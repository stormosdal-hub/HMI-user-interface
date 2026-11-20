"""Saved layouts live as JSON files in layouts/."""

import json
import re
import time
import unicodedata

from .config import LAYOUTS_DIR


def slugify(name):
    name = unicodedata.normalize("NFKD", str(name))
    name = name.replace("ø", "o").replace("Ø", "o").replace("æ", "ae").replace("Æ", "ae")
    name = name.encode("ascii", "ignore").decode().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", name).strip("-")
    return slug[:60] or "uten-navn"


def _path(slug):
    if not re.fullmatch(r"[a-z0-9-]{1,60}", slug):
        raise ValueError("ugyldig layout-navn")
    return LAYOUTS_DIR / f"{slug}.json"


def list_layouts():
    out = []
    for p in sorted(LAYOUTS_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except ValueError:
            continue
        out.append({
            "slug": p.stem,
            "name": data.get("name", p.stem),
            "kind": data.get("kind", "pixel"),
            "width": data.get("width"),
            "height": data.get("height"),
            "tabs": len(data["tabs"]) if isinstance(data.get("tabs"), list) else 1,
            "updated": data.get("updated"),
        })
    out.sort(key=lambda x: x.get("updated") or 0, reverse=True)
    return out


def load_layout(slug):
    return json.loads(_path(slug).read_text())


def save_layout(layout):
    slug = slugify(layout.get("name", ""))
    layout = {**layout, "updated": time.time()}
    LAYOUTS_DIR.mkdir(exist_ok=True)
    path = _path(slug)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(layout, ensure_ascii=False, indent=1))
    tmp.replace(path)
    return slug


def delete_layout(slug):
    _path(slug).unlink(missing_ok=True)
