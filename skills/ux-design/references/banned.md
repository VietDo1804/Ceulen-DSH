# Banned anti-patterns and named cliché clusters

## Auto-detected (fail the audit's slop-tell gate)

These are detected by `ux_audit`'s slop-tell gate. Fail the gate and the screen
stays in draft until refactored.

- **Glassmorphism** (`backdrop-filter`) — faux depth that implies capability the feature lacks (violates "honest").
- **Gradient orbs / purple-indigo glow** (large-blur `radial-gradient`, coloured high-opacity `box-shadow`) — the #1 AI-slop signature, unless the brand explicitly calls for it.
- **Neon-on-dark** (cyan/violet glowing card borders) — the v0/Cursor signature.
- **The default card** (`rounded-2xl shadow-lg p-6` untouched shadcn reflex) — separate with whitespace → background shift → elevation, in that order; a border is the last resort.
- **1px gray card border** (`border-zinc`/`border-gray` defaults) — the most reliable AI tell.
- **Tracked-out ALL-CAPS eyebrow** above a heading at ≤13px with ≥0.08em tracking — template chrome.
- **Tinted near-black background** (`#0B0B0B`, `#111` standing in for black) — template chrome. Pure `#000` is a deliberate choice and stays allowed.

## Never (judgement, not a lint rule)

- **Permanent dark mode** as the default reflex — the most common AI tell.
- Shadows as texture (drifting blur/opacity per component). Shadows = named elevation only.
- Magic pixel values; off-scale font sizes; ad-hoc accent colours.
- Shipping a component without `focus-visible` + `disabled` states.
- `outline: none` on a focus rule with no visible replacement (focus ring kill).
- Prompting "make it modern/clean" with no DESIGN.md and no direction — the single biggest slop trigger.

## Named cliché clusters

All legitimate for *some* briefs — but they are defaults, not choices, and
appear regardless of subject. Where the brief pins a direction, follow it
exactly; where an axis is free, don't spend it here:

- **The cream-clay look** — warm cream bg (near `#F4F1EA`) + high-contrast serif display + terracotta accent (near `#D97757`); on anyone else's brief it reads as Claude-flavoured.
- **Acid on black** — near-black background + single acid-green/vermilion accent.
- **Broadsheet kit** — hairline rules, zero border-radius everywhere, dense newspaper columns.
- **The SaaS-card kit** — identical rounded cards, one radius for everything, the same soft shadow under each, gradient washes as decoration.
- **Template chrome** — tracked-out ALL-CAPS eyebrow above every heading; meta strings joined with middle dots (`A · B · C`); `WORD — fragment` labels; monospace for small data labels; `→` appended to every link/button.
