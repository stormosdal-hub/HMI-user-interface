"""
hub_adapter.py - kobler et Python-program til HMI-huben som en adapter.

Ingen pakker trengs: bare Python 3.7 eller nyere, så den virker også på maskiner uten
internett. Kopier filen ved siden av programmet ditt og importer den:

    from hub_adapter import HubAdapter

    hub = HubAdapter('ws://192.168.1.10:8080', 'py_1')         # navnet blir tagprefikset
    hub.add_tag('temp', 'number', unit='°C')                    # -> taggen py_1.temp
    hub.add_tag('pump', 'boolean', writable=True, on_write=set_pump)
    hub.start()                                                 # kobler til i bakgrunnen

    hub.set('temp', 21.5)              # fra programmet ditt, så ofte du vil
    hub.event('Pump started')          # en linje i HMI-ens hendelseslogg

Adapteren gjør resten selv:
  - kobler til huben, sier hello og registrerer taggene (med verdiene de har nå);
  - sender en verdi bare når den er endret;
  - kaller on_write når HMI-en skriver til en skrivbar tag, og sender verdien som faktisk
    ble satt tilbake (ekkoet), så alle HMI-er viser den;
  - svarer på hubens ping, og kobler til igjen av seg selv når forbindelsen faller ut.

All nettverkstrafikk går i en egen tråd. set(), set_many() og event() kan kalles fra hvilken
som helst tråd; on_write kalles i adapterens tråd, så hold den kort.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import threading
import time
from urllib.parse import urlparse

__all__ = ['HubAdapter']

DATA_TYPES = ('number', 'boolean', 'string')


class HubAdapter:
    def __init__(self, url='ws://localhost:8080', name='py_1', reconnect_s=2.0, log=print):
        """url: huben, f.eks. ws://192.168.1.10:8080. name: adapterens navn og tagprefiks,
        unikt på huben (bokstaver, sifre og _). log: en funksjon for meldinger, eller None."""
        u = urlparse(url if '://' in url else 'ws://' + url)
        if u.scheme != 'ws':
            raise ValueError('only ws:// is supported (the hub has no TLS)')
        self.host, self.port, self.path = u.hostname or 'localhost', u.port or 8080, u.path or '/'
        self.url, self.name = url, name
        self.reconnect_s = reconnect_s
        self._log = log or (lambda *a: None)
        self._tags = {}            # nøkkel -> {'def': registreringen, 'on_write': ..., 'value': ..., 'quality': ...}
        self._lock = threading.RLock()
        self._sock = None
        self._running = False
        self._thread = None
        self.connected = False

    # ------------------------------------------------------------ for programmet ditt
    def add_tag(self, key, data_type='number', unit='', writable=False, description='',
                on_write=None, alarm=None, value=None):
        """Legg til taggen <name>.<key>. Kall før start(), eller senere (den registreres da med en gang).
        data_type: 'number', 'boolean' eller 'string'.
        on_write(value): kalles når HMI-en skriver taggen. Returner verdien som faktisk ble satt
          (eller None for "som bedt om"); kast en exception for å avvise skrivingen.
        alarm: f.eks. {'severity': 'alarm', 'text': 'Level above 95 %'}: huben viser alarmen så
          lenge verdien er true (eller ulik 0); se README.md for 'when', 'delay' og 'codes'."""
        if data_type not in DATA_TYPES:
            raise ValueError('data_type must be one of %s' % (DATA_TYPES,))
        d = {'name': self._full(key), 'dataType': data_type, 'unit': unit, 'writable': bool(writable)}
        if description:
            d['description'] = description
        if alarm:
            d['alarm'] = alarm
        with self._lock:
            self._tags[key] = {'def': d, 'on_write': on_write, 'value': value, 'quality': 'good'}
            if self.connected:
                self._register([key])

    def set(self, key, value, quality='good'):
        """Ny verdi for en tag. Sendes bare hvis den (eller kvaliteten) er endret.
        quality: 'good', eller 'bad' når programmet vet at verdien ikke stemmer (f.eks. en
        sensor som har falt ut); HMI-en viser den da som foreldet (stale)."""
        self.set_many({key: value}, quality)

    def set_many(self, values, quality='good'):
        """Flere verdier samtidig, i én melding: {'temp': 21.5, 'pump': True}."""
        out = {}
        with self._lock:
            for key, value in values.items():
                t = self._tags.get(key)
                if t is None:
                    raise KeyError('unknown tag %r: add_tag() it first' % key)
                if t['value'] != value or t['quality'] != quality or type(t['value']) is not type(value):
                    t['value'], t['quality'] = value, quality
                    out[self._full(key)] = value
            if out and self.connected:
                msg = {'type': 'update', 'values': out}
                if quality != 'good':
                    msg['quality'] = quality
                self._send_json(msg)

    def get(self, key):
        """Verdien en tag har nå (det programmet sist satte, eller det HMI-en sist skrev)."""
        with self._lock:
            return self._tags[key]['value']

    def event(self, message, severity='info'):
        """En linje i HMI-ens hendelseslogg. severity: 'info', 'warning' eller 'alarm'.
        En advarsel eller alarm blir stående i alarmlisten til noen kvitterer for den."""
        with self._lock:
            if self.connected:
                self._send_json({'type': 'event', 'severity': severity, 'message': str(message)})

    def start(self):
        """Kobler til huben i en bakgrunnstråd, og holder forbindelsen oppe til stop()."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, name='hub-adapter', daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        self._close()
        if self._thread:
            self._thread.join(timeout=3)

    # ------------------------------------------------------------ protokollen
    def _full(self, key):
        return '%s.%s' % (self.name, key)

    def _register(self, keys=None):
        with self._lock:
            tags = []
            for key, t in self._tags.items():
                if keys is not None and key not in keys:
                    continue
                d = dict(t['def'])
                if t['value'] is not None:
                    d['value'] = t['value']     # så HMI-en har verdien med en gang
                tags.append(d)
            if tags:
                self._send_json({'type': 'register', 'tags': tags})

    def _on_message(self, msg):
        kind = msg.get('type')
        if kind == 'write':
            self._on_write(str(msg.get('tag', '')), msg.get('value'), msg.get('from', ''))
        elif kind == 'welcome':
            self._log('hub: connected as %s' % msg.get('name'))
        elif kind == 'error':
            self._log('hub says: %s' % msg.get('message'))

    def _on_write(self, tag, value, who):
        key = tag[len(self.name) + 1:] if tag.startswith(self.name + '.') else None
        with self._lock:
            t = self._tags.get(key)
        if t is None or not t['def']['writable']:
            self.event('Write to %s refused: not a writable tag' % tag)
            return
        applied = value
        if t['on_write']:
            try:
                r = t['on_write'](value)
                if r is not None:
                    applied = r
            except Exception as e:          # avvist: ekkoet er den gamle verdien, så kontrollen hopper tilbake
                self._log('write %s = %r refused: %s' % (tag, value, e))
                self.event('Write to %s refused: %s' % (tag, e))
                applied = t['value']
        with self._lock:
            t['value'] = applied
            self._send_json({'type': 'update', 'tag': tag, 'value': applied})   # ekkoet
        self._log('write from %s: %s = %r' % (who or 'HMI', key, applied))

    # ------------------------------------------------------------ forbindelsen
    def _run(self):
        wait = self.reconnect_s
        while self._running:
            try:
                self._connect()
                wait = self.reconnect_s
                self._read_loop()
            except Exception as e:
                if self._running:
                    self._log('hub %s: %s; trying again in %.0f s' % (self.url, e, wait))
            self._close()
            # vent litt før neste forsøk, lenger for hvert forsøk som feiler (høyst 30 s)
            end = time.time() + wait
            while self._running and time.time() < end:
                time.sleep(0.2)
            wait = min(wait * 2, 30.0)

    def _connect(self):
        sock = socket.create_connection((self.host, self.port), timeout=5)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n'
                      % (self.path, self.host, self.port, key)).encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = sock.recv(1024)
            if not chunk:
                raise ConnectionError('the hub closed the connection during the handshake')
            head += chunk
            if len(head) > 8192:
                raise ConnectionError('no WebSocket answer (is this the hub?)')
        head, rest = head.split(b'\r\n\r\n', 1)
        lines = head.decode('latin-1').split('\r\n')
        if ' 101 ' not in lines[0] + ' ':
            raise ConnectionError('the hub answered %s' % lines[0])
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if not any(l.lower().startswith('sec-websocket-accept:') and l.split(':', 1)[1].strip() == accept for l in lines):
            raise ConnectionError('wrong WebSocket answer')
        sock.settimeout(1.0)
        self._buf = rest
        with self._lock:
            self._sock = sock
            self.connected = True
            self._send_json({'type': 'hello', 'role': 'adapter', 'name': self.name})
            self._register()
        self._log('connected to %s as %s' % (self.url, self.name))

    def _read_loop(self):
        last = time.time()
        text = b''
        while self._running:
            try:
                fin, op, data = self._recv_frame()
            except socket.timeout:
                # huben pinger hvert 15. s: er det helt stille i 40 s, er forbindelsen død
                if time.time() - last > 40:
                    raise ConnectionError('no ping from the hub for 40 s')
                continue
            last = time.time()
            if op == 0x9:                               # ping -> pong med samme innhold
                with self._lock:
                    self._send_frame(0xA, data)
            elif op == 0x8:
                raise ConnectionError('the hub closed the connection')
            elif op in (0x1, 0x0):                      # tekst, eventuelt i flere deler
                text += data
                if fin:
                    try:
                        msg = json.loads(text.decode('utf-8'))
                    except ValueError:
                        msg = None
                    text = b''
                    if isinstance(msg, dict):
                        self._on_message(msg)

    def _recv_exact(self, n, first=False):
        # first: venter på starten av en ramme (timeout er greit); ellers: resten av rammen
        while len(self._buf) < n:
            try:
                chunk = self._sock.recv(65536)
            except socket.timeout:
                if first and not self._buf:
                    raise
                continue
            if not chunk:
                raise ConnectionError('the hub closed the connection')
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _recv_frame(self):
        b0, b1 = self._recv_exact(2, first=True)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack('>H', self._recv_exact(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', self._recv_exact(8))[0]
        mask = self._recv_exact(4) if b1 & 0x80 else None
        data = self._recv_exact(n) if n else b''
        if mask:
            data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
        return bool(b0 & 0x80), b0 & 0x0F, data

    def _send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj, separators=(',', ':')).encode('utf-8'))

    def _send_frame(self, op, data):
        # klienter må maskere alt de sender (RFC 6455); kalles med låsen holdt
        if not self._sock:
            return
        n = len(data)
        head = bytes([0x80 | op])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        body = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
        try:
            self._sock.sendall(head + mask + body)
        except OSError:
            self._close()

    def _close(self):
        with self._lock:
            s, self._sock = self._sock, None
            was = self.connected
            self.connected = False
        if s:
            try:
                s.close()
            except OSError:
                pass
        if was:
            self._log('disconnected from the hub')
