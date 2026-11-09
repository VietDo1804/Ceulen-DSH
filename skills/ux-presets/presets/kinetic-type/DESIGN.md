---
name: Kinetic Type
description: The poster is the type. Ultramarine ground, cream condensed capitals at huge sizes, one yellow, names that arrive from alternating sides.
colors:
  ultra: "#2B2FC9"
  deep: "#1A1C7A"
  cream: "#F6F1E4"
  cream-muted: "#C9CBF5"
  yellow: "#FFD84A"
typography:
  display: { fontFamily: Anton, textTransform: uppercase, lineHeight: 1.24, sizes: "4.5–15rem hero, 2.75–7rem rows" }
  body: { fontFamily: Manrope, fontWeight: 500, fontSize: 1.0625rem, lineHeight: 1.55 }
  label: { fontFamily: Manrope, fontWeight: 700 }
rounded: { pill: 999px, else: 0px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 120px }
components:
  button: { backgroundColor: "{colors.yellow}", textColor: "{colors.deep}", rounded: "{rounded.pill}", fontWeight: 800, minHeight: 48px }
  button-hover: { backgroundColor: "{colors.cream}" }
  filter: { border: "2px solid {colors.cream}", pressed: "{colors.deep} pill, {colors.yellow} border, {colors.cream} text" }
  row: { rule: "2px {colors.deep} above", name: "{typography.display}", meta: "{colors.cream-muted}" }
  band: { backgroundColor: "{colors.deep}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 760ms
  m-gap: 75ms
  m-surface: "{colors.deep}"
---

## Overview

A festival poster pasted on a harbour wall: the words are the picture. One
saturated ground, cream capitals set huge in a condensed face, a single yellow
for the headliner and the actions. No photos needed.

Use for: festivals, concerts, launches, podcasts, sports events, campaigns,
any page whose content is a list of names.
Not for: dashboards, forms, long reading, anything people use daily.

## Colors

- **ultra** is the ground; **deep** is the second band and the ghost word.
- **cream** is all text. **cream-muted** is metadata (set times, places), never
  body copy on deep.
- **yellow** goes to the headliner, the year, the hot ticket and the buttons.
  Text on yellow is **deep**, never cream.

## Typography

Anton in capitals for anything a person should see from across the street:
hero at 15vw, rows at 2.75–7rem, headliner bigger than the rest. Manrope 500–800
for everything else. Times take `tabular-nums`.

## Layout

Full-width rows divided by 2px deep rules. Names alternate left and right, the
meta sits on the opposite side. Three ticket tiers under 3px rules, the middle
one in yellow.

## Signature

A ghost word from the name, in deep on ultra, at least 40% of the viewport
wide, bleeding off the right and bottom of the hero and trailing the scroll.
Put it inside `<figure class="deco" aria-hidden="true">` with `position: absolute; inset: 0; overflow: hidden`, and never clip the hero itself: the audit reports a section that clips its text.

## Motion character

Big and rhythmic: the headline rises word by word, rows arrive from the side
their name sits on (32px over 760ms), the ghost word drifts with
`data-parallax="0.25"`, prices count up, the "left" badge pops.

## Do / Don't

- DO make the headliner the largest row and the only yellow name.
- DO keep metadata on one line beside the name, never wrapped under it on desktop.
- DON'T use a dark near-black ground or neon: the colour of the ground is the brand.
- DON'T set body copy in Anton.

## Audit pairs

```json
[
  { "fg": "#F6F1E4", "bg": "#2B2FC9", "label": "cream on ultra", "size": 16 },
  { "fg": "#C9CBF5", "bg": "#2B2FC9", "label": "meta on ultra", "size": 14, "role": "secondary" },
  { "fg": "#FFD84A", "bg": "#2B2FC9", "label": "yellow display on ultra", "weight": 400, "size": 48 },
  { "fg": "#1A1C7A", "bg": "#FFD84A", "label": "deep on yellow", "size": 16 },
  { "fg": "#F6F1E4", "bg": "#1A1C7A", "label": "cream on deep", "size": 16 },
  { "fg": "#C9CBF5", "bg": "#1A1C7A", "label": "meta on deep", "size": 14, "role": "secondary" }
]
```

Derived from the Kinetic Typography and Bold Typography rows of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates. Infinite marquees from the upstream row are left out: loops are for status dots only.
