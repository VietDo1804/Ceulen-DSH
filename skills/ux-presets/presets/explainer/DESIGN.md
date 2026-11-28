---
name: Explainer
description: A technical explainer that reads like an annotated notebook. Warm paper, black ink, one pen blue for links and diagram lines, a yellow marker for the terms that matter, diagrams that draw themselves.
colors:
  paper: "#F6F5F0"
  sheet: "#FDFCF9"
  shade: "#ECEAE2"
  ink: "#15171C"
  ink-muted: "#555A66"
  pen: "#1B45A8"
  on-pen: "#F6F8FF"
  marker: "#FFE169"
  ok: "#135536"
  ok-soft: "#E1F0E7"
  warn: "#6E4200"
  warn-soft: "#F7ECD3"
  rule: "#D8D5CA"
typography:
  display: { fontFamily: Bricolage Grotesque, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.3 }
  body: { fontFamily: Public Sans, fontSize: 1.0625rem, lineHeight: 1.65 }
  number: { fontFamily: Bricolage Grotesque, fontWeight: 700, fontVariantNumeric: tabular-nums }
  code: { fontFamily: JetBrains Mono, fontSize: 0.875rem, lineHeight: 1.6 }
rounded: { sm: 6px, md: 12px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 96px }
components:
  button: { backgroundColor: "{colors.marker}", textColor: "{colors.ink}", rounded: "{rounded.pill}", minHeight: 44px }
  link: { textColor: "{colors.pen}", underline: "1px, offset 3px" }
  mark: { backgroundColor: "{colors.marker}", textColor: "{colors.ink}" }
  figure: { backgroundColor: "{colors.sheet}", rounded: "{rounded.md}", border: none }
  callout: { note: "ink on shade", ok: "ok on ok-soft", warn: "warn on warn-soft" }
  code-block: { backgroundColor: "{colors.shade}", rounded: "{rounded.sm}" }
  table-row: { divider: "inset 0 -1px 0 {colors.rule}", padding: 12px }
  contents: { current: "{colors.pen}", position: "sticky rail on wide screens, a list under the title on phones" }
motion:
  m-rise: 32px
  m-arrive: 700ms
  m-gap: 70ms
  m-surface: "{colors.shade}"
---

## Overview

A page that teaches one thing well: how something works, what was found, how
two options compare. It reads like a good engineer's notebook: warm paper,
black ink, one pen blue, and a yellow marker drawn over the few terms the
reader must not miss. The diagram is the centre of the page, not an
illustration beside it.

Use for: explainers, how-it-works pages, research and review write-ups,
reports, comparisons, guides and tutorials delivered as an HTML page.
Not for: product screens people work in, or marketing pages.

## Colors

- **paper** is the page, **sheet** every figure and card, **shade** code blocks,
  table heads and neutral callouts.
- **pen** is for links, the current contents entry and every diagram line.
  Nothing else is blue.
- **marker** is the highlighter: behind a key term (`<mark>`), on the one box of
  a diagram that the section is about, and on the primary button. At most three
  marked terms per section, or nothing stands out.
- **ok** and **warn** are for callouts only, always dark text on their soft tint.
- **rule** draws table rows and section dividers as inset shadows.

## Typography

Bricolage Grotesque 700 for headings and big numbers, Public Sans for reading,
JetBrains Mono for code and identifiers. Body is 17px at 1.65 in a column no
wider than 68 characters. Headings keep line height 1.3 so stacked Vietnamese
marks stay clear of the line above.

## Layout

A contents rail on the left at 220px on wide screens, then one reading column of
68 characters. Figures, tables and code may break out to the full content
width. On phones the contents become a short list under the title. Every
section opens with an `h2` and one sentence that says what the section answers.

## Signature

The annotated diagram: boxes and arrows written as plain lines for the diagram
kit, one box in marker yellow, and a step-by-step walkthrough the reader
advances. Never a hand-placed SVG, and never a screenshot of a diagram.

## Motion character

Calm and explanatory: 32px arrivals over 700ms, 70ms apart. The headline lands
word by word, key numbers count once, the diagram draws from its first box to
its last and sends a dot along each arrow, a timeline rail draws as the reader
scrolls. Nothing loops.

## Do / Don't

- DO write every diagram as lines in `<figure data-diagram><pre>…</pre></figure>`.
- DO give each diagram a `figcaption` that says what it shows.
- DO keep a number that appears in text equal to the number in the table or chart.
- DON'T use the marker as a background for whole paragraphs or cards.
- DON'T outline figures with a 1px grey border; the sheet colour separates them.
- DON'T centre body text, and don't set it wider than 68 characters.

## Audit pairs

```json
[
  { "fg": "#15171C", "bg": "#F6F5F0", "label": "ink on paper", "size": 17 },
  { "fg": "#15171C", "bg": "#FDFCF9", "label": "ink on sheet", "size": 17 },
  { "fg": "#15171C", "bg": "#ECEAE2", "label": "ink on shade", "size": 14 },
  { "fg": "#555A66", "bg": "#F6F5F0", "label": "muted on paper", "size": 14, "role": "secondary" },
  { "fg": "#555A66", "bg": "#FDFCF9", "label": "muted on sheet", "size": 14, "role": "secondary" },
  { "fg": "#1B45A8", "bg": "#F6F5F0", "label": "pen link on paper", "size": 17 },
  { "fg": "#1B45A8", "bg": "#FDFCF9", "label": "pen link on sheet", "size": 17 },
  { "fg": "#F6F8FF", "bg": "#1B45A8", "label": "on pen", "weight": 600, "size": 16 },
  { "fg": "#15171C", "bg": "#FFE169", "label": "ink on marker", "weight": 600, "size": 16 },
  { "fg": "#135536", "bg": "#E1F0E7", "label": "ok callout", "size": 16 },
  { "fg": "#6E4200", "bg": "#F7ECD3", "label": "warn callout", "size": 16 }
]
```

Built for this module; it follows the structure of the other presets (see `../NOTICE`).
