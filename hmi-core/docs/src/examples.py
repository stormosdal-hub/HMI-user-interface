"""example-adapters.svg og adapter-messages.svg - eksempeladapterne og hvordan de snakker med huben.

Skriver begge til adapters/example-adapters/, ved siden av adapterne de beskriver.
"""
import os
from svgkit import *
HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, '..', '..', 'adapters', 'example-adapters')


# ================================================================ 1. oversikten
W = 1600
s = Svg(W, 1000, 'Eksempeladaptere: ESP32, Pico W, Python og Node.js koblet til huben')
s.add(s.text(48, 62, 'Eksempeladaptere: slik kobles de til huben', 30, INK, 600))
s.add(s.text(48, 92, 'Alle fire snakker hubens JSON-protokoll over WebSocket, som binary-adapter.js gjør. Hver adapter har sitt eget tagprefiks.', 15, INK2))
s.legend(48, 128, [(AMBER, 'verdier og hendelser', False), (BLUE, 'skrivinger fra HMI-en', False),
                   (CYAN, 'prosjekt og filer', False), (INK3, 'inne i enheten eller programmet', True)])

LX, LW = 48, 600          # enheter og programmer
HX, HW = 790, 340         # huben
BX, BW = 1250, 302        # HMI-en
TOP = 196
for x, label in [(LX, 'Enheter og programmer på nettverket'), (HX, 'Pi-en'), (BX, 'Nettlesere')]:
    s.add(s.text(x, TOP - 14, label, 15, INK3, 600))


def machine(y, title, sub, left, right, calls=('set()', 'on_write()')):
    """En enhet eller datamaskin: programmet til venstre, adapterdelen til høyre. Returnerer
    (høyde, y midt på adapterdelen)."""
    pad, gap = 16, 100
    iw = (LW - 2 * pad - gap) / 2
    y0 = y + 62
    lh = s.box(LX + pad, y0, iw, left[0], left[1], accent=INK3, fill=PANEL2, title_size=13.5, body_size=12.5, mono_title=left[2])
    rh = s.box(LX + pad + iw + gap, y0, iw, right[0], right[1], accent=AMBER, fill=PANEL2, title_size=13.5, body_size=12.5, mono_title=right[2])
    ih = max(lh, rh)
    h = 62 + ih + pad
    s.parts.insert(len(s.parts) - 2, f'<g class="box">{s.rect(LX, y, LW, h, PANEL, LINE)}'
                   f'{s.text(LX + 20, y + 28, title, 16, INK, 600)}'
                   f'{s.text(LX + 20, y + 47, sub, 12.5, INK3, 400, mono=True)}</g>')
    # programmet kaller adapteren, og adapteren kaller programmet tilbake
    xa, xb = LX + pad + iw + 3, LX + pad + iw + gap - 3
    cy = y0 + min(lh, rh) / 2
    s.arrow(xa, cy - 9, xb, cy - 9, INK3, dash='4 3', sw=1.4)
    s.arrow(xb, cy + 9, xa, cy + 9, INK3, dash='4 3', sw=1.4)
    s.add(s.text((xa + xb) / 2, cy - 15, calls[0], 11, INK3, 500, 'middle', mono=True))
    s.add(s.text((xa + xb) / 2, cy + 26, calls[1], 11, INK3, 500, 'middle', mono=True))
    return h, y0 + rh / 2


