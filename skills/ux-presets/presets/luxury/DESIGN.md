---
name: Luxury
description: Exaggerated minimalism for things that cost a lot. Bone paper, black ink, a high-contrast Didone set enormous, one bronze, hairline rules, and a lot of nothing.
colors:
  bone: "#EDEDEA"
  ink: "#111111"
  ink-muted: "#55554F"
  bronze: "#5E4B2D"
  night: "#1B1814"
  night-muted: "#B9B8B1"
typography:
  display: { fontFamily: Noto Serif Display, fontWeight: 400, letterSpacing: "-0.035em", lineHeight: 1.06 }
  body: { fontFamily: Hanken Grotesk, fontSize: 1rem, lineHeight: 1.7, letterSpacing: "0.01em" }
rounded: { all: 0px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 40px, 6: 72px, 7: 144px }
components:
  button: { backgroundColor: "{colors.bone}", textColor: "{colors.ink}", rounded: 0px, height: 52px }
  button-hover: { backgroundColor: "{colors.night}", textColor: "{colors.bone}" }
  row: { borderBottom: "1px solid {colors.ink}" }
  band: { backgroundColor: "{colors.night}", textColor: "{colors.bone}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 860ms
  m-gap: 110ms
  m-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  m-surface: "{colors.bone}"
---

## Overview

A watchmaker's catalogue: bone paper, black ink, a Didone headline at 12vw, one
bronze for the italic and the index numerals, hairline rules, and long empty
margins. Expensive things are shown slowly.

Use for: fashion, jewellery, watches, perfume, hotels, resorts, real estate,
architecture firms, weddings, galleries, high-end services.
Not for: anything with a lot of data, forms, or a low price as the message.

## Colors

- **bone** is the page, **night** the one dark band (warm black, never `#111`
  as a background).
- **ink** is text, the 1px rules and the outline button.
- **bronze** marks the italic word in the headline, index numerals and the
  second hand. It is never a background.

## Typography

Noto Serif Display 400 for display, 4–12.5rem, tight tracking, italic for one word.
Hanken Grotesk for everything else at 16px with slight positive tracking.
Prices use `tabular-nums`. No bold anywhere.

## Layout

A hero that ends at the bottom of the first screen (max 820px tall), the
headline sitting on a full-width hairline. The collection as ruled rows:
roman numeral, name in the Didone, specification, price, an enquire link.
Sections 144px apart.

## Signature

An object drawn in thin line, large, bleeding off the right of the hero at
about 30% opacity, inside `<figure class="deco" aria-hidden="true">` with its
own `overflow: hidden`. Here it is a dial whose ring draws itself once with
`pathLength="1"`. Keep `vector-effect` off any path that uses `pathLength`.

## Motion character

Slow and quiet: 32px over 860ms on a long ease-out, 110ms apart. The headline
rises word by word, the ring draws once in 1.2s, rows arrive one by one from the
left, numbers count, the dial drifts against the scroll.

## Do / Don't

- DO leave space: if a section feels empty, it is probably right.
- DO keep every rule 1px ink, every corner square.
- DON'T use bold, shadows, gradients, or more than one accent.
- DON'T put body text under 16px or in grey lighter than ink-muted.

## Audit pairs

```json
[
  { "fg": "#111111", "bg": "#EDEDEA", "label": "ink on bone", "size": 16 },
  { "fg": "#55554F", "bg": "#EDEDEA", "label": "muted on bone", "size": 15, "role": "secondary" },
  { "fg": "#5E4B2D", "bg": "#EDEDEA", "label": "bronze on bone", "size": 16 },
  { "fg": "#EDEDEA", "bg": "#1B1814", "label": "bone on night", "size": 16 },
  { "fg": "#B9B8B1", "bg": "#1B1814", "label": "muted on night", "size": 15, "role": "secondary" }
]
```

Derived from the Exaggerated Minimalism row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
