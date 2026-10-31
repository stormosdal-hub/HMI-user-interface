"""pi-files.svg - filene på Pi-en i kjøreverket: prosjektmappen, oppsettet install.sh skriver i /etc,
og tjenestene systemd starter. Vises i README_systemd-service.md."""
import os
from svgkit import *
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pi-files.svg')

W = 1600
s = Svg(W, 0, 'Filene på Pi-en i kjøreverket: prosjektmappen i /opt/kjoreverk, oppsettet i /etc og tjenestene systemd starter')

# ---------------------------------------------------------------- tittel og forklaring
s.add(s.text(48, 62, 'Filene på Pi-en i kjøreverket', 30, INK, 600))
s.add(s.text(48, 92, 'Prosjektmappen er lik på alle Pi-ene. install.sh skriver oppsettet for akkurat dette kjøreverket i /etc, og systemd starter programmene ut fra det.', 15, INK2))
s.legend(48, 128, [(AMBER, 'programmer tjenestene kjører', False), (CYAN, 'oppsett og prosjekt', False),
                   (GREEN, 'install.sh og det den gjør', False), (INK3, 'nettverket', True)])

IND = 24            # innrykk per nivå i treet
ROW = 26            # minste radhøyde


def tree(x, y, w, desc_x, entries):
    """Et filtre med forklaring: entries er (nivå, navn, forklaring, farge). Mapper slutter på /.
    Tegner navnene, forklaringene og linjene mellom dem; returnerer (y under siste rad, {navn: midt-y})."""
    rows = []
    cy = y
    for depth, name, desc, col in entries:
        lines = wrap(desc, x + w - desc_x - 20, 13) if desc else []
        h = max(ROW, len(lines) * 18 + 8)
        base = cy + 18
        rows.append((depth, name, desc, col, lines, base, cy + h))
        cy += h
    mids = {}
    for i, (depth, name, desc, col, lines, base, _) in enumerate(rows):
        nx = x + depth * IND
        mid = base - 4.5
        mids.setdefault(name, mid)
        if depth > 0:
            # forelderen: nærmeste rad over med ett nivå mindre
            p = next(r for r in reversed(rows[:i]) if r[0] == depth - 1)
            px = x + (depth - 1) * IND + 7
            s.add(f'<path d="M{px} {p[5] + 6} V{mid} H{nx - 5}" fill="none" stroke="{LINE}" stroke-width="1.2"/>')
        folder = name.endswith('/')
        s.add(s.text(nx, base, name, 13.5, INK if folder else col, 600 if folder or col != INK2 else 400, mono=True))
        for j, ln in enumerate(lines):
            s.add(s.text(desc_x, base + j * 18, ln, 13, INK2 if col != INK3 else INK3))
    return cy, mids


def panel(x, y, w, h, title, sub, accent):
    s.add(s.rect(x, y, w, h, PANEL, LINE))
    s.add(f'<rect x="{x}" y="{y + 12}" width="3" height="{h - 24}" rx="1.5" fill="{accent}"/>')
    s.add(s.text(x + 22, y + 34, title, 18, INK, 600, mono=True))
    s.add(s.text(x + 22, y + 58, sub, 13.5, INK3))


