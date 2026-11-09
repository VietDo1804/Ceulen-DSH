---
name: Editorial
description: A magazine long read. Cool newsprint, a tall condensed serif display, a reading serif for body, one teal for kickers, links and the drop cap.
colors:
  paper: "#F1F0EB"
  shade: "#E6E4DC"
  ink: "#161616"
  ink-muted: "#55544F"
  teal: "#0E5C63"
typography:
  display: { fontFamily: Playfair Display, fontWeight: 400, lineHeight: 1.05, letterSpacing: "-0.02em" }
  body: { fontFamily: Source Serif 4, fontSize: 1.1875rem, lineHeight: 1.65 }
  label: { fontFamily: Public Sans, fontWeight: 700, fontSize: 0.9375rem }
rounded: { all: 0px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 40px, 6: 64px, 7: 120px }
components:
  kicker: { typography: "{typography.label}", textColor: "{colors.teal}" }
  link: { textColor: "{colors.teal}" }
  pull-quote: { typography: "{typography.display}", borderTop: "1px solid {colors.ink}", borderBottom: "1px solid {colors.ink}" }
  band: { backgroundColor: "{colors.shade}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 780ms
  m-gap: 90ms
  m-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  m-surface: "{colors.shade}"
---

## Overview

The feature well of a good magazine: cool newsprint, black ink, a tall serif
headline set huge, a body serif built for reading, and one teal that marks the
kicker, the links and the drop cap. Quiet until it needs to be loud.

Use for: articles, essays, blogs, news, journals, reports, case studies,
newsletters on the web, author portfolios.
Not for: apps, dashboards, forms.

## Colors

- **paper** is the page, **shade** one band near the end (related stories).
- **ink** is all text and every rule. **ink-muted** for bylines and captions,
  in the sans.
- **teal** marks the kicker, the italic word in the headline, links, chapter
  numerals, the drop cap and the timeline dots. Nothing else.
- Not the cream-and-terracotta look: the paper stays cool grey-white.

## Typography

Three roles: Playfair Display for headline, chapter heads, pull quotes and big
numbers; Source Serif 4 at 19px for body; Public Sans for kickers, bylines,
navigation and captions. Body measure 40rem.

## Layout

Three columns: an empty left margin, the reading column, a sticky side column
with "by the numbers". Pull quotes break out of the column on both sides.
Related stories as ruled columns, the first one wider.

## Signature

The opening: a headline of at least 7rem with one word in teal italic, and a
teal drop cap six lines deep on the first paragraph.

## Motion character

Slow and literary: 32px over 780ms on a long ease-out, 90ms apart. The headline
rises word by word, paragraphs arrive as they are reached, chapter rules sweep,
the timeline rail draws, side numbers count.

## Do / Don't

- DO keep body text at 19px on the serif, 40rem wide.
- DO use rules, not boxes: 1px ink above and below pull quotes and lists.
- DON'T round corners, add cards, or shadows.
- DON'T use teal for body text or headings other than the one italic word.

## Audit pairs

```json
[
  { "fg": "#161616", "bg": "#F1F0EB", "label": "ink on paper", "size": 19 },
  { "fg": "#55544F", "bg": "#F1F0EB", "label": "muted on paper", "size": 15, "role": "secondary" },
  { "fg": "#0E5C63", "bg": "#F1F0EB", "label": "teal link on paper", "size": 19 },
  { "fg": "#161616", "bg": "#E6E4DC", "label": "ink on shade", "size": 16 },
  { "fg": "#55544F", "bg": "#E6E4DC", "label": "muted on shade", "size": 15, "role": "secondary" }
]
```

Derived from the Editorial Grid / Magazine row of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
