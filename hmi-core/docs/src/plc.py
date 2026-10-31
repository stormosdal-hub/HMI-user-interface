"""plc-ouc.svg - Kjoreverk-forbindelsen til S7-1200: PLS, adapter, hub, HMI; telegramformatet; tidsgrensene."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'plc-ouc.svg')

W = 1600
s = Svg(W, 2000, 'S7-1200 over Open User Communication: KjoreverkLink, binary-adapter.js, huben og HMI-en')

s.add(s.text(48, 62, 'S7-1200 over Open User Communication', 30, INK, 600))
s.add(s.text(48, 92, 'Slik samarbeider KjoreverkLink v0.8 i PLS-en, binary-adapter.js på Pi-en, huben og HMI-en. Verdier går mot høyre, kommandoer mot venstre.', 15, INK2))
s.legend(48, 128, [(AMBER, 'verdier og status', False), (BLUE, 'kommandoer', False), (VIOLET, 'beregnede tagger', False),
                   (GREEN, 'beskyttelser', False)])

PX, PW = 48, 420       # PLS
AX, AW = 600, 430      # adapter
HX, HW = 1088, 222     # hub
MX, MW = 1352, 200     # HMI
TOP = 196
for x, label in [(PX, 'S7-1200 PLS'), (PW + PX + 18, 'Ethernet, TCP'), (AX, 'PC'), (HX, 'Hub'), (MX, 'Operatør')]:
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
    h = s.box(PX + 16, y, iw, 'V90 servodrive', ['PROFINET, standardtelegram 1: faktisk hastighet, statusordet ZSW1, feil- og advarselskoder.'], accent=INK3, fill=PANEL2, title_size=14)
    y2 = y + h + 26
    s.arrow(PX + PW / 2, y + h + 2, PX + PW / 2, y2 - 2, AMBER)
    h2 = s.box(PX + 16, y2, iw, 'Ditt program', [
        'Fyller KjoreverkTxBits, KjoreverkTxDrive og KjoreverkTxValues.',
        'Leser KjoreverkRxCommands: biter som nivåer og som pulser på én syklus, ints og words.'], accent=AMBER, fill=PANEL2, title_size=14)
    y3 = y2 + h2 + 26
    s.arrow(PX + PW / 2 - 14, y2 + h2 + 2, PX + PW / 2 - 14, y3 - 2, AMBER)
    s.arrow(PX + PW / 2 + 14, y3 - 2, PX + PW / 2 + 14, y2 + h2 + 2, BLUE)
    h3 = s.box(PX + 16, y3, iw, 'KjoreverkLink FB', [
        'TCON: passiv, lytter på port 2000, én klient om gangen.',
        ('TSEND: uplinken på 112 byte, når noe endres (analoge verdier med dødbånd) og minst én gang i sekundet.', AMBER),
        ('TRCV: downlinken på 46 byte. En ramme med feil header bryter forbindelsen.', BLUE),
        ('Ingen kommandoramme på 2 s (cmdTimeout): alle kommandoer nullstilles.', GREEN)], accent=INK, fill=PANEL2, title_size=14)
    plc['fb'] = (y3, h3)
    return y3 + h3
plc_h = framed(PX, PW, 'S7-1200', 'KjoreverkLink v0.8 og ditt program', build_plc)

# ---------------------------------------------------------------- adapteren
ad = {}
def build_adapter(y):
    iw = AW - 32
    h = s.box(AX + 16, y, iw, 'Mottak av uplinken', [
        'Sjekker magic, versjon og lengde. Hvis strømmen kommer ut av takt, leter den etter neste header.',
        'Teller hopp i sekvensnummeret i pls.rx_gaps.',
        'Gjør hvert felt om til en tag: pls.bit00 til bit63, speedAct, statusWord og ZSW1-bitene, ints, words og dints.',
        'Viser DTL-tider i lokal tid, og måler lastDriveTime_age mot PLS-ens egen sendetid.',
        'Feil- og advarselskoder blir hendelser.'], accent=AMBER, fill=PANEL2, title_size=14)
    ad['rx'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(AX + 16, y2, iw, 'Overvåking av forbindelsen', [
        ('Ingen blokk på 3 s: pls.link blir false, og alle pls-tagger blir foreldet.', INK2)], accent=GREEN, fill=PANEL2, title_size=14)
    y3 = y2 + h2 + 12
    h3 = s.box(AX + 16, y3, iw, 'Sending av downlinken', [
        'Holder et kommandobilde og sender det som en blokk på 46 byte ved hver endring og hvert 500 ms.',
        'Skriver headeren 16#5A, 1, 46, 0 og et sekvensnummer.',
        'Begrenser verdier til typen sin, og avviser skriving mens PLS-en er frakoblet.'], accent=BLUE, fill=PANEL2, title_size=14)
    ad['tx'] = (y3, h3)
    y4 = y3 + h3 + 12
    h4 = s.box(AX + 16, y4, iw, 'Beskyttelse av kommandoene', [
        'Hold-to-run-biter faller 600 ms etter siste trykk, og venter så på at knappen slippes.',
        'Aksjonsbiter kan slå seg av selv (autoReset).',
        'Kommandobiter starter nullstilt etter en ny tilkobling, eller når huben forsvinner.'], accent=GREEN, fill=PANEL2, title_size=14)
    return y4 + h4
ad_h = framed(AX, AW, 'binary-adapter.js', 'fixed-modus, leser binary-layouts/kjoreverk-layout.json', build_adapter, mono=True)

# ---------------------------------------------------------------- hub og HMI
hub = {}
def build_hub(y):
    iw = HW - 32
    h = s.box(HX + 16, y, iw, 'pls.*-tagger', ['Verdi, kvalitet og historikk for hvert felt.'], accent=AMBER, fill=PANEL2, title_size=14)
    hub['tags'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(HX + 16, y2, iw, 'Beregninger', [
        ('calc.kv_speed_rpm = speedAct / 16384 \u00d7 p2000', VIOLET),
        ('calc.kv_torque_nm = torqueAct / 16384 \u00d7 p2003', VIOLET),
        ('calc.kv_power_w', VIOLET)], accent=VIOLET, fill=PANEL2, title_size=14)
    y3 = y2 + h2 + 12
    h3 = s.box(HX + 16, y3, iw, 'Skriving', ['Skriving til pls.cmd_* går til binary-adapter.js, som eier de taggene.'], accent=BLUE, fill=PANEL2, title_size=14)
    hub['writes'] = (y3, h3)
    return y3 + h3
hub_h = framed(HX, HW, 'hub.js', 'tagger, historikk, beregninger', build_hub, mono=True)

hmi = {}
def build_hmi(y):
    iw = MW - 32
    h = s.box(MX + 16, y, iw, 'PLS-skjermbilde', ['Hastighet, moment, effekt, ZSW1, feilkode, når drivet sist gikk og hvor lenge den har stått stille.'], accent=AMBER, fill=PANEL2, title_size=14)
    hmi['screen'] = (y, h)
    y2 = y + h + 12
    h2 = s.box(MX + 16, y2, iw, 'Betjening', ['Brytere og knapper skriver til pls.cmd_*.', 'Knapper med hold-to-run gjentar trykket hvert 200 ms.'], accent=BLUE, fill=PANEL2, title_size=14)
    hmi['controls'] = (y2, h2)
    y3 = y2 + h2 + 12
    h3 = s.box(MX + 16, y3, iw, 'Foreldede verdier', [('Vises i grått mens PLS-forbindelsen er nede.', INK2)], accent=GREEN, fill=PANEL2, title_size=14)
    return y3 + h3
hmi_h = framed(MX, MW, 'HMI-en', 'i alle nettlesere', build_hmi)

# ---------------------------------------------------------------- flyt mellom kolonnene
# vinkelkoblinger, så hver pil starter og slutter på boksen den hører til
def elbow(x1, y1, xm, y2, x2, color):
    s.path_arrow(f'M{x1} {y1} H{xm} V{y2} H{x2}', color)

fy, fh = plc['fb']
ry, rh = ad['rx']
xy, xh = ad['tx']
uy, dy = fy + fh * 0.30, fy + fh * 0.70
rxc, txc = ry + rh * 0.5, xy + xh * 0.5
g0, g1 = PX + PW, AX           # mellomrommet mellom PLS og PC
ux, dx = g0 + 30, g1 - 30      # de to loddrette strekkene
elbow(PX + PW - 13, uy, ux, rxc, AX + 13, AMBER)      # fra selve FB-boksen
elbow(AX + 13, txc, dx, dy, PX + PW - 13, BLUE)
lx = (ux + dx) / 2
s.add(s.text(lx, (uy + rxc) / 2 - 16, 'uplink', 12.5, AMBER, 500, 'middle'))
s.add(s.text(lx, (uy + rxc) / 2, '112 byte', 12, AMBER, 400, 'middle'))
s.add(s.text(lx, (uy + rxc) / 2 + 15, '16#A5', 12, AMBER, 400, 'middle', mono=True))
dl = max(dy, txc) + 24          # under downlinkens nedre strekk, klar av linjen
s.add(s.text(lx, dl, 'downlink', 12.5, BLUE, 500, 'middle'))
s.add(s.text(lx, dl + 16, '46 byte', 12, BLUE, 400, 'middle'))
s.add(s.text(lx, dl + 31, '16#5A', 12, BLUE, 400, 'middle', mono=True))
s.add(s.text(lx, rxc - 34, 'PC-en kobler seg', 12, INK3, 400, 'middle'))
s.add(s.text(lx, rxc - 19, 'til port 2000', 12, INK3, 400, 'middle'))

# adapter <-> hub
ty_, th = hub['tags']
wy, wh = hub['writes']
h0, h1 = AX + AW, HX
elbow(AX + AW - 13, rxc, h0 + 22, ty_ + th / 2, HX + 13, AMBER)
elbow(HX + 13, wy + wh / 2, h1 - 22, txc, AX + AW - 13, BLUE)
s.add(s.text((h0 + h1) / 2, min(rxc, ty_ + th / 2) - 10, 'update', 12.5, AMBER, 500, 'middle'))
s.add(s.text((h0 + h1) / 2, max(txc, wy + wh / 2) + 22, 'write', 12.5, BLUE, 500, 'middle'))

# hub <-> operatør
sy_, sh_ = hmi['screen']
cy_, ch_ = hmi['controls']
m0, m1 = HX + HW, MX
elbow(HX + HW - 13, ty_ + th / 2, m0 + 18, sy_ + sh_ / 2, MX + 13, AMBER)
elbow(MX + 13, cy_ + ch_ / 2, m1 - 18, wy + wh / 2, HX + HW - 13, BLUE)

# ---------------------------------------------------------------- de to blokkene som sendes
Y = max(TOP + plc_h, TOP + ad_h, TOP + hub_h, TOP + hmi_h) + 70
s.add(s.text(48, Y, 'De to blokkene som sendes', 20, INK, 600))
s.add(s.text(48, Y + 26, 'Tegnet i samme målestokk. Tall er big-endian; i bitene er bit 0 den minst signifikante (DBX n.0). Offsetene stemmer med Offset-kolonnen i TIA for en DB uten optimert tilgang.', 14, INK2))
BYTE = 12.3
SX = 170
SH = 86          # blokkhøyde

def strip(y, label, sub, segs, total, col, tint):
    s.add(s.text(48, y + 27, label, 16, INK, 600))
    s.add(s.text(48, y + 46, sub, 12.5, col, 500))
    for a, b_, name, detail, mono in segs:
        x, w = SX + a * BYTE, (b_ - a) * BYTE
        inner = [s.rect(x, y, w, SH, tint, col, rx=3, sw=1),
                 s.text(x + 7, y + 20, name, 13, INK, 600)]
        yy = y + 22
        for line in wrap(detail, w - 12, 11.5, mono):
            yy += 15
            inner.append(s.text(x + 7, yy, line, 11.5, INK2, 400, mono=mono))
        s.add(f'<g class="box">{"".join(inner)}</g>')
    for off in sorted({a for a, *_ in segs} | {total}):
        x = SX + off * BYTE
        s.add(f'<line x1="{x}" y1="{y + SH}" x2="{x}" y2="{y + SH + 8}" stroke="{INK3}" stroke-width="1"/>')
        s.add(s.text(x, y + SH + 22, str(off), 11.5, INK3, 400, 'middle', mono=True))

up_y = Y + 52
strip(up_y, 'Uplink', 'PLS til PC, TSEND', [
    (0, 6, 'header', 'A5 05 70 flags seq', True),
    (6, 18, 'ts', 'DTL, PLS-ens sendetid', False),
    (18, 26, 'bits', '64 signaler, bit00 til bit63', False),
    (26, 36, 'drive', 'hastighet, moment, feil, advarsel, ZSW1', False),
    (36, 60, 'ints', '12 verdier (Int)', False),
    (60, 68, 'words', '4 verdier (Word)', False),
    (68, 80, 'lastDriveTime', 'DTL', False),
    (80, 112, 'dints', '8 verdier (DInt)', False),
], 112, AMBER, 'rgba(242,180,65,0.10)')
dn_y = up_y + SH + 54
strip(dn_y, 'Downlink', 'PC til PLS, TRCV', [
    (0, 6, 'header', '5A 01 2E 00 seq', True),
    (6, 14, 'bits', '64 kommandoer', False),
    (14, 38, 'ints', '12 verdier (Int)', False),
    (38, 46, 'words', '4 verdier (Word)', False),
], 46, BLUE, 'rgba(122,167,255,0.10)')

# ---------------------------------------------------------------- tidsgrenser langs kjeden
T = dn_y + SH + 80
s.add(s.text(48, T, 'Tidsgrenser langs kjeden', 20, INK, 600))
s.add(s.text(48, T + 26, 'Hvert lag gir laget foran seg noen sjanser før det griper inn.', 14, INK2))
ax_y = T + 70
X0, PXS = SX, 420          # 0 s ved X0, piksler per sekund
s.add(f'<line x1="{X0}" y1="{ax_y}" x2="{X0 + 3.3 * PXS}" y2="{ax_y}" stroke="{LINE}" stroke-width="2"/>')
for t in [0, 1, 2, 3]:
    x = X0 + t * PXS
    s.add(f'<line x1="{x}" y1="{ax_y - 5}" x2="{x}" y2="{ax_y + 5}" stroke="{INK3}" stroke-width="1.5"/>')
    s.add(s.text(x, ax_y - 12, f'{t} s', 12, INK3, 400, 'middle'))
marks = [
    (0.2, 'HMI-en gjentar et holdt trykk', BLUE, 0),
    (0.5, 'adapteren gjentar kommandoblokken', BLUE, 1),
    (0.6, 'adapteren slipper en hold-to-run-bit', GREEN, 2),
    (1.0, 'PLS-en sender minst én gang', AMBER, 0),
    (2.0, 'PLS-en nullstiller alle kommandoer', GREEN, 1),
    (3.0, 'adapteren melder PLS-forbindelsen nede', GREEN, 2),
]
for t, label, col, row in marks:
    x = X0 + t * PXS
    ly = ax_y + 28 + row * 24
    s.add(f'<circle cx="{x}" cy="{ax_y}" r="5" fill="{col}"/>')
    s.add(f'<line x1="{x}" y1="{ax_y + 6}" x2="{x}" y2="{ly - 11}" stroke="{col}" stroke-width="1" stroke-dasharray="2 3"/>')
    tl = f'{t:g} s' if t < 1 or t % 1 else f'{int(t)} s'
    text = f'{tl}: {label}'
    near_edge = x + 8 + len(text) * 7.4 > W - 48
    s.add(s.text(x - 6 if near_edge else x + 6, ly, text, 12.5, col, 500, 'end' if near_edge else 'start'))

# ---------------------------------------------------------------- når noe går galt
F = ax_y + 118
s.add(s.text(48, F, 'Når noe går galt', 20, INK, 600))
cards = [
    ('Nettleseren dør midt i et trykk', 'Gjentakelsene stopper. Adapteren slipper hold-to-run-biten 600 ms etter siste trykk, og venter på at knappen slippes før den godtar den igjen.'),
    ('PC-en eller adapteren stopper', 'Ingen kommandorammer kommer fram, og etter 2 s nullstiller KjoreverkLink alle kommandoer.'),
    ('PLS-en slutter å sende', 'Etter 3 s blir pls.link false. Alle pls-tagger, og hver beregning som bruker en av dem, blir foreldet, og en advarselshendelse vises.'),
    ('TCP-forbindelsen faller ut', 'PLS-en nullstiller kommandoene. Adapteren prøver å koble til igjen hvert sekund, og kommandobitene starter nullstilt.'),
]
cw, gap = (W - 96 - 3 * 16) / 4, 16
x = 48
hs = []
for t, body in cards:
    hs.append(s.box(x, F + 18, cw, t, [body], accent=GREEN, title_size=14, min_h=120))
    x += cw + gap
sug_y = F + 18 + max(hs) + 16
sug_h = s.box(48, sug_y, W - 96, 'Forslag til KjoreverkLink, ikke med i v0.8 ennå', [
    'Etter et tidsavbrudd for kommandoene bør hver bit måtte ses som false før den kan virke igjen, så en drive ikke kan starte på nytt av seg selv når rammene kommer tilbake.'],
    accent=GREEN, dash='5 4', fill=BG, title_size=14)

s.h = int(sug_y + sug_h + 40)
open(OUT, 'w', encoding='utf-8').write(s.render())
print('plc-ouc.svg written, height', s.h)
