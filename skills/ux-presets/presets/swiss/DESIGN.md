---
name: Swiss Grid
description: International Typographic Style. Twelve columns, one grotesk, one red, structure carried by rules and numerals.
colors:
  paper: "#F3F3EF"
  ink: "#121314"
  ink-muted: "#55575A"
  red: "#BE2219"
  red-text: "#A51C14"
typography:
  display: { fontFamily: Schibsted Grotesk, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 0.95 }
  numeral: { fontFamily: Schibsted Grotesk, fontWeight: 900, letterSpacing: "-0.06em" }
  body: { fontFamily: Schibsted Grotesk, fontSize: 1.0625rem, lineHeight: 1.5 }
rounded: { all: 0px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 48px, 7: 112px }
rules: { structural: "2px solid {colors.ink}", hairline: "1px solid {colors.ink}" }
components:
  button: { backgroundColor: "{colors.red}", textColor: "{colors.paper}", rounded: 0px, minHeight: 44px }
  button-hover: { backgroundColor: "{colors.ink}" }
  filter: { border: "2px solid {colors.ink}", pressed: "{colors.red-text} text, {colors.red} border" }
  row: { borderBottom: "1px solid {colors.ink}", columns: "time | title | person | place" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 700ms
  m-gap: 60ms
  m-out: "cubic-bezier(0.65, 0, 0.35, 1)"
  m-surface: "{colors.paper}"
---

## Overview

The Zürich school poster and the railway timetable: a strict twelve-column grid,
flush-left type, one red, and nothing decorative. Hierarchy comes from size and
position only.

Use for: events, conferences, schedules, architecture and design studios,
documentation, public-service and transit information.
Not for: playful consumer brands, children, anything that wants warmth.

## Colors

- **paper** is the only background. **ink** draws text and rules.
- **red** is for blocks, the signature numeral, and buttons. Paper text on red.
- **red-text** is the red for small text on paper (rooms, prices, hover).
- No other colour. No tints, no shadows.

## Typography

One family, Schibsted Grotesk, 400 to 900. Display 800 at −0.04em. Use
`tabular-nums` only on counts and indexes. In this face tabular figures also
space out colons, commas and full stops, so leave times (09:30) and running
text proportional, and never set it on `body`.

## Layout

A 12-column grid with a 24px gutter on every section. Section labels take
columns 1–3; content takes 4–12. Rows are fixed column grids (time · title ·
person · place) split by 1px ink hairlines, with a 2px ink rule on top.

## Signature

One huge numeral from the subject (a date, a year, an edition), in red, at least
40% of the viewport wide, bleeding off the right edge behind the headline.
Put it inside `<figure class="deco" aria-hidden="true">` with `position: absolute; inset: 0; overflow: hidden`, and never clip the hero itself: the audit reports a section that clips its text.

## Motion character

Mechanical and exact: arrivals use an ease-in-out curve, 32px over 700ms, with
rows sliding in from the left like a departure board. The filter pill is paper
with the kit's red underline; the pressed button turns red-text.
Set the `motion` values above as `--m-*` in `:root`.

## Do / Don't

- DO align every block to the 12 columns. No centred text.
- DO use rules for structure: 2px for sections, 1px between rows.
- DO keep the section label sticky beside a long list, so the columns stay balanced.
- DON'T round any corner, add a shadow, or use a second accent.
- DON'T set `font-feature-settings: "tnum"` on `body`.

## Audit pairs

```json
[
  { "fg": "#121314", "bg": "#F3F3EF", "label": "body on paper", "size": 16 },
  { "fg": "#55575A", "bg": "#F3F3EF", "label": "muted on paper", "size": 14, "role": "secondary" },
  { "fg": "#A51C14", "bg": "#F3F3EF", "label": "red-text on paper", "size": 16 },
  { "fg": "#F3F3EF", "bg": "#BE2219", "label": "paper on red", "size": 16 },
  { "fg": "#F3F3EF", "bg": "#121314", "label": "paper on ink", "size": 16 }
]
```

Derived from the Swiss Modernism 2.0 and Minimalism & Swiss Style rows of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
