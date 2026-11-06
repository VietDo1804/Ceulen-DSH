# Render & inspect, and the review report

## The LOOK checklist

Capture at the **brief's target viewport** (mobile briefs: capture at exactly
390 wide; never widen the capture to make a problem invisible — that is
cheating the loop). Scroll the page to the bottom in viewport-sized steps and
back to the top before the shot: scroll-reveal sections sit at `opacity:0`
until observed and a naive capture reports them as blank. Fix every failure in
one batch, re-capture, repeat (two loops, then move on).

- **Squint test:** three distinguishable levels of hierarchy? Does the eye land first where it should?
- **Dead zones:** any region with nothing for the eye? Whitespace piling up on one side? On app screens: does content leave a large empty region below the last element at the target height? (The runtime audit reports blocks over 480px that render nothing — treat those as leads, fix the real ones.)
- **Monotony:** consecutive sections with identical weight/background? Every content group in the same box?
- **Timidity:** cover the logo — could this page belong to anyone? Then amplify the display scale or the signature.
- **Type & overflow at target width:** display sizes actually large? measure comfortable? any horizontal scroll, cut-off text, squeezed badges, orphans? (`ux_audit {url}` flags clipped text and horizontal overflow with the offending element.)
- **Mood:** is the palette's temperature visible at a glance, or is it generic white+blue?

**Visibility baseline:** judge at what a viewer sees at 1×–3×. Nothing
sub-visible can fail, and nothing sub-visible may be produced — no ±1px claims,
no per-pixel diffs.

## Interaction

A screenshot proves the page LOOKS right; only interaction proves it WORKS.
After visual inspection, drive the page with `web_interact` (click the primary
CTA, submit the form, toggle a control, read back state). Steps stop at the
first failure with the reason. Trusted CDP clicks grant user activation, so
clipboard/login flows behave for real. Capture/step traps are in
`../../ux-capture/SKILL.md`.

## Accessibility pass (what CSS text cannot show)

Tab through and confirm a visible focus ring (an `outline:none` rule with no
replacement is a defect, not a pass); accessible names on icon-only controls;
one `<h1>` with ordered headings; labels tied to inputs; meaningful `alt`; tap
targets ≥44×44 at mobile widths; horizontal overflow with the offending element
named; text contrast against its *inherited* background. `ux_audit {url}`
reports all of these automatically — fix what it finds, then check what it
cannot (keyboard order, focus trapping, screen-reader naming).

## Report shape (fixed, ranked)

```
Verdict: Ship / Ship with fixes / Needs work · viewports checked: 360/390/768/1024/1440/1920
Blockers — breaks usability or fails AA
High — fix before merge
Medium — polish
Nits — prefix each "Nit:"
What's working — name it, so the fix pass does not erase it
```

Every finding carries its evidence: what you saw → why it fails → the fix,
backed by a screenshot, console line, or measured value. No evidence, no
finding. Separate "broken" from "I'd prefer"; fix Blockers/High before you hand off.

## No capture path?

Say so plainly and label the pass heuristic — never report a check you could
not run as passed. `ux_audit` is then the only deterministic gate, and its
`post-`/`INCOMPLETE` verdicts still stand.
