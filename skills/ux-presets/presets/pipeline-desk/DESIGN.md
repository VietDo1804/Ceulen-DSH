---
name: Pipeline Desk
description: A light, dense work app (CRM, inventory, admin). Cool desk, white panels, one cobalt, status as soft chips, tables that read in columns.
colors:
  desk: "#F1F3F6"
  panel: "#FBFCFD"
  raise: "#E7EBF1"
  text: "#161B26"
  text-muted: "#525B6B"
  cobalt: "#2440B0"
  on-cobalt: "#F7F9FF"
  cobalt-soft: "#E3E8F8"
  won: "#135A37"
  won-soft: "#E3F1E8"
  lost: "#8A1E12"
  lost-soft: "#F8E4E1"
  risk: "#6B4600"
  risk-soft: "#F6ECD6"
  rule: "#DCE1E8"
typography:
  display: { fontFamily: Instrument Sans, fontWeight: 700, fontSize: 1.75rem, letterSpacing: "-0.02em" }
  body: { fontFamily: Instrument Sans, fontSize: 0.9375rem, lineHeight: 1.45 }
  number: { fontFamily: Instrument Sans, fontWeight: 600, fontVariantNumeric: tabular-nums }
  time: { fontFamily: Red Hat Mono, fontWeight: 500, fontSize: 0.8125rem }
rounded: { sm: 6px, md: 10px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 24px, 6: 32px }
components:
  button: { backgroundColor: "{colors.cobalt}", textColor: "{colors.on-cobalt}", rounded: "{rounded.sm}", minHeight: "40px, 44px on phones" }
  button-hover: { backgroundColor: "{colors.text}" }
  panel: { backgroundColor: "{colors.panel}", rounded: "{rounded.md}", border: none }
  kpi-strip: { one panel, cells split by "inset 1px {colors.rule}" }
  nav-current: { backgroundColor: "{colors.cobalt-soft}", textColor: "{colors.cobalt}" }
  segmented: { backgroundColor: "{colors.desk}", pill: "{colors.cobalt-soft}", pressedText: "{colors.cobalt}" }
  table-row: { divider: "inset 0 -1px 0 {colors.rule}", padding: 12px }
  chip: { neutral: "{colors.raise}", won: "won on won-soft", lost: "lost on lost-soft", risk: "risk on risk-soft" }
motion:
  m-rise: 24px
  m-arrive: 600ms
  m-gap: 60ms
  m-surface: "{colors.cobalt-soft}"
  html: data-recount="off"
---

## Overview

The desk of someone who works in the app all day: a cool grey desk, white
panels, one cobalt for actions and selection, and status shown as soft chips.
Dense but calm. Nothing competes with the numbers.

Use for: CRM, inventory, orders, admin consoles, back-office tools, any React or
Next app people use for hours. The closest preset to a real product.
Not for: marketing pages, or screens that must look like a brand.

## Colors

- **desk** is the app background, **panel** every surface, **raise** neutral chips.
- **cobalt** only for the primary action, the current nav item, selection and
  bars. One primary button per view.
- **won / lost / risk** are status, always dark text on their soft tint.
  Never use them as decoration.
- **rule** draws row dividers and KPI splits, as inset box-shadows, never as a
  border around a panel.

## Typography

Instrument Sans everywhere. Every number that lines up (money, counts, percents)
takes `tabular-nums` in the same face. Red Hat Mono only for timestamps.
Body 15px; table headers 13px muted.

## Layout

Sidebar 220px, then content. One KPI strip as a single panel with 4 cells, not
4 floating cards. A main column and a 300px side column for the activity feed.
Tables right-align values and keep metadata on one line; hide the low-value
columns on phones instead of wrapping them.

## Signature

The stage funnel: bars at real proportions with count and value columns that
add up to the KPI strip.

## Motion character

Quick and quiet, for an app opened many times a day: 24px over 600ms, 60ms
apart. KPIs count once, funnel bars fill, rows arrive, the activity rail draws,
the filter pill slides. Put `data-recount="off"` on `<html>` so a number under
the pointer never shows a false value. In React, give every row a stable `key`.

## Do / Don't

- DO make KPIs and the funnel agree: the stage counts and values sum to the strip.
- DO keep one cobalt action per view.
- DON'T outline panels with a 1px grey border; the desk colour separates them.
- DON'T put a pointer cursor or a lift on table rows that are not links.

## Audit pairs

```json
[
  { "fg": "#161B26", "bg": "#F1F3F6", "label": "text on desk", "size": 16 },
  { "fg": "#161B26", "bg": "#FBFCFD", "label": "text on panel", "size": 15 },
  { "fg": "#525B6B", "bg": "#FBFCFD", "label": "muted on panel", "size": 13, "role": "secondary" },
  { "fg": "#2440B0", "bg": "#FBFCFD", "label": "cobalt link on panel", "size": 15 },
  { "fg": "#2440B0", "bg": "#E3E8F8", "label": "cobalt on cobalt-soft", "weight": 600, "size": 15 },
  { "fg": "#F7F9FF", "bg": "#2440B0", "label": "on cobalt", "weight": 600, "size": 15 },
  { "fg": "#161B26", "bg": "#E7EBF1", "label": "neutral chip", "weight": 700, "size": 12 },
  { "fg": "#135A37", "bg": "#E3F1E8", "label": "won chip", "weight": 700, "size": 12 },
  { "fg": "#8A1E12", "bg": "#F8E4E1", "label": "lost chip", "weight": 700, "size": 12 },
  { "fg": "#6B4600", "bg": "#F6ECD6", "label": "risk chip", "weight": 700, "size": 12 }
]
```

Derived from the Data-Dense Dashboard and Sales Intelligence Dashboard rows of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
