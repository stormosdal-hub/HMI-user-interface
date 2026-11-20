"""Drives the physical displays: OLEDs via luma.oled, character LCDs via
hd44780.py and colour TFTs via st7789.py.

Each display runs its own thread that re-renders the deployed layout at the
layout's refresh interval. If the display isn't reachable (I2C/SPI disabled,
wrong address, loose wire) it keeps rendering into memory – the editor's live
view still works – and retries the connection periodically.

A layout with several tabs shows one of them, and the board's inputs move
between them (tabs.py). Which tab is active is only kept in memory: after a
restart the display starts on the first tab, or the one a switch that is on
asks for.
"""

import errno
import json
import logging
import threading
import time
from pathlib import Path

from PIL import Image

from .charrender import Frame, char_size, is_char, render_char
from .renderer import is_color, layout_size, render
from .tabs import check as check_tabs, nav_of, page, tab_index, tab_names, tabs_of

log = logging.getLogger(__name__)

RECONNECT_SECONDS = 10


def _probe(bus, address):
    """Raises OSError unless something answers at address.

    luma keeps the bus open (and an atexit hook alive) when its constructor
    fails, and a missing display is retried every RECONNECT_SECONDS, so the
    drivers must only be opened once we know the display is there.
    """
    from smbus2 import SMBus

    path = f"/dev/i2c-{bus}"
    if not Path(path).exists():
        raise OSError(f"I2C device not found: {path}")  # same wording as luma
    with SMBus(bus) as b:
        try:
            b.read_byte(address)
        except OSError as e:
            if e.errno in (errno.ENXIO, errno.EREMOTEIO):  # nobody acknowledged the address
                raise OSError(f"I2C device not found on address: 0x{address:02X}") from None
            raise


def _open_device(cfg):
    if cfg["kind"] == "color":
        from .st7789 import ST7789

        # SPI is write-only here, so unlike on I2C nothing tells us whether a panel is attached.
        port, dev = int(cfg["spi_port"]), int(cfg["spi_device"])
        if not Path(f"/dev/spidev{port}.{dev}").exists():
            raise OSError(f"SPI device not found: /dev/spidev{port}.{dev}")
        return ST7789(port, dev, dc=int(cfg["dc_pin"]), reset=int(cfg["reset_pin"]),
                      backlight=int(cfg["backlight_pin"]), width=int(cfg["width"]), height=int(cfg["height"]),
                      rotate=int(cfg["rotate"]), offset_x=cfg.get("offset_x"), offset_y=cfg.get("offset_y"),
                      invert=bool(cfg["invert"]), bgr=bool(cfg["bgr"]),
                      speed_hz=int(float(cfg["spi_mhz"]) * 1_000_000), brightness=int(cfg["contrast"]),
                      backlight_active_low=bool(cfg["backlight_active_low"]))

    bus, address = int(cfg["bus"]), int(cfg["address"])
    _probe(bus, address)
    if cfg["kind"] == "char":
        from .hd44780 import HD44780

        return HD44780(bus, address, int(cfg["cols"]), int(cfg["rows"]), backlight=bool(cfg["backlight"]))

    from luma.core.interface.serial import i2c
    from luma.oled import device as oled

    serial = i2c(port=bus, address=address)
    try:
        dev = getattr(oled, cfg["driver"])(serial, width=int(cfg["width"]), height=int(cfg["height"]),
                                           rotate=int(cfg["rotate"]))
        dev.contrast(int(cfg["contrast"]))
    except Exception:
        serial.cleanup()
        raise
    dev.close = serial.cleanup  # luma devices have no close(); Display._disconnect needs one
    return dev


def describe_size(kind, w, h):
    return {"char": f"{w}×{h} tegn", "color": f"{w}×{h} piksler i farger"}.get(kind, f"{w}×{h} piksler")


def layout_kind(layout):
    return "char" if is_char(layout) else "color" if is_color(layout) else "pixel"


def _where(cfg):
    if cfg["kind"] == "color":
        return f"SPI{cfg['spi_port']}.{cfg['spi_device']}"
    return f"I2C-{cfg['bus']} · 0x{int(cfg['address']):02X}"


