---
name: Ledger
description: The accountant's desk. Desk paper, ruled card panels, one ledger green, every number in a mono face, statuses as stamps.
colors:
  desk: "#F3F1EA"
  card: "#FCFBF7"
  ink: "#1C211E"
  ink-muted: "#5B625D"
  green: "#1E6B50"
  on-green: "#F6F4EE"
  green-text: "#17573F"
  paid: "#14513A"
  paid-soft: "#E2EEE7"
  overdue: "#82251C"
  overdue-soft: "#F4E3E0"
  due: "#6A4A08"
  due-soft: "#F2EAD4"
  track: "#E4E0D4"
typography:
  display: { fontFamily: IBM Plex Sans, fontWeight: 700, fontSize: 1.75rem, letterSpacing: "-0.015em" }
  body: { fontFamily: IBM Plex Sans, fontSize: 0.9375rem, lineHeight: 1.5 }
  data: { fontFamily: IBM Plex Mono, fontWeight: 500 }
  label: { fontFamily: IBM Plex Mono, fontWeight: 500, fontSize: 0.75rem, letterSpacing: "0.06em" }
rounded: { sm: 3px, md: 6px }
spacing: { 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 24px, 6: 40px }
components:
  button: { backgroundColor: "{colors.green}", textColor: "{colors.on-green}", rounded: "{rounded.md}", height: 44px }
  button-hover: { backgroundColor: "{colors.ink}" }
  panel: { backgroundColor: "{colors.card}", rounded: "{rounded.md}" }
  stamp-paid: { textColor: "{colors.paid}", backgroundColor: "{colors.paid-soft}" }
  stamp-due: { textColor: "{colors.due}", backgroundColor: "{colors.due-soft}" }
  stamp-overdue: { textColor: "{colors.overdue}", backgroundColor: "{colors.overdue-soft}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 700ms
  m-gap: 70ms
  m-surface: "{colors.card}"
  html: data-recount="off"
---

## Overview

The desk of a bookkeeper: warm desk paper, card panels drawn with a 1.5px ink
rule, numbers in a mono face that line up in columns, and statuses stamped on
the row. Exact and trustworthy.

Use for: invoicing, accounting, payroll, banking, expenses, legal and
compliance registers, any screen where money is the main content.
Not for: marketing pages, playful consumer apps.

## Colors

- **desk** is the page, **card** every panel. Panels have a 1.5px **ink** border:
  in this preset the rule is the branding.
- **green** is the one action and the cash line. **green-text** for green words.
- **paid, due, overdue** are stamps: dark text on the soft tint with a
  1.5px border in the text colour. Overdue stamps tilt by −3°.
- **track** is bar tracks, hairline row dividers and chart baselines.

## Typography

IBM Plex Sans for words, IBM Plex Mono for every number, date and invoice
number, always with `tabular-nums`. Column labels are mono capitals at 0.75rem
with 0.06em tracking.

## Layout

A KPI strip as one ruled panel, cells split by the same rule. A chart beside an
ageing panel. The register is a real `<table>`: numbers right-aligned except the
invoice number, a ruled header, hairlines between rows.

## Signature

The stamps: status as a bordered mono stamp, overdue ones tilted, popping in
after their row. Totals must add up: the strip equals the sum of the rows.

## Motion character

32px over 700ms, 70ms apart. KPIs count once, the cash line draws with its
peak label landing as it passes, ageing bars fill, rows arrive, stamps pop.
`data-recount="off"` on `<html>`.

## Do / Don't

- DO make every total match its rows and every bar match its amount.
- DO keep numbers in the mono face, right-aligned.
- DON'T use soft shadows or pastel dashboards; the rule does the separating.
- DON'T use the status colours for anything but status.

## Audit pairs

```json
[
  { "fg": "#1C211E", "bg": "#F3F1EA", "label": "ink on desk", "size": 16 },
  { "fg": "#1C211E", "bg": "#FCFBF7", "label": "ink on card", "size": 15 },
  { "fg": "#5B625D", "bg": "#FCFBF7", "label": "muted on card", "size": 13, "role": "secondary" },
  { "fg": "#F6F4EE", "bg": "#1E6B50", "label": "on green", "weight": 600, "size": 15 },
  { "fg": "#17573F", "bg": "#FCFBF7", "label": "green text on card", "size": 15 },
  { "fg": "#14513A", "bg": "#E2EEE7", "label": "paid stamp", "weight": 700, "size": 11 },
  { "fg": "#6A4A08", "bg": "#F2EAD4", "label": "due stamp", "weight": 700, "size": 11 },
  { "fg": "#82251C", "bg": "#F4E3E0", "label": "overdue stamp", "weight": 700, "size": 11 }
]
```

Derived from the Financial Dashboard row of ui-ux-pro-max-skill (MIT, see `../NOTICE`) and this module's earlier S2 Ledger starter; palette, type and motion rebuilt for this module's gates.
