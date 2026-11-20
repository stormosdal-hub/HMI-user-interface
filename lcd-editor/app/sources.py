"""Data sources: the hub's tags, built-in system values, the board's inputs, configured sources,
plugins and pushed values.

All providers are polled in the background, and the hub's tags come as they change
(hub.py); the renderer only reads snapshots, so a slow command or HTTP call never
blocks the display.
"""

import glob
import importlib.util
import json
import logging
import os
import re
import socket
import subprocess
import threading
import time
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

try:
    import psutil
except ImportError:  # sudo apt install python3-psutil; the hub's tags work without it
    psutil = None

from .hub import HubLink

log = logging.getLogger(__name__)

HISTORY_LEN = 3600  # one sample per second -> one hour of history for graphs

WEEKDAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]
MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli",
          "august", "september", "oktober", "november", "desember"]

CLOCK_META = {
    "time": {"label": "Klokke (TT:MM)", "group": "Tid"},
    "time_s": {"label": "Klokke (TT:MM:SS)", "group": "Tid"},
    "date": {"label": "Dato (DD.MM.ÅÅÅÅ)", "group": "Tid"},
    "date_long": {"label": "Dato (10. november)", "group": "Tid"},
    "weekday": {"label": "Ukedag", "group": "Tid"},
    "weekday_short": {"label": "Ukedag (kort)", "group": "Tid"},
}


def clock_values(now=None):
    now = now or datetime.now()
    wd = WEEKDAYS[now.weekday()]
    return {
        "time": now.strftime("%H:%M"),
        "time_s": now.strftime("%H:%M:%S"),
        "date": now.strftime("%d.%m.%Y"),
        "date_long": f"{now.day}. {MONTHS[now.month - 1]}",
        "weekday": wd,
        "weekday_short": wd[:3],
    }


