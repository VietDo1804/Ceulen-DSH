# Motion — smooth, alive, and seen

Read this whole file before writing CSS for new or user-facing UI. A correct page
with little motion feels unfinished, so motion is part of the design, not polish
added at the end.

**Default posture: rich and smooth.** A visitor sees something move on load, while
scrolling, on every interaction, and wherever the pointer goes: the interface itself
answers the cursor. Never a glow, trail, or custom cursor that follows it. Motion nobody sees
does not count: anything below the first screen waits until it scrolls in.

## Start with the kit

Do not write this motion yourself and do not retype the kit. Copy both files next
to the page, using this skill's base directory:

```bash
cp <base directory>/kit/motion.js <base directory>/kit/motion.css .
```

```html
<link rel="stylesheet" href="motion.css">   <!-- after your own stylesheet -->
<script src="motion.js"></script>           <!-- last thing in body -->
```

```css
:root { --m-accent: var(--your-accent); --m-surface: var(--your-raised-surface); }
```

Run `ux_audit` on your own stylesheet, not on `motion.css`. Then mark up what the page has. The kit reads these attributes and does the rest:

| Put this | On | You get |
|---|---|---|
| `data-words` | the page headline | Words rise in one by one |
| `data-load` | each other first-screen block | Blocks arrive in order on load |
| `data-arrive` | every row, card, and list item below the first screen | It arrives as it scrolls in, and reacts to the pointer. `="left"` or `="right"` slides it in from that side |
| `data-count` | a span holding a number, such as `18,400` or `$4.2M` | Counts up when seen, keeping its format |
| `data-sweep` | a section header with a bottom rule | A line sweeps across it |
| `data-fill="0.6"` | an empty block element | A bar draws to 60%. Add `data-from="0.2"` for a span on a timeline |
| `data-draw` | an `<svg>` chart with a real `viewBox` | The line wipes in with a dot running along it. Put `data-line` on the line if the chart has several paths. Children of its parent with `data-at="0.5"` land as it passes that fraction |
| `data-start="18:55" data-end="20:55"` | the same `<svg>`: the times of the line's first and last point | Turns on `data-time`. Also takes dates or plain numbers |
| `data-time="19:40"` | each axis label and note, and any `<line>` marking a moment | The kit puts it at that time on the line and lands it as the line passes. Never write a `left` or an `x` for a mark by hand |
| `data-axis` | a `<div>` beside the `<svg>`, in the same parent, holding `data-time` labels | One row of labels. Use one above and one below. Labels that would collide stack onto a second row, so it needs no phone rules |
| `data-rail` | a timeline list | A line draws as you read. Put `data-dot` on each row's marker: it lights and pops when reached |
| `data-filter-list` | the filtered list | Give each row `data-type="x"` |
| `data-filter="x"` | each filter button, with `data-filter="all"` for all | A pill slides between buttons, rows glide, sections below glide. Add `aria-pressed` |
| `data-filter-count`, `data-filter-empty` | a result count, an empty message | Kept up to date. For your own wording, listen for `motion:filtered` on `document` (`detail` has `type`, `shown`, `total`) |
| `data-pulse` | a live or open status dot | A ring leaves it, slowly |
| `data-breathe` | a small status dot | It fades gently in and out |
| `data-pop` | a pill or badge inside an arriving item | It pops in after its parent |
| `data-glow` | the hero | A soft light drifts behind it |
| `data-parallax="0.2"` | large decoration in the hero | It trails the scroll |

Automatic, no markup: every `h2` wipes in, a progress bar appears on tall pages, and
rows slide an accent bar in on hover. Everything marked above also answers the pointer.
What sits near the cursor moves and settles behind it: rows lean, dots swell, cards tilt,
numbers and headline words lift, filter buttons pull toward it, `data-parallax` drifts
against it. What the cursor reaches plays again: numbers recount, bars redraw, pills pop,
the rail runs to the row under it, and the dot on a `data-draw` chart runs along the line. With
`prefers-reduced-motion` all of it is off and the page is complete and readable.
Screenshots stay full: the audit's normal pass renders with motion off, so nothing
sits blank. Filtering does not replay arrivals, the kit handles that.