rows = [
    ('ESP32 på Wi-Fi', 'esp32-json/esp32-json.ino',
     ('Sketchen din', ['Leser sensorer og BOOT-knappen, styrer LED og PWM.'], False),
     ('Adapterdelen', ['WebSockets + ArduinoJson i samme sketch. Tagger: esp32_1.*'], False),
     ('setTag()', 'handleWrite()')),
    ('Pico W / Pico 2 W med MicroPython', 'pico-micropython/main.py + hub_adapter.py',
     ('main.py', ['Leser temperaturen og BOOTSEL, styrer LED og PWM. Kaller poll() i løkken.'], True),
     ('hub_adapter.py', ['En liten WebSocket-klient, uten biblioteker. Tagger: pico_1.*'], True),
     ('set()', 'on_write()')),
    ('PC eller Pi med Python', 'python/example.py + hub_adapter.py',
     ('Programmet ditt', ['F.eks. en GUI, en seriellport, en logger. example.py viser hvordan.'], False),
     ('hub_adapter.py', ['Egen tråd, bare standardbiblioteket. Tagger: py_1.*'], True),
     ('set()', 'on_write()')),
    ('PC eller Pi med Node.js', 'node/example.js + hub-adapter.js',
     ('Programmet ditt', ['F.eks. en webtjeneste, en fil, en annen protokoll. example.js viser hvordan.'], False),
     ('hub-adapter.js', ['Node 22s egen WebSocket, ingen pakker. Tagger: node_1.*'], True),
     ('set()', 'onWrite()')),
]
y = TOP
mids = []
for title, sub, left, right, calls in rows:
    h, mid = machine(y, title, sub, left, right, calls)
    mids.append(mid)
    y += h + 22
left_bottom = y - 22

# ---------------------------------------------------------------- huben
hub_lines = [
    'Tar imot tagger fra alle adapterne, ved siden av kv_1.* fra PLS-en. Hver adapter eier taggene med sitt prefiks.',
    'En skriving fra HMI-en går til adapteren som eier taggen; adapteren svarer med verdien som ble satt (ekkoet).',
    ('Pinger hver adapter hvert 15. s. Forsvinner en, blir taggene foreldet (stale), og alarmen Adapter disconnected kommer.', INK3),
]
hh = s.box(HX, TOP, HW, 'hub.js', hub_lines, sub='ws://pi:8080 og http://pi:8080', accent=CYAN, mono_title=True, min_h=left_bottom - TOP - 150)
plc_y = TOP + hh + 30
ph = s.box(HX, plc_y, HW, 'binary-adapter.js', ['S7-1200-PLS-en, som før: tagger kv_1.*'], accent=INK3, mono_title=True, dash='5 4')
s.arrow(HX + HW / 2, plc_y - 3, HX + HW / 2, TOP + hh + 3, INK3, both=True, dash='5 4', sw=1.4)

# hver adapter: verdier inn til huben (amber) over skrivinger ut (blått)
for i, mid in enumerate(mids):
    x1, x2 = LX + LW + 3, HX - 3
    ty = min(max(mid, TOP + 30), TOP + hh - 30)        # treffer hubboksen
    s.arrow(x1, mid - 6, x2, ty - 6, AMBER)
    s.arrow(x2, ty + 6, x1, mid + 6, BLUE)
gx = (LX + LW + HX) / 2
s.add(s.text(gx, mids[0] - 26, 'update, register, event', 12, AMBER, 500, 'middle'))
s.add(s.text(gx, mids[0] + 36, 'write', 12, BLUE, 500, 'middle'))
s.add(s.text(gx, mids[1] + 40, 'WebSocket, JSON', 12, INK3, 400, 'middle'))

# ---------------------------------------------------------------- HMI-en
bh = s.box(BX, TOP, BW, 'HMI-en', [
    'Widgeter bindes til de nye taggene akkurat som til PLS-ens: Value, Gauge, Switch, Slider, Trend, Alarm list.',
    ('Tagoversikten viser dem under hvert prefiks, med live-verdier.', INK3)],
    sub='http://pi:8080', accent=CYAN)
