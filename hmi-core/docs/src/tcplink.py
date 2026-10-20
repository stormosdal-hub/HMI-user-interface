"""tcplink.svg - TcpLink-blokken i PLS-en, tcplink-adapter.js, huben og HMI-en: navnene kommer fra PLS-en."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tcplink.svg')

W = 1600
s = Svg(W, 2000, 'TcpLink: navnene kommer fra PLS-en. TcpLink, tcplink-adapter.js, huben og HMI-en')

s.add(s.text(48, 62, 'TcpLink: navnene kommer fra PLS-en', 30, INK, 600))
s.add(s.text(48, 92, 'Slik får HMI-en både verdiene og navnene fra PLS-en, uten layoutfil. Verdier og navn går mot høyre, kommandoer mot venstre.', 15, INK2))
s.legend(48, 128, [(AMBER, 'verdier og status', False), (CYAN, 'navn og innstillinger', False), (BLUE, 'kommandoer', False),
                   (GREEN, 'beskyttelser', False)])

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
    h = s.box(PX + 16, y, iw, 'LinkNames', [
        'Én String per plass, indeks for indeks:',
        ("txReals[0] := 'Hastighet [rpm]'", CYAN, True),
        ("txWords[0] := 'Feilkode'", CYAN, True),
        ("rxBits[5]  := 'Jogg forover'", CYAN, True)], accent=CYAN, fill=PANEL2, title_size=14)
    y2 = y + h + 12
    h2 = s.box(PX + 16, y2, iw, 'LinkDB og ditt program', [
        'Fyller txDigital (bits, words, times) og txAnalog (ints, dints, reals).',
        'Leser rx: bits som nivåer og som pulser på én syklus, words, ints, dints og reals.'], accent=AMBER, fill=PANEL2, title_size=14)
    y3 = y2 + h2 + 26
    s.arrow(PX + PW / 2 - 14, y2 + h2 + 2, PX + PW / 2 - 14, y3 - 2, AMBER)
    s.arrow(PX + PW / 2 + 14, y3 - 2, PX + PW / 2 + 14, y2 + h2 + 2, BLUE)
    h3 = s.box(PX + 16, y3, iw, 'TcpLink FB', [
        'TCON: passiv, lytter på port 2000, én klient om gangen.',
        ('Navnemeldingen (kind 1): én gang per tilkobling, før dataene, og igjen på en flanke på resendNames.', CYAN),
        ('Datameldinger (kind 0): ved endring og minst én gang i sekundet. Størrelsene på arrayene står i headeren.', AMBER),
        ('Kommandorammen (format 3) i størrelsen PLS-en selv oppgir. En ramme med feil header bryter forbindelsen.', BLUE),
        ('Ingen kommandoramme på 2 s (rxTimeout): alt i rx nullstilles.', GREEN)], accent=INK, fill=PANEL2, title_size=14)
    plc['fb'] = (y3, h3)
    return y3 + h3
plc_h = framed(PX, PW, 'S7-1200', 'TcpLink, LinkNames og ditt program', build_plc)

# ---------------------------------------------------------------- adapteren
ad = {}
def build_adapter(y):
    iw = AW - 32
    h = s.box(AX + 16, y, iw, 'Navnemeldingen', [
        'Leser strengene seksjon for seksjon, som Windows-1252, så æ, ø og å kommer fram.',
        'Navnet blir taggens navn i HMI-en. En [enhet] til slutt på en tallplass blir enheten: Hastighet, rpm.',
        'Et endret navn: taggene registreres på nytt, og hendelsesloggen sier hva som er endret.'], accent=CYAN, fill=PANEL2, title_size=14)
    ad['names'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(AX + 16, y2, iw, 'Datameldingene', [
        'Størrelsene fra headeren: én tag per plass, kv_1.bit00, words_0, times_0, ints_0, dints_0, reals_0.',
        'En større UDT gir nye tagger; plasser som er borte, blir foreldet.',
        'times_N_age: sekunder fra tiden til PLS-klokka i samme melding.',
        'Hopp i sekvensnummeret telles i kv_1.rx_gaps.'], accent=AMBER, fill=PANEL2, title_size=14)
    ad['data'] = (y2, h2)
    y3 = y2 + h2 + 12
    h3 = s.box(AX + 16, y3, iw, 'tcplink-options/kjoreverk-options.json', [
        'Det PLS-en ikke kan si om en plass:',
        ('words_0: alarm «Drive fault F{value}»', CYAN, True),
        ('words_2: bitene i ZSW1 (zsw1_enabled ...)', CYAN, True),
        ('cmd_bit05, cmd_bit06: hold 600 ms', CYAN, True)], accent=CYAN, fill=PANEL2, title_size=13, mono_title=True, dash='5 4')
    ad['opts'] = (y3, h3)
    y4 = y3 + h3 + 12
    h4 = s.box(AX + 16, y4, iw, 'Kommandoene', [
        'Ingenting går ut før den første datameldingen har fortalt hvordan kommandorammen skal se ut.',
        'Sender hele rammen hvert 500 ms og ved hver endring. Begrenser verdier til typen sin.'], accent=BLUE, fill=PANEL2, title_size=14)
    ad['cmd'] = (y4, h4)
    y5 = y4 + h4 + 12
    h5 = s.box(AX + 16, y5, iw, 'Beskyttelsene', [
        'Hold-for-å-kjøre-bits faller 600 ms etter siste trykk.',
        'Kommandobits starter nullstilt etter en ny tilkobling, og når huben forsvinner.',
        'Ingen melding på 3 s: kv_1.link blir false og taggene foreldet. 10 s: ny tilkobling.'], accent=GREEN, fill=PANEL2, title_size=14)
    return y5 + h5
ad_h = framed(AX, AW, 'tcplink-adapter.js', 'ingen layoutfil: størrelsene og navnene kommer fra PLS-en', build_adapter, mono=True)

# ---------------------------------------------------------------- hub og operatør
hub = {}
def build_hub(y):
    iw = HW - 32
    h = s.box(HX + 16, y, iw, 'kv_1.reals_0', [
        ('navn: Hastighet', CYAN), ('enhet: rpm', CYAN),
        'Taggen er plassen og endres aldri: skjermbilder, beregninger og historikk bruker den.'],
        accent=AMBER, fill=PANEL2, title_size=14, mono_title=True)
    hub['tag'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(HX + 16, y2, iw, 'Navnet som vises', [
        'Ditt eget navn (tagnames.json) går foran navnet fra PLS-en.',
        'Tømmer du ditt, vises PLS-ens igjen.'], accent=CYAN, fill=PANEL2, title_size=14)
    hub['label'] = (y2, h2)
    y3 = y2 + h2 + 12
    h3 = s.box(HX + 16, y3, iw, 'Skriving', ['kv_1.cmd_* går til tcplink-adapter.js, som eier de taggene.'], accent=BLUE, fill=PANEL2, title_size=14)
    hub['writes'] = (y3, h3)
    return y3 + h3
hub_h = framed(HX, HW, 'hub.js', 'tagger, navn, historikk', build_hub, mono=True)

hmi = {}
def build_hmi(y):
    iw = MW - 32
    h = s.box(MX + 16, y, iw, 'Tagoversikten', ['Navnet fra PLS-en ved hver tag. With a name viser bare de navngitte.'], accent=CYAN, fill=PANEL2, title_size=14)
    hmi['tags'] = (y, h)
    y3 = y + h + 12
    h3 = s.box(MX + 16, y3, iw, 'Betjening', ['Knapper og brytere skriver til kv_1.cmd_*.'], accent=BLUE, fill=PANEL2, title_size=14)
    hmi['controls'] = (y3, h3)
    return y3 + h3
hmi_h = framed(MX, MW, 'HMI-en', 'i nettleseren', build_hmi)

# ---------------------------------------------------------------- flyt mellom kolonnene
def elbow(x1, y1, xm, y2, x2, color, dash=None):
    s.path_arrow(f'M{x1} {y1} H{xm} V{y2} H{x2}', color, dash=dash)

fy, fh = plc['fb']
ny, nh = ad['names']
dy_, dh = ad['data']
cy_, ch = ad['cmd']
g0, g1 = PX + PW, AX
fx = PX + PW - 13
elbow(fx, fy + fh * 0.30, g0 + 26, ny + nh * 0.5, AX + 13, CYAN)
elbow(fx, fy + fh * 0.50, g0 + 52, dy_ + dh * 0.5, AX + 13, AMBER)
elbow(AX + 13, cy_ + ch * 0.5, g1 - 26, fy + fh * 0.80, fx, BLUE)
lx = (g0 + g1) / 2
s.add(s.text(lx, ny + nh * 0.5 - 12, 'navn', 12.5, CYAN, 500, 'middle'))
s.add(s.text(lx, dy_ + dh * 0.5 - 12, 'data', 12.5, AMBER, 500, 'middle'))
s.add(s.text(lx, cy_ + ch * 0.5 + 22, 'kommandoer', 12.5, BLUE, 500, 'middle'))

# adapter <-> hub
ty_, th = hub['tag']
wy, wh = hub['writes']
h0, h1 = AX + AW, HX
elbow(AX + AW - 13, dy_ + dh * 0.5, h0 + 22, ty_ + th / 2, HX + 13, AMBER)
elbow(HX + 13, wy + wh / 2, h1 - 22, cy_ + ch * 0.5, AX + AW - 13, BLUE)
# over den siste vannrette strekken, klar av den loddrette som kommer nedenfra
s.add(s.text(h1 - 4, ty_ + th / 2 - 18, 'update', 12, AMBER, 500, 'end'))
s.add(s.text((h0 + h1) / 2, wy + wh / 2 - 9, 'write', 12, BLUE, 500, 'middle'))

# hub <-> operatør
my_, mh = hmi['tags']
ky_, kh = hmi['controls']
m0, m1 = HX + HW, MX
elbow(HX + HW - 13, ty_ + th / 2, m0 + 18, my_ + mh / 2, MX + 13, AMBER)
elbow(MX + 13, ky_ + kh / 2, m1 - 18, wy + wh / 2, HX + HW - 13, BLUE)

# ---------------------------------------------------------------- plass og tag
Y = max(TOP + plc_h, TOP + ad_h, TOP + hub_h, TOP + hmi_h) + 70
s.add(s.text(48, Y, 'Plassen i PLS-en og taggen i huben', 20, INK, 600))
s.add(s.text(48, Y + 26, 'Indeksen i arrayen er den samme i LinkDB, i LinkNames og i taggen. Navnet i LinkNames blir navnet du ser, ikke taggen.', 14, INK2))
rows = [
    ('txDigital.bits[i]', 'kv_1.bit00 ... bit31', 'LinkNames.txBits[i]', AMBER),
    ('txDigital.words[i]', 'kv_1.words_0 ...', 'LinkNames.txWords[i]', AMBER),
    ('txDigital.times[i]', 'kv_1.times_0, times_0_age', 'LinkNames.txTimes[i]', AMBER),
    ('txAnalog.ints / dints / reals[i]', 'kv_1.ints_0, dints_0, reals_0', 'txInts / txDints / txReals[i], med [enhet]', AMBER),
    ('rx.bits[i] (og pulse[i])', 'kv_1.cmd_bit00 ... cmd_bit15', 'LinkNames.rxBits[i]', BLUE),
    ('rx.words / ints / dints / reals[i]', 'kv_1.cmd_words_0, cmd_ints_0 ...', 'rxWords / rxInts / rxDints / rxReals[i]', BLUE),
]
cols = [(48, 'I PLS-en'), (470, 'Taggen i huben'), (900, 'Navnet kommer fra')]
ry = Y + 66
for x, h in cols:
    s.add(s.text(x, ry, h, 13, INK3, 600))
ry += 12
for i, (a, b, c, col) in enumerate(rows):
    yy = ry + i * 34
    s.add(s.rect(48, yy, W - 96, 30, PANEL if i % 2 == 0 else BG, LINE_SOFT, rx=4))
    s.add(s.text(60, yy + 20, a, 13, col, 500, mono=True))
    s.add(s.text(482, yy + 20, b, 13, INK, 500, mono=True))
    s.add(s.text(912, yy + 20, c, 13, CYAN, 400, mono=True))
s.add(s.text(48, ry + len(rows) * 34 + 26, 'I tillegg: kv_1.link (true mens meldinger kommer), kv_1.rx_gaps, kv_1.ts (PLS-klokka) og kv_1.ts_is_local, og bitene som innstillingsfilen gir navn (kv_1.zsw1_enabled ...).', 13, INK2))

# ---------------------------------------------------------------- rekkefølgen
T = ry + len(rows) * 34 + 90
s.add(s.text(48, T, 'Rekkefølgen på en forbindelse', 20, INK, 600))
s.add(s.text(48, T + 26, 'Navnene kommer alltid før dataene. Et nytt navn i PLS-en endrer bare det som vises: taggen og verdien står.', 14, INK2))
steps = [
    ('1. Tilkobling', 'Adapteren kobler seg til port 2000. PLS-en er den passive siden.', INK3),
    ('2. Navnene', 'PLS-en sender LinkNames (kind 1). Adapteren tar vare på dem.', CYAN),
    ('3. Første data', 'Størrelsene er kjent: adapteren registrerer taggene med navnene og enhetene.', AMBER),
    ('4. Kommandoer', 'Først nå sender adapteren kommandorammer, hvert 500 ms.', BLUE),
    ('5. Nytt navn', 'Last ned LinkNames og gi resendNames en flanke, eller koble til på nytt: navnet i HMI-en byttes.', CYAN),
]
cw, gap = (W - 96 - 4 * 16) / 5, 16
x, hs = 48, []
for t, body, col in steps:
    hs.append(s.box(x, T + 46, cw, t, [body], accent=col, title_size=14, min_h=110))
    x += cw + gap
for i in range(4):
    xa = 48 + (i + 1) * (cw + gap) - gap + 2
    s.arrow(xa, T + 46 + 55, xa + gap - 4, T + 46 + 55, INK3, sw=1.5)

s.h = int(T + 46 + max(hs) + 40)
open(OUT, 'w', encoding='utf-8').write(s.render())
print('tcplink.svg written, height', s.h)
