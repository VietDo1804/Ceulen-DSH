---
name: Retro Film
description: A seventies photo lab turned café. Warm print paper, dark-room brown, Kodak yellow and red, a heavy slab display, typewriter labels, a contact strip with sprocket holes.
colors:
  paper: "#F1ECE2"
  brown: "#24170F"
  brown-muted: "#5E4E40"
  yellow: "#F7C843"
  red: "#931D13"
  on-red: "#F7F1E6"
typography:
  display: { fontFamily: Alfa Slab One, fontWeight: 400, lineHeight: 1.48, letterSpacing: "-0.01em" }
  body: { fontFamily: Work Sans, fontSize: 1.0625rem, lineHeight: 1.6 }
  label: { fontFamily: Space Mono, fontWeight: 700 }
rounded: { sm: 4px, frame: 10px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 104px }
components:
  button: { backgroundColor: "{colors.red}", textColor: "{colors.on-red}", rounded: "{rounded.sm}", height: 52px }
  button-alt: { backgroundColor: "{colors.yellow}", textColor: "{colors.brown}", rounded: "{rounded.sm}", height: 52px }
  frame-yellow: { backgroundColor: "{colors.yellow}", textColor: "{colors.brown}", rounded: "{rounded.frame}" }
  frame-red: { backgroundColor: "{colors.red}", textColor: "{colors.on-red}", rounded: "{rounded.frame}" }
  strip: { backgroundColor: "{colors.brown}" }
  menu-row: { borderBottom: "2px dashed {colors.brown-muted}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 740ms
  m-gap: 90ms
  m-surface: "{colors.yellow}"
---

## Overview

A café in an old darkroom: warm print paper, the brown of developer trays, a
box of film in yellow and red, a slab headline you could paint on a window, and
labels from a typewriter. Nostalgic without sepia filters or grain.

Use for: cafés, coffee roasters, restaurants, bakeries, bars, record shops,
barbers, photography studios, menus.
Not for: tech products, finance, health.

## Colors

- **paper** is the page; **brown** is text, the contact strip and the last band.
- **yellow** and **red** alternate as film frames. Text on yellow is brown;
  text on red is **on-red**. Buttons: red for the main action, yellow for the
  second.
- **brown-muted** for descriptions and the dashed menu rules.

## Typography

Alfa Slab One for the headline, section heads and frame titles. Work Sans for
reading. Space Mono 700 for navigation, buttons, prices, frame numbers and
small labels.

## Layout

A tall slab headline with its second half in red. A full-width contact strip:
sprocket holes along both edges, frame numbers in yellow, four frames. Two
columns below: the menu as dashed-ruled rows with prices right, and the shelf
with roast bars and the roast-day timeline.

## Signature

The contact strip. Sprocket holes are rows of small paper-coloured `<i>` inside
their own `overflow: hidden` row, never a clipped section with text in it. Each
frame is one item from the subject (here a coffee origin) with a line icon.

## Motion character

32px over 740ms, 90ms apart. The headline rises word by word, frames slide in
from the left like film through a gate, menu rows arrive, roast bars fill, the
roast-day rail draws.

## Do / Don't

- DO put prices in Space Mono, right-aligned.
- DO alternate yellow and red frames, never two of a colour side by side.
- DON'T add grain, sepia filters, or terracotta.
- DON'T use the slab for body text or anything under 24px.

## Audit pairs

```json
[
  { "fg": "#24170F", "bg": "#F1ECE2", "label": "brown on paper", "size": 17 },
  { "fg": "#5E4E40", "bg": "#F1ECE2", "label": "muted on paper", "size": 15, "role": "secondary" },
  { "fg": "#931D13", "bg": "#F1ECE2", "label": "red text on paper", "size": 17 },
  { "fg": "#24170F", "bg": "#F7C843", "label": "brown on yellow", "size": 16 },
  { "fg": "#F7F1E6", "bg": "#931D13", "label": "on red", "size": 16 },
  { "fg": "#F1ECE2", "bg": "#24170F", "label": "paper on brown", "size": 17 },
  { "fg": "#F7C843", "bg": "#24170F", "label": "yellow on brown", "size": 16 }
]
```

Derived from the Vintage Analog / Retro Film row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