class Display:
    def __init__(self, cfg, registry, state_dir, inputs=None):
        self.cfg = cfg
        self.id = cfg["id"]
        self.kind = cfg["kind"]
        w, h = int(cfg["width"]), int(cfg["height"])
        # A display turned 90° takes layouts the other way round (luma swaps them the same way).
        self.size = (h, w) if self.kind != "char" and int(cfg.get("rotate", 0)) % 2 else (w, h)
        self.where = _where(cfg)
        self.registry = registry
        self.inputs = inputs
        self.state_file = state_dir / f"deployed-{self.id}.json"
        self.settings_file = state_dir / f"settings-{self.id}.json"  # kept when the layout is cleared
        self.device = None
        self.error = None
        self.layout = None
        self.deployed_at = None
        self.tab = 0
        self._nav = {}    # input -> (action, tab index)
        self._held = {}   # input with a "hold" action that is on -> the tab to go back to
        self.powered = True
        self.contrast = int(cfg.get("brightness" if self.kind == "color" else "contrast", 255))
        self.backlight = bool(cfg.get("backlight", True))
        self.last_image = self._render(None)[1]
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._next_connect = 0.0
        self._load_state()
        self._load_settings()
        with self._lock:
            self._follow_switches()
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"display-{self.id}")

    def start(self):
        self._thread.start()

    # --- state -----------------------------------------------------------

    def _load_state(self):
        try:
            state = json.loads(self.state_file.read_text())
            self._check(state["layout"])  # the display may have changed in config.toml
            self.layout = state["layout"]
            self.deployed_at = state.get("deployed_at")
            self._nav = nav_of(self.layout)
        except FileNotFoundError:
            pass
        except (ValueError, KeyError) as e:
            log.warning("Kunne ikke bruke %s: %s", self.state_file, e)

    def _load_settings(self):
        """On/off, contrast and backlight as last set in the editor; config.toml only gives the defaults."""
        try:
            s = json.loads(self.settings_file.read_text())
            powered, contrast, backlight = bool(s["powered"]), int(s["contrast"]), bool(s["backlight"])
        except FileNotFoundError:
            return
        except (ValueError, KeyError, TypeError) as e:
            log.warning("Kunne ikke bruke %s: %s", self.settings_file, e)
            return
        self.powered, self.contrast, self.backlight = powered, max(0, min(contrast, 255)), backlight

    def _save_settings(self):
        with self._lock:
            tmp = self.settings_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"powered": self.powered, "contrast": self.contrast, "backlight": self.backlight}))
            tmp.replace(self.settings_file)

    def _check(self, layout):
        kind = layout_kind(layout)
        size = char_size(layout) if kind == "char" else layout_size(layout)
        if (kind, size) != (self.kind, self.size):
            raise ValueError(f"Layouten er {describe_size(kind, *size)}, men displayet «{self.cfg['name']}» "
                             f"er {describe_size(self.kind, *self.size)}.")
        check_tabs(layout, len(self.inputs) if self.inputs else 0)

    def deploy(self, layout, tab=None):
        """Shows the layout, on the tab at index tab, or else the tab it showed (by id) or the first one."""
        self._check(layout)
        with self._lock:
            old = tabs_of(self.layout)[self.tab].get("id") if self.layout else None
            keep = tab_index(layout, old)
            self.layout = layout
            self._nav = nav_of(layout)
            self._held = {}
            self.tab = 0
            self._go(tab if tab is not None else keep or 0)
            self.deployed_at = time.time()
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"layout": layout, "deployed_at": self.deployed_at}))
            tmp.replace(self.state_file)
        self._wake.set()

    def clear(self):
        with self._lock:
            self.layout = None
            self.deployed_at = None
            self.tab = 0
            self._nav, self._held = {}, {}
            self.state_file.unlink(missing_ok=True)
        self._wake.set()

    # --- tabs ------------------------------------------------------------

    def _go(self, index):
        """Under self._lock. Past the last tab is the first again, and before the first the last."""
        index %= len(tabs_of(self.layout or {}))
        if index != self.tab:
            self.tab = index
            self._wake.set()

    def _follow_switches(self):
        """Under self._lock, at start: inputs that are on already show their tab (a selector switch)."""
        if not self.inputs or self.layout is None:
            return
        for n, on in enumerate(self.inputs.states()):
            action, target = self._nav.get(n, (None, None))
            if on and action == "hold":
                self._held[n] = self.tab
            if on and action in ("goto", "hold"):
                self._go(target)

    def on_input(self, n, on):
        """An input went on or off, on the board or in the editor. Only what is in memory changes."""
        with self._lock:
            if self.layout is None or n not in self._nav:
                return
            action, target = self._nav[n]
            if not on:
                back = self._held.pop(n, None) if action == "hold" else None
                if back is not None and self.tab == target:  # unless another input has moved on since
                    self._go(back)
            elif action == "next":
                self._go(self.tab + 1)
            elif action == "prev":
                self._go(self.tab - 1)
            elif action == "goto":
                self._go(target)
            elif action == "hold":
                if self.tab != target:
                    self._held[n] = self.tab
                self._go(target)

    def set_tab(self, index=None, step=0):
        with self._lock:
            if self.layout is not None:
                self._go(self.tab + int(step) if index is None else int(index))

    def set_power(self, on):
        self.powered = bool(on)
        self._save_settings()
        self._with_device(lambda d: d.show() if self.powered else d.hide())

    def set_contrast(self, value):
        """OLED contrast, or TFT backlight brightness."""
        if self.kind == "char":
            return  # set with the potentiometer on the I2C backpack
        self.contrast = max(0, min(int(value), 255))
        self._save_settings()
        self._with_device(lambda d: d.contrast(self.contrast))

    def set_backlight(self, on):
        if self.kind != "char":
            return
        self.backlight = bool(on)
        self._save_settings()
        self._with_device(lambda d: d.set_backlight(self.backlight))

    # --- device ----------------------------------------------------------

    def _with_device(self, fn):
        with self._lock:
            if self.device is None:
                return
            try:
                fn(self.device)
            except Exception as e:  # luma turns I2C errors into its own DeviceNotFoundError
                self._disconnect(e)

    def _disconnect(self, err):
        log.warning("Display %s mistet forbindelsen: %s", self.id, err)
        if hasattr(self.device, "close"):
            self.device.close()
        self.device = None
        self.error = str(err)
        self._next_connect = time.monotonic() + RECONNECT_SECONDS

    def _try_connect(self):
        if self.device is not None or time.monotonic() < self._next_connect:
            return
        try:
            cfg = {**self.cfg, "contrast": self.contrast, "backlight": self.backlight}
            self.device = _open_device(cfg)
            if not self.powered:
                self.device.hide()
            self.error = None
            log.info("Display %s tilkoblet (%s på %s)", self.id, self.cfg["driver"], self.where)
        except Exception as e:
            if self.error != str(e):
                log.warning("Display %s ikke tilgjengelig: %s – kjører emulert", self.id, e)
            self.error = str(e) or type(e).__name__
            self._next_connect = time.monotonic() + RECONNECT_SECONDS

    def _render(self, layout, tab=0):
        """Returns (what the device takes, a preview image)."""
        if layout is not None:
            layout, values = page(layout, tab)
            values = {**self.registry.snapshot(), **values}
        if self.kind == "char":
            if layout is None:
                frame = Frame(*self.size)
            else:
                frame, _, _ = render_char(layout, values, self.registry.history)
            return frame, frame.image()
        if layout is None:
            image = Image.new("RGB" if self.kind == "color" else "1", self.size, 0)
        else:
            image, _, _ = render(layout, values, self.registry.history)
        return image, image

    def _loop(self):
        while True:
            self._wake.clear()
            with self._lock:
                layout, tab = self.layout, self.tab
            output, self.last_image = self._render(layout, tab)
            refresh = max(0.1, float((layout or {}).get("refresh", 1.0) or 1.0))

            with self._lock:
                self._try_connect()
                if self.device is not None:
                    try:
                        self.device.display(output)
                    except Exception as e:  # as above; an uncaught one would end this thread
                        self._disconnect(e)
            # Sleep until the next refresh tick, or until a new deploy arrives.
            self._wake.wait(refresh - time.time() % refresh if refresh >= 1 else refresh)

    def status(self):
        c = self.cfg
        return {
            "id": self.id,
            "name": c["name"],
            "kind": self.kind,
            "driver": c["driver"],
            "where": self.where,
            "bus": c.get("bus"),
            "address": f"0x{int(c['address']):02X}" if "address" in c else None,
            "width": self.size[0],
            "height": self.size[1],
            "connected": self.device is not None,
            "error": self.error,
            "powered": self.powered,
            "contrast": self.contrast if self.kind != "char" else None,
            "backlight": self.backlight if self.kind == "char" else None,
            "layout_name": (self.layout or {}).get("name"),
            "deployed_at": self.deployed_at,
            "tab": self.tab,
            "tabs": tab_names(self.layout) if self.layout else [],
            "nav": sorted(self._nav),
        }
