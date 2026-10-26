"""tcplink-history.svg - historikken fra PLS-ens retentive ringbuffer kommer tilbake i huben ved hver tilkobling."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tcplink-history.svg')

W = 1600
s = Svg(W, 2000, 'Historikken fra PLS-en: LinkHistory og TcpLink, tcplink-adapter.js, huben og HMI-en')

s.add(s.text(48, 62, 'Historikken fra PLS-en', 30, INK, 600))
s.add(s.text(48, 92, 'PLS-en logger hele tiden, også mens Pi-en er av. Ved hver tilkobling får huben tilbake det den ikke har, på PLS-ens eget tidspunkt.', 15, INK2))
s.legend(48, 128, [(VIOLET, 'historikk fra PLS-en', False), (AMBER, 'verdier direkte', False), (CYAN, 'innstillinger', False),
                   (GREEN, 'mot dobbelpunkter og feil tid', False)])

PX, PW = 48, 390       # PLS
AX, AW = 568, 420      # adapter
HX, HW = 1046, 250     # hub
MX, MW = 1338, 214     # HMI
TOP = 196
for x, label in [(PX, 'S7-1200 PLS'), (PX + PW + 18, 'Ethernet, TCP'), (AX, 'Pi-en'), (HX, 'Hub'), (MX, 'Operatør')]:
    s.add(s.text(x, TOP - 14, label, 15, INK3, 600))


def framed(x, w, title, sub, build, mono=False, head=64):
    """En ramme rundt boksene som build(y0) -> y_end lager; rammen legges under dem."""
    n0 = len(s.parts)
    y_end = build(TOP + head)
    h = y_end - TOP + 12
    frame = (f'<g class="box">{s.rect(x, TOP, w, h, PANEL, LINE)}'
             f'{s.text(x + 18, TOP + 28, title, 17, INK, 600, mono=mono)}'
             f'{s.text(x + 18, TOP + 48, sub, 13, INK3)}</g>')
    s.parts.insert(n0, frame)
    return h


# ---------------------------------------------------------------- PLS-en
plc = {}
def build_plc(y):
    iw = PW - 32
    h = s.box(PX + 16, y, iw, 'LinkHistory', [
        'Retentiv ringbuffer: overlever strømbrudd. 20 byte per post, 200 poster er 4 008 byte.',
        ('Én post per endring: løpenummer, PLS-tid, plassen og den nye verdien.', VIOLET),
        ('histMask i LinkDB velger hvilke bits og words som logges.', CYAN)], accent=VIOLET, fill=PANEL2, title_size=14)
    y2 = y + h + 26
    s.arrow(PX + PW / 2, y2 - 2, PX + PW / 2, y + h + 2, VIOLET)
    s.add(s.text(PX + PW / 2 + 10, y + h + 18, 'logger, også uten klient', 12, VIOLET, 500))
    h2 = s.box(PX + 16, y2, iw, 'TcpLink FB', [
        'Ved hver tilkobling: navnene, en datamelding, og så hele bufferen.',
        ('Historikkmeldinger (kind 2): eldste post først, 16 i hver, så hver ny post etter hvert som den logges.', VIOLET),
        ('Datameldingene har PLS-klokka i headeren.', AMBER)], accent=INK, fill=PANEL2, title_size=14)
    plc['fb'] = (y2, h2)
    return y2 + h2
plc_h = framed(PX, PW, 'S7-1200', 'LinkHistory og TcpLink (TCP_LINK.md §3.8)', build_plc)

# ---------------------------------------------------------------- adapteren
ad = {}
def build_adapter(y):
    iw = AW - 32
    h = s.box(AX + 16, y, iw, 'Kopien', [
        ('Holder det PLS-en har: løpenummer og post. Det som er overskrevet, slettet eller fra før en ny nedlasting, faller bort.', VIOLET),
        'En hub som har startet på nytt, får hele kopien, selv om PLS-en ikke sender bufferen igjen.'], accent=VIOLET, fill=PANEL2, title_size=14)
    ad['copy'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(AX + 16, y2, iw, 'Tiden', [
        ('Klokkeforskjellen måles på hver datamelding: Pi-ens klokke minus PLS-klokka.', AMBER),
        'Hver post flyttes med forskjellen, så den havner riktig mot det huben fikk direkte. Loggen sier fra når forskjellen er over 5 s.'],
        accent=GREEN, fill=PANEL2, title_size=14)
    ad['time'] = (y2, h2)
    y3 = y2 + h2 + 12
    h3 = s.box(AX + 16, y3, iw, 'Taggene', [
        ('bits:  kv_1.bit03 …', VIOLET, True),
        ('words: kv_1.words_2 …', VIOLET, True),
        ('og bitene innstillingsfilen gir navn i et word: kv_1.zsw1_fault …', CYAN),
        'Hver post går én gang per hubforbindelse, med løpenummer og PLS-tid som ref.'], accent=VIOLET, fill=PANEL2, title_size=14)
    ad['tags'] = (y3, h3)
    return y3 + h3
ad_h = framed(AX, AW, 'tcplink-adapter.js', 'tar imot historikken og sender den til huben', build_adapter, mono=True)

# ---------------------------------------------------------------- hub og operatør
hub = {}
def build_hub(y):
    iw = HW - 32
    h = s.box(HX + 16, y, iw, 'restore', [
        ('Hvert punkt på sin plass i tid.', VIOLET),
        ('En ref den har fra før: hoppes over.', GREEN),
        ('Samme verdi som punktet før: ingenting nytt.', GREEN),
        ('Samme verdi som punktet etter: endringen får PLS-ens tid.', GREEN)], accent=VIOLET, fill=PANEL2, title_size=14, mono_title=True)
    hub['restore'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(HX + 16, y2, iw, 'Historikken', ['De siste 600 endringene per tag, i minnet. Det trendene viser.'], accent=AMBER, fill=PANEL2, title_size=14)
    hub['hist'] = (y2, h2)
    y3 = y2 + h2 + 12
    h3 = s.box(HX + 16, y3, iw, 'Hendelsesloggen', [('Restored 12 changes from the PLC history (… to …)', VIOLET, True)], accent=VIOLET, fill=PANEL2, title_size=14)
    hub['event'] = (y3, h3)
    return y3 + h3
hub_h = framed(HX, HW, 'hub.js', 'historikk i minnet', build_hub, mono=True)

hmi = {}
def build_hmi(y):
    iw = MW - 32
    h = s.box(MX + 16, y, iw, 'Trender', ['Får restored og henter tidsrommet sitt på nytt.'], accent=VIOLET, fill=PANEL2, title_size=14)
    hmi['trend'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(MX + 16, y2, iw, 'Event log', ['Sier hvor mye som kom tilbake, og hvilket tidsrom det dekker.'], accent=VIOLET, fill=PANEL2, title_size=14)
    hmi['events'] = (y2, h2)
    return y2 + h2
hmi_h = framed(MX, MW, 'HMI-en', 'i nettleseren', build_hmi)

# ---------------------------------------------------------------- flyt mellom kolonnene
def elbow(x1, y1, xm, y2, x2, color, dash=None):
    s.path_arrow(f'M{x1} {y1} H{xm} V{y2} H{x2}', color, dash=dash)

fy, fh = plc['fb']
cy_, ch = ad['copy']
ty_, th = ad['time']
g0, g1 = PX + PW, AX
fx = PX + PW - 13
elbow(fx, fy + fh * 0.45, g0 + 26, cy_ + ch * 0.5, AX + 13, VIOLET)
elbow(fx, fy + fh * 0.80, g0 + 52, ty_ + th * 0.4, AX + 13, AMBER)
lx = (g0 + g1) / 2
s.add(s.text(lx, cy_ + ch * 0.5 - 12, 'kind 2', 12.5, VIOLET, 500, 'middle'))
s.add(s.text(lx + 10, ty_ + th * 0.4 - 12, 'data (ts)', 12.5, AMBER, 500, 'middle'))

# adapter -> hub
gy, gh = ad['tags']
ry_, rh = hub['restore']
h0, h1 = AX + AW, HX
elbow(AX + AW - 13, gy + gh * 0.5, h0 + 22, ry_ + rh * 0.3, HX + 13, VIOLET)
s.add(s.text(h1 - 4, ry_ + rh * 0.3 - 10, 'restore', 12, VIOLET, 500, 'end'))
# restore -> historikken og hendelsesloggen, inne i huben
hy, hh = hub['hist']
ey, eh = hub['event']
s.arrow(HX + HW / 2, ry_ + rh + 2, HX + HW / 2, hy - 2, VIOLET, sw=1.6)

# hub -> operatør
my_, mh = hmi['trend']
ny_, nh = hmi['events']
m0 = HX + HW
elbow(HX + HW - 13, hy + hh / 2, m0 + 18, my_ + mh / 2, MX + 13, VIOLET)
elbow(HX + HW - 13, ey + eh / 2, m0 + 30, ny_ + nh / 2, MX + 13, VIOLET)

# ---------------------------------------------------------------- et strømbrudd på Pi-en
Y = max(TOP + plc_h, TOP + ad_h, TOP + hub_h, TOP + hmi_h) + 70
s.add(s.text(48, Y, 'Et strømbrudd på Pi-en', 20, INK, 600))
s.add(s.text(48, Y + 26, 'Slik ser trenden for en bit ut etterpå. Det PLS-en logget mens Pi-en var av, fyller hullet.', 14, INK2))
X0, X1 = 90, W - 90
ax_y = Y + 232
lo, hi = ax_y - 30, ax_y - 110
# fasene langs tidsaksen
phases = [(0.00, 0.28, 'Pi-en går', 'huben får hver endring direkte', AMBER),
          (0.28, 0.62, 'Strømbrudd: Pi-en er av', 'PLS-en logger i LinkHistory', VIOLET),
          (0.62, 0.70, 'Oppstart', 'hub og adapter', INK3),
          (0.70, 1.00, 'Linken er oppe', 'historikken kommer, så direkte igjen', AMBER)]
px = lambda f: X0 + f * (X1 - X0)
for a, b, t, sub, col in phases:
    s.add(s.rect(px(a), Y + 54, px(b) - px(a) - 4, 50, PANEL, LINE_SOFT, rx=6))
    s.add(s.text(px(a) + 10, Y + 74, t, 13, col, 600))
    s.add(s.text(px(a) + 10, Y + 93, sub, 12, INK3))
# tidsakse
s.add(f'<line x1="{X0}" y1="{ax_y}" x2="{X1}" y2="{ax_y}" stroke="{LINE}" stroke-width="1.5"/>')
s.add(s.text(X1, ax_y + 20, 'tid', 12, INK3, 400, 'end'))
# trinnkurven: (start, slutt, verdi, farge)
segs = [(0.00, 0.12, 0, AMBER), (0.12, 0.28, 1, AMBER),
        (0.28, 0.36, 1, VIOLET), (0.36, 0.50, 0, VIOLET), (0.50, 0.70, 1, VIOLET),
        (0.70, 0.86, 1, AMBER), (0.86, 1.00, 0, AMBER)]
yv = lambda v: hi if v else lo
prev = None
for a, b, v, col in segs:
    if prev is not None and prev[0] != v:
        s.add(f'<line x1="{px(a)}" y1="{yv(prev[0])}" x2="{px(a)}" y2="{yv(v)}" stroke="{col}" stroke-width="2.5"/>')
    s.add(f'<line x1="{px(a)}" y1="{yv(v)}" x2="{px(b)}" y2="{yv(v)}" stroke="{col}" stroke-width="2.5"/>')
    prev = (v, col)
s.add(s.text(X0 - 12, hi + 4, '1', 12, INK3, 400, 'end'))
s.add(s.text(X0 - 12, lo + 4, '0', 12, INK3, 400, 'end'))
# postene i PLS-en: prikker der endringene skjedde mens Pi-en var av
for f, label in [(0.36, '#811  av'), (0.50, '#812  på')]:
    s.add(f'<circle cx="{px(f)}" cy="{ax_y}" r="5" fill="{VIOLET}"/>')
    s.add(s.text(px(f) + 8, ax_y + 20, label, 12, VIOLET, 500, mono=True))
s.add(s.text(px(0.28) + 4, ax_y + 42, 'lilla: punktene kom tilbake fra LinkHistory da linken var oppe igjen', 12, INK3, 400, italic=True))

# ---------------------------------------------------------------- hva som skjer når
T = ax_y + 80
s.add(s.text(48, T, 'Hva som skjer når', 20, INK, 600))
rows = [
    ('Strømbrudd på Pi-en', 'Huben starter tom. Ved tilkoblingen kommer alt PLS-en har, tilbake.', 'Restored 37 changes from the PLC history (…)'),
    ('Brudd på linken', 'Det som ble logget mens linken var nede, fylles inn i hullet.', 'Restored 4 changes from the PLC history (…)'),
    ('Huben starter på nytt', 'Adapteren sender kopien sin, også når linken til PLS-en står.', 'Restored 37 changes from the PLC history (…)'),
    ('Adapteren starter på nytt', 'Huben har alt fra før og kjenner igjen hver post: ingenting endres.', '(ingen hendelse)'),
    ('Bufferen gikk rundt', 'De eldste endringene var overskrevet før adapteren fikk dem.', '5 changes in the PLC history were overwritten …'),
    ('histClear, eller ny nedlasting', 'Det huben allerede har, blir stående. Løpenumrene kan starte på 1 igjen.', 'The PLC history was cleared / started again from #1'),
]
cols = [(48, 'Når'), (330, 'Hva skjer'), (960, 'I hendelsesloggen')]
ry = T + 40
for x, h in cols:
    s.add(s.text(x, ry, h, 13, INK3, 600))
ry += 12
for i, (a, b, c) in enumerate(rows):
    yy = ry + i * 34
    s.add(s.rect(48, yy, W - 96, 30, PANEL if i % 2 == 0 else BG, LINE_SOFT, rx=4))
    s.add(s.text(60, yy + 20, a, 13, INK, 500))
    s.add(s.text(342, yy + 20, b, 13, INK2))
    s.add(s.text(972, yy + 20, c, 12.5, VIOLET, 400, mono=True))
note = ry + len(rows) * 34 + 30
s.add(s.text(48, note, 'Bare historikken kommer tilbake: verdien en tag har nå, kommer fra datameldingene, og alarmlisten og beregnede tagger (calc.*) bygges ikke opp igjen.', 13, INK2))
s.add(s.text(48, note + 22, 'Et word logges som hele wordet i det øyeblikket en bit i masken endret seg. Analoge verdier logges ikke i PLS-en ennå.', 13, INK2))

s.h = int(note + 22 + 40)
open(OUT, 'w', encoding='utf-8').write(s.render())
print('tcplink-history.svg written, height', s.h)
