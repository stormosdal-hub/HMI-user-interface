"""Renders a character-LCD layout (HD44780, e.g. 1602) to a frame of character codes.

Positions and sizes are in character cells. Text uses the LCD's own ROM font.
Icons, bars, graphs and letters the ROM lacks (æ ø å) become custom glyphs,
and the LCD only has room for 8 of those at a time.

Like renderer.py this produces both the editor preview and what the display
shows, so the two always agree.
"""

from PIL import Image, ImageDraw

from . import lcdfont
from .lcdfont import CODE_FULL, CODE_SPACE, CODE_UNKNOWN, CUSTOM_SLOTS, ROM, ROM_BY_GLYPH
from .renderer import _int, _num
from .renderer import paint_graph as paint_pixel_graph
from .textfmt import render_template, value_text

MAX_COLS, MAX_ROWS = 40, 4
CHAR_SIZES = [[16, 2], [20, 4], [16, 4], [20, 2], [16, 1], [8, 2], [40, 2]]
SLOTS_FULL = (f"LCD-et har bare plass til {CUSTOM_SLOTS} egne tegn (ikoner, æ/ø/å, stolper og grafer) "
              "– resten vises som «?».")


def is_char(layout):
    return layout.get("kind") == "char"


def char_size(layout):
    cols = max(1, min(int(layout.get("width", 16)), MAX_COLS))
    rows = max(1, min(int(layout.get("height", 2)), MAX_ROWS))
    return cols, rows


class Frame:
    """What the LCD shows: codes[row][col] are ROM codes, except 0–7 which index glyphs."""

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.codes = [[CODE_SPACE] * cols for _ in range(rows)]
        self.glyphs = []

    def code_for(self, glyph):
        """ROM code or custom slot for glyph; None when all custom slots are taken."""
        code = ROM_BY_GLYPH.get(glyph)
        if code is not None:
            return code
        if glyph in self.glyphs:
            return self.glyphs.index(glyph)
        if len(self.glyphs) >= CUSTOM_SLOTS:
            return None
        self.glyphs.append(glyph)
        return len(self.glyphs) - 1

    def put(self, col, row, code):
        if 0 <= row < self.rows and 0 <= col < self.cols:
            self.codes[row][col] = code

    def compact(self):
        """Drops glyphs that later elements painted over."""
        used = sorted({c for row in self.codes for c in row if c < CUSTOM_SLOTS})
        remap = {old: new for new, old in enumerate(used)}
        self.glyphs = [self.glyphs[old] for old in used]
        self.codes = [[remap.get(c, c) if c < CUSTOM_SLOTS else c for c in row] for row in self.codes]

    def glyph_at(self, col, row):
        code = self.codes[row][col]
        if code < CUSTOM_SLOTS:
            return self.glyphs[code]
        return ROM.get(code, ROM[CODE_UNKNOWN])

    def image(self):
        """The dots, without the gaps between cells: (cols·5) × (rows·8), mode "1"."""
        w, h = lcdfont.WIDTH, lcdfont.HEIGHT
        img = Image.new("1", (self.cols * w, self.rows * h), 0)
        px = img.load()
        for r in range(self.rows):
            for c in range(self.cols):
                for y, bits in enumerate(self.glyph_at(c, r)):
                    for x in range(w):
                        if bits >> (w - 1 - x) & 1:
                            px[c * w + x, r * h + y] = 1
        return img


class _Ctx:
    def __init__(self, frame, values, history):
        self.frame, self.values, self.history = frame, values, history
        self.warnings = []

    def warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)

    def glyph(self, glyph):
        code = self.frame.code_for(glyph)
        if code is None:
            self.warn(SLOTS_FULL)
            return CODE_UNKNOWN
        return code


