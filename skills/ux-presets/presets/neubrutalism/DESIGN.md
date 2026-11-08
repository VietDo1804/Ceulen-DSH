---
name: Neubrutalism
description: Poster-loud product pages. Ink rules, hard offset shadows, three saturated blocks on butter paper, a wide grotesk at 900.
colors:
  paper: "#FFF1C9"
  card: "#FFFCF2"
  ink: "#151515"
  ink-muted: "#4A4536"
  tomato: "#FF7A59"
  tomato-text: "#C2361A"
  sky: "#8FD3FF"
  lime: "#C6F27A"
typography:
  display: { fontFamily: Archivo, fontWeight: 900, fontStretch: "112%", letterSpacing: "-0.035em", lineHeight: 1.02 }
  body: { fontFamily: Archivo, fontSize: 1.0625rem, lineHeight: 1.55 }
  data: { fontFamily: JetBrains Mono, fontWeight: 700 }
rounded: { block: 0px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 48px, 7: 96px }
elevation:
  block: "6px 6px 0 {colors.ink}"
  press: "2px 2px 0 {colors.ink}"
  block-hot: "6px 6px 0 {colors.tomato}"
components:
  button: { backgroundColor: "{colors.lime}", textColor: "{colors.ink}", border: "3px solid {colors.ink}", shadow: "{elevation.block}", minHeight: 52px }
  button-hover: { backgroundColor: "{colors.sky}" }
  button-active: { transform: "translate(4px, 4px)", shadow: "{elevation.press}" }
  block: { border: "3px solid {colors.ink}", shadow: "{elevation.block}", rounded: "{rounded.block}" }
  tag: { fontFamily: JetBrains Mono, border: "2px solid {colors.ink}", backgroundColor: "{colors.lime}" }
motion:
  m-rise: 32px
  m-arrive: 660ms
  m-gap: 70ms
  m-out: "cubic-bezier(0.2, 0.9, 0.1, 1)"
---

## Overview

The printed gig poster: thick ink outlines, flat colour blocks, shadows that are
solid offsets instead of blur. Loud, confident, slightly rude.

Use for: developer tools, indie SaaS, creator products, launch pages, hackathons.
Not for: banking, healthcare, legal, anything that must feel calm or premium-quiet.

## Colors

- **paper** is the page. **card** is the only lighter surface.
- **ink** draws every border, every shadow, and all text.
- **tomato, sky, lime** are blocks: a block carries ink text, never paper text.
  Buttons are lime and turn sky on hover. At most one tomato block per screen.
- **tomato-text** is the tomato for small text on card or paper (timings, prices).

## Typography

Archivo at 900 with `font-stretch: 112%` for display, 125% for the logo and
step numerals. Display tracks tight (−0.035em). Body is Archivo 400–600.
Terminal output, dates and tags are JetBrains Mono 700.

## Layout

Hard grid, one column offset on purpose: the middle step block drops 32px.
Stats sit in one ruled strip, cells split by 3px ink rules, not separate cards.
Lists are ruled rows, ink rule above and below each row.

## Signature

One rotated object made from the product's own data, with a pill stamp
overlapping its corner (here a deploy ticket with real step timings).

## Motion character

Snappy and mechanical. Arrivals rise 32px over 660ms with a fast-out curve.
Steps arrive from the left, centre and right. Buttons press into their shadow
on `:active`, the only place an element moves on click. Set the `motion` values
above as `--m-rise`, `--m-arrive`, `--m-gap` and `--m-out` in `:root`.

## Do / Don't

- DO keep every shadow an `elevation` token. No blur on any shadow.
- DO give every block, button and tag a 2–3px ink border.
- DON'T round corners except the stamp pill.
- DON'T put paper-coloured text on tomato, sky or lime.
- DON'T use gradients, glow, or transparency.

## Audit pairs

```json
[
  { "fg": "#151515", "bg": "#FFF1C9", "label": "body on paper", "size": 16 },
  { "fg": "#4A4536", "bg": "#FFF1C9", "label": "muted on paper", "size": 14, "role": "secondary" },
  { "fg": "#151515", "bg": "#FFFCF2", "label": "body on card", "size": 16 },
  { "fg": "#151515", "bg": "#FF7A59", "label": "ink on tomato (large)", "weight": 800, "size": 24 },
  { "fg": "#151515", "bg": "#8FD3FF", "label": "ink on sky", "weight": 700, "size": 16 },
  { "fg": "#151515", "bg": "#C6F27A", "label": "ink on lime", "weight": 700, "size": 16 },
  { "fg": "#FFF1C9", "bg": "#151515", "label": "paper on ink", "size": 16 },
  { "fg": "#C2361A", "bg": "#FFFCF2", "label": "tomato-text on card", "weight": 700, "size": 16 }
]
```

Derived from the Neubrutalism row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
