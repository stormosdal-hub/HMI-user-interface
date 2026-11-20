"""The kjøreverk's tags from the hub (hmi-core/hub.js) as data sources.

The editor connects to the hub's WebSocket as a read-only HMI, like the recorder's
reader: hello with readonly, then subscribe "*". The hub answers with the tag list
(names, labels, units) and the values, and sends every change after that. Nothing
is ever written to the hub.

A value is missing ("--" on the display) while its quality is bad (the PLC link or
the adapter is gone) and while the hub doesn't answer, so a display never shows a
frozen value as if it were live.

Only the standard library: the Pi needs no WebSocket package.
"""

import base64
import hashlib
import json
import logging
import os
import socket
import struct
import threading
import time
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

NAME = "lcd-editor"  # the name in the hub's log
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # RFC 6455
RETRY_SECONDS = 3
SILENT_SECONDS = 40  # the hub pings every 15 s, so this long without a word means it's gone
MAX_MESSAGE = 16 * 1024 * 1024
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA

ALARM_GROUP = "Hub: alarmer"
ALARM_META = {
    "alarms_active": {"label": "Aktive alarmer", "unit": "", "type": "number", "group": ALARM_GROUP},
    "alarm_text": {"label": "Nyeste aktive alarm", "unit": "", "type": "string", "group": ALARM_GROUP},
}


class HubLink:
    def __init__(self, url):
        self.url = url
        self.connected = False
        self.error = None
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._meta = {}     # tag -> {"label", "unit", "type", "group"}, in the hub's order
        self._values = {}   # tag -> value, None while missing
        self._alarms = None  # the active alarms, newest first; None while the hub is gone
        self._thread = threading.Thread(target=self._run, daemon=True, name="hub")

    def start(self):
        self._thread.start()

    # --- what the registry reads ---------------------------------------------

    def values(self):
        with self._lock:
            out = dict(self._values)
            alarms = self._alarms
        if alarms is None:
            out["alarms_active"] = out["alarm_text"] = None
        else:
            out["alarms_active"] = len(alarms)
            out["alarm_text"] = str(alarms[0].get("text") or "") if alarms else ""
        return out

    def describe(self):
        """The tags for the editor's list of data sources, in the hub's order."""
        values = self.values()
        with self._lock:
            meta = list(self._meta.items())
        rows = [{"name": name, **m, "value": values.get(name)} for name, m in meta]
        if meta or self.connected:
            rows += [{"name": name, **m, "value": values[name]} for name, m in ALARM_META.items()]
        return rows

    def names(self):
        with self._lock:
            return set(self._meta) | set(ALARM_META)

    def status(self):
        with self._lock:
            tags = len(self._meta)
        return {"url": self.url, "connected": self.connected, "error": self.error, "tags": tags}

    # --- the connection ------------------------------------------------------

    def _run(self):
        while True:
            try:
                self._session()
                err = "huben lukket forbindelsen"
            except ConnectionRefusedError:
                err = "huben svarer ikke (kjører kjoreverk@hub?)"
            except socket.timeout:
                err = f"huben har ikke sagt noe på {SILENT_SECONDS} s" if self.connected else "huben svarer ikke (tidsavbrudd)"
            except (OSError, ValueError) as e:
                err = str(e) or type(e).__name__
            if self.connected or err != self.error:
                log.warning("Huben (%s): %s – prøver igjen hvert %d. sekund", self.url, err, RETRY_SECONDS)
            self._lost(err)
            time.sleep(RETRY_SECONDS)

    def _lost(self, err):
        with self._lock:
            self.connected = False
            self.error = err
            self._values = dict.fromkeys(self._values)
            self._alarms = None

    def _session(self):
        sock, rest = _handshake(self.url)
        try:
            sock.settimeout(SILENT_SECONDS)
            reader = _Reader(sock, rest)
            self._send(sock, OP_TEXT, json.dumps({"type": "hello", "role": "hmi", "name": NAME, "readonly": True}))
            self._send(sock, OP_TEXT, json.dumps({"type": "subscribe", "tags": ["*"]}))
            while True:
                op, data = reader.message()
                if op == OP_PING:
                    self._send(sock, OP_PONG, data)
                elif op == OP_CLOSE:
                    return
                elif op == OP_TEXT:
                    try:
                        msg = json.loads(data.decode("utf-8"))
                    except ValueError:
                        continue
                    if isinstance(msg, dict):
                        self._handle(msg)
        finally:
            sock.close()

    def _send(self, sock, op, payload):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        n = len(payload)
        if n < 126:
            head = struct.pack(">BB", 0x80 | op, 0x80 | n)
        elif n < 1 << 16:
            head = struct.pack(">BBH", 0x80 | op, 0x80 | 126, n)
        else:
            head = struct.pack(">BBQ", 0x80 | op, 0x80 | 127, n)
        mask = os.urandom(4)  # a client masks everything it sends
        body = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._send_lock:
            sock.sendall(head + mask + body)

    def _handle(self, msg):
        kind = msg.get("type")
        if kind == "welcome":
            with self._lock:
                self.connected = True
                self.error = None
            log.info("Huben (%s): tilkoblet", self.url)
        elif kind == "tags":
            self._set_tags(msg.get("tags") or [])
        elif kind == "update":
            if isinstance(msg.get("values"), dict):
                for name, value in msg["values"].items():
                    self._set_value(str(name), value, msg.get("quality"))
            elif msg.get("tag") is not None:
                self._set_value(str(msg["tag"]), msg.get("value"), msg.get("quality"))
        elif kind == "alarms":
            active = [a for a in msg.get("alarms") or [] if isinstance(a, dict) and a.get("active")]
            active.sort(key=lambda a: a.get("since") or 0, reverse=True)
            with self._lock:
                self._alarms = active

    def _set_tags(self, tags):
        """The tag list: sent on hello and every time it changes. Each one has its value too."""
        meta, values = {}, {}
        for t in tags:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            name = str(t["name"])
            meta[name] = {
                "label": str(t.get("label") or "") or name,
                "unit": str(t.get("unit") or ""),
                "type": str(t.get("dataType") or ""),
                "group": _group(name),
            }
            values[name] = _value(t.get("value"), t.get("quality"))
        with self._lock:
            self._meta = meta
            self._values = values

    def _set_value(self, name, value, quality):
        with self._lock:
            if name not in self._meta:  # the hub sends the new tag list right after
                self._meta[name] = {"label": name, "unit": "", "type": "", "group": _group(name)}
            self._values[name] = _value(value, quality)


