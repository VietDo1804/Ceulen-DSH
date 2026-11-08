---
name: ux-presets
description: >
  Ready design systems for a page or app that has no DESIGN.md yet. Each preset
  is a complete DESIGN.md (palette, type, layout, signature, motion) that passes
  ux_audit, plus an example page built with the motion kit. Pick one from the
  table by the words in the request, copy its DESIGN.md, and build inside it.
  Also covers reusing shadcn/MUI/Radix and adding tokens to an old stylesheet.
argument-hint: ""
license: MIT
---

# UX presets

Use this when the working directory has no `DESIGN.md` and no design system is
wired in. If a `DESIGN.md` exists, stop here and use it.

## 1. A system already installed? Reuse it

| Installed | Use it |
|---|---|
| shadcn/ui (`components.json`) | its theme variables are the tokens |
| MUI (`@mui/material`) | its theme is the tokens |
| Radix, Park UI, Ark UI | their tokens and focus handling |
| Tailwind config with colours | those colours are the tokens |

Write those real tokens into `DESIGN.md` before any markup. Do not pick a preset.

## 2. Otherwise pick a preset from this table

Read the request and go down the table. The **first row** whose words appear in
the request is the preset. Match words in English or Vietnamese, any case. Do
not pick by taste and do not mix two presets.

| Preset | Words in the request |
|---|---|
| `pipeline-desk` | crm, pipeline, sales, deal, lead, inventory, stock, warehouse, kho, tồn kho, order, đơn hàng, admin, back office, quản lý, quản trị, erp, hr, nhân sự, ticket, helpdesk, khách hàng |
| `bento` | usage, analytics, billing, overview, tổng quan, thống kê, metrics, kpi, ai dashboard, token, spend |
| `kinetic-type` | festival, concert, lineup, music, nhạc, âm nhạc, podcast, sport, thể thao, tournament, campaign, chiến dịch |
| `swiss` | conference, hội thảo, hội nghị, schedule, lịch trình, agenda, timetable, transit, docs, documentation, tài liệu, architecture |
| `bauhaus` | school, trường, workshop, course, khoá học, class, lớp học, museum, bảo tàng, studio, education, giáo dục |
| `nature` | farm, food, thực phẩm, rau, organic, wellness, spa, yoga, garden, vườn, eco, sustainability, community, cộng đồng |
| `neubrutalism` | developer, dev tool, api, sdk, cli, startup, launch, hackathon, indie, creator, saas |
| `pipeline-desk` | dashboard, app, tool, công cụ, ứng dụng, internal, nội bộ |
| `swiss` | anything else |

## 3. Copy it

`<base directory>` is this skill's folder, given when the skill loads.

```bash
cp <base directory>/presets/<preset>/DESIGN.md DESIGN.md
cp <base directory>/../ux-design/kit/motion.js <base directory>/../ux-design/kit/motion.css .
```

Then read `<base directory>/presets/<preset>/example.html` once. It shows the
tokens in CSS, every state, the layout, the signature element and the motion
markup working together. Build your own page in that shape:

- Put the DESIGN.md colours in `:root` under the same names, and the `motion`
  values as `--m-rise`, `--m-arrive`, `--m-gap` and `--m-out` (plus `--m-side`
  and `--m-surface` where listed).
- Copy the example's fonts link, reduced-motion block, focus and disabled rules.
- Write your own content. The signature element comes from your subject, in the
  form the preset's Signature section describes.
- Add your `Direction:` line under the frontmatter of `DESIGN.md`.

Keep the palette. `ux_audit` reports a colour that is not in `DESIGN.md` as
`off-palette`. To use a brand colour, the request must give it as a hex value:
replace the preset's accent with it in `DESIGN.md`, then check its pairs with
`ux_audit` before using it.

## 4. Mobile and native screens

The presets are web pages. For an iOS, Android, React Native or Flutter screen,
or a page used mostly on a phone, keep the preset's palette and type and add:

- every tap target at least 44×44pt (48dp on Android);
- `:active` pressed states instead of hover;
- body text at least 16px, or iOS zooms inputs on focus;
- `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` padding;
- primary actions in the bottom third, in a tab bar or bottom sheet.

## 5. Tokens for an existing stylesheet

When a project already has CSS and only lacks tokens, add this to its `:root`
instead of a preset, then record the values in `DESIGN.md`.

```css
:root {
  --accent: #0F6E6E;          /* swap for the brand accent; one accent only */
  --accent-hover: #0B5757;
  --text: #1B1B1F;
  --text-muted: #5A5A63;
  --bg: #FCFBF8;
  --surface: #F3F1EA;
  --border: #E2DED4;
  --danger: #A32B1F;
  --text-sm: 0.8rem; --text-base: 1rem; --text-lg: 1.25rem; --text-xl: 1.563rem; --text-2xl: 1.953rem;
  --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 32px; --space-6: 48px;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --elev-sm: 0 1px 2px rgba(0,0,0,0.05);
  --elev-md: 0 2px 8px rgba(0,0,0,0.08);
  --elev-lg: 0 8px 24px rgba(0,0,0,0.12);
  --dur-fast: 150ms; --dur-base: 240ms; --dur-slow: 420ms;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:disabled { opacity: 0.5; cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

## Audit-ready pairs

The pairs for the section 5 tokens. Each preset's `DESIGN.md` carries its own.

```jsonc
// weight/size enable the APCA thresholds; min is the WCAG compliance sidecar.
[
  { "fg": "#1B1B1F", "bg": "#FCFBF8", "label": "body",        "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#5A5A63", "bg": "#FCFBF8", "label": "muted",       "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#0F6E6E", "bg": "#FCFBF8", "label": "accent-link", "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#FCFBF8", "bg": "#0F6E6E", "label": "button",      "min": 4.5, "weight": 600, "size": 16 },
  { "fg": "#A32B1F", "bg": "#FCFBF8", "label": "danger",      "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#1B1B1F", "bg": "#F3F1EA", "label": "body on surface", "min": 4.5, "weight": 400, "size": 16 }
]
```

## Never

- glassmorphism (`backdrop-filter`), neumorphism, gradient orbs, neon glow,
  aurora backgrounds, or a glow that follows the cursor: `ux_audit` fails them;
- a second accent, or colours from outside `DESIGN.md`;
- a design style fetched from the web instead of this table.

The presets are derived from style rows of ui-ux-pro-max-skill (MIT); see
`presets/NOTICE`.
