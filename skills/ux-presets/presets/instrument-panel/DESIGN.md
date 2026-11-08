---
name: Instrument Panel
description: Dark consoles for systems that run all night. Tinted chassis, backlit readouts in a mono face, one teal for the primary series, status lamps as soft chips.
colors:
  chassis: "#0E1116"
  panel: "#151A21"
  well: "#1C232C"
  text: "#E6EAF0"
  text-muted: "#B2BDC9"
  teal: "#8FE3DA"
  teal-ink: "#0E1116"
  ok: "#9BE3B8"
  ok-soft: "#12251B"
  warn: "#F2CE86"
  warn-soft: "#2A2314"
  bad: "#FFC4BA"
  bad-soft: "#2A1917"
  border: "#2A333E"
  grid: "#232C36"
typography:
  display: { fontFamily: IBM Plex Sans, fontWeight: 600, fontSize: 1.375rem, letterSpacing: "-0.01em" }
  body: { fontFamily: IBM Plex Sans, fontSize: 0.9375rem, lineHeight: 1.5 }
  data: { fontFamily: IBM Plex Mono, fontWeight: 500 }
rounded: { sm: 4px, md: 6px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 24px, 6: 32px }
components:
  button: { backgroundColor: "{colors.teal}", textColor: "{colors.teal-ink}", rounded: "{rounded.md}", height: 44px }
  button-hover: { backgroundColor: "{colors.text}" }
  panel: { backgroundColor: "{colors.panel}", rounded: "{rounded.md}" }
  chip-ok: { textColor: "{colors.ok}", backgroundColor: "{colors.ok-soft}" }
  chip-warn: { textColor: "{colors.warn}", backgroundColor: "{colors.warn-soft}" }
  chip-bad: { textColor: "{colors.bad}", backgroundColor: "{colors.bad-soft}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 700ms
  m-gap: 70ms
  m-surface: "{colors.well}"
  html: data-recount="off"
---

## Overview

An instrument rack: a matte chassis tinted cool, panels with 1px borders,
readouts in a mono face, lamps that mean something. Dark because the screen
lives on a wall or a night shift, not as a style reflex.

Use for: monitoring, infrastructure, logs, incidents, devops, security
consoles, trading or control rooms, anything watched for hours in the dark.
Not for: marketing pages, consumer apps, or any page that could be light.

## Colors

- **chassis** is the page, **panel** every surface, **well** inputs and the
  filter pill. Never pure black.
- **teal** draws the primary series and selection, and is the one button.
  Text on teal is **teal-ink**.
- **ok, warn, bad** are lamps: bright text on their soft tint, with a dot in
  the same colour. **warn** also marks moments on a chart as dashed hairlines.
- **grid** is chart baselines and row dividers; it stays dimmer than the data.

## Typography

IBM Plex Sans for words, IBM Plex Mono for every number, time, host name and
label, with `tabular-nums`.

## Layout

A KPI strip as one bordered panel. The main chart above a status table in the
wide column; the incident timeline in a narrow column. Host names left, numbers
right.

## Signature

The live chart: the real series in teal, the incident's start and end as
dashed warn hairlines with their notes landing as the line passes, and a
pulsing lamp in the headline that matches the system state.

## Motion character

32px over 700ms, 70ms apart. Numbers count once (`data-recount="off"`), the
series draws, lamps pop after their rows, the incident rail draws, the headline
lamp pulses slowly.

## Do / Don't

- DO keep one teal series; extra series step down in opacity, never new hues.
- DO mark spans of time with two hairlines, not a filled block.
- DON'T add glow, neon borders, or gradients.
- DON'T use this preset because "dark looks premium": pick it only for screens
  people watch.

## Audit pairs

```json
[
  { "fg": "#E6EAF0", "bg": "#0E1116", "label": "text on chassis", "size": 16 },
  { "fg": "#E6EAF0", "bg": "#151A21", "label": "text on panel", "size": 15 },
  { "fg": "#B2BDC9", "bg": "#151A21", "label": "muted on panel", "size": 13, "role": "secondary" },
  { "fg": "#8FE3DA", "bg": "#151A21", "label": "teal on panel", "size": 15 },
  { "fg": "#0E1116", "bg": "#8FE3DA", "label": "teal button", "weight": 600, "size": 15 },
  { "fg": "#9BE3B8", "bg": "#12251B", "label": "ok chip", "weight": 600, "size": 12 },
  { "fg": "#F2CE86", "bg": "#2A2314", "label": "warn chip", "weight": 600, "size": 12 },
  { "fg": "#FFC4BA", "bg": "#2A1917", "label": "bad chip", "weight": 600, "size": 12 }
]
```

Derived from the Real-Time Monitoring row of ui-ux-pro-max-skill (MIT, see `../NOTICE`) and this module's earlier S4 Instrument panel starter; palette, type and motion rebuilt for this module's gates.
