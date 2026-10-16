#!/usr/bin/env python3
"""
Generate the GotIt disclosure matrix.

The single most useful diagram for this product: who can see what. It is also the
sharpest way to distinguish GotIt from a payroll-attestation design, where the
payroll provider necessarily holds every salary in order to commit to it.

A markdown table could carry the same cells. This is a diagram because the
pattern — a column that is empty for every party except one, and a column that is
full — is what the reader should take away, and that reads faster as a grid than
as rows of prose.
"""
import html as html_mod
from pathlib import Path

PAPER = "#f4f2ec"
INK = "#14161c"
MUTED = "#4a4f5c"
SOFT = "#8b909c"
RULE = "#d5d1c4"
RULE_SOLID = "#b9b4a5"
ACCENT = "#0d6e6e"
LINK = "#a8253c"

SANS = "'Geist',system-ui,sans-serif"
SERIF = "'Instrument Serif',serif"
MONO = "'Geist Mono',monospace"

# Cell marks. A tick/dash/eye set reads faster than words at this size.
YES = "\u2713"       # present / visible
NO = "\u2715"        # never
PARTIAL = "\u25d0"   # only as an aggregate, or only with an extra step


def esc(s: str) -> str:
    return html_mod.escape(s)


ROWS = [
    # (party, note, [salary, identity, group counts, published report])
    ("The employee", "their own device", [YES, YES, PARTIAL, YES]),
    ("The employer who deployed it", "pays for the ledger", [NO, NO, PARTIAL, YES]),
    ("The proof server", "builds the proof", [PARTIAL, NO, NO, NO]),
    ("The indexer (Blockfrost)", "public state only", [NO, NO, YES, YES]),
    ("Works council / regulator", "reads without a wallet", [NO, NO, YES, YES]),
    ("Anyone on the internet", "no account, no key", [NO, NO, YES, YES]),
]

COLS = [
    ("Individual salary", "the witness"),
    ("Who submitted", "the identity"),
    ("Group counts", "raw ledger"),
    ("Published report", "gated figures"),
]

CELL_NOTES = {
    (0, 2): "their own",
    (0, 3): "their row",
    (1, 2): "sizes only",
    (2, 0): "in transit",
    (3, 2): "enumerable",
}


def build() -> str:
    left = 300          # party column width
    col_w = 150
    row_h = 54
    top = 150           # header baseline area
    x0 = 24

    width = x0 + left + col_w * len(COLS) + 24
    height = top + row_h * len(ROWS) + 108

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" '
             f'aria-labelledby="matrix-title matrix-desc">',
             f'  <title id="matrix-title">Who can see what in GotIt</title>',
             f'  <desc id="matrix-desc">A matrix of four kinds of data against six parties. '
             f'The individual salary is visible to the employee alone; the published report is '
             f'visible to everyone.</desc>']

    # ---- column headers ----
    for i, (title, sub) in enumerate(COLS):
        cx = x0 + left + i * col_w
        parts.append(f'  <text x="{cx + 12}" y="112" fill="{INK}" font-size="12" font-weight="600" '
                     f'font-family="{SANS}">{esc(title)}</text>')
        parts.append(f'  <text x="{cx + 12}" y="128" fill="{SOFT}" font-size="9" '
                     f'font-family="{MONO}">{esc(sub)}</text>')

    parts.append(f'  <line x1="{x0}" y1="{top - 14}" x2="{width - 24}" y2="{top - 14}" '
                 f'stroke="{RULE_SOLID}" stroke-width="1"/>')

    # ---- rows ----
    for r, (party, note, marks) in enumerate(ROWS):
        y = top + r * row_h
        if r % 2 == 1:
            parts.append(f'  <rect x="{x0}" y="{y - 18}" width="{width - 2 * x0}" height="{row_h}" '
                         f'fill="rgba(20,22,28,0.015)"/>')

        parts.append(f'  <text x="{x0 + 8}" y="{y}" fill="{INK}" font-size="12" font-weight="600" '
                     f'font-family="{SANS}">{esc(party)}</text>')
        parts.append(f'  <text x="{x0 + 8}" y="{y + 15}" fill="{SOFT}" font-size="9" '
                     f'font-family="{MONO}">{esc(note)}</text>')

        for c, mark in enumerate(marks):
            cx = x0 + left + c * col_w + col_w / 2
            if mark == YES:
                colour, weight = ACCENT, 600
            elif mark == NO:
                colour, weight = SOFT, 400
            else:
                colour, weight = MUTED, 400
            parts.append(f'  <text x="{cx:.0f}" y="{y}" fill="{colour}" font-size="13" '
                         f'font-weight="{weight}" font-family="{SANS}" text-anchor="middle">{mark}</text>')
            n = CELL_NOTES.get((r, c))
            if n:
                parts.append(f'  <text x="{cx:.0f}" y="{y + 15}" fill="{SOFT}" font-size="8" '
                             f'font-family="{MONO}" text-anchor="middle">{esc(n)}</text>')

        if r < len(ROWS) - 1:
            parts.append(f'  <line x1="{x0}" y1="{y + 18}" x2="{width - 24}" y2="{y + 18}" '
                         f'stroke="{RULE}" stroke-width="0.8"/>')

    # ---- legend + the point ----
    ly = top + row_h * len(ROWS) + 10
    legend = [(YES, "visible", ACCENT), (PARTIAL, "only in aggregate, or only in transit", MUTED),
              (NO, "never", SOFT)]
    lx = x0
    for mark, label, colour in legend:
        parts.append(f'  <text x="{lx}" y="{ly}" fill="{colour}" font-size="12" '
                     f'font-family="{SANS}">{mark}</text>')
        parts.append(f'  <text x="{lx + 16}" y="{ly}" fill="{MUTED}" font-size="9" '
                     f'font-family="{MONO}">{esc(label)}</text>')
        lx += 22 + len(label) * 5.4

    parts.append(f'  <text x="{x0}" y="{ly + 34}" fill="{INK}" font-size="12" '
                 f'font-family="{SERIF}" font-style="italic">The salary column is empty for every '
                 f'party but one. That is the product.</text>')

    parts.append('</svg>')
    return "\n".join(parts)


TITLE = "Who can see what in GotIt"
DESC = ("Four kinds of data against six parties. The individual salary is visible to the "
        "employee alone; the published report is visible to everyone.")

if __name__ == "__main__":
    out = Path("/home/kiter/midnight/docs/diagrams")
    out.mkdir(parents=True, exist_ok=True)
    slug = "disclosure-matrix"
    svg = build()
    (out / f"{slug}.svg").write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + svg)
    page = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html_mod.escape(TITLE)}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:'Geist',system-ui,sans-serif;background:{PAPER};color:{INK};
        padding:3rem 2rem;display:flex;justify-content:center}}
  figure{{max-width:1060px;width:100%}}
  h1{{font-family:'Instrument Serif',serif;font-weight:400;font-size:1.75rem;margin-bottom:.25rem}}
  p.sub{{color:{MUTED};font-size:.85rem;margin-bottom:1.5rem}}
  .scroll{{overflow-x:auto}}
  svg{{min-width:1000px;display:block}}
</style>
</head>
<body>
<figure>
  <h1>{html_mod.escape(TITLE)}</h1>
  <p class="sub">A payroll-attestation design has to fill the first column — it cannot commit to a salary it has never seen.</p>
  <div class="scroll">
{svg}
  </div>
</figure>
</body>
</html>
'''
    (out / f"{slug}.html").write_text(page)
    print(f"wrote {out / (slug + '.svg')}")
