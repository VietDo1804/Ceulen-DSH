---
name: Civic
description: Public services that anyone can finish. Plain page, black ink, one link blue, a green go button, a yellow focus you cannot miss, errors summarised at the top and repeated at the field.
colors:
  page: "#F7F7F5"
  field: "#FDFDFC"
  panel: "#EBECEC"
  ink: "#0B0C0C"
  ink-muted: "#505A5F"
  blue: "#1D4F91"
  on-blue: "#F7F7F5"
  green: "#00703C"
  on-green: "#FDFDFC"
  error: "#A4271D"
  focus: "#FFDD00"
typography:
  display: { fontFamily: Public Sans, fontWeight: 800, letterSpacing: "-0.01em", lineHeight: 1.16 }
  body: { fontFamily: Public Sans, fontSize: 1.1875rem, lineHeight: 1.5 }
  label: { fontFamily: Public Sans, fontWeight: 700, fontSize: 1.1875rem }
rounded: { all: 0px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 48px, 7: 80px }
components:
  button: { backgroundColor: "{colors.green}", textColor: "{colors.on-green}", rounded: 0px, height: 48px }
  button-hover: { backgroundColor: "{colors.ink}" }
  input: { backgroundColor: "{colors.field}", textColor: "{colors.ink}", height: 48px }
  error-summary: { backgroundColor: "{colors.field}", textColor: "{colors.error}" }
  header: { backgroundColor: "{colors.blue}", textColor: "{colors.on-blue}" }
  panel: { backgroundColor: "{colors.panel}", textColor: "{colors.ink}" }
motion:
  m-rise: 32px
  m-side: 32px
  m-arrive: 680ms
  m-gap: 70ms
  m-surface: "{colors.panel}"
---

## Overview

A government service page: one question per page, a label for every field,
plain words, a big green button, and a focus state a person with low vision
can see from across the room. It looks ordinary on purpose; it has to work for
everyone, on any phone.

Use for: public services, councils, applications, permits, licences, tax,
benefits, registrations, any long form or multi-step flow, internal forms that
must be hard to get wrong.
Not for: marketing, entertainment, brand-led pages.

## Colors

- **page** behind everything, **field** inside inputs, **panel** for side notes.
- **ink** for text and 2px input borders. **blue** for links and the header band.
- **green** only for the button that moves forward.
- **error** for the error summary border, the field's left bar and message.
- **focus** yellow: links get a yellow background with an ink underline;
  inputs and buttons a 3px yellow outline plus a 2px ink inset.

## Typography

Public Sans only. Body and labels 19px, headings 800. Hints in ink-muted under
the label, errors in bold error red above the input.

## Layout

One column for the question, a narrow side column with the step list and fees,
sticky on desktop and moved above the form on phones. Inputs are 48px tall,
radios 44px, each choice on its own line.

## Signature

The error pattern: a 5px red box at the top listing each problem as a link to
its field, and the same message at the field with a red bar beside it. People
see what is wrong without hunting.

## Motion character

Calm and useful: 32px over 680ms, 70ms apart. The question rises word by word,
the summary lands with the page, fields arrive in order, the error message pops
once, the step rail draws to the current step, fees count. Nothing moves while
someone types.

## Do / Don't

- DO give every input a `<label for>` and every group a `<legend>`.
- DO keep one question or topic per page.
- DON'T round corners, use placeholders as labels, or disable the button.
- DON'T add a second accent; colour here always means something.

## Audit pairs

```json
[
  { "fg": "#0B0C0C", "bg": "#F7F7F5", "label": "ink on page", "size": 19 },
  { "fg": "#505A5F", "bg": "#F7F7F5", "label": "hint on page", "size": 16, "role": "secondary" },
  { "fg": "#1D4F91", "bg": "#F7F7F5", "label": "link on page", "size": 19 },
  { "fg": "#A4271D", "bg": "#F7F7F5", "label": "error on page", "weight": 700, "size": 19 },
  { "fg": "#0B0C0C", "bg": "#FDFDFC", "label": "ink in field", "size": 19 },
  { "fg": "#FDFDFC", "bg": "#00703C", "label": "on green", "weight": 700, "size": 19 },
  { "fg": "#F7F7F5", "bg": "#1D4F91", "label": "on blue header", "weight": 700, "size": 19 },
  { "fg": "#0B0C0C", "bg": "#FFDD00", "label": "ink on focus", "size": 19 },
  { "fg": "#0B0C0C", "bg": "#EBECEC", "label": "ink on panel", "size": 16 }
]
```

Derived from the Accessible & Ethical and Inclusive Design rows of ui-ux-pro-max-skill (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