def _group(name):
    prefix, dot, _ = name.partition(".")
    return f"Hub: {prefix}.*" if dot else "Hub"


def _value(value, quality):
    if quality == "bad":
        return None
    if isinstance(value, (bool, int, float, str)):
        return value
    return None  # nothing yet, or something a display can't show


def _handshake(url):
    """Opens the WebSocket. Returns the socket and what came after the HTTP answer."""
    u = urlsplit(url)
    if u.scheme not in ("ws", "http"):
        raise ValueError(f"{url}: huben må være en ws://-adresse")
    host, port = u.hostname or "127.0.0.1", u.port or 80
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    sock = socket.create_connection((host, port), timeout=5)
    try:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                      f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
                     .encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise OSError("huben lukket forbindelsen før den svarte")
            buf += chunk
            if len(buf) > 65536:
                raise OSError("huben svarte ikke som en WebSocket")
        head, rest = buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0].split()
        if len(status) < 2 or status[1] != "101":
            raise OSError(f"{host}:{port} svarte «{lines[0]}», ikke som huben")
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:])}
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")
        if headers.get("sec-websocket-accept") != accept:
            raise OSError(f"{host}:{port} svarte ikke som en WebSocket")
        return sock, rest
    except BaseException:
        sock.close()
        raise


class _Reader:
    """Reads whole messages from the socket: joins fragments and unmasks."""

    def __init__(self, sock, rest=b""):
        self.sock = sock
        self.buf = bytearray(rest)

    def _exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError("huben lukket forbindelsen")
            self.buf += chunk
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def _frame(self):
        b0, b1 = self._exact(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._exact(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._exact(8))[0]
        if n > MAX_MESSAGE:
            raise OSError(f"for stor melding fra huben ({n} byte)")
        mask = self._exact(4) if b1 & 0x80 else None
        data = self._exact(n)
        if mask:
            data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        return bool(b0 & 0x80), b0 & 0x0F, data

    def message(self):
        """(opcode, payload) of the next whole message; control frames come as they are."""
        parts, first = [], None
        while True:
            fin, op, data = self._frame()
            if op >= OP_CLOSE:  # control frames may come between the fragments of a message
                return op, data
            if first is None:
                if op == OP_CONT:
                    raise OSError("WebSocket: en fortsettelse uten begynnelse")
                first = op
            parts.append(data)
            if sum(map(len, parts)) > MAX_MESSAGE:
                raise OSError("for stor melding fra huben")
            if fin:
                return first, b"".join(parts)
