"""replay.svg - forslag: opplasting til en sentral server, og en egen avspillingsmotor som spiller av
PLS-ringen etter et strømbrudd, med de samme beregningene som huben, uten å røre huben."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'replay.svg')

W, H = 1600, 1600
s = Svg(W, H, 'Forslag: opplasting til en sentral server, og avspilling av PLS-ringen etter et strømbrudd')

HEAD = 64        # tittel og undertittel øverst i en ramme
frames = []      # rammene settes inn bak boksene sine til slutt, når høydene er kjent


def frame(at, x, y, w, h, title, sub=None, mono=True):
    """En ramme rundt en gruppe bokser. at = len(s.parts) før boksene ble lagt til."""
    g = s.rect(x, y, w, h, PANEL, LINE) + s.text(x + 20, y + 30, title, 17, INK, 600, mono=mono)
    if sub:
        g += s.text(x + 20, y + 50, sub, 12.5, INK3)
    frames.append((at, f'<g class="box">{g}</g>'))


def measure(w, title, lines, **kw):
    """Høyden en boks ville fått, uten å tegne den."""
    return Svg(0, 0, '').box(0, 0, w, title, lines, **kw)


# ---------------------------------------------------------------- tittel og forklaring
s.add(s.text(48, 62, 'Forslag: opplasting og avspilling etter strømbrudd', 30, INK, 600))
s.add(s.text(48, 92, 'Øverst går sanntidsdata fra huben til serveren. Nederst spiller en egen avspillingsmotor av PLS-ringen etter et strømbrudd, '
                     'med de samme beregningene, uten å røre huben.', 15, INK2))
s.legend(48, 128, [(AMBER, 'sanntidsdata', False), (GREEN, 'gjenopprettede data', False), (VIOLET, 'beregninger', False),
                   (CYAN, 'kode og konfigurasjon som deles', False), (INK3, 'PLS-ens protokoll (TCP)', True),
                   (RED, 'ingen forbindelse', True)])

# kolonner
PX, PW = 48, 210          # PLS
AX, AW = 340, 200         # adapter
HX, HW = 620, 290         # hub
UX, UW = 990, 250         # opplaster
SX, SW = 1330, 222        # server
TOP = 196
for x, label in [(PX, 'PLS'), (AX, 'Raspberry Pi, i hvert kjøretøy'), (SX, 'Sentral server')]:
    s.add(s.text(x, TOP - 14, label, 15, INK3, 600))

# ================================================================ rad 1: sanntid
R1 = TOP
ah = s.box(AX, R1, AW, 'tcplink-adapter.js', [
    'Gjør meldingene fra TcpLink om til tagger: kv_1.bit00, kv_1.ints_0 …',
    ('Pluss kv_1.log_seq: PLS-ens loggteller.', INK3)],
    sub='som i dag', accent=AMBER, mono_title=True)

at = len(s.parts)
yy = R1 + HEAD
hub = {}
for key, title, lines, acc in [
    ('broker', 'Tag-broker', ['Siste verdi og kvalitet for hver tag. HMI-ene abonnerer her.'], AMBER),
    ('calc', 'Beregninger', ['calc.*-tagger fra lib/calc-engine.js. Klokke: når verdien kom fram.'], VIOLET),
    ('alarm', 'Alarmer og hendelser', ['Følger verdiene i sanntid, stemplet med tiden nå.'], AMBER),
]:
    hh = s.box(HX + 14, yy, HW - 28, title, lines, accent=acc, fill=PANEL2, title_size=14)
    hub[key] = (yy, hh)
    yy += hh + 10
hub_h = yy - R1 + 4
frame(at, HX, R1, HW, hub_h, 'hub.js', 'som i dag; beregningene ligger i lib/')

uh = s.box(UX, R1, UW, 'uploader.js', [
    'Recorderen med HTTP i stedet for SQLite. Følger huben kun for lesing og bruker lagringsreglene.',
    'Holder alt i RAM til serveren har svart OK, og sender hvert 10.–30. sekund.',
    ('Hver klump har med loggtelleren, så serveren vet hvor langt sanntidsdataene rekker.', INK3)],
    sub='ny, erstatter recorder.js', accent=AMBER, mono_title=True)
row1_bottom = R1 + max(ah, hub_h, uh)

# ================================================================ rad 2: felles kode og konfigurasjon
R2 = row1_bottom + 76
at = len(s.parts)
SHX, SHW = HX, UX + UW - HX
iw = (SHW - 28 - 12) / 2
ce = ('lib/calc-engine.js', [
    'Rekkefølge, kvalitet, hendelser og en tick hvert 100 ms. Klokken gis inn utenfra:',
    ('huben: når verdien kom fram', VIOLET),
    ('avspillingen: PLS-tiden i posten', GREEN)])
asis = ('Brukes som de er', [
    ('lib/calc.js og lib/record-rules.js', INK2, True),
    'Formlene og lagringsreglene. Tar allerede tiden som argument.',
    ('hmi.json og recorder.rules.json', INK2, True),
    'Beregningene, variablene og reglene. Alle leser de samme filene.'])
shared_min = max(measure(iw, *ce, sub='ny, flyttet ut av hub.js', mono_title=True, title_size=14),
                 measure(iw, *asis, title_size=14))
s.box(SHX + 14, R2 + HEAD, iw, *ce, sub='ny, flyttet ut av hub.js', accent=VIOLET, fill=PANEL2,
      mono_title=True, title_size=14, min_h=shared_min)
s.box(SHX + 14 + iw + 12, R2 + HEAD, iw, *asis, accent=CYAN, fill=PANEL2, title_size=14, min_h=shared_min)
sh_h = HEAD + shared_min + 14
frame(at, SHX, R2, SHW, sh_h, 'Felles kode og konfigurasjon', 'samme kode, to klokker', mono=False)

# ================================================================ rad 3: avspillingen
R3 = R2 + sh_h + 76
at = len(s.parts)
RX, RW = AX, UX + UW - AX
sgap = 30
steps3 = [
    ('1. Hent', 'Ber PLS-ringen om postene som mangler, rett etter oppstart, før ringen skriver over dem.', GREEN),
    ('2. Gjør om til tagger', 'De samme tagnavnene som tcplink-adapter.js lager: kv_1.bit00, kv_1.ints_0 …', GREEN),
    ('3. Egne beregninger', 'En egen lib/calc-engine.js med PLS-tiden som klokke, og tick hvert 100 ms mellom postene.', VIOLET),
    ('4. Egne lagringsregler', 'De samme reglene som opplasteren, så de gjenopprettede dataene ser ut som sanntidsdataene.', CYAN),
]
sw3 = (RW - 28 - (len(steps3) - 1) * sgap) / len(steps3)
h3 = max(measure(sw3, t, [b], title_size=14) for t, b, c in steps3)
centers3 = []
for i, (t, b, c) in enumerate(steps3):
    x = RX + 14 + i * (sw3 + sgap)
    s.box(x, R3 + HEAD, sw3, t, [b], accent=c, fill=PANEL2, title_size=14, min_h=h3)
    centers3.append(x + sw3 / 2)
    if i:
        s.arrow(x - sgap + 3, R3 + HEAD + h3 / 2, x - 3, R3 + HEAD + h3 / 2, GREEN, sw=1.6)
note, ny = s.para(RX + 20, R3 + HEAD + h3 + 6, RW - 40,
                  'Resultatet går til serveren merket gjenopprettet, og avspillingen prøver igjen til serveren svarer. '
                  'Den sender aldri noe til huben.', 12.5, INK3)
s.add(note)
r_h = ny - R3 + 14

# ================================================================ PLS-en og serveren, på høyde med radene
at_plc = len(s.parts)
t_y = R1 + HEAD
t_h = s.box(PX + 12, t_y, PW - 24, 'TcpLink', [
    'Sanntidsdata ved endring, som i dag.',
    ('Ny: loggtelleren i en ledig dint.', INK3)],
    sub='port 2000', accent=AMBER, fill=PANEL2, title_size=14)
ring_y = R3 + HEAD
ring_h = s.box(PX + 12, ring_y, PW - 24, 'Loggring', [
    'De siste ~250 postene. Skriver alltid over de eldste.',
    'Svarer på HENT fra en seq. Ingen kvittering.'],
    sub='retain, port 2100', accent=GREEN, fill=PANEL2, title_size=14)
mid_txt, _ = s.para(PX + 20, (t_y + t_h + ring_y) / 2 - 30, PW - 40,
                    'To OUC-blokker side om side, hver med sin connId og port.', 12.5, INK3)
s.add(mid_txt)

at_srv = len(s.parts)
api_y = R1 + HEAD
api_h = s.box(SX + 12, api_y, SW - 24, 'HTTP-API og database', [
    'Tar imot klumper fra opplasteren og avspillingen, og svarer OK etter COMMIT.',
    'Unik nøkkel per rad: en klump som kommer to ganger, lagres én gang.',
    ('Hver rad er merket sanntid eller gjenopprettet.', INK3)],
    accent=AMBER, fill=PANEL2, title_size=14)
cov_y = R3 + HEAD
cov_h = s.box(SX + 12, cov_y, SW - 24, 'Dekning', [
    'Siste loggteller i sanntidsdataene før et brudd, og den første etter.',
    'Svarer avspillingen på hvilke poster som mangler.'],
    accent=GREEN, fill=PANEL2, title_size=14)

# de tre rammene i rad 3 slutter på samme høyde
bottom3 = max(R3 + r_h, ring_y + ring_h + 14, cov_y + cov_h + 14)
frame(at, RX, R3, RW, bottom3 - R3, 'replay.js', 'avspillingsmotoren, ny. Kjører etter oppstart når serveren mangler data.')
frame(at_plc, PX, R1, PW, bottom3 - R1, 'S7-1200', 'i hvert kjøretøy', mono=False)
frame(at_srv, SX, R1, SW, bottom3 - R1, 'Server', 'én for alle 42 kjøretøy', mono=False)

# ================================================================ piler
by, bh = hub['broker']
yb = by + bh / 2

# PLS -> adapter, TcpLink som i dag
tc = t_y + t_h / 2
s.arrow(PX + PW + 3, tc, AX - 3, tc, INK3, both=True, dash='5 4', sw=1.6)
s.add(s.text((PX + PW + AX) / 2, tc - 12, 'TCP', 12, INK3, 500, 'middle'))
s.add(s.text((PX + PW + AX) / 2, tc + 22, 'port 2000', 12, INK3, 400, 'middle'))

# adapter -> hub -> opplaster
s.arrow(AX + AW + 3, yb, HX - 3, yb, AMBER)
s.add(s.text((AX + AW + HX) / 2, yb - 12, 'update', 12.5, AMBER, 500, 'middle'))
s.arrow(HX + HW + 3, yb, UX - 3, yb, AMBER)
s.add(s.text((HX + HW + UX) / 2, yb - 12, 'alle tagger', 12.5, AMBER, 500, 'middle'))
s.add(s.text((HX + HW + UX) / 2, yb + 22, 'kun lesing', 12, INK3, 400, 'middle'))

# opplaster <-> server
ys = api_y + min(api_h, uh - (api_y - R1)) / 2
gx = (UX + UW + SX) / 2
s.arrow(UX + UW + 3, ys - 7, SX - 3, ys - 7, AMBER)
s.arrow(SX - 3, ys + 7, UX + UW + 3, ys + 7, AMBER, dash='5 4', sw=1.6)
s.add(s.text(gx, ys - 20, 'klumper', 12.5, AMBER, 500, 'middle'))
s.add(s.text(gx, ys + 32, 'OK', 12.5, AMBER, 500, 'middle'))

# PLS-ringen -> avspillingen
rc = ring_y + min(ring_h, h3) / 2
s.arrow(PX + PW + 3, rc, RX - 3, rc, INK3, both=True, dash='5 4', sw=1.6)
s.add(s.text((PX + PW + RX) / 2, rc - 12, 'TCP', 12, INK3, 500, 'middle'))
s.add(s.text((PX + PW + RX) / 2, rc + 22, 'port 2100', 12, INK3, 400, 'middle'))

# avspillingen <-> server
yr = R3 + HEAD + min(h3, cov_h) / 2
gx = (RX + RW + SX) / 2
s.arrow(RX + RW + 3, yr - 7, SX - 3, yr - 7, GREEN)
s.arrow(SX - 3, yr + 7, RX + RW + 3, yr + 7, GREEN, dash='5 4', sw=1.6)
s.add(s.text(gx, yr - 20, 'gjenopprettet', 12, GREEN, 500, 'middle'))
s.add(s.text(gx, yr + 32, 'hva mangler', 12, GREEN, 500, 'middle'))

# felles kode: opp til huben og opplasteren, ned til avspillingen
cx_hub, cx_up = HX + HW / 2, UX + UW / 2
s.arrow(cx_hub, R2 - 3, cx_hub, R1 + hub_h + 3, CYAN, sw=1.6)
s.add(s.text(cx_hub + 10, (R2 + R1 + hub_h) / 2 + 4, 'samme beregninger', 12.5, CYAN, 500))
s.arrow(cx_up, R2 - 3, cx_up, R1 + uh + 3, CYAN, sw=1.6)
s.add(s.text(cx_up + 10, (R2 + R1 + uh) / 2 + 4, 'samme regler', 12.5, CYAN, 500))
for cx, label in [(centers3[2], 'samme beregninger'), (centers3[3], 'samme regler')]:
    s.arrow(cx, R2 + sh_h + 3, cx, R3 - 3, CYAN, sw=1.6)
    s.add(s.text(cx + 10, (R2 + sh_h + R3) / 2 + 4, label, 12.5, CYAN, 500))

# ingen forbindelse mellom huben og avspillingen
ry0 = R1 + hub_h - 26
vx = AX + 22
s.add(f'<path d="M{HX - 3} {ry0} H{vx} V{R3 - 3}" fill="none" stroke="{RED}" stroke-width="1.8" stroke-dasharray="5 4"/>')
cy = (ry0 + R3) / 2
s.add(f'<circle cx="{vx}" cy="{cy}" r="11" fill="{BG}" stroke="{RED}" stroke-width="1.8"/>')
s.add(f'<path d="M{vx - 4.5} {cy - 4.5} L{vx + 4.5} {cy + 4.5} M{vx + 4.5} {cy - 4.5} L{vx - 4.5} {cy + 4.5}" '
      f'stroke="{RED}" stroke-width="2" stroke-linecap="round"/>')
s.add(s.text(vx + 22, cy - 40, 'Ingen forbindelse', 13, RED, 600))
p, _ = s.para(vx + 22, cy - 36, AX + AW - vx - 22,
              'Avspillingen sender aldri noe til huben. Gamle verdier når aldri HMI-en, alarmene eller hendelsesloggen.',
              12.5, INK2)
s.add(p)

# rammene bak boksene sine, bakerst først så de tidligere plassene står stille
for at, g in sorted(frames, key=lambda f: -f[0]):
    s.parts.insert(at, g)

# ================================================================ etter et strømbrudd (en ekte sekvens, derfor nummerert)
RY = bottom3 + 70
s.add(s.text(48, RY, 'Etter et strømbrudd', 20, INK, 600))
steps = [
    ('Strømmen er tilbake', 'PLS-en er i gang etter noen sekunder og logger videre i ringen. RAM-bufferen på Pi-en er borte.', INK3),
    ('Sanntid igjen', 'Pi-en starter, og huben og opplasteren går som vanlig. Den første meldingen viser loggtelleren der sanntidsdataene begynner, f.eks. 1188.', AMBER),
    ('Hent med en gang', 'Avspillingen henter postene før 1188 fra ringen og holder dem i RAM, før ringen rekker å skrive over dem.', GREEN),
    ('Spør serveren', 'Når WiFi er oppe: serveren har sanntidsdata til og med 1041. Det som mangler, er 1042–1187.', GREEN),
    ('Spill av', 'Postene går gjennom egne kopier av beregningene og lagringsreglene, med PLS-tiden som klokke.', VIOLET),
    ('Send', 'Resultatet går til serveren merket gjenopprettet. Huben, HMI-en og alarmene har ikke merket noe.', GREEN),
]
gap = 16
cw = (W - 96 - (len(steps) - 1) * gap) / len(steps)
hs = max(measure(cw, f'{i + 1}. {t}', [b]) for i, (t, b, c) in enumerate(steps))
x = 48
for i, (t, b, c) in enumerate(steps):
    s.box(x, RY + 18, cw, f'{i + 1}. {t}', [b], accent=c, min_h=hs)
    if i < len(steps) - 1:
        s.arrow(x + cw + 1, RY + 18 + hs / 2, x + cw + gap - 1, RY + 18 + hs / 2, INK3, sw=1.4)
    x += cw + gap

ny = RY + 18 + hs + 14
for text in [
    'Det som ikke kan gjenopprettes: beregningene i et gjenopprettet tidsrom blir aldri bedre enn oppløsningen i PLS-ringen, '
    'og en beregning som bruker en tag ringen ikke har med, får ingen verdi, akkurat som i huben. Går strømmen etter et '
    'WiFi-brudd som varte lenger enn ringen rekker, mangler det eldste.',
    'Klokka: avspillingen bruker PLS-klokka, huben bruker Pi-klokka. Synkroniser begge, eller la tcplink-adapter.js sende '
    'PLS-klokka med som ts, så tidene fra de to veiene passer sammen.',
]:
    p, ny = s.para(48, ny, W - 96, text, 14, INK2)
    s.add(p)
    ny += 8

s.h = int(ny + 30)
open(OUT, 'w', encoding='utf-8').write(s.render())
print('replay.svg written, content ends at y', round(ny), 'of', s.h)