def to_number(value):
    """Return value as int/float if it looks numeric, else the stripped string."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value).strip()
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return text


def extract(raw, cfg):
    """Apply json/regex/scale/offset options from a source config to raw text."""
    value = raw
    if cfg.get("json"):
        value = json.loads(value) if isinstance(value, (str, bytes)) else value
        for part in str(cfg["json"]).split("."):
            value = value[int(part)] if isinstance(value, list) else value[part]
    if cfg.get("regex"):
        m = re.search(cfg["regex"], str(value))
        if not m:
            raise ValueError(f"regex fant ingen treff i {str(value)[:40]!r}")
        value = m.group(1) if m.groups() else m.group(0)
    value = to_number(value)
    if isinstance(value, (int, float)):
        scale, offset = cfg.get("scale", 1), cfg.get("offset", 0)
        if scale != 1 or offset != 0:
            value = value * scale + offset
    return value


class Provider:
    """Something that produces a dict of values every `interval` seconds."""

    interval = 5.0

    def __init__(self):
        self.next_due = 0.0
        self.running = False
        self.error = None

    def meta(self):
        """name -> {label, unit, group}"""
        return {}

    def poll(self):
        raise NotImplementedError


class SystemProvider(Provider):
    interval = 1.0

    def __init__(self):
        super().__init__()
        self._net = None
        psutil.cpu_percent(interval=None)  # first call primes the counter

    def meta(self):
        g = "System"
        m = {
            "hostname": {"label": "Vertsnavn"},
            "ip": {"label": "IP-adresse"},
            "cpu_temp": {"label": "CPU-temperatur", "unit": "°C"},
            "cpu_percent": {"label": "CPU-bruk", "unit": "%"},
            "cpu_freq": {"label": "CPU-frekvens", "unit": "MHz"},
            "load1": {"label": "Last (1 min)"},
            "mem_percent": {"label": "Minnebruk", "unit": "%"},
            "mem_used": {"label": "Minne brukt", "unit": "MB"},
            "mem_total": {"label": "Minne totalt", "unit": "MB"},
            "disk_percent": {"label": "Disk brukt", "unit": "%"},
            "disk_free": {"label": "Disk ledig", "unit": "GB"},
            "uptime": {"label": "Oppetid"},
            "net_rx": {"label": "Nett inn", "unit": "kB/s"},
            "net_tx": {"label": "Nett ut", "unit": "kB/s"},
        }
        if self._fan_path():
            m["fan_rpm"] = {"label": "Vifte", "unit": "rpm"}
        for v in m.values():
            v["group"] = g
        return m

    @staticmethod
    def _fan_path():
        paths = glob.glob("/sys/devices/platform/cooling_fan/hwmon/*/fan1_input")
        return paths[0] if paths else None

    @staticmethod
    def _ip():
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("10.255.255.255", 1))  # no packet is sent
                return s.getsockname()[0]
        except OSError:
            pass
        # No default route (e.g. an isolated LAN): use the first address on an active interface.
        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            if name == "lo" or not (name in stats and stats[name].isup):
                continue
            for a in addrs:
                if a.family == socket.AF_INET and not a.address.startswith("127."):
                    return a.address
        return "ingen nett"

    @staticmethod
    def _uptime():
        secs = int(time.time() - psutil.boot_time())
        d, rem = divmod(secs, 86400)
        h, rem = divmod(rem, 3600)
        m = rem // 60
        return f"{d}d {h}t {m}m" if d else f"{h}t {m}m"

    def poll(self):
        v = {"hostname": socket.gethostname(), "ip": self._ip(), "uptime": self._uptime()}
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                v["cpu_temp"] = round(int(f.read()) / 1000, 1)
        except OSError:
            pass
        v["cpu_percent"] = psutil.cpu_percent(interval=None)
        freq = psutil.cpu_freq()
        if freq:
            v["cpu_freq"] = round(freq.current)
        v["load1"] = round(os.getloadavg()[0], 2)
        mem = psutil.virtual_memory()
        v["mem_percent"] = mem.percent
        v["mem_used"] = round((mem.total - mem.available) / 2**20)
        v["mem_total"] = round(mem.total / 2**20)
        disk = psutil.disk_usage("/")
        v["disk_percent"] = disk.percent
        v["disk_free"] = round(disk.free / 2**30, 1)

        now, net = time.monotonic(), psutil.net_io_counters()
        if self._net:
            t0, n0 = self._net
            dt = max(now - t0, 1e-3)
            v["net_rx"] = round((net.bytes_recv - n0.bytes_recv) / 1024 / dt, 1)
            v["net_tx"] = round((net.bytes_sent - n0.bytes_sent) / 1024 / dt, 1)
        self._net = (now, net)

        fan = self._fan_path()
        if fan:
            with open(fan) as f:
                v["fan_rpm"] = int(f.read())
        return v


class ConfigProvider(Provider):
    """A [[source]] entry from config.toml (command, file or http)."""

    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.name = cfg["name"]
        self.type = cfg.get("type", "command")
        self.interval = float(cfg.get("interval", 5))
        if self.type not in ("command", "file", "http"):
            raise ValueError(f"ukjent kildetype {self.type!r}")

    def meta(self):
        return {self.name: {
            "label": self.cfg.get("label", self.name),
            "unit": self.cfg.get("unit", ""),
            "group": "Egne kilder",
        }}

    def poll(self):
        cfg = self.cfg
        timeout = float(cfg.get("timeout", 5))
        if self.type == "command":
            out = subprocess.run(cfg["command"], shell=True, capture_output=True,
                                 text=True, timeout=timeout)
            if out.returncode != 0 and not out.stdout.strip():
                raise RuntimeError(out.stderr.strip() or f"exit {out.returncode}")
            raw = out.stdout.strip()
        elif self.type == "file":
            matches = sorted(glob.glob(cfg["path"]))
            if not matches:
                raise FileNotFoundError(cfg["path"])
            with open(matches[0]) as f:
                raw = f.read().strip()
        else:
            with urllib.request.urlopen(cfg["url"], timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        return {self.name: extract(raw, cfg)}


class PluginProvider(Provider):
    """A Python file in plugins/ exposing read() -> dict (and optionally INTERVAL, SOURCES)."""

    def __init__(self, path):
        super().__init__()
        self.name = path.stem
        spec = importlib.util.spec_from_file_location(f"oled_plugin_{path.stem}", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        if not callable(getattr(self.module, "read", None)):
            raise ValueError("plugin mangler funksjonen read()")
        self.interval = float(getattr(self.module, "INTERVAL", 5))
        setup = getattr(self.module, "setup", None)
        if callable(setup):
            setup()

    def meta(self):
        meta = {}
        for name, info in getattr(self.module, "SOURCES", {}).items():
            meta[name] = {"label": name, "unit": "", **info, "group": f"Plugin: {self.name}"}
        return meta

    def poll(self):
        values = self.module.read() or {}
        return {k: to_number(v) if isinstance(v, str) else v for k, v in values.items()}


class SourceRegistry:
    def __init__(self, source_configs, plugin_dir, hub_url=None):
        self._lock = threading.Lock()
        self._values = {}
        self._history = {}
        self._pushed_meta = {}
        self._providers = []
        self._extra = []  # (values(), meta) read when asked for: the inputs, and each display's tab
        self._load_errors = []
        self.hub = HubLink(hub_url) if hub_url else None

        if psutil:
            self._providers.append(SystemProvider())
        else:
            self._load_errors.append("psutil mangler, så systemverdiene (CPU, minne, IP …) vises ikke: "
                                     "sudo apt install python3-psutil")

        for cfg in source_configs:
            try:
                self._providers.append(ConfigProvider(cfg))
            except (KeyError, ValueError) as e:
                self._load_errors.append(f"[[source]] {cfg.get('name', '?')}: {e}")
        for path in sorted(plugin_dir.glob("*.py")):
            if path.name.startswith("_"):
                continue
            try:
                self._providers.append(PluginProvider(path))
            except Exception as e:  # plugin code is user-supplied; never crash the server
                self._load_errors.append(f"plugin {path.name}: {e}")
        for err in self._load_errors:
            log.warning("Datakilde ikke lastet: %s", err)

        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="source")
        self._thread = threading.Thread(target=self._loop, daemon=True, name="sources")

    def start(self):
        if self.hub:
            self.hub.start()
        self._thread.start()

    def _run(self, provider):
        try:
            values = provider.poll()
            provider.error = None
            with self._lock:
                self._values.update(values)
        except Exception as e:
            provider.error = str(e) or type(e).__name__
            log.debug("Kilde %s feilet: %s", type(provider).__name__, e)
        finally:
            provider.running = False

    def _loop(self):
        while True:
            now = time.monotonic()
            for p in self._providers:
                if not p.running and now >= p.next_due:
                    p.running = True
                    p.next_due = now + p.interval
                    self._pool.submit(self._run, p)
            values = self._live()
            with self._lock:
                for name, value in values.items():
                    if isinstance(value, bool):
                        value = int(value)  # a bit graphs as 0 and 1
                    if isinstance(value, (int, float)):
                        self._history.setdefault(name, deque(maxlen=HISTORY_LEN)).append(value)
            time.sleep(1.0 - (time.monotonic() - now) % 1.0)

    def add_live(self, values, meta):
        """Sources that are read when asked for: values() -> {name: value}, meta: name -> {label, unit, group}."""
        self._extra.append((values, meta))

    def push(self, name, value):
        with self._lock:
            self._values[name] = to_number(value) if isinstance(value, str) else value
            self._pushed_meta.setdefault(name, {"label": name, "unit": "", "group": "Pushet via API"})

    def _live(self):
        with self._lock:
            values = dict(self._values)
        if self.hub:
            values.update(self.hub.values())
        for fn, _ in self._extra:
            values.update(fn())
        return values

    def snapshot(self):
        values = self._live()
        values.update(clock_values())
        return values

    def history(self, name):
        with self._lock:
            return list(self._history.get(name, ()))

    def describe(self):
        """List of all sources with metadata and current value, for the editor."""
        values = self.snapshot()
        out = []
        if self.hub:  # first: on the kjøreverk, these are what a display is for
            err = None if self.hub.connected else self.hub.error
            out += [{**row, "error": err} for row in self.hub.describe()]
        for name, meta in CLOCK_META.items():
            out.append({"name": name, "unit": "", **meta, "value": values.get(name)})
        for _, meta in self._extra:
            out += [{"name": name, "unit": "", **m, "value": values.get(name)} for name, m in meta.items()]
        for p in self._providers:
            err = p.error
            for name, meta in p.meta().items():
                out.append({"name": name, "unit": "", **meta, "value": values.get(name), "error": err})
        with self._lock:
            pushed = dict(self._pushed_meta)
        known = {s["name"] for s in out}
        if self.hub:
            known |= self.hub.names()
        for name, meta in pushed.items():
            if name not in known:
                out.append({"name": name, **meta, "value": values.get(name)})
        # plugin values not declared in SOURCES still deserve to be visible
        for name in values:
            if name not in known and name not in pushed:
                out.append({"name": name, "label": name, "unit": "", "group": "Annet", "value": values[name]})
        return out

    @property
    def load_errors(self):
        return list(self._load_errors)
