---
name: ux-design
description: >
  Anti-slop UI/UX design discipline for AI-generated interfaces. Constraint-First
  method: own the system via a lintable DESIGN.md, derive a direction from the
  subject, generate inside tokens, render-and-inspect, pass a measurable slop-audit
  gate. Use for any UI — web, mobile, desktop. Active via /ux lite|strict|off.
argument-hint: ""
license: MIT
---

# UX Design Discipline — Direction + Anti-Slop

Two moves, both required:

1. **Discipline** — tokens only, named elevation, full states, no banned tells.
2. **Direction** — a committed point of view drawn from the subject, before markup.

Discipline without direction gives the forgettable page; direction without
discipline gives purple glow and missing states. DESIGN.md anchors the system;
the direction brief anchors the taste.

## The anti-slop guardrail (hard rules)

- **Tokens ONLY** — colour, type, spacing, radius, elevation. No off-system values.
- **Elevation:** named levels only (sm/md/lg/xl). A modal is nearer than a card; a dropdown nearer than the page.
- **Accent:** only the defined accent token. No purple/indigo gradients, no glow unless requested.
- **Type:** modular scale only (e.g. 1.25). **Spacing:** 8px grid via tokens. No magic values.
- **States:** every interactive element declares `default`, `hover`, `focus-visible`, `active`, `disabled` + `error`/`empty`/`loading` where relevant. Motion ships a `prefers-reduced-motion` fallback.
- **Inventory first:** one line naming the components + states you will produce.
- **Ambiguity = ask.** Do not guess aesthetics.

## The Constraint-First method

### Step 0 — Own the system via DESIGN.md

A `DESIGN.md` at the project root (the working directory) combines machine-readable tokens with rationale; it is
never invented per screen. **Resolution order (stop at the first that holds):**

