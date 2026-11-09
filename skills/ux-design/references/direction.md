# Direction playbook

The guardrail stops bad; this playbook produces good. Use it in Step 1.5 of
`../SKILL.md` — pick deliberately, then say the six-part direction line.

## Typography voice

1–2 families with clearly distinct roles. Inter/system-ui is the statistical
default this method exists to escape — reach past it unless the subject is
genuinely neutral infrastructure. Pairings that work (Google Fonts; first =
display, second = body):

| Subject voice | Pairing | Why it works |
|---|---|---|
| Editorial / literary / journal | **Newsreader** + **Source Sans 3** | serif display at 500–600, tight leading; body stays quiet |
| Expedition / outdoors / heritage | **Bricolage Grotesque 800** + **Newsreader** | heavy grotesque display over a serif body reads "printed field guide" |
| Financial / ledger / legal | **IBM Plex Sans** + **IBM Plex Mono** | mono for every numeral, `tabular-nums`; ruled borders do the branding |
| Technical / infra / dev tool | **IBM Plex Sans** + **IBM Plex Mono** | personality from weight contrast + hairline rules, not decoration |
| Warm consumer / food / home | **Be Vietnam Pro** 700–800 display + body | geometric warmth; personality from color + radius + scale |
| Dense data / dashboard | Inter + Roboto Mono, or the IBM Plex pair | personality from rhythm and status-color discipline |

Cautions: the cream+Fraunces+terracotta and Space-Grotesk-on-dark looks are
named cliché clusters (see `banned.md`). Off-table picks that still carry voice:
Archivo, Inter Tight, Playfair Display, Spectral (displays); Public Sans,
Onest, Work Sans, Noto Sans (bodies).

Vietnamese copy needs a family with the Google Fonts `vietnamese` subset; every
family named here has it. Without it, marks break apart (ế renders as ê plus a
loose accent). The fallbacks need it too, because they show while the web font
loads: "Times New Roman" for serif, system-ui or Arial for sans, "Courier New"
for mono, never Georgia, Futura, Didot or Rockwell. One family per role: never
combine two fonts with `unicode-range` so one word mixes two designs. Vietnamese marks stacked on a capital reach 1.0–1.2em above the baseline, so a
headline's line height must be above that for its font: about 1.2 for Playfair
Display or a heavy slab, 1.1 for most grotesques.

Numbers that make type feel designed: marketing h1 ≥
`clamp(2.75rem, 7vw, 6.75rem)` (≈96–108px at 1440 — the hero must dominate at
3–4× body size or the scale step is wrong); section h2 ≥ 2rem; stat/metric
numerals ≥ 2rem with `tabular-nums`; display weight 700–800 against body 400;
body 1rem–1.125rem/1.6 at 45–75ch; display letter-spacing −0.01 to −0.025em.
Timid sizes are the #1 "no feel" symptom — when in doubt, bigger display,
fewer words.

## Color mood construction

- **Temperature first:** warm or cool page? Then tint EVERY neutral with the mood hue at very low chroma — warm paper `#F6F4EE`, green-black ink `#22302A`, blue-gray desk `#F3F1EA`. Never pure `#fff`/`#000`.
- **One accent, posture committed:** deep + saturated (vermilion, forest, indigo, oxblood) beats bright + default. Pure blue `#0066FF` on white IS the default look. Test the accent's APCA pair before committing.
- **Support colours only when they encode meaning** (success/danger/warning), each with a soft tinted background for badges — never as decoration.
- **Bands give rhythm:** 2–3 background treatments across a page (paper → tinted → dark ink → paper). Alternating white sections are fog, not rhythm.
- **Surface budget: three surfaces, one family.** Base, one tinted mid, one inverse — all tinted by the same mood hue — plus the accent for CTAs and marks. If the header introduces a colour nothing else uses, delete it: the header inherits the base surface.

## Composition anatomy

