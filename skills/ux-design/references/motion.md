# Motion — smooth, alive, and seen

Read this whole file (about 170 lines) before writing CSS for new or user-facing UI. A correct page
with little motion feels unfinished, so motion is part of the design, not polish
added at the end.

**Default posture: smooth and alive.** Calm means nothing bounces, loops, or
hurries. It never means little. A visitor should see something move on load, while
scrolling, and on every interaction. Motion nobody sees does not count: anything
below the first screen must wait until it scrolls in.

## Every page ships four things

1. **A load moment.** The first screen arrives in order, and its numbers, bars, and lines animate as part of it. That is one moment, not several.
2. **Arrival on scroll.** On a page longer than one screen, every row, card, and list item arrives as it enters the viewport. Trigger each item, never a whole list: a list-level trigger plays its cascade off-screen.
3. **Soft state changes.** Hover, press, focus, selection, and filter results never snap.
4. **A reduced-motion fallback** that really stops the motion.

## What to pick

| Page | Load moment | Then |
|---|---|---|
| Dashboard | Key numbers count up, the main chart draws, bars fill | Rows brighten on hover, `softChange` on filters, one lamp pulse if the data is live |
| Report, incident, or long article | Title in order, key numbers count up | Each timeline row, card, and list item arrives as it enters; rows brighten on hover; `softChange` on filters |
| Settings or form | The signature element comes alive | Toggles slide, save state fades, errors appear without a jump |
| Landing page | Headline and action arrive in order | Each section's items arrive as they enter, hover on actions |
| Explainer | Each step animates when the reader reaches it | The reader controls the pace; replay is available |

## Rules

- Animate only `transform` and `opacity`. `color`, `background-color`, and `box-shadow` are fine for state changes. Never `width`, `height`, `top`, `left`, `margin`, or `transition: all`: they stutter and `ux_audit` flags them.
- Vary the motion by content: numbers count, bars fill, lines draw, rows arrive. The AI tell is one identical fade-up on every whole section. Several different moments are expected.
- Keep the load moment under 900ms. Stagger by 40–60ms, across eight items at most. Move small distances: 8–16px. Scale only between 0.96 and 1.
- Arriving things ease out. Nothing bounces or overshoots in product UI. Infinite loops are only for live status.
- Rows and cards that hold data brighten on hover, background colour only. It helps the eye keep its place and promises no click, so no pointer cursor and no lift.
- The resting CSS is the final state, so content stays visible with motion off or JavaScript broken. Clip anything that slides across the page (`overflow-x: clip` on its parent).

## The motion kit

Copy all of it. Mark up three things: `class="later"` on each row, card, or item; `data-count` on a span holding only the digits; `class="below-list"` on every section after a filtered list.

```css
@keyframes rise { from { opacity: 0; transform: translateY(12px); } }
.wait:not(.in) { opacity: 0; }
.wait.in { animation: rise var(--dur-slow) var(--ease-out) backwards; animation-delay: calc(var(--n, 0) * 60ms); }
@media print { .wait:not(.in) { opacity: 1; } }
[data-count] { font-variant-numeric: tabular-nums; }
```
```js
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const ease = 'cubic-bezier(0.22, 1, 0.36, 1)'

function countUp (el) {
  const end = Number(el.dataset.count)
  if (calm || !Number.isFinite(end)) return
  const places = (el.dataset.count.split('.')[1] ?? '').length
  const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })
  const start = performance.now()
  const tick = (now) => {
    const t = Math.min((now - start) / 800, 1)
    el.textContent = format.format(end * (1 - (1 - t) ** 3))
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// Each item arrives as it enters; items entering together stagger.
const seen = new IntersectionObserver((entries) => {
  let n = 0
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    entry.target.style.setProperty('--n', Math.min(n++, 5))
    entry.target.classList.add('in')
    entry.target.querySelectorAll('[data-count]').forEach(countUp)
    seen.unobserve(entry.target)
  }
}, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' })
if (!calm) document.querySelectorAll('.later').forEach((el) => { el.classList.add('wait'); seen.observe(el) })

// Filters and sorting: the list fades, changes while unseen, and its rows return;
// sections below glide to their new place instead of jumping.
let turn = 0
async function softChange (list, below, change) {
  if (calm) return change()
  const mine = ++turn
  await list.animate({ opacity: [getComputedStyle(list).opacity, 0] }, { duration: 140, fill: 'forwards' }).finished
  if (mine !== turn) return
  const tops = below.map((el) => el.getBoundingClientRect().top)
  change()
  list.getAnimations().forEach((a) => a.cancel())
  list.animate({ opacity: [0, 1] }, { duration: 200 })
  below.forEach((el, i) => {
    const dy = tops[i] - el.getBoundingClientRect().top
    if (dy !== 0) el.animate({ transform: [`translateY(${dy}px)`, 'none'] }, { duration: 420, easing: ease })
  })
  ;[...list.children].filter((row) => !row.hidden).forEach((row, i) => {
    row.classList.remove('wait', 'in')
    seen.unobserve(row)
    if (i < 8) row.animate({ opacity: [0, 1], transform: ['translateY(8px)', 'none'] }, { duration: 340, delay: i * 30, easing: ease, fill: 'backwards' })
  })
}
// chip.onclick: set aria-pressed now, then
// softChange(list, [...document.querySelectorAll('.below-list')], () => applyFilter(value))
```

Do not use `document.startViewTransition` on filtered lists: leaving rows ghost behind the new ones.

## Tokens

Use these, do not invent timings.

```css
:root {
  --dur-fast: 150ms;   /* hover, press, colour */
  --dur-base: 240ms;   /* panels, tabs */
  --dur-slow: 420ms;   /* arrivals */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);    /* things arriving */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1); /* things moving across */
}

/* !important is required: `*` loses to any class selector without it. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
```

## More patterns

**Ordered load**, first screen only.

```css
.reveal { animation: rise var(--dur-slow) var(--ease-out) both; animation-delay: calc(var(--i, 0) * 50ms); }
```
```html
<section class="panel reveal" style="--i: 2">…</section>
```

**Bars and meters that fill.** Use `scaleX`, never `width`.

```css
.fill { transform-origin: left; transform: scaleX(var(--value)); animation: fill 700ms var(--ease-out) both; }
@keyframes fill { from { transform: scaleX(0); } }
```

**Lines and rings that draw.** Add `pathLength="1"` to the SVG shape.

```css
.line { stroke-dasharray: 1; animation: draw 900ms var(--ease-in-out) both; }
@keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
```

**State changes.**

```css
.btn { transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.btn:active { transform: scale(0.98); }
.row { transition: background-color var(--dur-fast) var(--ease-out); }
.row:hover { background-color: var(--surface-2); }
```

## Check it

1. Call `ux_audit` with `url` and `motion: true`. It returns three frames (start, middle, end) of the load, from a frozen timeline. Does the page build in a sensible order, and does the last frame match the resting page?
2. Those frames cover load only. Check scroll and filters with `web_interact`: it returns only the last screenshot, so take one shot per call. On a page with `scroll-behavior: smooth`, set `document.documentElement.style.scrollBehavior = 'auto'` first, or its clicks can miss.
3. Fix any `motion-layout`, `motion-slow`, `motion-overflow`, or `reduced-motion` finding.

`requestAnimationFrame` counters do not appear in frames, and no frame can prove a page feels smooth, so say what you could not check.
