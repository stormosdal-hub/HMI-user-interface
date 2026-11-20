"""Loads config.toml and exposes project paths."""

import os
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config.toml"
STATIC_DIR = ROOT / "static"
FONTS_DIR = ROOT / "fonts"
LAYOUTS_DIR = ROOT / "layouts"
STATE_DIR = ROOT / "state"
PLUGINS_DIR = ROOT / "plugins"
# the kjøreverk's name, written by install.sh; HMI_VEHICLE_FILE points elsewhere (as for hmi-core)
VEHICLE_FILE = Path(os.environ.get("HMI_VEHICLE_FILE", "/etc/kjoreverk/vehicle"))
DEFAULT_HUB = "ws://127.0.0.1:8080"

OLED_DRIVERS = ("ssd1306", "sh1106", "ssd1309", "ssd1315")
CHAR_DRIVERS = ("hd44780",)
COLOR_DRIVERS = ("st7789",)

DEFAULT_DISPLAY = {
    "id": "main",
    "name": "Hoveddisplay",
    "driver": "ssd1306",
    "bus": 1,
    "address": 0x3C,
    "width": 128,
    "height": 64,
    "rotate": 0,
    "contrast": 255,
}

# Character LCDs (1602/2004) with a PCF8574 I2C backpack. Size is in characters.
DEFAULT_CHAR_DISPLAY = {
    "id": "lcd",
    "name": "LCD",
    "bus": 1,
    "address": 0x27,
    "cols": 16,
    "rows": 2,
    "backlight": True,
}

# Colour TFTs on SPI. width/height are the panel's own (portrait) size and
# rotate turns it, so a 76×284 panel with rotate = 1 takes 284×76 layouts.
# The pins are the ones on the X1 plug of the kjøreverk's RaspiPower board; every
# other GPIO goes to the board's inputs and 24 V outputs (GPIO 18, 24 and 25 too).
DEFAULT_COLOR_DISPLAY = {
    "id": "tft",
    "name": "TFT",
    "spi_port": 0,
    "spi_device": 0,      # 0 = CE0 (GPIO8), 1 = CE1 (GPIO7)
    "spi_mhz": 32,
    "dc_pin": 7,          # CE1 on X1, free with dtoverlay=spi0-1cs
    "reset_pin": -1,      # -1 = not connected (RES to 3.3 V; the panel gets a software reset)
    "backlight_pin": 9,   # MISO on X1, free with no_miso; -1 = BL wired straight to 3.3 V
    "backlight_active_low": False,  # True = the light is on when BLK is low
    "width": 76,
    "height": 284,
    "rotate": 1,
    "invert": True,       # IPS panels show negative colours without it
    "bgr": False,
    "brightness": 255,
}

# The inputs INN0–INN7 on the RaspiPower board, as GPIO numbers. They have optocouplers,
# so a GPIO reads 0 while 24 V is on its input. Layouts with tabs use them to move between the tabs.
DEFAULT_INPUTS = {
    "enabled": True,
    "gpio": [16, 26, 20, 21, 19, 13, 12, 6],
    "active_low": True,
    "debounce_ms": 30,
}


def _display(d):
    driver = str(d.get("driver", DEFAULT_DISPLAY["driver"])).lower()
    if driver in CHAR_DRIVERS:
        d = {**DEFAULT_CHAR_DISPLAY, **d, "driver": driver, "kind": "char"}
        return {**d, "width": int(d["cols"]), "height": int(d["rows"])}
    if driver in COLOR_DRIVERS:
        return {**DEFAULT_COLOR_DISPLAY, **d, "driver": driver, "kind": "color"}
    if driver not in OLED_DRIVERS:
        raise ValueError(f"ukjent driver {driver!r}, bruk en av {', '.join(OLED_DRIVERS + CHAR_DRIVERS + COLOR_DRIVERS)}")
    return {**DEFAULT_DISPLAY, **d, "driver": driver, "kind": "pixel"}


def load_config(path=CONFIG_FILE):
    data = {}
    if path.exists():
        with open(path, "rb") as f:
            data = tomllib.load(f)

    server = {"host": "0.0.0.0", "port": 8000, **data.get("server", {})}
    hub = {"url": DEFAULT_HUB, **data.get("hub", {})}
    displays = [_display(d) for d in data.get("display", [])] or [_display({})]

    ids = [d["id"] for d in displays]
    if len(ids) != len(set(ids)):
        raise ValueError(f"Display-id-er må være unike i {path}: {ids}")

    inputs = {**DEFAULT_INPUTS, **data.get("inputs", {})}
    if not (isinstance(inputs["gpio"], list) and all(isinstance(p, int) and 0 <= p <= 27 for p in inputs["gpio"])):
        raise ValueError(f"[inputs] gpio i {path} må være en liste med GPIO-numre (0–27)")

    return {"server": server, "hub": hub, "displays": displays, "inputs": inputs,
            "sources": data.get("source", [])}


def vehicle_name():
    """The kjøreverk's name (kv_52), or "" off the kjøreverk. As hmi-core/lib/vehicle.js."""
    try:
        name = VEHICLE_FILE.read_text().strip()
    except OSError:
        return ""
    return name if re.fullmatch(r"[A-Za-z_][\w.-]{0,31}", name, re.ASCII) else ""
