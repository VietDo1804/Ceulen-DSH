---
name: Bauhaus
description: Primary forms and primary colours. Circle, square and triangle in red, blue and yellow, black rules, a geometric sans in capitals.
colors:
  paper: "#EFEEE9"
  light: "#F7F6F2"
  ink: "#171717"
  ink-muted: "#4F4E4A"
  red: "#C92A1E"
  blue: "#1C46A8"
  yellow: "#F5CB45"
typography:
  display: { fontFamily: Montserrat, fontWeight: 800, textTransform: uppercase, letterSpacing: "-0.02em", lineHeight: 1.31 }
  label: { fontFamily: Montserrat, fontWeight: 700, textTransform: uppercase, letterSpacing: "0.04em", fontSize: 0.9375rem }
  body: { fontFamily: Montserrat, fontSize: 1.0625rem, lineHeight: 1.55 }
rounded: { square: 0px, circle: 9999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 48px, 7: 104px }
elevation: { hard: "6px 6px 0 {colors.ink}" }
components:
  button: { backgroundColor: "{colors.yellow}", textColor: "{colors.ink}", border: "3px solid {colors.ink}", shadow: "6px 6px 0 #171717", minHeight: 48px }
  button-active: { transform: "translate(6px, 6px)", shadow: "0 0 0 {colors.ink}" }
  block-red: { backgroundColor: "{colors.red}", textColor: "{colors.light}", minTextSize: 18px bold }
  block-blue: { backgroundColor: "{colors.blue}", textColor: "{colors.light}" }
  block-yellow: { backgroundColor: "{colors.yellow}", textColor: "{colors.ink}" }
  marker: { size: 32px, shapes: "circle red, square blue, triangle yellow" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 720ms
  m-gap: 90ms
  m-out: "cubic-bezier(0.65, 0, 0.35, 1)"
  m-surface: "{colors.yellow}"
---

## Overview

The Dessau workshop: three forms, three colours, black rules, and type in
capitals. Each form stands for one category, so colour and shape carry meaning
twice and nobody depends on colour alone.

Use for: schools, studios, workshops, museums, events with a few categories,
kids' learning products that want structure rather than candy.
Not for: finance, dense data, long reading.

## Colors

- **paper** is the page; **light** is the text on red and blue blocks and the
  idle filter button.
- **red, blue, yellow** are blocks and forms, one per category. Light text on
  red needs 18px bold or larger. Ink text on yellow, never light.
- **ink** draws every rule (3px) and all text on paper.

## Typography

Montserrat, a geometric sans in the Futura line with full Vietnamese. Fall back to system-ui and Arial, never Futura or Century Gothic: they have no Vietnamese. Display and labels in capitals at 700–800; body in
sentence case at 400–500. Times and counts take `tabular-nums`.

## Layout

Three-part splits: three category blocks in one ruled band, three facts under
the headline. Rows are fixed grids: marker · time · title · place, with a 3px
ink rule under each.

## Signature

The composition: a red circle, a blue square and a yellow triangle overlapping
on one black line, at least 40% of the hero, each drifting at a different
`data-parallax` rate.

## Motion character

Deliberate and geometric: ease-in-out, 32px over 720ms, 90ms apart. Category
blocks arrive from left, centre and right. The forms drift against the scroll
and the pointer. Buttons press fully into their shadow.

## Do / Don't

- DO give each category one colour and one form, and use both everywhere.
- DO keep corners square except the circle.
- DON'T add a fourth colour or any gradient.
- DON'T set light text on yellow.

## Audit pairs

```json
[
  { "fg": "#171717", "bg": "#EFEEE9", "label": "body on paper", "size": 16 },
  { "fg": "#4F4E4A", "bg": "#EFEEE9", "label": "muted on paper", "size": 14, "role": "secondary" },
  { "fg": "#F7F6F2", "bg": "#C92A1E", "label": "light on red (large bold)", "weight": 700, "size": 18 },
  { "fg": "#F7F6F2", "bg": "#1C46A8", "label": "light on blue", "size": 16 },
  { "fg": "#171717", "bg": "#F5CB45", "label": "ink on yellow", "size": 16 },
  { "fg": "#171717", "bg": "#F7F6F2", "label": "ink on light", "size": 16 }
]
```

Derived from the Bauhaus row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates. The upstream row asks for instant 0ms transitions; this preset keeps the module's level-2 motion instead.