TOP = 168
start = len(s.parts)        # panelene tegnes bak innholdet når høyden er kjent
# ---------------------------------------------------------------- /opt/kjoreverk
OX, OW = 48, 742
opt_entries = [
    (0, 'install.sh', 'setter opp Pi-en', GREEN),
    (0, 'README_systemd-service.md', 'installasjonen og tjenestene', INK2),
    (0, '.gitattributes', 'holder install.sh med Unix-linjeskift', INK2),
    (0, 'hmi-core/', '', INK),
    (1, 'hub.js', 'huben og HMI-en', AMBER),
    (1, 'recorder.js', 'sender til den sentrale serveren', AMBER),
    (1, 'adapters/', '', INK),
    (2, 'tcplink-adapter.js', 'forbindelsen til PLS-en', AMBER),
    (2, 'tcplink-options/', '', INK),
    (3, 'kjoreverk-options.json', 'alarmene, bitene i ZSW1, hold-for-å-kjøre og PLS-ens adresse', CYAN),
    (1, 'lib/', 'calc.js, record-rules.js og vehicle.js, som programmene bruker', INK2),
    (1, 'hmi/', 'nettsiden til HMI-en', INK2),
    (1, 'config/', '', INK),
    (2, 'hmi.json', 'prosjektet: skjermbildene, variablene og beregningene', CYAN),
    (2, 'codes.json', 'tekstene til feil- og varselkodene', CYAN),
    (2, 'tagnames.json', 'dine egne navn på taggene, og hvilke som gir alarm (fra Tag-list)', CYAN),
    (2, 'assets/', 'tegningene (SVG)', CYAN),
    (1, 'node_modules/', 'ws og three, så Pi-en ikke trenger internett', INK2),
    (1, 'docs/', 'dokumentasjonen og diagrammene', INK2),
]
opt_end, opt_mid = tree(OX + 26, TOP + 84, OW - 26, OX + 330, opt_entries)
note_y = opt_end + 12
note, note_end = s.para(OX + 26, note_y, OW - 52, 'Huben skriver i config/ når du lagrer i HMI-en. Ellers skrives ingenting i mappen mens kjøreverket går.', 13, INK3)
s.add(note)
opt_h = note_end + 18 - TOP

# ---------------------------------------------------------------- /etc
EX, EW = 830, 722
etc_entries = [
    (0, 'kjoreverk/', '', INK),
    (1, 'vehicle', 'kjøreverkets navn: kv_52', CYAN),
    (1, 'recorder.json', 'serveren og nøkkelen; bare brukeren kan lese den (640, root:pi)', CYAN),
    (1, 'instances/', 'kommandolinjen til hver tjeneste, SCRIPT_ARGS=…', INK),
    (2, 'hub.env', 'hmi-core/hub.js', CYAN),
    (2, 'tcplink-adapter.env', 'hmi-core/adapters/tcplink-adapter.js --plc=10.0.123.51:2000', CYAN),
    (2, 'recorder.env', 'hmi-core/recorder.js', CYAN),
    (0, 'systemd/', '', INK),
    (1, 'system/', '', INK),
    (2, 'kjoreverk@.service', 'malen: node $SCRIPT_ARGS i /opt/kjoreverk, som pi, startes på nytt etter 2 s', CYAN),
    (2, 'multi-user.target.wants/', '', INK),
    (3, 'kjoreverk@hub.service …', 'lenkene systemctl enable lager: tjenestene starter ved oppstart', CYAN),
    (1, 'timesyncd.conf.d/', '', INK),
    (2, 'kjoreverk.conf', 'tidsserveren: NTP=10.0.0.104', CYAN),
    (1, 'journald.conf.d/', '', INK),
    (2, 'kjoreverk.conf', 'loggene i RAM: Storage=volatile', CYAN),
]
etc_end, etc_mid = tree(EX + 26, TOP + 84, EW - 26, EX + 330, etc_entries)
etc_h = max(etc_end + 18 - TOP, opt_h)
opt_h = etc_h

content, s.parts = s.parts, []
panel(OX, TOP, OW, opt_h, '/opt/kjoreverk', 'Prosjektmappen. Lik på alle Pi-ene: den kopieres hit.', AMBER)
panel(EX, TOP, EW, etc_h, '/etc', 'Oppsettet for dette kjøreverket. install.sh skriver det.', GREEN)
s.parts = content[:start] + s.parts + content[start:]

# install.sh skriver /etc
iy = opt_mid['install.sh']
s.arrow(OX + 450, iy, EX - 3, iy, GREEN, sw=2)
s.add(s.text(OX + 460, iy - 9, 'skriver oppsettet', 12.5, GREEN, 500))