1. **`DESIGN.md` exists** → read it; use its tokens verbatim.
2. **A system is already wired in** (shadcn/MUI/Radix theme, Tailwind config) → reuse it. With no `DESIGN.md`, record that system's real tokens in one before any markup; never invent new ones.
3. **A reference site exists** → `web_extract` it, distill its DNA (4–6 hex, type roles, rhythm) into a DESIGN.md starter, then work inside it.
4. **Nothing exists** → do NOT block. Load `ux-presets` and pick a starter (B1 Web, B2 Mobile, an S-starter matching the subject's material, or S4 for dashboards). **A preset is a floor, not an identity:** Step 1.5 must bend it until the page could not be mistaken for the stock preset. Then write the bent system to `DESIGN.md` in the working directory, next to the page, before any markup.
5. **No preset fits** → derive a minimal DESIGN.md from the brief + direction (one accent, tinted neutrals, 1.25 scale, 8px grid, 4 named elevations, the state contract). Enough to generate inside; don't stall for a bigger model. Write it to `DESIGN.md` before any markup too.

`DESIGN.md` is the contract, so it is written even when the request names only other files, and it is never a thing to offer or to skip. Keep it short: the direction line first, then the tokens this page uses, in the starter's format. When a token changes, change it here in the same edit: `ux_audit` reports colours this file lists that the stylesheet no longer has.

The system defines colour tokens, a type scale, spacing, radius, 3–5 named
elevations, and the state contract before any screen is written.

### Step 1 — The 5-field brief (one per screen)

1. **User job + success state** — one sentence.
2. **Screen inventory** — required components and actions.
3. **Token constraints** — paste the tokens.
4. **Required interaction states** per component.
5. **One reference** that already feels like the product.

Scale to the task: internal single-file tool → one-line brief; user-facing
product UI → full brief. The gates are the same either way.

### Step 1.5 — Derive a direction (before any markup)

Not optional for user-facing UI. Extract the subject's **material**, then
commit six parts: material, three mood adjectives, one visual concept, type
voice, colour mood, exactly one signature element. Test for a real direction:
*two designers following it must produce visibly different pages* — otherwise
you wrote a default.

Say it in one line before markup:

`Direction: <concept> · type <display>+<body> · palette <hex> · signature: <element> · motion: <load> + <scroll>`

Type pairings, colour construction, composition, the signature element, the
punctuation kit, and the taste rules are in
[references/direction.md](references/direction.md). Read it when choosing type
or palette; the direction line is the required output.

**Motion is part of the design.** Every page ships a load moment, items that
arrive as they scroll in, soft state changes, a response to the pointer, and a
reduced-motion fallback. Copy `kit/motion.js` and `kit/motion.css` next to the page
and mark it up with attributes: see [references/motion.md](references/motion.md).
Read all of it before writing CSS.

### Step 2 — Generate fast, converge early

- **Variants are files, not vibes.** For a new surface, write three drafts in `.ux/drafts/<slug>-{a,b,c}.html`, capture each (`web_screenshot`), compare, and commit to one before touching real data or app code. Redesigning existing UI: capture a BEFORE screenshot first.
- **Convergence trigger:** after two generate-revise loops the variants must visibly converge. If not, tighten the brief.

### Step 3 — Normalise into the system

Replace ad-hoc colours with tokens, remap shadows to the elevation scale, snap
spacing to the rhythm. Gate: sample 10 components; fewer than 8 mapping
cleanly means repair the baseline first.

### Step 4 — Render & Inspect (required when the route sees images)

The gates check CSS text; they never see the page.

**Capability rule:** if the active route accepts images, this step is
**REQUIRED in strict mode**. If `read_image` or the image return from
`ux_audit`/`web_screenshot` refuses, say so and rely on the deterministic +
runtime checks; never claim a look you did not do.

1. **Reference-first** — capture the target URL/screenshot before generating.
2. **Inspect your own build** — serve it, then capture and LOOK (`web_screenshot`, or `ux_audit {url}` which returns phone + desktop screenshots). Capture traps: `../ux-capture/SKILL.md` (read by path).
3. **Run the LOOK checklist** at the brief's target viewport — squint test, dead zones, monotony, timidity, clipped text/overflow, mood. Full checklist and report shape: [references/review.md](references/review.md).
4. **Interact & verify** with `web_interact` — a screenshot proves looks, not behaviour.
5. **Watch the motion.** Audits render with motion off, so call `ux_audit` with `url` and `motion: true` and look at its three frames. They cover load only, so check scroll and filters with `web_interact`.
6. **Gates stay final.** `ux_audit` is the authority for what it checks; vision settles only what looking can settle.

### Step 5 — Slop-audit gate

Run `ux_audit` on the generated CSS (`path` preferred — a retyped copy drifts)
and, when the UI runs, on the page (`url`). One call may do both: `url` + `path`
gives two labelled verdicts.

Contrast reports **APCA Lc** (design gate, exploratory per W3C) plus the WCAG
2.x ratio (normative). A failed pair prints the nearest passing same-hue colour.

| Gate | What passes | Fail action |
|---|---|---|
| Contrast | Lc ≥75 body, ≥60 small-bold or `role: "secondary"`, ≥45 large, ≥30 non-text; WCAG ratio ≥ `min` when supplied | Use the suggested colour or token |
| Tokens | no hardcoded hex outside a token scope (`:root`, `@theme`, `.dark`, `[data-theme]`, `:host`); no ad-hoc shadows | Move values into tokens / named elevation |
| States + motion | every interactive base has `:focus-visible` + `:disabled`; no focus-ring kill; every animated selector has a reduced-motion fallback | Keep in draft |
| Slop tells | no glassmorphism / orbs / neon glow / default-card / 1px-gray border / tracked eyebrow / tinted near-black | Refactor: space → bg shift → elevation before a border |

**Keep the hierarchy.** Do not brighten secondary text to clear Lc 75. Pass captions, metadata, and
helper text as `pairs` with `role: "secondary"` and a `size`: they need Lc 60 and WCAG 4.5. Text under
12px keeps the body rule. Paragraphs, instructions, and error messages are never secondary.

Verdicts: **PASS**, **FAIL**, **INCOMPLETE**. `INCOMPLETE` means a gate had
nothing to check (e.g. no rule declares both colour and background) — never a
pass. Fix a FAIL and re-run. **A PASS does not end the visual review** — re-read
Step 4.

**Model-side checks:** token mapping ≥8/10 sampled components; ≤3 named shadow
recipes; no duplicate components.

### Step 6 — Review & report (evidence-first)

A screenshot proves looks, interaction proves behaviour, neither proves
accessibility. Run the runtime audit and read the page before calling UI work
done — protocol, report shape, and the "no capture path" rule:
[references/review.md](references/review.md).

## Banned anti-patterns

The audit catches the mechanical ones; the full banned list and named cliché
clusters are in [references/banned.md](references/banned.md). Read before
inventing a section, and never spend the page's one bold moment on one.

## Model routing

The who-does-what table is `../ux-routing/SKILL.md` (reference-only; read by
path when delegating). Always true: **the deterministic gate reviews; a model
that can see looks at its own render; taste lives in the direction brief, not
the model choice.**
