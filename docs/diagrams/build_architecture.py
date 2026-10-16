#!/usr/bin/env python3
"""
Generate the GotIt architecture diagram.

Positions are computed rather than hand-written, because hand-estimating label
widths is what made the first attempt collide: an 8px Geist Mono string is about
4.8px per character, and a mask narrower than its text puts the label over the
box beside it.

Emits a complete single-file HTML (the skill's output format) plus a bare SVG,
because the README embeds the SVG and GitHub will not run the HTML.
"""
import html as html_mod
from pathlib import Path

# ---- tokens: the project's style guide (tide palette) ----------------------
PAPER = "#f4f2ec"
INK = "#14161c"
MUTED = "#4a4f5c"
SOFT = "#8b909c"
RULE = "#d5d1c4"
RULE_SOLID = "#b9b4a5"
ACCENT = "#0d6e6e"
ACCENT_TINT = "rgba(13,110,110,0.08)"
LINK = "#a8253c"

SANS = "'Geist',system-ui,sans-serif"
SERIF = "'Instrument Serif',serif"
MONO = "'Geist Mono',monospace"

# 8px Geist Mono with 0.06em tracking: measured average advance.
MONO_ADVANCE_8 = 5.0
EYEBROW_ADVANCE_7 = 5.4


def text_w(s: str, size: float, advance: float) -> float:
    return len(s) * advance * (size / 8.0)


def esc(s: str) -> str:
    return html_mod.escape(s)


