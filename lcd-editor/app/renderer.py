"""Renders a layout (JSON) to a PIL image: 1-bit for OLEDs, RGB for colour TFTs.

The same code renders the editor preview and the real display, so what you see
in the browser is pixel for pixel what ends up on the screen.
"""

import base64
import io
import math
import threading
from functools import lru_cache

from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageOps

from .fonts import DEFAULT_FONT, get_font, is_pixel_font
from .icons import ICONS
from .textfmt import render_template, value_text

COLOR_OFF, COLOR_ON, COLOR_INVERT = 0, 1, 2
INK = 255  # "on" in a mode "1" mask, full strength in an anti-aliased mode "L" one
MAX_SIZE = 320
COLOR_SIZES = [[284, 76], [76, 284], [320, 240], [240, 320], [240, 240], [320, 170], [240, 135], [160, 80]]
DEFAULT_FG, DEFAULT_BG = "#ffffff", "#000000"

_lock = threading.Lock()  # FreeType faces are not safe to share between threads


def _num(el, key, default=0.0):
    try:
        v = el.get(key)
        return default if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return default


def _int(el, key, default=0):
    return int(round(_num(el, key, default)))


def _opt_num(el, key):
    v = el.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _box(el):
    x, y = _int(el, "x"), _int(el, "y")
    w, h = max(1, _int(el, "w", 1)), max(1, _int(el, "h", 1))
    return x, y, w, h


# --- element painters: each draws a mask with INK and returns its bounding box ---

def _rgb(value, default):
    try:
        return ImageColor.getrgb(str(value))[:3]
    except ValueError:
        return ImageColor.getrgb(default)


def _paint_text(draw, el, text):
    font_id = el.get("font") or DEFAULT_FONT
    font, cap_top, line_h = get_font(font_id, _num(el, "size", 8))
    if is_pixel_font(font_id):
        draw.fontmode = "1"
    lines = text.split("\n")
    spacing = _int(el, "spacing", 1)
    widths = [math.ceil(draw.textlength(line, font=font)) for line in lines]
    total_w = max(widths) if widths else 0
    total_h = len(lines) * line_h + (len(lines) - 1) * spacing
    x, y = _int(el, "x"), _int(el, "y")
    align = el.get("align", "left")
    factor = {"center": 0.5, "right": 1.0}.get(align, 0.0)
    x0 = x - math.floor(total_w * factor)
    for i, (line, w) in enumerate(zip(lines, widths)):
        lx = x0 + math.floor((total_w - w) * factor)
        draw.text((lx, y + i * (line_h + spacing) - cap_top), line, font=font, fill=INK)
    return [x0, y, x0 + max(total_w, 3), y + total_h]


def paint_text(draw, el, values, _history):
    return _paint_text(draw, el, render_template(str(el.get("text", "")), values))


def paint_value(draw, el, values, _history):
    value = values.get(el.get("source", ""))
    text = value_text(el, value)
    return _paint_text(draw, el, f"{el.get('prefix', '')}{text}{el.get('suffix', '')}")


@lru_cache(maxsize=256)
def _icon_mask(name, scale):
    rows = ICONS.get(name) or ICONS["warning"]
    small = Image.new("1", (len(rows[0]), len(rows)), 0)
    small.putdata([1 if ch == "#" else 0 for row in rows for ch in row])
    return small.resize((small.width * scale, small.height * scale), Image.NEAREST)


def paint_icon(draw, el, _values, _history):
    mask = _icon_mask(el.get("icon", "warning"), max(1, min(_int(el, "scale", 1), 8)))
    x, y = _int(el, "x"), _int(el, "y")
    draw.bitmap((x, y), mask, fill=INK)
    return [x, y, x + mask.width, y + mask.height]


def paint_line(draw, el, _values, _history):
    x, y, x2, y2 = _int(el, "x"), _int(el, "y"), _int(el, "x2"), _int(el, "y2")
    width = max(1, _int(el, "width", 1))
    draw.line([(x, y), (x2, y2)], fill=INK, width=width)
    pad = width // 2
    return [min(x, x2) - pad, min(y, y2) - pad, max(x, x2) + pad + 1, max(y, y2) + pad + 1]


