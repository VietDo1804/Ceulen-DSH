---
name: Bento Overview
description: Overview dashboards as a bento box. Tiles of different sizes on warm stone, one night tile, one ember tile, separation by background shift.
colors:
  stone: "#EBE9E3"
  tile: "#F8F7F3"
  ink: "#1E2320"
  ink-muted: "#5A5F59"
  night-text: "#EDEBE5"
  night-muted: "#BFC4BD"
  ember: "#9A3613"
  ember-bright: "#FFB896"
  on-ember: "#FFF6EF"
  track: "#DEDBD2"
typography:
  display: { fontFamily: Geist, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.22 }
  number: { fontFamily: Geist, fontWeight: 600, letterSpacing: "-0.04em", fontVariantNumeric: tabular-nums }
  body: { fontFamily: Geist, fontSize: 1rem, lineHeight: 1.5 }
  data: { fontFamily: Geist Mono, fontWeight: 500 }
rounded: { tile: 22px, inner: 12px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 48px }
components:
  tile: { backgroundColor: "{colors.tile}", rounded: "{rounded.tile}", padding: "{spacing.4}", border: none, shadow: none }
  tile-night: { backgroundColor: "{colors.ink}", textColor: "{colors.night-text}", number: "{colors.ember-bright}" }
  tile-ember: { backgroundColor: "{colors.ember}", textColor: "{colors.on-ember}" }
  segmented: { backgroundColor: "{colors.tile}", pressed: "{colors.ink} pill, {colors.tile} text", minHeight: 44px }
  bar: { height: 10px, track: "{colors.track}", fill: "{colors.ember}, then {colors.ink}" }
motion:
  m-rise: 32px
  m-arrive: 720ms
  m-gap: 80ms
---

## Overview

A bento box: compartments of different sizes, each holding one thing. The big
tile holds the main chart, a tall night tile holds money, a small ember tile
holds what is live. Calm and warm, never the cold blue SaaS default.

Use for: product overviews, usage and billing dashboards, personal analytics,
"today" screens, feature showcases on a landing page.
Not for: dense tables with many columns (use Ledger), long reading.

## Colors

- **stone** is the page; **tile** is every compartment. Tiles never get a border
  or a shadow: the background shift separates them.
- Exactly one **night** tile (ink background) and at most one **ember** tile per
  screen. They are the rhythm; more of them is noise.
- **ember-bright** is for large numbers (24px or more) on the night tile only.
- **track** is the empty part of bars and the hairline between rows.

## Typography

Geist for everything readable, Geist Mono for times, token counts, money in
lists. Headline numbers are Geist 600 at −0.04em, 2.5–5.5rem.

## Layout

A 6-column grid with 16px gaps. Spans must differ: 4+2, then 3+2+1, then 6.
Never three equal tiles in a row. Collapse to 6/3/3 below 1000px and one column
below 640px.

## Signature

The size contrast itself: one tile at least four times the area of the smallest,
holding the real series as a drawn line with its peak marked.

## Motion character

Tiles load in reading order, 32px over 720ms, 80ms apart. Numbers count, the
chart draws with its peak landing as the line passes, bars fill. The live dot
pulses. Override a bar's colour with `--m-tint` on the bar, not `--m-accent`.

## Do / Don't

- DO vary tile spans and keep one night and one ember tile.
- DO put `data-fill` on the track element itself, with no child.
- DON'T add borders, shadows or gradients to tiles.
- DON'T use blue or purple as the accent.

## Audit pairs

```json
[
  { "fg": "#1E2320", "bg": "#EBE9E3", "label": "body on stone", "size": 16 },
  { "fg": "#1E2320", "bg": "#F8F7F3", "label": "body on tile", "size": 16 },
  { "fg": "#5A5F59", "bg": "#F8F7F3", "label": "muted on tile", "size": 13, "role": "secondary" },
  { "fg": "#EDEBE5", "bg": "#1E2320", "label": "text on night", "size": 16 },
  { "fg": "#BFC4BD", "bg": "#1E2320", "label": "muted on night", "size": 13, "role": "secondary" },
  { "fg": "#FFB896", "bg": "#1E2320", "label": "ember-bright number on night", "weight": 600, "size": 48 },
  { "fg": "#9A3613", "bg": "#F8F7F3", "label": "ember text on tile", "size": 16 },
  { "fg": "#FFF6EF", "bg": "#9A3613", "label": "text on ember", "size": 16 }
]
```

Derived from the Bento Box Grid row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