- **Hierarchy = scale + weight + colour contrast**, not shadow boxes. If hierarchy needs a shadow, the scale is broken.
- **Hero formula:** kicker (small, real information) → one big claim (display face, ≥3rem, ≤9 words) → one sub (≤2 lines) → one primary action. No gradient-blob backgrounds; whitespace and type ARE the design.
- **Rows beat card grids** for repeated content (trips, features, invoices, episodes) — and a row is a **fixed column grid**: 4–5 columns at identical x-positions across all rows (identity left, one datum per middle column, terminal value/CTA right-aligned), hairline separators, equal row heights. Metadata never wraps to a second line; if it doesn't fit, the copy is too long. If you must card, vary the span — one wide, two narrow.
- **Shaped whitespace:** asymmetric gutters, a deliberately wide margin around one element, rag that breathes. Whitespace is a material you place, not what is left over.
- **Depth via composition** — overlap, scale steps, band shifts — not glow or shadow piles.

## The signature element

Exactly one memorable element, drawn from the subject, **scaled like
composition rather than framed like content**: ≥25% of the viewport wide,
allowed to bleed off the canvas edge, at reduced contrast so it reads as
atmosphere — never a small bordered "illustration card" smaller than the
headline beside it. Forms that work: an oversized glyph or numeral from the
subject's own writing system, a rotated stamp/seal, index numerals as design
objects, a contour/texture system that fills the hero, one full-bleed moment.
Everything else stays quiet. If you cannot name your signature element, you
don't have one — and the page will be forgettable.

## The punctuation kit (2–3 authored details per viewport)

Small deliberate marks are the difference between "clean" and "authored":

- one accent-coloured terminal on the H1 (a coloured period, a final word);
- pull quotes framed by a bracket, rule, or oversized mark — not a floating italic slab;
- one stamp/seal/badge marking a real scarcity or guarantee claim;
- texture glyphs from the subject's language on repeated items (kanji beside route names, §, №, coordinates);
- terminal marks as data affordances (an arrow on prices/rows) — NEVER appended to every link/button (that is template chrome).

Placeholder monograms (initials in a circle) are not punctuation — replace them
with role labels and one real credential line.

## Default vs directed

- *Default:* `Inter`, `#111` on `#fff`, `h1{font-size:2.5rem}`, blue button, three equal cards.
- *Directed (same brief, "ledger" concept):* IBM Plex Sans + mono `tabular-nums`, desk `#F3F1EA`, ruled table borders, one rotated `OVERDUE` stamp badge, forest accent `#1E6B50`.

Same effort. One is a page; the other is a template.

## Taste rules

- **Ground it in the subject.** Distinctive choices come from the brief's industry, materials, and vernacular — a toy for kids and a trading dashboard should not share a visual language.
- **Typography carries personality.** 1–2 families with clearly distinct roles; body lines under ~80 chars. Never accent a single word of a headline; structural devices (numbers, rules, eyebrows) only when they encode real information — `01 / 02 / 03` is for actual sequences.
- **Motion: visible and smooth.** Required, not optional: see [motion.md](motion.md). Load, scroll, state changes, and the pointer all drive motion, each suited to its content. Copy the kit instead of writing it. Identical fade-ups on every section are the tell to avoid. Always ship a `prefers-reduced-motion` fallback.
- **Design writing is design.** Use the user's words, not system words; CTAs say what happens; one name per action; errors direct instead of apologising; empty states invite action. Placeholder names ("Acme", "Lorem") read as template — write real content even in drafts.
- **Spend boldness in one place.** One memorable element; everything around it quiet and disciplined. Quality floor without announcing it: responsive, visible keyboard focus, reduced motion, accessible contrast.
- **Data-viz (dashboards & charts).** Chart fills pass non-text contrast (≥3:1) against their track. Adjacent categorical fills must be nameably different, not opacity steps; cap ramps at 7. Secondary series ≤0.85 opacity or a muted token; today/selected gets full accent. Numeric cells get `font-variant-numeric: tabular-nums`. Empty/zero chart states show an axis or "no data", never a blank canvas. Tables: row hover on bg, right-aligned numerics, sentence-case headers.