def paint_rect(draw, el, _values, _history):
    x, y, w, h = _box(el)
    xy = [x, y, x + w - 1, y + h - 1]
    fill = INK if el.get("fill") else None
    width = max(1, _int(el, "width", 1))
    radius = _int(el, "radius", 0)
    if radius > 0:
        draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=INK, width=width)
    else:
        draw.rectangle(xy, fill=fill, outline=INK, width=width)
    return [x, y, x + w, y + h]


def paint_ellipse(draw, el, _values, _history):
    x, y, w, h = _box(el)
    fill = INK if el.get("fill") else None
    draw.ellipse([x, y, x + w - 1, y + h - 1], fill=fill, outline=INK, width=max(1, _int(el, "width", 1)))
    return [x, y, x + w, y + h]


def paint_bar(draw, el, values, _history):
    x, y, w, h = _box(el)
    lo, hi = _num(el, "min", 0), _num(el, "max", 100)
    value = values.get(el.get("source", ""))
    frac = 0.0
    if isinstance(value, (int, float)) and hi != lo:
        frac = min(max((value - lo) / (hi - lo), 0.0), 1.0)
    pad = 0
    if el.get("border", True):
        draw.rectangle([x, y, x + w - 1, y + h - 1], outline=INK)
        pad = 2
    iw, ih = w - 2 * pad, h - 2 * pad
    if iw > 0 and ih > 0:
        if el.get("vertical"):
            fh = round(ih * frac)
            if fh:
                draw.rectangle([x + pad, y + pad + ih - fh, x + pad + iw - 1, y + pad + ih - 1], fill=INK)
        else:
            fw = round(iw * frac)
            if fw:
                draw.rectangle([x + pad, y + pad, x + pad + fw - 1, y + pad + ih - 1], fill=INK)
    return [x, y, x + w, y + h]


def paint_graph(draw, el, _values, history):
    x, y, w, h = _box(el)
    pad = 0
    if el.get("border", True):
        draw.rectangle([x, y, x + w - 1, y + h - 1], outline=INK)
        pad = 2
    ix, iy, iw, ih = x + pad, y + pad, w - 2 * pad, h - 2 * pad
    if iw < 2 or ih < 2:
        return [x, y, x + w, y + h]

    span = max(_int(el, "span", iw), 1)
    data = history(el.get("source", ""))[-span:]
    missing = span - len(data)  # graph fills in from the right while history is young
    points = []
    for col in range(iw):
        s0 = int(col * span / iw) - missing
        s1 = max(int((col + 1) * span / iw) - missing, s0 + 1)
        if s1 <= 0:
            continue
        chunk = data[max(s0, 0):s1]
        if chunk:
            points.append((col, sum(chunk) / len(chunk)))
    if not points:
        return [x, y, x + w, y + h]

    lo, hi = _opt_num(el, "min"), _opt_num(el, "max")
    vals = [v for _, v in points]
    lo = min(vals) if lo is None else lo
    hi = max(vals) if hi is None else hi
    if hi == lo:
        lo, hi = lo - 1, hi + 1

    def py(v):
        f = min(max((v - lo) / (hi - lo), 0.0), 1.0)
        return iy + ih - 1 - round(f * (ih - 1))

    style = el.get("style", "line")
    prev = None
    for col, v in points:
        px, pyv = ix + col, py(v)
        if style == "bars":
            draw.line([(px, pyv), (px, iy + ih - 1)], fill=INK)
        elif style == "dots":
            draw.point((px, pyv), fill=INK)
        else:
            draw.line([prev, (px, pyv)] if prev else [(px, pyv), (px, pyv)], fill=INK)
            prev = (px, pyv)
    return [x, y, x + w, y + h]


def _decode(data):
    b64 = data.split(",", 1)[1] if data.startswith("data:") else data
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    img.load()
    return img


