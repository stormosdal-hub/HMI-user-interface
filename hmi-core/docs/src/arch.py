"""architecture.svg - hvordan HMI core henger sammen med PLS-en, og hvordan en verdi beveger seg."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'architecture.svg')

W, H = 1600, 1110
s = Svg(W, H, 'HMI core-arkitektur: PLS-en med TcpLink, tcplink-adapter.js, huben og HMI-en')

# ---------------------------------------------------------------- tittel og forklaring
s.add(s.text(48, 62, 'HMI core: slik henger det sammen', 30, INK, 600))
s.add(s.text(48, 92, 'PLS-en til venstre, operatørene til høyre. Verdier går mot høyre, kommandoer mot venstre.', 15, INK2))
s.legend(48, 128, [(AMBER, 'verdier og status', False), (BLUE, 'kommandoer (skriving)', False),
                   (CYAN, 'konfigurasjon, prosjekt og filer', False), (VIOLET, 'beregnede tagger', False),
                   (INK3, 'PLS-ens egen protokoll (TCP)', True)])

# kolonner
PX, PW = 48, 212          # PLS
AX, AW = 318, 296         # adapter og innstillingsfil
HX, HW = 744, 400         # hub og prosjektmappe
BX, BW = 1260, 292        # nettlesere
TOP = 196
for x, label in [(PX, 'PLS'), (AX, 'Adapter'), (HX, 'Hub'), (BX, 'Nettlesere')]:
    s.add(s.text(x, TOP - 14, label, 15, INK3, 600))

# ---------------------------------------------------------------- adapteren og innstillingsfilen
a1 = TOP
h1 = s.box(AX, a1, AW, 'tcplink-adapter.js', [
    'Gjør hver plass i TcpLink om til en tag (kv_1.bit00, kv_1.reals_0 …), med navnet og enheten fra PLS-en.',
    'Sender kommandorammen tilbake ved hver endring og hvert 500 ms.',
    'Legger det PLS-en har logget, tilbake i hubens historikk (restore).',
    ('Ingen layoutfil: størrelsene står i headeren. kv_1.link sier om forbindelsen er oppe.', INK3)],
    accent=AMBER, mono_title=True)
a1c = a1 + h1 / 2
a2 = a1 + h1 + 30
h2 = s.box(AX, a2, AW, 'kjoreverk-options.json', [
    'Det PLS-en ikke kan si: adressen, tagprefikset, alarmer, bitene i statusordet og hold-for-å-kjøre.'],
    sub='adapters/tcplink-options/', accent=CYAN, mono_title=True)
s.arrow(AX + AW / 2, a2 - 2, AX + AW / 2, a1 + h1 + 3, CYAN, sw=1.6)
s.add(s.text(AX + AW / 2 + 10, a1 + h1 + 20, 'leses ved start', 12, CYAN, 500))

# ---------------------------------------------------------------- PLS-en
ph1 = s.box(PX, TOP, PW, 'Siemens S7-1200', [
    'Sender data (196 byte) ved endring og minst én gang i sekundet, og navnene fra LinkNames ved hver tilkobling.',
    'Logger endringer i en retentiv ringbuffer og sender hele den ved hver tilkobling.',
    'Tar imot kommandorammen (80 byte); er den borte i 2 s, nullstilles rx.'],
    sub='TcpLink, LinkNames og LinkHistory', accent=INK3, title_size=14)
s.arrow(PX + PW, a1c, AX - 2, a1c, INK3, both=True, dash='5 4', sw=1.6)
s.add(s.text((PX + PW + AX) / 2, a1c - 12, 'TCP', 12, INK3, 500, 'middle'))
s.add(s.text((PX + PW + AX) / 2, a1c + 22, 'port 2000', 12, INK3, 400, 'middle'))

# ---------------------------------------------------------------- huben
hub_head = 58
parts_y = TOP + hub_head
inner_w = HW - 32
ys = {}
yy = parts_y
for key, title, lines, acc in [
    ('broker', 'Tag-broker', ['Hver tag med verdi, kvalitet og eier. Nettlesere abonnerer på tagger; en skriving går til adapteren som eier taggen.'], AMBER),
    ('history', 'Historikk, hendelser og alarmer', ['De siste 600 endringene for hver numeriske tag, også det PLS-en har logget, de siste 200 hendelsene og alarmlisten med kvittering, holdt i minnet.'], AMBER),
    ('calc', 'Beregninger og kontroller', ['calc.*-tagger fra formler satt opp i HMI-en: hastighet i rpm, effekt, betingelser og kontroller over tid. De fortsetter å kjøre selv om alle nettlesere er lukket.'], VIOLET),
    ('web', 'Webserver', ['Leverer HMI-appen, prosjektfilen, tegninger, animasjonskode, kodetekster og tagnavn.'], CYAN),
]:
    hh = s.box(HX + 16, yy, inner_w, title, lines, accent=acc, fill=PANEL2, title_size=14)
    ys[key] = (yy, hh)
    yy += hh + 12
hub_h = yy - TOP + 6
# rammen bak delene
s.parts.insert(len(s.parts) - 4, f'<g class="box">{s.rect(HX, TOP, HW, hub_h, PANEL, LINE)}'
               f'{s.text(HX + 20, TOP + 30, "hub.js", 17, INK, 600, mono=True)}'
               f'{s.text(HX + 96, TOP + 30, "Node.js, http://pi:8080", 13, INK3, 400)}</g>')

# ---------------------------------------------------------------- prosjektmappen
py = TOP + hub_h + 70
ph = s.box(HX, py, HW, 'Prosjektmappe', [
    ('hmi.json: skjermbilder, widgeter, kort, variabler, beregninger, passkode', INK2),
    ('codes.json og tagnames.json: kodetekster og dine egne tagnavn', INK2),
    ('assets/: tegninger (.svg) og animasjonskode (.js)', INK2)],
    sub='config/ i hmi-core, eller en egen mappe', accent=CYAN)
s.arrow(HX + HW / 2, TOP + hub_h + 4, HX + HW / 2, py - 4, CYAN, both=True)
s.add(s.text(HX + HW / 2 + 12, TOP + hub_h + 40, 'leses ved start, skrives ved Save', 12.5, CYAN, 500))

# ---------------------------------------------------------------- nettlesere: HMI-en
bh_head = 64
yy = TOP + bh_head
bparts = {}
for key, title, lines, acc, dash in [
    ('run', 'Run-modus', ['Widgeter bundet til tagger: verdier, målere, stolper, trender, alarmer, tegninger og kort med faner. Betjeningselementer skriver kommandotagger.'], AMBER, None),
    ('edit', 'Edit-modus', ['Bak en valgfri passkode. Palett, egenskaper, kort og flervalg, pluss editorer for tegninger, beregninger, animasjonskode og tagnavn.'], CYAN, None),
    ('anim', 'Animasjonssandkasse', ['Three.js kjører i en lukket ramme. Tagverdier går inn; ingenting kommer ut.'], AMBER, '5 4'),
]:
    hh = s.box(BX + 16, yy, BW - 32, title, lines, accent=acc, fill=PANEL2, title_size=14, dash=dash)
    bparts[key] = (yy, hh)
    yy += hh + 12
b_h = yy - TOP + 6
s.parts.insert(len(s.parts) - 3, f'<g class="box">{s.rect(BX, TOP, BW, b_h, PANEL, LINE)}'
               f'{s.text(BX + 20, TOP + 28, "HMI-en", 17, INK, 600)}'
               f'{s.text(BX + 20, TOP + 48, "så mange du vil, på http://pi:8080", 13, INK3, 400)}</g>')

# ---------------------------------------------------------------- flyt
# hver forbindelse er et par: verdier mot høyre (amber) over kommandoer mot venstre (blått)
def pair(x1, x2, y, gap=7):
    s.arrow(x1 + 3, y - gap, x2 - 3, y - gap, AMBER)
    s.arrow(x2 - 3, y + gap, x1 + 3, y + gap, BLUE)

gx = (AX + AW + HX) / 2
pair(AX + AW, HX, a1c)
s.add(s.text(gx, a1c - 22, 'update, event, restore', 12.5, AMBER, 500, 'middle'))
s.add(s.text(gx, a1c + 34, 'write', 12.5, BLUE, 500, 'middle'))
s.add(s.text(gx, a1c + 52, 'WebSocket, JSON', 12, INK3, 400, 'middle'))

ry, rrh = bparts['run']
rcy = ry + rrh / 2
hx2, bgx = HX + HW, (HX + HW + BX) / 2
pair(hx2, BX, rcy)
s.add(s.text(bgx, rcy - 36, 'update, tags,', 12.5, AMBER, 500, 'middle'))
s.add(s.text(bgx, rcy - 21, 'events, alarms', 12.5, AMBER, 500, 'middle'))
s.add(s.text(bgx, rcy + 34, 'write, ack', 12.5, BLUE, 500, 'middle'))
wy, wh = ys['web']
wc = wy + wh / 2
s.arrow(hx2 + 3, wc, BX - 3, wc, CYAN, both=True)
s.add(s.text(bgx, wc - 26, 'HTTP: appen,', 12.5, CYAN, 500, 'middle'))
s.add(s.text(bgx, wc - 11, 'prosjekt, filer', 12.5, CYAN, 500, 'middle'))

# beregningene publiserer calc.*-tagger tilbake til brokeren
by, bhh = ys['broker']
cy2, ch = ys['calc']
xr = HX + HW - 16
s.path_arrow(f'M{xr + 1} {cy2 + ch / 2} C {xr + 13} {cy2 + ch / 2}, {xr + 13} {by + bhh / 2}, {xr + 4} {by + bhh / 2}', VIOLET, sw=1.6)

# ---------------------------------------------------------------- en verdis rundtur (en ekte sekvens, derfor nummerert)
RY = max(a2 + h2, py + ph, TOP + b_h) + 64
s.add(s.text(48, RY, 'En verdis rundtur', 20, INK, 600))
steps = [
    ('Måle', 'PLS-en sender en datamelding når noe endres. tcplink-adapter.js gjør plassene om til tagger og sender update for dem som er endret.', AMBER),
    ('Lagre', 'Huben tar vare på verdien og kvaliteten i minnet, og regner ut på nytt hver calc.* som bruker den.', AMBER),
    ('Vise', 'Huben sender update til hver nettleser som viser taggen, og widgetene tegnes på nytt.', AMBER),
    ('Kommando', 'En operatør trykker på et betjeningselement. Skrivingen går via huben til tcplink-adapter.js, som setter den i kommandorammen til PLS-en.', BLUE),
    ('Bekrefte', 'Adapteren sender verdien i kommandorammen tilbake som ekko. Alle nettlesere viser den, og PLS-en handler på den.', AMBER),
]
cw, gap = 288, 16
x = 48
heights = []
for i, (t, body, col) in enumerate(steps):
    heights.append(s.box(x, RY + 18, cw, f'{i + 1}. {t}', [body], accent=col, title_size=15, min_h=132))
    if i < len(steps) - 1:
        s.arrow(x + cw + 1, RY + 18 + 66, x + cw + gap - 1, RY + 18 + 66, INK3, sw=1.4)
    x += cw + gap
note_y = RY + 18 + max(heights) + 30
s.add(s.text(48, note_y, 'Kommer det ingenting fra PLS-en på 3 s, eller faller adapteren ut, blir taggene foreldet: siste verdi står i grått, og beregninger som bruker dem, blir også foreldet.', 14, INK2))
s.add(s.text(48, note_y + 22, 'Alarmen No data from the PLC kommer 2 s etter at kv_1.link er blitt false.', 14, INK2))
note_y += 22

s.h = int(note_y + 40)
open(OUT, 'w', encoding='utf-8').write(s.render())
print('architecture.svg written, content ends at y', note_y, 'of', H)
