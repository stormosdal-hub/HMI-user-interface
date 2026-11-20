"""Font discovery and caching. Layouts reference fonts by id, never by path."""

from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from .config import FONTS_DIR

# Sizes where pixel fonts render crisply (multiples of their design grid).
SIZE_HINTS = {
    "Silkscreen-Regular": [8, 16, 24],
    "Silkscreen-Bold": [8, 16, 24],
    "PressStart2P-Regular": [8, 16, 24],
    "VT323-Regular": [16, 20, 32],
}

SYSTEM_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

BUILTIN = "builtin"
DEFAULT_FONT = "Silkscreen-Regular"


def _discover():
    fonts = {BUILTIN: {"id": BUILTIN, "name": "Innebygd (6×11 bitmap)", "path": None, "sizes": [11], "pixel": True}}
    for p in sorted(FONTS_DIR.glob("*")):
        if p.suffix.lower() in (".ttf", ".otf"):
            fonts[p.stem] = {"id": p.stem, "name": p.stem.replace("-Regular", ""), "path": str(p),
                             "sizes": SIZE_HINTS.get(p.stem, []), "pixel": p.stem in SIZE_HINTS}
    for path in SYSTEM_FONTS:
        p = Path(path)
        if p.exists() and p.stem not in fonts:
            fonts[p.stem] = {"id": p.stem, "name": p.stem, "path": path, "sizes": []}
    return fonts


FONTS = _discover()


def font_list():
    return [{k: v for k, v in f.items() if k != "path"} for f in FONTS.values()]


def _info(font_id):
    return FONTS.get(font_id) or FONTS.get(DEFAULT_FONT) or FONTS[BUILTIN]


def is_pixel_font(font_id):
    """Pixel fonts are drawn without anti-aliasing, also on colour displays."""
    return bool(_info(font_id).get("pixel"))


@lru_cache(maxsize=128)
def get_font(font_id, size):
    """Returns (font, cap_top, line_height).

    cap_top is how far below the draw origin capital letters start, so text can
    be positioned by the top of its capitals – what you'd expect in an editor.
    """
    info = _info(font_id)
    if info["path"] is None:
        # the 6×11 bitmap font; Pillow before 10.1 (Bookworm has 9.4) calls it load_default()
        font = getattr(ImageFont, "load_default_imagefont", ImageFont.load_default)()
        cap_top = font.getbbox("H")[1]
        return font, cap_top, font.getbbox("Hg")[3] - cap_top
    size = max(4, min(int(size), 128))
    font = ImageFont.truetype(info["path"], size)
    ascent, descent = font.getmetrics()
    cap_top = font.getbbox("H", anchor="la")[1]
    return font, cap_top, ascent + descent - cap_top
