"""Flask web server: serves the editor and the JSON API."""

import logging
from urllib.parse import urlsplit

from flask import Flask, abort, jsonify, request, send_from_directory

from . import lcdfont, storage
from .charrender import CHAR_SIZES, is_char, render_char
from .config import PLUGINS_DIR, STATE_DIR, STATIC_DIR, load_config, vehicle_name
from .display import Display
from .fonts import font_list
from .icons import ICONS
from .inputs import Inputs
from .renderer import COLOR_SIZES, render, to_png_b64
from .sources import SourceRegistry
from .tabs import TAB_META, page

log = logging.getLogger(__name__)

SIZES = [[128, 64], [128, 32], [96, 16], [64, 48], [64, 32]]


def create_app(config=None):
    config = config or load_config()
    hub_url = str(config["hub"].get("url") or "").strip()
    registry = SourceRegistry(config["sources"], PLUGINS_DIR, hub_url or None)
    vehicle = vehicle_name()
    inputs = Inputs(config["inputs"])
    inputs.open()  # before the displays, which start on the tab a switch that is on asks for
    registry.add_live(inputs.values, inputs.meta())
    registry.add_live(dict, TAB_META)  # every display fills these in for its own tab
    STATE_DIR.mkdir(exist_ok=True)
    displays = {d["id"]: Display(d, registry, STATE_DIR, inputs) for d in config["displays"]}
    for d in displays.values():
        inputs.subscribe(d.on_input)

    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

    def get_display(display_id):
        d = displays.get(display_id)
        if d is None:
            abort(404, f"ukjent display {display_id!r}")
        return d

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            abort(400, "forventet et JSON-objekt")
        return data

    @app.errorhandler(400)
    @app.errorhandler(404)
    def json_error(e):
        return jsonify(error=e.description), e.code

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(STATIC_DIR, name)

    @app.get("/api/meta")
    def meta():
        return jsonify(
            fonts=font_list(),
            icons=[{"name": name, "rows": rows} for name, rows in ICONS.items()],  # a list keeps the order
            lcd_icons=[{"name": name, "rows": lcdfont.to_art(g)} for name, g in lcdfont.ICONS.items()],
            sizes=SIZES,
            char_sizes=CHAR_SIZES,
            color_sizes=COLOR_SIZES,
            displays=[d.status() for d in displays.values()],
            inputs=inputs.status(),
            source_errors=registry.load_errors,
            vehicle=vehicle,
            hub=hub_status(),
        )

    def hub_status():
        if registry.hub is None:
            return None
        st = registry.hub.status()
        try:
            st["port"] = urlsplit(st["url"]).port or 80  # the HMI is on the hub's port: the editor links to it
        except ValueError:
            st["port"] = None
        return st

    @app.get("/api/hub")
    def hub():
        return jsonify(hub_status())

    @app.get("/api/sources")
    def sources():
        return jsonify(registry.describe())

    @app.post("/api/render")
    def render_preview():
        """Renders the layout's tab number ?tab= (from 0), or the layout as it is when it has no tabs."""
        try:
            layout, tab_values = page(body(), request.args.get("tab", 0, type=int))
        except (AttributeError, TypeError, ValueError):
            abort(400, "fanene i layouten er ødelagt")
        values = {**registry.snapshot(), **tab_values}
        if is_char(layout):
            frame, boxes, warnings = render_char(layout, values, registry.history)
            image = frame.image()
        else:
            image, boxes, warnings = render(layout, values, registry.history)
        return jsonify(png=to_png_b64(image), boxes=boxes, warnings=warnings)

    # --- layouts ---------------------------------------------------------

    @app.get("/api/layouts")
    def layouts():
        return jsonify(storage.list_layouts())

    @app.get("/api/layouts/<slug>")
    def get_layout(slug):
        try:
            return jsonify(storage.load_layout(slug))
        except (FileNotFoundError, ValueError):
            abort(404, "fant ikke layouten")

    @app.post("/api/layouts")
    def save_layout():
        slug = storage.save_layout(body())
        return jsonify(slug=slug)

    @app.delete("/api/layouts/<slug>")
    def delete_layout(slug):
        try:
            storage.delete_layout(slug)
        except ValueError:
            abort(404, "fant ikke layouten")
        return jsonify(ok=True)

    # --- displays --------------------------------------------------------

    @app.get("/api/displays")
    def display_list():
        return jsonify([d.status() for d in displays.values()])

    @app.post("/api/displays/<display_id>/deploy")
    def deploy(display_id):
        """?tab= (from 0) is the tab the display shows; without it, the one it showed."""
        d = get_display(display_id)
        layout = body()
        try:
            d.deploy(layout, request.args.get("tab", type=int))
        except (AttributeError, TypeError, ValueError) as e:
            abort(400, str(e) if isinstance(e, ValueError) else "fanene i layouten er ødelagt")
        slug = storage.save_layout(layout)
        return jsonify(slug=slug, status=d.status())

    @app.get("/api/displays/<display_id>/screen")
    def screen(display_id):
        d = get_display(display_id)
        return jsonify(png=to_png_b64(d.last_image), status=d.status(), inputs=inputs.status())

    @app.post("/api/displays/<display_id>/tab")
    def set_tab(display_id):
        """{"tab": n} (from 0) or {"step": 1 / -1}: which tab the display shows, until an input moves it."""
        d = get_display(display_id)
        data = body()
        try:
            d.set_tab(data.get("tab"), data.get("step", 0))
        except (TypeError, ValueError):
            abort(400, "forventet tab eller step som et tall")
        return jsonify(status=d.status())

    @app.post("/api/displays/<display_id>/clear")
    def clear(display_id):
        d = get_display(display_id)
        d.clear()
        return jsonify(status=d.status())

    @app.post("/api/displays/<display_id>/settings")
    def settings(display_id):
        d = get_display(display_id)
        data = body()
        if "contrast" in data:
            d.set_contrast(data["contrast"])
        if "powered" in data:
            d.set_power(data["powered"])
        if "backlight" in data:
            d.set_backlight(data["backlight"])
        return jsonify(status=d.status())

    # --- the board's inputs ------------------------------------------------

    @app.get("/api/inputs")
    def input_list():
        return jsonify(inputs.status())

    @app.post("/api/inputs/<int:n>")
    def press(n):
        """{"on": true} presses the input as if its switch was on, {"on": false} lets go."""
        if n >= len(inputs):
            abort(404, f"INN{n} finnes ikke")
        inputs.press(n, bool(body().get("on")))
        return jsonify(inputs.status())

    # --- push values from other programs -----------------------------------

    @app.post("/api/push")
    def push_many():
        for name, value in body().items():
            registry.push(str(name), value)
        return jsonify(ok=True)

    @app.post("/api/push/<name>")
    def push_one(name):
        data = request.get_json(silent=True)
        if data is None:
            data = request.get_data(as_text=True).strip()
        elif isinstance(data, dict):
            data = data.get("value")
        registry.push(name, data)
        return jsonify(ok=True)

    registry.start()
    inputs.start()
    for d in displays.values():
        d.start()
    return app, config