by = TOP + min(bh, hh) / 2
s.arrow(HX + HW + 3, by - 7, BX - 3, by - 7, AMBER)
s.arrow(BX - 3, by + 7, HX + HW + 3, by + 7, BLUE)
s.add(s.text((HX + HW + BX) / 2, by - 20, 'update, tags', 12, AMBER, 500, 'middle'))
s.add(s.text((HX + HW + BX) / 2, by + 32, 'write', 12, BLUE, 500, 'middle'))
rec_y = TOP + bh + 30
rh = s.box(BX, rec_y, BW, 'recorder.js', ['Lagrer også de nye taggene når en lagringsregel fanger dem (py_1.*, esp32_1.*).'], accent=AMBER, mono_title=True)

# ---------------------------------------------------------------- hva du trenger
NY = max(left_bottom, plc_y + ph, rec_y + rh) + 60
s.add(s.text(48, NY, 'Hva hver av dem trenger', 20, INK, 600))
needs = [
    ('ESP32', 'Arduino IDE med arduino-esp32 2.0.2 eller nyere, og bibliotekene WebSockets (Markus Sattler) og ArduinoJson 7.'),
    ('Pico W / Pico 2 W', 'MicroPython 1.20 eller nyere på kortet. Kopier main.py og hub_adapter.py med Thonny eller mpremote.'),
    ('Python', 'Python 3.7 eller nyere. Ingen pakker: kopier hub_adapter.py ved siden av programmet ditt.'),
    ('Node.js', 'Node.js 22 eller nyere. Ingen pakker; på eldre Node: npm install ws.'),
]
cw, gap = (W - 96 - 3 * 16) / 4, 16
x = 48
hs = []
for t, body in needs:
    hs.append(s.box(x, NY + 18, cw, t, [body], accent=CYAN, title_size=15, min_h=110))
    x += cw + gap
note_y = NY + 18 + max(hs) + 30
s.add(s.text(48, note_y, 'Navnet (esp32_1, pico_1, py_1, node_1) må være unikt på huben. To enheter med samme navn tar taggene fra hverandre.', 14, INK2))
s.h = int(note_y + 40)
open(os.path.join(OUTDIR, 'example-adapters.svg'), 'w', encoding='utf-8').write(s.render())
print('example-adapters.svg written, height', s.h)


# ================================================================ 2. meldingene mellom adapter, hub og HMI
m = Svg(W, 1200, 'Meldingene mellom en adapter, huben og HMI-en, fra tilkobling til ny tilkobling')
m.add(m.text(48, 62, 'En adapters liv: meldingene, steg for steg', 30, INK, 600))
m.add(m.text(48, 92, 'Eksempelet bruker Python-adapteren py_1 og tanken i example.py. ESP32-, Pico- og Node-adapterne sender de samme meldingene.', 15, INK2))
m.legend(48, 128, [(AMBER, 'verdier og hendelser', False), (BLUE, 'skrivinger', False),
                   (CYAN, 'tilkobling', False), (INK3, 'WebSocket-ping (automatisk)', True)])

AXC, HXC, MXC = 220, 600, 980       # livslinjene: adapter, hub, HMI
HEAD_Y, LANE_W = 176, 300
NOTE_X, NOTE_W = 1180, W - 48 - 1180  # merknadene, i en egen kolonne til høyre
for xc, title, sub in [(AXC, 'Adapteren', 'py_1: programmet ditt + hub_adapter.py'),
                       (HXC, 'Huben', 'hub.js på Pi-en'),
                       (MXC, 'HMI-en', 'nettleseren')]:
    m.box(xc - LANE_W / 2, HEAD_Y, LANE_W, title, [], sub=sub, accent=CYAN, title_size=16)
m.add(m.text(NOTE_X, HEAD_Y + 40, 'Hva som skjer', 16, INK, 600))