# ---------------------------------------------------------------- systemd
SY = TOP + opt_h + 70
SH = 76
s.add(s.rect(48, SY, W - 96, SH, PANEL2, LINE))
s.add(f'<rect x="48" y="{SY + 12}" width="3" height="{SH - 24}" rx="1.5" fill="{AMBER}"/>')
s.add(s.text(70, SY + 31, 'systemd', 17, INK, 600, mono=True))
s.add(s.text(170, SY + 31, 'ved oppstart, og etter 2 s hvis et program stopper', 13.5, INK3))
s.add(s.text(70, SY + 57, 'For hver lenke i multi-user.target.wants: les malen og instances/<navn>.env, og kjør node $SCRIPT_ARGS i /opt/kjoreverk som pi.', 13.5, INK2))
# koden fra /opt, oppsettet fra /etc
s.arrow(OX + OW / 2, TOP + opt_h + 2, OX + OW / 2, SY - 3, AMBER, sw=1.8)
s.add(s.text(OX + OW / 2 + 12, TOP + opt_h + 40, 'koden og prosjektet', 12.5, AMBER, 500))
s.arrow(EX + EW / 2, TOP + etc_h + 2, EX + EW / 2, SY - 3, CYAN, sw=1.8)
s.add(s.text(EX + EW / 2 + 12, TOP + etc_h + 40, 'malen, kommandolinjene og lenkene', 12.5, CYAN, 500))

# ---------------------------------------------------------------- tjenestene
TY = SY + SH + 56
GAP = 30
TW = (W - 96 - 2 * GAP) / 3
services = [
    ('kjoreverk@hub', 'node hmi-core/hub.js', [
        'Huben og HMI-en: http://<pi>:8080.',
        'Leser og lagrer prosjektet i hmi-core/config/.',
        ('Leser /etc/kjoreverk/vehicle.', INK3)], 'nettleserne, port 8080'),
    ('kjoreverk@tcplink-adapter', 'node hmi-core/adapters/tcplink-adapter.js --plc=…', [
        'Forbindelsen til PLS-en, med navnene fra PLS-en.',
        'Leser kjoreverk-options.json.',
        ('Leser /etc/kjoreverk/vehicle.', INK3)], 'PLS-en, TCP port 2000'),
    ('kjoreverk@recorder', 'node hmi-core/recorder.js', [
        'Sender taggene og hendelsene til den sentrale serveren. Skriver ingenting til SD-kortet.',
        ('Leser /etc/kjoreverk/recorder.json og vehicle.', INK3)], 'den sentrale serveren'),
]
heights = []
for i, (name, cmd, lines, net) in enumerate(services):
    x = 48 + i * (TW + GAP)
    h = s.box(x, TY, TW, name, [(cmd, AMBER, True)] + lines, accent=AMBER, mono_title=True)
    heights.append(h)
    s.arrow(x + TW / 2, SY + SH + 2, x + TW / 2, TY - 3, AMBER, sw=1.8)
    s.add(s.text(x + TW / 2 + 10, SY + SH + 32, 'starter', 12.5, AMBER, 500))
NY = TY + max(heights) + 46
for i, (name, cmd, lines, net) in enumerate(services):
    x = 48 + i * (TW + GAP)
    s.arrow(x + TW / 2, TY + heights[i] + 2, x + TW / 2, NY - 6, INK3, both=True, dash='5 4', sw=1.6)
    s.add(s.text(x + TW / 2, NY + 12, net, 13, INK3, 500, 'middle'))

# ---------------------------------------------------------------- oppdatering
UY = NY + 48
up, up_end = s.para(48, UY, W - 96, 'Oppdatere: kopier en ny prosjektmappe over /opt/kjoreverk, og kjør sudo bash /opt/kjoreverk/install.sh --yes. Oppsettet i /etc beholder navnet, PLS-en, serveren og nøkkelen, og tjenestene startes på nytt med den nye koden.', 14, INK2)
s.add(up)
s.h = int(up_end + 36)

open(OUT, 'w', encoding='utf-8').write(s.render())
print('pi-files.svg written, height', s.h)
