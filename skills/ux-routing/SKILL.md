---
name: ux-routing
disable-model-invocation: true
description: >
  Reference table for dividing UX work across models — who defines the DESIGN.md
  scaffold, who generates variants, who renders and inspects, what reviews.
  Consult when delegating design work to another model or deciding whether the
  main model should do a step itself. Not injected every turn; the always-true
  rule lives in ux-design: the deterministic gate reviews, a model that can see
  looks at its own render, taste lives in the direction brief.
---

# Model routing for design work (who does what)

**The inversion rule:** the cheaper/weaker the model, the MORE you must
externalise constraints. Taste lives in the direction brief, not the weights.

**The deterministic-first principle:** the gate is mechanical (`ux_audit` +
runtime checks), not a vision-LLM call. Inside a locked system, cheap models
produce non-slop. A second model is optional polish, never the review gate.

**The capability rule (replaces per-model claims):**

- If the route accepts images, Render & Inspect is **required**: capture, look,
  fix. `ux_audit {url}` already returns the phone + desktop screenshots.
- If `read_image` (or the image return) refuses, say so plainly and rely on the
  deterministic gates plus the runtime findings. Never report a look you did not
  perform.
- Vision capability is a route property, not a brand claim: check it with a
  `read_image` call rather than assuming from the model name.

| Step | Who | Why |
|---|---|---|
| **Define system** (DESIGN.md tokens, elevation, type) | Reuse `ux-presets`, or derive a minimal system from the brief + direction | Preset is cheapest; the direction step supplies the taste. No bigger model required. |
| **Derive direction** (Step 1.5) | The generating model itself, after reading the subject material | Direction needs the brief, not a bigger model. |
| **Per-screen brief** | The generating model | It holds the system while scoping one screen. |
| **Generate variants** | The generating model inside the locked system | Constraints, not model size, decide non-slop. |
| **Normalise into system** | The generating model | Token remapping is mechanical. |
| **Render & inspect** | The generating model, when its route accepts images, via `web_screenshot` / `ux_audit {url}` | Eyes on your own output is the biggest quality lever for cheap models. |
| **Static audit** | `ux_audit` (`path` / `css` / `pairs`) | Contrast, tokens, states, slop tells are computable. |
| **Runtime audit** | `ux_audit {url}` | Focus, names, headings, tap targets, overflow, labels, clipped text, empty space, console errors. |
| **Behaviour check** | `web_interact` | A screenshot proves looks, not behaviour. |
| **Second visual review** (optional, test it) | Any route with image input and a different family | Only useful if it catches defects the generating model missed; measure before adding cost. |

**Cross-family rule:** the deterministic gate reviews any model's output. Spend
vision calls on looking at renders, not on recomputing what `ux_audit` already
computes for free.

## Routes observed in this bundle (2026-11-04, pi-ai catalog)

| Route | Input | Use for |
|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | text + image | generation and first visual review (cheapest capable route) |
| `opencode-go/glm-5.3` | text only | code review, advice — **not** visual judgement |
| `opencode-go/glm-5.3-flash` | text + image | alternative visual reviewer |
| `opencode-go/mimo-v2.6-flash` | text + image | optional second visual review |

This table is evidence, not policy: re-check the route's declared input before
relying on it, and treat an undeclared route as unknown rather than text-only.
