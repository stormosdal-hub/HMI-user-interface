"""
hub_adapter.py - HMI-hub-adapter for MicroPython (Raspberry Pi Pico W og Pico 2 W).

Kobler kortet til huben over Wi-Fi med WebSocket og JSON, uten andre biblioteker. Kopier
filen til kortet (Thonny eller mpremote) ved siden av main.py.

    from hub_adapter import HubAdapter

    hub = HubAdapter('192.168.1.10', 8080, 'pico_1')     # navnet blir tagprefikset
    hub.add_tag('temp', 'number', unit='°C')              # -> taggen pico_1.temp
    hub.add_tag('led', 'boolean', writable=True, on_write=set_led)

    while True:
        hub.poll()                 # ofte: kobler til, leser skrivinger, svarer på ping
        hub.set('temp', read_temp())
        time.sleep_ms(50)

Ingen tråder: alt skjer i poll(), som returnerer med en gang når det ikke er noe å gjøre. Faller
forbindelsen ut, prøver poll() igjen hvert RECONNECT_MS. Samme API som Python-adapteren på en PC
(add_tag, set, set_many, event), så kode kan flyttes mellom dem.

Filen kjører også med vanlig Python på en PC, for å teste uten kortet.
"""
import json
import socket
import struct

try:
    import ubinascii as binascii
except ImportError:
    import binascii
try:
    import uos as os
except ImportError:
    import os
try:
    import uselect as select
except ImportError:
    import select
try:
    from time import ticks_ms, ticks_diff, ticks_add
except ImportError:                      # vanlig Python
    import time as _t

    def ticks_ms():
        return int(_t.monotonic() * 1000)

    def ticks_diff(a, b):
        return a - b

    def ticks_add(a, b):
        return a + b

RECONNECT_MS = 3000        # tid mellom tilkoblingsforsøk
DEAD_MS = 40000            # huben pinger hvert 15. s: helt stille så lenge betyr at forbindelsen er død