@lru_cache(maxsize=32)
def _image_mask(data, w, h, dither, threshold, invert):
    img = _decode(data)
    if img.mode in ("RGBA", "LA", "P", "PA"):
        img = img.convert("RGBA")
        background = Image.new("RGBA", img.size, (0, 0, 0, 255))
        img = Image.alpha_composite(background, img)  # transparent = pixel off
    img = img.convert("L").resize((w, h), Image.LANCZOS)
    if invert:
        img = ImageOps.invert(img)
    if dither:
        return img.convert("1")  # Floyd–Steinberg
    return img.point(lambda p: 255 if p >= threshold else 0).convert("1", dither=Image.Dither.NONE)


def paint_image(draw, el, _values, _history):
    x, y, w, h = _box(el)
    w, h = min(w, MAX_SIZE), min(h, MAX_SIZE)
    data = el.get("data")
    if not data:
        draw.rectangle([x, y, x + w - 1, y + h - 1], outline=INK)
        draw.line([(x, y), (x + w - 1, y + h - 1)], fill=INK)
        draw.line([(x, y + h - 1), (x + w - 1, y)], fill=INK)
    else:
        mask = _image_mask(data, w, h, bool(el.get("dither", True)),
                           _int(el, "threshold", 128), bool(el.get("invert")))
        draw.bitmap((x, y), mask, fill=INK)
    return [x, y, x + w, y + h]


@lru_cache(maxsize=32)
def _photo(data, w, h):
    return _decode(data).convert("RGBA").resize((w, h), Image.LANCZOS)


def paste_photo(base, el):
    """Colour displays show images as they are, instead of as a mask."""
    x, y, w, h = _box(el)
    photo = _photo(el["data"], min(w, MAX_SIZE), min(h, MAX_SIZE))
    base.paste(photo, (x, y), photo)
    return [x, y, x + photo.width, y + photo.height]


PAINTERS = {
    "text": paint_text,
    "value": paint_value,
    "icon": paint_icon,
    "line": paint_line,
    "rect": paint_rect,
    "ellipse": paint_ellipse,
    "bar": paint_bar,
    "graph": paint_graph,
    "image": paint_image,
}


def is_color(layout):
    return layout.get("kind") == "color"


def layout_size(layout):
    w = max(8, min(int(layout.get("width", 128)), MAX_SIZE))
    h = max(8, min(int(layout.get("height", 64)), MAX_SIZE))
    return w, h


def render(layout, values, history=lambda _name: []):
    """Returns (image, boxes, warnings). boxes: element id -> [x0, y0, x1, y1]."""
    with _lock:
        size = layout_size(layout)
        color = is_color(layout)
        base = Image.new("RGB", size, _rgb(layout.get("background"), DEFAULT_BG)) if color else Image.new("1", size, 0)
        boxes, warnings = {}, {}
        for i, el in enumerate(layout.get("elements", [])):
            el_id = str(el.get("id", i))
            painter = PAINTERS.get(el.get("type"))
            if painter is None:
                warnings[el_id] = f"ukjent elementtype {el.get('type')!r}"
                continue
            if el.get("hidden"):
                continue
            # Every element is painted as a mask, then combined with the canvas:
            # in its colour, or on an OLED lit (on), erased (off) or XOR-ed (invert).
            layer = Image.new("L" if color else "1", size, 0)
            try:
                if color and el.get("type") == "image" and el.get("data"):
                    boxes[el_id] = paste_photo(base, el)
                    continue
                boxes[el_id] = painter(ImageDraw.Draw(layer), el, values, history)
            except Exception as e:
                warnings[el_id] = str(e) or type(e).__name__
                continue
            if color:
                base.paste(_rgb(el.get("color"), DEFAULT_FG), mask=layer)
                continue
            mode = _int(el, "color", COLOR_ON)
            if mode == COLOR_INVERT:
                base = ImageChops.logical_xor(base, layer)
            elif mode == COLOR_OFF:
                base.paste(0, mask=layer)
            else:
                base.paste(1, mask=layer)
        if layout.get("invert") and not color:
            base = base.point(lambda p: 0 if p else 255).convert("1", dither=Image.Dither.NONE)
        return base, boxes, warnings


def to_png_b64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")
