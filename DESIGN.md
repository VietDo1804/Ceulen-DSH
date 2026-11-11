# Ceulen documentation design system

Direction: technical field report · type Charter+DejaVu Sans Mono · palette #eff0ea/#151a16/#861f0a · signature execution rail · motion word-rise + section arrivals.

Reuses the existing documentation palette and typography from `docs/explainers/codemode-vs-pi-1.5.html`; no new product identity. Paper, green-black ink, vermilion annotations. Long-form reading, left-aligned headings, narrow prose and full-width evidence tables. No cards, gradients, or decorative metrics.

Canonical stylesheet tokens: `docs/codemode_explain/codemode-tokens.css`. The copied motion kit owns its animation constants. Native anchors use hover/focus-visible/active; disabled/loading/empty/error do not apply to static navigation. All content remains readable without JavaScript.

```css
:root {
  --paper: #eff0ea;
  --paper-2: #e6e8e0;
  --surface: #f7f7f2;
  --ink: #151a16;
  --ink-soft: #343b35;
  --muted: #49514a;
  --rule: #cdd2c7;
  --rule-strong: #a7aea1;

  --accent-ink: #861f0a;
  --accent-fill: #c04720;

  --success: #0d4a2e;
  --success-tint: #dfeae1;
  --danger: #7a1f16;
  --danger-tint: #f3e0db;

  --focus: #6e1c08;
  --selection: #f0d8c8;

  --inverse: #191f1b;
  --inverse-2: #232a25;
  --inverse-ink: #e9ece4;
  --inverse-ink-soft: #e0e5dd;
  --inverse-muted: #d3dacf;
  --inverse-rule: #39423b;
  --inverse-rule-strong: #6a756b;
  --inverse-accent: #ffc7a6;
  --inverse-danger: #f0a08d;
  --inverse-success: #8ec9a6;

  --code-bg: #20261f;
  --code-bar: #293029;
  --code-rule: #3a4239;
  --code-ink: #e7ebe2;
  --code-muted: #d3dbcf;
  --code-comment: #ced8ca;
  --code-key: #ffcfae;
  --code-string: #bfdcb6;
  --code-number: #efce93;
  --code-punct: #d5ddd1;
  --code-hover: #323a31;
  --code-ok: #b8e3c6;
  --code-err: #ffd0c2;

  --focus-inverse: #ffbc98;

  --font-serif: "Bitstream Charter", "Charter", "C059", "Georgia", serif;
  --font-mono: "DejaVu Sans Mono", "Liberation Mono", "SFMono-Regular", Consolas, monospace;

  --text-xs: 0.8125rem;   /* 13 */
  --text-sm: 0.9375rem;   /* 15 */
  --text-base: 1.0625rem; /* 17 */
  --text-lg: 1.25rem;     /* 20 */
  --text-xl: 1.5rem;      /* 24 */
  --text-2xl: 2rem;       /* 32 */
  --text-display: clamp(3.25rem, 8.5vw, 5.75rem);

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-10: 6rem;

  --radius-xs: 2px;
  --radius-sm: 3px;
  --radius-md: 5px;

  --elev-1: 0 1px 0 var(--rule);

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-1: 180ms;
  --dur-2: 320ms;
  --dur-3: 700ms;

  --frame-max: 76rem;
  --gutter: clamp(1.25rem, 4vw, 3.5rem);
  --print-paper: #ffffff;
}
```

Layout uses existing spacing scale; hairlines 1px; zero radius except code samples. Reduced-motion disables transitions and animation. All interactive targets have at least 44px height.
