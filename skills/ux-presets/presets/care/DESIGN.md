---
name: Care
description: Calm and legible health services. Misty blue-green page, white surfaces, one clinical teal, a type pair built for people who struggle to read, big targets.
colors:
  mist: "#F2F6F6"
  surface: "#FBFDFD"
  ink: "#14262B"
  ink-muted: "#4E6166"
  teal: "#0F6870"
  on-teal: "#F4FBFB"
  teal-soft: "#DDEEEE"
  teal-ink: "#0B5258"
  amber: "#6E4A00"
  amber-soft: "#FBF0D9"
  line: "#D5E2E3"
typography:
  display: { fontFamily: Lexend, fontWeight: 600, letterSpacing: "-0.025em", lineHeight: 1.36 }
  body: { fontFamily: Noto Sans, fontSize: 1.0625rem, lineHeight: 1.6 }
  label: { fontFamily: Noto Sans, fontWeight: 700 }
rounded: { sm: 10px, md: 16px, lg: 24px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 96px }
components:
  button: { backgroundColor: "{colors.teal}", textColor: "{colors.on-teal}", rounded: "{rounded.pill}", height: 52px }
  button-hover: { backgroundColor: "{colors.ink}" }
  button-outline: { backgroundColor: "{colors.surface}", textColor: "{colors.teal-ink}", rounded: "{rounded.pill}", height: 48px }
  row: { backgroundColor: "{colors.surface}", rounded: "{rounded.md}", padding: "{spacing.4}" }
  slot: { backgroundColor: "{colors.surface}", rounded: "{rounded.sm}", height: 48px }
  slot-selected: { backgroundColor: "{colors.teal}", textColor: "{colors.on-teal}" }
  badge: { backgroundColor: "{colors.teal-soft}", textColor: "{colors.teal-ink}" }
  badge-notice: { backgroundColor: "{colors.amber-soft}", textColor: "{colors.amber}" }
motion:
  m-rise: 32px
  m-arrive: 740ms
  m-gap: 80ms
  m-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  m-surface: "{colors.teal-soft}"
---

## Overview

A clinic that wants you to feel looked after: a misty page, white surfaces,
one teal you can trust, generous targets, and type chosen for people with low
vision. Nothing is urgent unless it is.

Use for: clinics, hospitals, dentists, pharmacies, therapy, care homes,
insurance, appointment booking, patient portals.
Not for: entertainment, fashion, anything that wants drama.

## Colors

- **mist** is the page, **surface** every row and card, **line** the 2px borders
  on unselected choices.
- **teal** is the one primary action and a selected choice. Text on
  **teal-soft** is **teal-ink**.
- **amber** on **amber-soft** marks a condition (needs referral, fasting
  required), never an error.

## Typography

Lexend 600 for headings and buttons, Noto Sans for everything
read, body 17px. Both draw Vietnamese marks clearly at small sizes.

## Layout

Hero with the promise on the left and this week's free times on the right.
Doctors as full-width rows: name and role, languages, next time, one outline
button. Times as a 4-column grid of 48px buttons; taken ones disabled, the
chosen one filled.

## Signature

The week strip: five day tiles with a large count of free times each, today in
teal-soft. It answers "when can I go?" before anything else.

## Motion character

Gentle: 32px over 740ms on a long ease-out, 80ms apart. Day counts count up,
doctor rows arrive, the soonest badge pops, wait bars fill. Nothing flashes.

## Do / Don't

- DO make every target at least 48px tall.
- DO put the clinic's phone number in the header.
- DON'T use red for anything but a real emergency.
- DON'T show initials in circles for people; use name and role.

## Audit pairs

```json
[
  { "fg": "#14262B", "bg": "#F2F6F6", "label": "ink on mist", "size": 17 },
  { "fg": "#14262B", "bg": "#FBFDFD", "label": "ink on surface", "size": 17 },
  { "fg": "#4E6166", "bg": "#FBFDFD", "label": "muted on surface", "size": 15, "role": "secondary" },
  { "fg": "#0F6870", "bg": "#FBFDFD", "label": "teal text on surface", "size": 17 },
  { "fg": "#F4FBFB", "bg": "#0F6870", "label": "on teal", "weight": 600, "size": 17 },
  { "fg": "#0B5258", "bg": "#DDEEEE", "label": "teal-ink on teal-soft", "size": 16 },
  { "fg": "#6E4A00", "bg": "#FBF0D9", "label": "amber notice", "weight": 700, "size": 14 }
]
```

Derived from the Healthcare rows of ui-ux-pro-max-skill's product list and its Accessible & Ethical row (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
