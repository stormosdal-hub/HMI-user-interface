"""Liten SVG-bygger for arkitekturdiagrammene til HMI core.

Bokser bryter teksten etter bredden sin og vokser så den får plass; hver boks er en <g class="box">
der første barn er rammen, så en sjekk i nettleseren kan bekrefte at all tekst får plass.
"""
import html

# HMI-ens egen palett: amber = verdier, blå = kommandoer, cyan = konfigurasjon,
# fiolett = beregnet, grønn = beskyttelser, rød = feil
BG, PANEL, PANEL2, LINE, LINE_SOFT = '#171b20', '#1e2329', '#262c34', '#3a434f', '#2b323b'
INK, INK2, INK3 = '#e7eaee', '#aab3be', '#7d8793'
AMBER, BLUE, CYAN, VIOLET, GREEN, RED = '#f2b441', '#7aa7ff', '#5cc8e8', '#c79bf2', '#43c483', '#e5533d'
SANS = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif"
MONO = "Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace"

esc = lambda s: html.escape(str(s), quote=True)


def wrap(text, width, size, mono=False):
    """Grådig ordbryting med en forsiktig (romslig) gjennomsnittlig tegnbredde."""
    per = size * (0.62 if mono else 0.56)
    limit = max(4, int(width / per))
    lines, cur = [], ''
    for word in str(text).split(' '):
        cand = (cur + ' ' + word).strip()
        if len(cand) <= limit or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.title = w, h, title
        self.parts = []
        self.colors = set()

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, fill=PANEL, stroke=LINE, rx=10, sw=1, dash=None, extra=''):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}{extra}/>'

    def text(self, x, y, s, size=13, fill=INK2, weight=400, anchor='start', mono=False, italic=False):
        fam = MONO if mono else SANS
        st = ' font-style="italic"' if italic else ''
        return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
                f'fill="{fill}" text-anchor="{anchor}"{st}>{esc(s)}</text>')

    def para(self, x, y, width, s, size=13, fill=INK2, lh=1.42, mono=False, weight=400):
        """Brutt tekst; returnerer (svg, ny y under siste linje)."""
        out = []
        for line in wrap(s, width, size, mono):
            y += size * lh
            out.append(self.text(x, y - size * 0.32, line, size, fill, weight, mono=mono))
        return ''.join(out), y

    def box(self, x, y, w, title, lines=(), accent=LINE, fill=PANEL, title_size=15, body_size=13,
            sub=None, mono_title=False, dash=None, pad=14, min_h=0, bar=True):
        """En boks med ramme: aksentstrek til venstre, en tittel, en valgfri undertittel, brutte linjer.
        Returnerer høyden."""
        inner = []
        ty = y + pad + title_size
        inner.append(self.text(x + pad + (6 if bar else 0), ty, title, title_size, INK, 600, mono=mono_title))
        cy = ty + 4
        if sub:
            s, cy = self.para(x + pad + (6 if bar else 0), cy, w - 2 * pad - 6, sub, body_size - 1, INK3)
        for ln in lines:
            if isinstance(ln, tuple):           # (tekst, farge) eller (tekst, farge, mono)
                t, col = ln[0], ln[1]
                mono = len(ln) > 2 and ln[2]
            else:
                t, col, mono = ln, INK2, False
            s2, cy = self.para(x + pad + (6 if bar else 0), cy + 3, w - 2 * pad - 6, t, body_size, col, mono=mono)
            inner.append(s2)
        if sub:
            inner.insert(1, s)
        h = max(min_h, cy - y + pad)
        frame = self.rect(x, y, w, h, fill, LINE, dash=dash)
        barsvg = f'<rect x="{x}" y="{y + 10}" width="3" height="{h - 20}" rx="1.5" fill="{accent}"/>' if bar else ''
        self.add(f'<g class="box">{frame}{barsvg}{"".join(inner)}</g>')
        return h

    def arrow(self, x1, y1, x2, y2, color, label=None, lx=None, ly=None, both=False, dash=None, sw=2, anchor='middle', label_size=12.5):
        self.colors.add(color)
        mid = color.strip('#')
        d = f' stroke-dasharray="{dash}"' if dash else ''
        start = f' marker-start="url(#s{mid})"' if both else ''
        self.add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{sw}"{d} '
                 f'marker-end="url(#e{mid})"{start}/>')
        if label:
            lx = (x1 + x2) / 2 if lx is None else lx
            ly = (y1 + y2) / 2 - 8 if ly is None else ly
            self.add(self.text(lx, ly, label, label_size, color, 500, anchor))

    def path_arrow(self, d, color, both=False, dash=None, sw=2):
        self.colors.add(color)
        mid = color.strip('#')
        dd = f' stroke-dasharray="{dash}"' if dash else ''
        start = f' marker-start="url(#s{mid})"' if both else ''
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{dd} marker-end="url(#e{mid})"{start}/>')

    def render(self):
        markers = []
        for c in sorted(self.colors):
            m = c.strip('#')
            markers.append(f'<marker id="e{m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                           f'<path d="M0 0 L10 5 L0 10 z" fill="{c}"/></marker>')
            markers.append(f'<marker id="s{m}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                           f'<path d="M10 0 L0 5 L10 10 z" fill="{c}"/></marker>')
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" '
                f'role="img" aria-labelledby="t">\n<title id="t">{esc(self.title)}</title>\n'
                f'<defs>{"".join(markers)}</defs>\n'
                f'<rect width="{self.w}" height="{self.h}" fill="{BG}"/>\n' + '\n'.join(self.parts) + '\n</svg>\n')

    def legend(self, x, y, items):
        """items: [(farge, etikett, stiplet)] på én rad; returnerer x etter siste element."""
        for col, label, dashed in items:
            self.colors.add(col)
            d = ' stroke-dasharray="5 4"' if dashed else ''
            self.add(f'<line x1="{x}" y1="{y}" x2="{x + 30}" y2="{y}" stroke="{col}" stroke-width="2.5"{d}/>')
            self.add(self.text(x + 38, y + 4.5, label, 13, INK2))
            x += 38 + len(label) * 7.2 + 26
        return x