A chart with time on it. `data-end` is the time of the line's last point, and no label needs a position:

```html
<div class="chart">
  <div data-axis><span data-time="19:14">19:14 · pool exhausted</span><span data-time="20:42">20:42 · resolved</span></div>
  <svg data-draw data-start="18:55" data-end="20:55" viewBox="0 0 1000 200" preserveAspectRatio="none">
    <line data-time="19:14" y1="0" y2="182" vector-effect="non-scaling-stroke"/>
    <line data-time="20:42" y1="0" y2="182" vector-effect="non-scaling-stroke"/>
    <path data-line d="M0,181 L16.7,181 …"/>
  </svg>
  <div data-axis><span data-time="19:00">19:00</span><span data-time="19:30">19:30</span><span data-time="20:00">20:00</span><span data-time="20:30">20:30</span></div>
</div>
```

## Rules

- Use every row the kit can move: a long page with a still list fails the audit.
- Animate only `transform`, `opacity`, `clip-path`, and `filter`. `color`, `background`, and `box-shadow` are fine for state changes. Never `width`, `height`, `top`, `left`, `margin`, or `padding`.
- Vary the motion by content: numbers count, bars fill, lines draw, rows arrive from different sides. One identical fade-up on every section is the AI tell.
- Arrivals move 24–32px over about 700ms, staggered 70–90ms across six items at most. The first screen settles within about 1.5s. Any single CSS animation stays at 1.2s or under.
- Springs are for small things landing: dots and pills, never rows or sections. Slow loops are for status dots and one background glow, nothing else.
- Hover moves content a few pixels at most, never a lift or a shadow jump. Data rows promise no click, so no pointer cursor.
- Animate a chart only when the page has the real series. Never invent data so that something can draw.
- Mark a span of time on a chart with two thin `<line data-time>` hairlines, never a filled block: a tinted rectangle that stops short of the chart's edges reads as a layout bug.
- A time or value you write in text must be read off the series. A peak labelled 19:15 sits at 19:15 on the line.
- If a section's content is on the first screen, use `data-load`, not `data-arrive`.

## In React or Next

Copy both files to `public/`, link `/motion.css` in the root layout, and load the script from one component at the root, so it runs after hydration. A `<script>` tag in the layout changes the page before React hydrates it.

```jsx
'use client'
import { useEffect } from 'react'
export const Motion = () => { useEffect(() => { document.body.append(Object.assign(document.createElement('script'), { src: '/motion.js' })) }, []); return null }
```

- The kit watches the page: rows, charts, and filters that render later or after a route change are picked up. Give list rows a stable `key`, or every refresh replays them.
- Put `data-recount="off"` on `<html>` in any app people work in, so a number under the pointer never shows a false value. It still counts up once.
- `data-words` and `data-count` need one plain string: `{`${n} min`}`, not `{n} min`. Otherwise the kit leaves that element still.
- If React state filters the list, leave out the `data-filter` attributes. New rows arrive by themselves.

## What to pick

| Page | Load | Then |
|---|---|---|
| Dashboard | `data-count` on key numbers, `data-draw` on the main chart, `data-fill` on bars | `data-arrive` rows, filters, `data-pulse` if data is live |
| Report, incident, or long article | `data-words`, `data-count`, `data-glow` | `data-rail` on any timeline, `data-arrive="left"` and `="right"` by section, `data-fill` for durations |
| Settings or form | The signature element comes alive | Toggles slide, save state fades, errors appear without a jump |
| Landing page | `data-words`, `data-load` on the action, `data-glow` | `data-arrive` on each section's items |
| Explainer | Each step animates when the reader reaches it | The reader controls the pace; replay is available |

## Tokens

For your own state changes. Use these, do not invent timings.

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

## Beyond the kit

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
3. Fix any `chart-time`, `chart-peak`, `motion-arrival`, `motion-layout`, `motion-slow`, `motion-overflow`, or `reduced-motion` finding.

`requestAnimationFrame` counters do not appear in frames, and no frame can prove a page feels smooth, so say what you could not check.
