"""architecture.svg - hvordan HMI core henger sammen med PLS-en, og hvordan en verdi beveger seg."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'architecture.svg')

W, H = 1600, 1110
s = Svg(W, H, 'HMI core-arkitektur: PLS-en, binary-adapter.js, huben, HMI-en, recorderen og databaseleseren')

# ---------------------------------------------------------------- tittel og forklaring
s.add(s.text(48, 62, 'HMI core: slik henger det sammen', 30, INK, 600))
s.add(s.text(48, 92, 'PLS-en til venstre, operatørene til høyre. Verdier går mot høyre, kommandoer mot venstre. Recorderen lagrer det reglene velger.', 15, INK2))
s.legend(48, 128, [(AMBER, 'verdier og status', False), (BLUE, 'kommandoer (skriving)', False),
                   (CYAN, 'konfigurasjon, prosjekt og filer', False), (VIOLET, 'beregnede tagger', False),
                   (INK3, 'PLS-ens egen protokoll (TCP)', True)])

# kolonner
PX, PW = 48, 212          # PLS
AX, AW = 318, 296         # adapter, layout, recorder, database
HX, HW = 744, 400         # hub og prosjektmappe
BX, BW = 1260, 292        # nettlesere
TOP = 196
for x, label in [(PX, 'PLS'), (AX, 'Adapter'), (HX, 'Hub'), (BX, 'Nettlesere')]:
    s.add(s.text(x, TOP - 14, label, 15, INK3, 600))

# ---------------------------------------------------------------- adapteren og layoutfilen
a1 = TOP
h1 = s.box(AX, a1, AW, 'binary-adapter.js', [
    'Leser blokkene fra PLS-en og gjør hvert felt om til en tag (kv_1.*).',
    'Sender kommandoblokken tilbake ved hver endring og hvert 500 ms.',
    ('Alarmer fra faultCode og warnCode; kv_1.link sier om forbindelsen er oppe.', INK3)],
    accent=AMBER, mono_title=True)
a1c = a1 + h1 / 2
a2 = a1 + h1 + 30
h2 = s.box(AX, a2, AW, 'kjoreverk-layout.json', [
    'Layoutfilen: offset, type og navn for hvert felt i statusblokken og kommandoblokken.'],
    accent=CYAN, mono_title=True)
s.arrow(AX + AW / 2, a2 - 2, AX + AW / 2, a1 + h1 + 3, CYAN, sw=1.6)
s.add(s.text(AX + AW / 2 + 10, a1 + h1 + 20, 'leses ved start', 12, CYAN, 500))

# ---------------------------------------------------------------- PLS-en
ph1 = s.box(PX, TOP, PW, 'Siemens S7-1200', [
    'Sender statusblokken (112 byte) med TSEND_C og tar imot kommandoblokken (46 byte) med TRCV_C.'],
    sub='KjoreverkLink v0.8', accent=INK3, title_size=14)
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
    ('history', 'Historikk, hendelser og alarmer', ['De siste 600 punktene for hver numeriske tag, de siste 200 hendelsene og alarmlisten med kvittering, holdt i minnet.'], AMBER),
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

# ---------------------------------------------------------------- recorderen, ved siden av huben
r1 = a2 + h2 + 46
rh = s.box(AX, r1, AW, 'recorder.js', [
    'Følger alle tagger og hendelser gjennom huben, og lagrer det lagringsreglene velger.',
    'Svarer trender som går lenger tilbake enn hubens minne.',
    ('Regler og pauser: recorder.rules.json', INK3)],
    accent=AMBER, mono_title=True)
rc = r1 + rh / 2

# ---------------------------------------------------------------- databasen og databaseleseren, nederst
dbs_y = max(r1 + rh + 56, py + ph + 40, TOP + b_h + 40)
dh = s.box(AX, dbs_y, AW, 'SQLite-database', [
    ('data/recorder.db', INK2, True),
    'Verdier, hendelser, tagnavn og et minuttsammendrag for lange trender.'], accent=AMBER)
bh = s.box(BX, dbs_y, BW, 'Databaseleseren', [
    'Hva som lagres per tag, lagringsregler og pause, tagnavn, tabellene og SQL.',
    ('Henter taglisten og tagnavnene fra huben.', INK3)],
    sub='db-browser.js, http://pi:8088', accent=CYAN)
s.arrow(AX + AW / 2, r1 + rh + 3, AX + AW / 2, dbs_y - 3, AMBER, sw=1.8)
s.add(s.text(AX + AW / 2 + 10, r1 + rh + 32, 'skriver samlet, hvert 30. s', 12, AMBER, 500))
dc = dbs_y + min(dh, bh) / 2
s.arrow(AX + AW + 3, dc, BX - 3, dc, CYAN, both=True)
s.add(s.text((AX + AW + BX) / 2, dc - 12, 'leser databasen, skriver lagringsreglene', 12.5, CYAN, 500, 'middle'))

# ---------------------------------------------------------------- flyt
# hver forbindelse er et par: verdier mot høyre (amber) over kommandoer mot venstre (blått)
def pair(x1, x2, y, gap=7):
    s.arrow(x1 + 3, y - gap, x2 - 3, y - gap, AMBER)
    s.arrow(x2 - 3, y + gap, x1 + 3, y + gap, BLUE)

gx = (AX + AW + HX) / 2
pair(AX + AW, HX, a1c)
s.add(s.text(gx, a1c - 22, 'update, event', 12.5, AMBER, 500, 'middle'))
s.add(s.text(gx, a1c + 34, 'write', 12.5, BLUE, 500, 'middle'))
s.add(s.text(gx, a1c + 52, 'WebSocket, JSON', 12, INK3, 400, 'middle'))

# recorderen får verdiene fra huben, og svarer trendenes spørsmål
s.arrow(HX - 3, rc - 7, AX + AW + 3, rc - 7, AMBER)
s.arrow(AX + AW + 3, rc + 7, HX - 3, rc + 7, AMBER, dash='5 4', sw=1.6)
s.add(s.text(gx, rc - 22, 'verdier, hendelser', 12.5, AMBER, 500, 'middle'))
s.add(s.text(gx, rc + 34, 'svar til trender', 12.5, AMBER, 500, 'middle'))

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
RY = max(dbs_y + max(dh, bh), py + ph, TOP + b_h) + 64
s.add(s.text(48, RY, 'En verdis rundtur', 20, INK, 600))
steps = [
    ('Måle', 'PLS-en sender statusblokken. binary-adapter.js gjør feltene om til tagger og sender update for dem som er endret.', AMBER),
    ('Lagre', 'Huben tar vare på verdien og kvaliteten, og regner ut på nytt hver calc.* som bruker den. Recorderen lagrer den hvis en regel sier det.', AMBER),
    ('Vise', 'Huben sender update til hver nettleser som viser taggen, og widgetene tegnes på nytt.', AMBER),
    ('Kommando', 'En operatør trykker på et betjeningselement. Skrivingen går via huben til binary-adapter.js, som setter den i kommandoblokken til PLS-en.', BLUE),
    ('Bekrefte', 'Adapteren sender verdien i kommandoblokken tilbake som ekko. Alle nettlesere viser den, og PLS-en handler på den.', AMBER),
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
s.add(s.text(48, note_y, 'Faller PLS-en eller adapteren ut, blir taggene foreldet: siste verdi står i grått, alarmen No data from the PLC kommer etter 2 s, og beregninger som bruker dem, blir også foreldet.', 14, INK2))

s.h = int(note_y + 40)
open(OUT, 'w', encoding='utf-8').write(s.render())
print('architecture.svg written, content ends at y', note_y, 'of', H)
