---
name: Nature Distilled
description: Calm, earthy and alive. Sage paper, leaf-white surfaces, one moss green, a soft serif display, rounded forms, slow arrivals.
colors:
  sage: "#ECEFE4"
  leaf: "#F7F8F2"
  ink: "#1F2A1D"
  ink-muted: "#525C4E"
  moss: "#3A5A2B"
  on-moss: "#F4F6EE"
  moss-soft: "#DCE5CF"
  moss-ink: "#2C4520"
  ochre: "#66450B"
  ochre-soft: "#F3EBD6"
  forest: "#24331F"
  forest-text: "#E8EDDF"
typography:
  display: { fontFamily: Young Serif, fontWeight: 400, lineHeight: 1.02 }
  body: { fontFamily: Figtree, fontSize: 1.0625rem, lineHeight: 1.6 }
  label: { fontFamily: Figtree, fontWeight: 700, fontSize: 0.8125rem }
rounded: { sm: 12px, md: 20px, lg: 32px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 112px }
components:
  button: { backgroundColor: "{colors.moss}", textColor: "{colors.on-moss}", rounded: "{rounded.pill}", minHeight: 48px }
  button-hover: { backgroundColor: "{colors.forest}" }
  button-soft: { backgroundColor: "{colors.moss-soft}", textColor: "{colors.ink}" }
  row: { backgroundColor: "{colors.leaf}", rounded: "{rounded.md}", gap: 8px }
  badge: { backgroundColor: "{colors.moss-soft}", textColor: "{colors.moss-ink}" }
  badge-notice: { backgroundColor: "{colors.ochre-soft}", textColor: "{colors.ochre}" }
  panel-deep: { backgroundColor: "{colors.forest}", textColor: "{colors.forest-text}" }
motion:
  m-rise: 32px
  m-arrive: 820ms
  m-gap: 90ms
  m-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  m-surface: "{colors.moss-soft}"
---

## Overview

A walk through a market garden: sage paper, leaf-white compartments, a single
moss green, and a soft serif that feels hand-set. Everything is rounded, nothing
is shiny. It avoids the cream-and-terracotta look: the warmth comes from green
and ochre, not clay.

Use for: food and farm products, wellness, gardening, local services,
sustainability reports, community organisations.
Not for: developer tools, dense data, anything urgent.

## Colors

- **sage** is the page, **leaf** every surface. Rows separate by background,
  never by border.
- **moss** is the one action colour. **moss-soft** is its quiet partner for
  secondary buttons, badges and bar tracks; text on it is **moss-ink**.
- **ochre** on **ochre-soft** marks one notable thing (a first of the season),
  never decoration.
- **forest** is the one deep surface per page, for the plan you recommend.

## Typography

Young Serif for headings, 400 only, sizes 1.25–5.75rem. Figtree for body and
labels. Quantities take `tabular-nums`.

## Layout

Generous: 112px between sections, a hero card with 32px radius. Lists are
rounded rows with 8px gaps, not cards in a grid. One two-column block per page
(a timeline beside a panel).

## Signature

A leaf's veins drawn as thin strokes across the hero, at least half its width,
bleeding off the edge at about 28% opacity, drifting with `data-parallax`.
Put it inside `<figure class="deco" aria-hidden="true">` with `position: absolute; inset: 0; overflow: hidden`, and never clip the hero itself: the audit reports a section that clips its text.

## Motion character

Slow and soft: 32px over 820ms on a long ease-out, 90ms apart. Rows arrive
from the left like produce laid on a table, badges pop after their row, the
timeline rail draws as you read, season bars fill.

## Do / Don't

- DO keep one moss action per view and one forest panel per page.
- DO round everything: 12px small, 20px rows, 32px sections.
- DON'T use terracotta, cream, or a serif with a heavy weight.
- DON'T put moss text on moss-soft; use moss-ink.

## Audit pairs

```json
[
  { "fg": "#1F2A1D", "bg": "#ECEFE4", "label": "body on sage", "size": 16 },
  { "fg": "#525C4E", "bg": "#ECEFE4", "label": "muted on sage", "size": 14, "role": "secondary" },
  { "fg": "#1F2A1D", "bg": "#F7F8F2", "label": "body on leaf", "size": 16 },
  { "fg": "#3A5A2B", "bg": "#F7F8F2", "label": "moss text on leaf", "size": 16 },
  { "fg": "#F4F6EE", "bg": "#3A5A2B", "label": "on moss", "weight": 600, "size": 16 },
  { "fg": "#2C4520", "bg": "#DCE5CF", "label": "moss-ink on moss-soft", "size": 16 },
  { "fg": "#66450B", "bg": "#F3EBD6", "label": "ochre on ochre-soft", "size": 16 },
  { "fg": "#E8EDDF", "bg": "#24331F", "label": "text on forest", "size": 16 }
]
```

Derived from the Nature Distilled and Organic Biophilic rows of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