steps = [
    # (fra, til, melding, farge, stiplet, merknad)
    ('a', 'h', 'WebSocket: ws://pi:8080', CYAN, False, 'Adapteren kobler til. Huben vet ennå ikke hvem den er.'),
    ('a', 'h', 'hello  name: "py_1"', CYAN, False, 'Navnet blir tagprefikset. Huben svarer med welcome.'),
    ('a', 'h', 'register  [py_1.level, ...]', AMBER, False, 'Taggene: type, måleenhet, skrivbar, alarm, og verdien de har nå.'),
    ('h', 'm', 'tags  (den nye taglisten)', AMBER, False, 'Hver HMI får den nye taglisten.'),
    ('a', 'h', 'update  py_1.level = 42.5', AMBER, False, 'En verdi som er endret. Uendrede verdier sendes ikke.'),
    ('h', 'm', 'update  py_1.level = 42.5', AMBER, False, 'HMI-ene som viser taggen, tegner widgetene på nytt.'),
    ('m', 'h', 'write  py_1.setpoint = 30', BLUE, False, 'En operatør setter settpunktet i HMI-en.'),
    ('h', 'a', 'write  py_1.setpoint = 30', BLUE, False, 'Huben sender skrivingen til adapteren som eier taggen.'),
    ('self', 'a', 'on_write(30): programmet ditt', INK3, True, 'Funksjonen gjør det, og returnerer verdien som faktisk ble satt (her 30).'),
    ('a', 'h', 'update  py_1.setpoint = 30', AMBER, False, 'Ekkoet. Først nå viser alle HMI-er 30, så kontrollen viser alltid det bekreftede.'),
    ('h', 'm', 'update  py_1.setpoint = 30', AMBER, False, 'Ekkoet går videre til alle HMI-ene.'),
    ('a', 'h', 'event  info: "Pump started"', AMBER, False, 'En linje i hendelsesloggen. warning og alarm havner også i alarmlisten.'),
    ('h', 'a', 'ping  /  pong   (hvert 15. s)', INK3, True, 'Svarer adapteren ikke, kobler huben den fra etter 30 s.'),
    ('h', 'm', 'update  quality: bad', AMBER, True, 'Forbindelsen faller ut: taggene blir foreldet (stale), og alarmen Adapter disconnected kommer.'),
    ('a', 'h', 'ny tilkobling, hello, register', CYAN, False, 'Adapteren prøver igjen av seg selv (2, 4, 8 ... høyst 30 s). Verdiene er tilbake.'),
]
X = {'a': AXC, 'h': HXC, 'm': MXC}
top_line = HEAD_Y + 62
y = HEAD_Y + 70
row_h = 58
for frm, to, msg, col, dash, note in steps:
    y += row_h
    if frm == 'self':
        bw = 250
        m.add(f'<g class="box">{m.rect(AXC - bw / 2, y - 21, bw, 30, PANEL2, LINE, rx=6, dash="4 3")}'
              f'{m.text(AXC, y - 1, msg, 12, INK2, 500, "middle", mono=True)}</g>')
    else:
        x1, x2 = X[frm], X[to]
        d = 1 if x2 > x1 else -1
        m.arrow(x1 + 4 * d, y, x2 - 4 * d, y, col, dash='5 4' if dash else None, sw=1.8)
        m.add(m.text((x1 + x2) / 2, y - 9, msg, 12, col, 500, 'middle', mono=True))
    svg, _ = m.para(NOTE_X, y - 22, NOTE_W, note, 12.5, INK3)
    m.add(svg)
bottom = y + 40
# livslinjene bak pilene
for xc in (AXC, HXC, MXC):
    m.parts.insert(4, f'<line x1="{xc}" y1="{top_line}" x2="{xc}" y2="{bottom}" stroke="{LINE}" stroke-width="1.5" stroke-dasharray="3 5"/>')
m.add(m.text(48, bottom + 34, 'Alle meldinger er JSON-tekst i én WebSocket-ramme. Den fullstendige listen står i README.md i hmi-core, avsnitt 12.1.', 14, INK2))
m.h = int(bottom + 70)
open(os.path.join(OUTDIR, 'adapter-messages.svg'), 'w', encoding='utf-8').write(m.render())
print('adapter-messages.svg written, height', m.h)