class Canvas:
    def __init__(self, w: int, h: int):
        self.w, self.h = w, h
        self.zones: list[str] = []
        self.arrows: list[str] = []
        self.nodes: list[str] = []
        self.notes: list[str] = []

    # ---- zones ----
    def zone(self, x, y, w, h, label):
        self.zones.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" '
            f'fill="rgba(20,22,28,0.02)" stroke="rgba(20,22,28,0.10)" stroke-width="0.8"/>'
        )
        lw = text_w(label, 7, EYEBROW_ADVANCE_7) + 12
        lx = x + 16
        self.zones.append(
            f'<rect x="{lx - 6}" y="{y + 4}" width="{lw}" height="12" rx="2" fill="{PAPER}"/>'
        )
        self.zones.append(
            f'<text x="{lx - 6 + lw / 2}" y="{y + 13}" fill="{SOFT}" font-size="7" '
            f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.14em">{esc(label)}</text>'
        )

    # ---- node ----
    def node(self, x, y, w, h, name, subs, focal=False):
        fill = ACCENT_TINT if focal else PAPER
        stroke = ACCENT if focal else RULE_SOLID
        sw = "1.2" if focal else "1"
        self.nodes.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw}"/>'
        )
        self.nodes.append(
            f'<text x="{x + 12}" y="{y + 22}" fill="{INK}" font-size="12" font-weight="600" '
            f'font-family="{SANS}">{esc(name)}</text>'
        )
        for i, s in enumerate(subs):
            colour = SOFT if s.startswith("~") else MUTED
            self.nodes.append(
                f'<text x="{x + 12}" y="{y + 38 + i * 14}" fill="{colour}" font-size="9" '
                f'font-family="{MONO}">{esc(s.lstrip("~"))}</text>'
            )

    # ---- horizontal arrow with a correctly sized label mask ----
    def arrow_h(self, x1, x2, y, label, colour=MUTED, dashed=False):
        dash = ' stroke-dasharray="4,3" stroke-width="1"' if dashed else ' stroke-width="1.2"'
        marker = "arrow-link" if colour == LINK else ("arrow-accent" if colour == ACCENT else "arrow")
        self.arrows.append(
            f'<path d="M {x1},{y} H {x2}" fill="none" stroke="{colour}"{dash} '
            f'marker-end="url(#{marker})"/>'
        )
        if label:
            mid = (x1 + x2) / 2
            tw = text_w(label, 8, MONO_ADVANCE_8)
            mw = tw + 18          # 9px of mask each side: the required visible gap
            self.arrows.append(
                f'<rect x="{mid - mw / 2:.1f}" y="{y - 7}" width="{mw:.1f}" height="14" fill="{PAPER}"/>'
            )
            self.arrows.append(
                f'<text x="{mid:.1f}" y="{y + 3}" fill="{colour}" font-size="8" '
                f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{esc(label)}</text>'
            )

    # ---- vertical arrow ----
    def arrow_v(self, x, y1, y2, label, colour=MUTED, dashed=False):
        dash = ' stroke-dasharray="4,3" stroke-width="1"' if dashed else ' stroke-width="1.2"'
        marker = "arrow-accent" if colour == ACCENT else "arrow"
        self.arrows.append(
            f'<path d="M {x},{y1} V {y2}" fill="none" stroke="{colour}"{dash} '
            f'marker-end="url(#{marker})"/>'
        )
        if label:
            mid = (y1 + y2) / 2
            tw = text_w(label, 8, MONO_ADVANCE_8)
            mw = tw + 18
            self.arrows.append(
                f'<rect x="{x - mw / 2:.1f}" y="{mid - 7}" width="{mw:.1f}" height="14" fill="{PAPER}"/>'
            )
            self.arrows.append(
                f'<text x="{x:.1f}" y="{mid + 3}" fill="{colour}" font-size="8" '
                f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{esc(label)}</text>'
            )

    # ---- editorial callout ----
    def callout(self, x, y, w, eyebrow, lines, foot=None):
        height = 44 + len(lines) * 16 + (20 if foot else 0)
        self.notes.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{height}" rx="6" fill="{PAPER}" '
            f'stroke="{RULE}" stroke-width="1"/>'
        )
        self.notes.append(
            f'<text x="{x + 14}" y="{y + 22}" fill="{SOFT}" font-size="7" font-family="{MONO}" '
            f'letter-spacing="0.14em">{esc(eyebrow)}</text>'
        )
        for i, line in enumerate(lines):
            self.notes.append(
                f'<text x="{x + 14}" y="{y + 44 + i * 16}" fill="{INK}" font-size="11" '
                f'font-family="{SERIF}" font-style="italic">{esc(line)}</text>'
            )
        if foot:
            self.notes.append(
                f'<text x="{x + 14}" y="{y + 44 + len(lines) * 16 + 12}" fill="{MUTED}" '
                f'font-size="9" font-family="{MONO}">{esc(foot)}</text>'
            )

    def render(self, title, desc, slug):
        return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" role="img" aria-labelledby="{slug}-title {slug}-desc">
  <title id="{slug}-title">{esc(title)}</title>
  <desc id="{slug}-desc">{esc(desc)}</desc>
  <!-- OPAQUE BACKGROUND. A transparent SVG inherits whatever the host page paints,
       and GitHub renders this in <img> context: on the dark theme the page is
       near-black and dark ink disappears entirely. The diagram carries its own
       paper so it reads the same in both themes. -->
  <rect x="0" y="0" width="100%" height="100%" fill="{PAPER}"/>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="{MUTED}"/>
    </marker>
    <marker id="arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="{ACCENT}"/>
    </marker>
    <marker id="arrow-link" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="{LINK}"/>
    </marker>
  </defs>
  <!-- zones, then arrows, then nodes: z-order puts connections behind components -->
{chr(10).join("  " + z for z in self.zones)}
{chr(10).join("  " + a for a in self.arrows)}
{chr(10).join("  " + n for n in self.nodes)}
  <!-- editorial callouts -->
{chr(10).join("  " + n for n in self.notes)}
</svg>
'''


def build():
    c = Canvas(960, 430)

    # ---- geometry: 4 boxes in a row, 96px gaps so labels have room ----
    y, h = 118, 66
    a = (20, 150)      # employee device
    gap = 96
    b_x = a[0] + a[1] + gap
    c_x = b_x + 150 + gap
    d_x = c_x + 150 + gap
    b = (b_x, 140)
    cc = (c_x, 150)
    d = (d_x, 150)

    # zone: only the two on-chain nodes
    zx = c_x - 20
    c.zone(zx, y - 26, (d_x + 150) - zx + 20, h + 52, "MIDNIGHT PREPROD")

    # ---- arrows first (drawn behind nodes) ----
    c.arrow_h(a[0] + a[1], b[0], y + h / 2, "WITNESS", colour=LINK, dashed=True)
    c.arrow_h(b[0] + b[1], cc[0], y + h / 2, "PROOF")
    c.arrow_h(cc[0] + cc[1], d[0], y + h / 2, "EVENTS", dashed=True)
    c.arrow_v(d[0] + d[1] / 2, y + h, 300, "GATED READS", colour=ACCENT)

    # ---- nodes ----
    c.node(a[0], y, a[1], h, "Employee device",
           ["salary = witness", "~never leaves*"], focal=True)
    c.node(b[0], y, b[1], h, "Proof server",
           ["builds the proof", "~we operate it"])
    c.node(cc[0], y, cc[1], h, "gotit.compact",
           ["8 circuits", "~counts, not people"], focal=True)
    c.node(d[0], y, d[1], h, "Blockfrost indexer",
           ["public ledger state", "~token held by proxy"])

    c.zone(700, 276, 236, 118, "READS · NO WALLET")
    c.node(716, 308, 204, h, "Anyone",
           ["report page", "pnpm verify:chain"])

    # ---- callouts ----
    c.callout(20, 280, 300, "THE GATE",
              ["getGroupHistogram returns zero for any group",
               "below k = 5 — the employer who deployed it too."],
              foot="enforced by the circuit, not the page")
    c.callout(356, 280, 312, "* RESIDUAL TRUST",
              ["The proof server receives the witness to build",
               "the proof. It does not record it, and a local run",
               "avoids it entirely."],
              foot="pnpm dev:all — nothing leaves the machine")

    return c


TITLE = "GotIt architecture: a private salary becomes a publishable count"
DESC = ("An employee's salary stays on their device, becomes a zero-knowledge proof, "
        "then a counted figure in the Compact ledger, and finally a gated read that "
        "anyone can perform without a wallet.")

if __name__ == "__main__":
    out_dir = Path("/home/kiter/midnight/docs/diagrams")
    out_dir.mkdir(parents=True, exist_ok=True)
    c = build()
    slug = "architecture"

    svg = c.render(TITLE, DESC, slug)
    (out_dir / f"{slug}.svg").write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + svg)

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
  figure{{max-width:1000px;width:100%}}
  h1{{font-family:'Instrument Serif',serif;font-weight:400;font-size:1.75rem;margin-bottom:.25rem}}
  p.sub{{color:{MUTED};font-size:.85rem;margin-bottom:1.5rem}}
  .scroll{{overflow-x:auto}}
  svg{{min-width:960px;display:block}}
</style>
</head>
<body>
<figure>
  <h1>{html_mod.escape(TITLE)}</h1>
  <p class="sub">The salary exists on the employee's device. Everything to the right of it is public.</p>
  <div class="scroll">
{svg}
  </div>
</figure>
</body>
</html>
'''
    (out_dir / f"{slug}.html").write_text(page)
    print(f"wrote {out_dir / (slug + '.svg')}")
    print(f"wrote {out_dir / (slug + '.html')}")