def _fit(text, width, align):
    if not width:
        return text
    if len(text) > width:
        return text[:width]
    pad = width - len(text)
    if align == "right":
        return " " * pad + text
    if align == "center":
        return " " * (pad // 2) + text + " " * (pad - pad // 2)
    return text + " " * pad


def _write_text(ctx, el, text):
    x, y = _int(el, "x"), _int(el, "y")
    width = max(0, _int(el, "w", 0))
    lines = [_fit(line, width, el.get("align", "left")) for line in text.split("\n")]
    missing = []
    for i, line in enumerate(lines):
        for j, ch in enumerate(line):
            enc = lcdfont.encode_char(ch)
            if enc is None:
                code = CODE_UNKNOWN
                if ch not in missing:
                    missing.append(ch)
            elif isinstance(enc, tuple):
                code = ctx.frame.code_for(enc)
                if code is None:
                    ctx.warn(SLOTS_FULL)
                    code = CODE_UNKNOWN
            else:
                code = enc
            ctx.frame.put(x + j, y + i, code)
    if missing:
        ctx.warn(f"LCD-et har ikke tegnet {', '.join('«' + c + '»' for c in missing)}")
    return [x, y, x + max(width or max(map(len, lines)), 1), y + len(lines)]


def paint_text(ctx, el):
    return _write_text(ctx, el, render_template(str(el.get("text", "")), ctx.values))


def paint_value(ctx, el):
    text = value_text(el, ctx.values.get(el.get("source", "")))
    return _write_text(ctx, el, f"{el.get('prefix', '')}{text}{el.get('suffix', '')}")


def paint_icon(ctx, el):
    x, y = _int(el, "x"), _int(el, "y")
    glyph = lcdfont.ICONS.get(el.get("icon")) or ROM[CODE_UNKNOWN]
    ctx.frame.put(x, y, ctx.glyph(glyph))
    return [x, y, x + 1, y + 1]


def paint_bar(ctx, el):
    """Horizontal bar with 5 steps per cell. Only the partly filled cell needs a custom glyph."""
    x, y = _int(el, "x"), _int(el, "y")
    w = max(1, _int(el, "w", 8))
    lo, hi = _num(el, "min", 0), _num(el, "max", 100)
    value = ctx.values.get(el.get("source", ""))
    frac = 0.0
    if isinstance(value, (int, float)) and hi != lo:
        frac = min(max((value - lo) / (hi - lo), 0.0), 1.0)
    lit = round(frac * w * lcdfont.WIDTH)
    for i in range(w):
        n = min(max(lit - i * lcdfont.WIDTH, 0), lcdfont.WIDTH)
        if n in (0, lcdfont.WIDTH):
            code = CODE_FULL if n else CODE_SPACE
        else:
            code = ctx.frame.code_for(((0x1F << (lcdfont.WIDTH - n)) & 0x1F,) * lcdfont.HEIGHT)
            if code is None:  # no slot left: round to a whole cell rather than show "?"
                ctx.warn(SLOTS_FULL)
                code = CODE_FULL if n * 2 >= lcdfont.WIDTH else CODE_SPACE
        ctx.frame.put(x + i, y, code)
    return [x, y, x + w, y + 1]


def paint_graph(ctx, el):
    """Draws the history like the OLED graph, then cuts it into custom glyphs (one per cell)."""
    x, y = _int(el, "x"), _int(el, "y")
    w, h = max(1, _int(el, "w", 6)), max(1, _int(el, "h", 1))
    cw, ch = lcdfont.WIDTH, lcdfont.HEIGHT
    img = Image.new("1", (w * cw, h * ch), 0)
    graph_el = {**el, "x": 0, "y": 0, "w": w * cw, "h": h * ch, "border": False}
    paint_pixel_graph(ImageDraw.Draw(img), graph_el, ctx.values, ctx.history)
    px = img.load()
    for r in range(h):
        for c in range(w):
            glyph = tuple(sum((1 if px[c * cw + i, r * ch + j] else 0) << (cw - 1 - i) for i in range(cw))
                          for j in range(ch))
            ctx.frame.put(x + c, y + r, ctx.glyph(glyph))
    return [x, y, x + w, y + h]



PAINTERS = {
    "text": paint_text,
    "value": paint_value,
    "icon": paint_icon,
    "bar": paint_bar,
    "graph": paint_graph,
}


def render_char(layout, values, history=lambda _name: []):
    """Returns (frame, boxes, warnings), with boxes in cells: id -> [col0, row0, col1, row1]."""
    frame = Frame(*char_size(layout))
    boxes, warnings = {}, {}
    for i, el in enumerate(layout.get("elements", [])):
        el_id = str(el.get("id", i))
        painter = PAINTERS.get(el.get("type"))
        if painter is None:
            warnings[el_id] = f"elementtypen {el.get('type')!r} finnes ikke for tegn-LCD"
            continue
        if el.get("hidden"):
            continue
        ctx = _Ctx(frame, values, history)
        try:
            boxes[el_id] = painter(ctx, el)
        except Exception as e:
            warnings[el_id] = str(e) or type(e).__name__
            continue
        if ctx.warnings:
            warnings[el_id] = " ".join(ctx.warnings)
    frame.compact()
    return frame, boxes, warnings
