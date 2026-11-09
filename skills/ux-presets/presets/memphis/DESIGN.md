---
name: Memphis
description: Playful and loud for kids and families. Warm cream, three sweet blocks (pink, mint, yellow) outlined in ink, rounded shapes, squiggles and dots that drift.
colors:
  cream: "#FBF4EA"
  ink: "#16131F"
  ink-muted: "#4D4860"
  pink: "#FFBDD1"
  teal: "#86DED2"
  yellow: "#FFD34D"
typography:
  display: { fontFamily: Baloo 2, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.26 }
  body: { fontFamily: Nunito, fontWeight: 500, fontSize: 1.125rem, lineHeight: 1.55 }
rounded: { md: 18px, lg: 28px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 104px }
elevation:
  block: "6px 6px 0 {colors.ink}"
  press: "2px 2px 0 {colors.ink}"
components:
  button: { backgroundColor: "{colors.yellow}", textColor: "{colors.ink}", rounded: "{rounded.pill}", height: 52px }
  button-hover: { backgroundColor: "{colors.pink}" }
  block-pink: { backgroundColor: "{colors.pink}", textColor: "{colors.ink}", rounded: "{rounded.lg}" }
  block-teal: { backgroundColor: "{colors.teal}", textColor: "{colors.ink}", rounded: "{rounded.lg}" }
  block-yellow: { backgroundColor: "{colors.yellow}", textColor: "{colors.ink}", rounded: "{rounded.lg}" }
  row: { backgroundColor: "{colors.cream}", rounded: "{rounded.md}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 700ms
  m-gap: 80ms
  m-spring: "cubic-bezier(0.34, 1.7, 0.64, 1)"
  m-surface: "{colors.yellow}"
---

## Overview

Milan in the eighties, made friendly: sweet flat colours, thick ink outlines,
rounded everything, and geometric confetti (a squiggle, a ring, a triangle, a
dot grid) scattered around the hero. Energetic but never chaotic: the content
still sits on a clear grid.

Use for: kids, families, camps, toys, games for children, parties, playful
learning, creative clubs.
Not for: finance, health, government, or adults who need to concentrate.

## Colors

- **cream** is the page and every row. **ink** draws text, 3px borders and the
  hard shadows.
- **pink, teal, yellow** are blocks, badges and confetti, always with ink text.
  Buttons are yellow and turn pink on hover.
- One ink band near the end, with cream text and a pink-shadowed button.

## Typography

Baloo 2 700 for headings, buttons, dates and labels; Nunito for reading.
Headline line height stays at 1.1 or more: Baloo 2's descenders are deep and
Vietnamese marks stack high, so a tighter line makes them touch.

## Layout

Hero copy on the left, confetti on the right. Three tilted project blocks
(−1.5°, 0, +1.5°, the middle one dropped 24px). Sessions as outlined rounded
rows with an age badge. FAQ as outlined `<details>`.

## Signature

The confetti: four shapes in the preset's colours, inside
`<figure class="deco" aria-hidden="true">` with its own `overflow: hidden`,
each with a different `data-parallax` rate so they drift apart as you scroll
and lean towards the pointer.

## Motion character

Bouncy: 32px over 700ms, 80ms apart, with a springier `--m-spring` so badges
overshoot when they pop. Blocks arrive from left, centre and right. Buttons
press into their shadow on `:active`.

## Do / Don't

- DO outline every block, badge, row and button in 3px ink.
- DO keep body text on cream, not on the colour blocks, when it runs long.
- DON'T use gradients, glow or more than three block colours.
- DON'T put cream text on pink, teal or yellow.

## Audit pairs

```json
[
  { "fg": "#16131F", "bg": "#FBF4EA", "label": "ink on cream", "size": 18 },
  { "fg": "#4D4860", "bg": "#FBF4EA", "label": "muted on cream", "size": 16, "role": "secondary" },
  { "fg": "#16131F", "bg": "#FFBDD1", "label": "ink on pink", "size": 16 },
  { "fg": "#16131F", "bg": "#86DED2", "label": "ink on teal", "size": 16 },
  { "fg": "#16131F", "bg": "#FFD34D", "label": "ink on yellow", "size": 16 },
  { "fg": "#FBF4EA", "bg": "#16131F", "label": "cream on ink", "size": 18 }
]
```

Derived from the Memphis Design row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