class HubAdapter:
    def __init__(self, host, port=8080, name='pico_1', log=print):
        self.host, self.port, self.name = host, port, name
        self.log = log or (lambda *a: None)
        self.tags = {}               # nøkkel -> [definisjon, on_write, verdi]
        self.sock = None
        self.connected = False
        self._next_try = ticks_ms()
        self._last_rx = 0
        self._buf = b''
        self._poller = None

    # ------------------------------------------------------------ for programmet ditt
    def add_tag(self, key, data_type='number', unit='', writable=False, on_write=None, alarm=None, value=None):
        """data_type: 'number', 'boolean' eller 'string'.
        on_write(value): kalles når HMI-en skriver taggen; returner verdien som ble satt (eller None
        for "som bedt om"), eller kast en exception for å avvise skrivingen.
        alarm: f.eks. {'severity': 'alarm', 'text': 'Temperature above limit'}."""
        d = {'name': self.name + '.' + key, 'dataType': data_type, 'unit': unit, 'writable': writable}
        if alarm:
            d['alarm'] = alarm
        self.tags[key] = [d, on_write, value]
        if self.connected:
            self._register([key])

    def set(self, key, value):
        """Ny verdi for en tag; sendes bare når den er endret."""
        self.set_many({key: value})

    def set_many(self, values):
        out = {}
        for key, value in values.items():
            t = self.tags[key]
            if t[2] != value or type(t[2]) is not type(value):
                t[2] = value
                out[self.name + '.' + key] = value
        if out:
            self._send({'type': 'update', 'values': out})

    def get(self, key):
        return self.tags[key][2]

    def event(self, message, severity='info'):
        """En linje i HMI-ens hendelseslogg: 'info', 'warning' eller 'alarm'."""
        self._send({'type': 'event', 'severity': severity, 'message': message})

    def poll(self):
        """Kall ofte fra hovedløkken. Kobler til når det er tid, og behandler alt som har kommet."""
        if not self.connected:
            if ticks_diff(ticks_ms(), self._next_try) >= 0:
                self._connect()
            return
        try:
            while self._readable():
                self._read_frame()
            if ticks_diff(ticks_ms(), self._last_rx) > DEAD_MS:
                raise OSError('no ping from the hub for %d s' % (DEAD_MS // 1000))
        except Exception as e:
            self._drop(e)

    # ------------------------------------------------------------ protokollen
    def _register(self, keys=None):
        tags = []
        for key, t in self.tags.items():
            if keys is None or key in keys:
                d = dict(t[0])
                if t[2] is not None:
                    d['value'] = t[2]
                tags.append(d)
        self._send({'type': 'register', 'tags': tags})

    def _on_message(self, msg):
        kind = msg.get('type')
        if kind == 'write':
            tag = msg.get('tag', '')
            key = tag[len(self.name) + 1:] if tag.startswith(self.name + '.') else None
            t = self.tags.get(key)
            if t is None or not t[0]['writable']:
                self.event('Write to %s refused: not a writable tag' % tag)
                return
            value = msg.get('value')
            if t[1]:
                try:
                    r = t[1](value)
                    if r is not None:
                        value = r
                except Exception as e:      # avvist: ekko den gamle verdien, så kontrollen hopper tilbake
                    self.event('Write to %s refused: %s' % (tag, e))
                    value = t[2]
            t[2] = value
            self._send({'type': 'update', 'tag': tag, 'value': value})     # ekkoet
        elif kind == 'error':
            self.log('hub says:', msg.get('message'))

    # ------------------------------------------------------------ forbindelsen
    def _connect(self):
        self._next_try = ticks_add(ticks_ms(), RECONNECT_MS)
        try:
            addr = socket.getaddrinfo(self.host, self.port, socket.AF_INET)[0][-1]   # IPv4, som socket()
            s = socket.socket()
            s.settimeout(5)
            s.connect(addr)
            key = binascii.b2a_base64(os.urandom(16)).strip().decode()
            req = ('GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                   'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n') % (self.host, self.port, key)
            self.sock = s
            self._write(req.encode())
            head = b''
            while b'\r\n\r\n' not in head:
                chunk = s.recv(256)
                if not chunk:
                    raise OSError('closed during the handshake')
                head += chunk
                if len(head) > 4096:
                    raise OSError('no WebSocket answer')
            head, self._buf = head.split(b'\r\n\r\n', 1)
            if b' 101 ' not in head.split(b'\r\n')[0] + b' ':
                raise OSError('the hub answered ' + head.split(b'\r\n')[0].decode())
            if hasattr(select, 'poll'):
                self._poller = select.poll()
                self._poller.register(s, select.POLLIN)
            self.connected = True
            self._last_rx = ticks_ms()
            self._send({'type': 'hello', 'role': 'adapter', 'name': self.name})
            self._register()
            self.log('connected to the hub as', self.name)
        except Exception as e:
            self._drop(e)

    def _drop(self, why):
        if self.connected:
            self.log('disconnected from the hub:', why)
        else:
            self.log('hub %s:%d not reached:' % (self.host, self.port), why)
        self.connected = False
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None
        self._buf = b''
        self._poller = None
        self._next_try = ticks_add(ticks_ms(), RECONNECT_MS)

    def _readable(self):
        if self._buf:
            return True
        if self._poller:
            ev = self._poller.poll(0)
            if ev and ev[0][1] & (getattr(select, 'POLLHUP', 0) | getattr(select, 'POLLERR', 0)):
                raise OSError('connection lost')
            return bool(ev)
        return bool(select.select([self.sock], [], [], 0)[0])      # vanlig Python på Windows

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(max(n - len(self._buf), 512))
            if not chunk:
                raise OSError('the hub closed the connection')
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _read_frame(self):
        b0, b1 = self._recv_exact(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack('>H', self._recv_exact(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', self._recv_exact(8))[0]
        if b1 & 0x80:
            self._recv_exact(4)          # huben maskerer ikke det den sender
        data = self._recv_exact(n) if n else b''
        self._last_rx = ticks_ms()
        op = b0 & 0x0F
        if op == 0x9:                    # ping -> pong med samme innhold
            self._send_frame(0xA, data)
        elif op == 0x8:
            raise OSError('the hub closed the connection')
        elif op == 0x1 and b0 & 0x80:    # en hel tekstmelding (huben deler dem ikke opp)
            try:
                msg = json.loads(data.decode())
            except ValueError:
                return
            if isinstance(msg, dict):
                self._on_message(msg)

    def _send(self, obj):
        if self.connected:
            try:
                self._send_frame(0x1, json.dumps(obj).encode())
            except Exception as e:
                self._drop(e)

    def _send_frame(self, op, data):
        # klienter må maskere det de sender (RFC 6455)
        n = len(data)
        if n < 126:
            head = struct.pack('>BB', 0x80 | op, 0x80 | n)
        elif n < 65536:
            head = struct.pack('>BBH', 0x80 | op, 0x80 | 126, n)
        else:
            head = struct.pack('>BBQ', 0x80 | op, 0x80 | 127, n)
        mask = os.urandom(4)
        body = bytearray(data)
        for i in range(n):
            body[i] ^= mask[i & 3]
        self._write(head + mask + body)

    def _write(self, b):
        mv = memoryview(b)
        while mv:
            k = self.sock.send(mv)
            if k is None:                # noen MicroPython-porter: ikke klar ennå
                continue
            mv = mv[k:]
