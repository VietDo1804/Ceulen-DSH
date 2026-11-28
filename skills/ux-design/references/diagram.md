# Diagrams — written as lines, drawn by the kit

A block or flow diagram is never an `<svg>` you place by hand: boxes drift,
arrows miss, and it breaks on a phone. Write the diagram as lines and let
`kit/diagram.js` lay it out, theme it from the tokens, and animate it.
`ux_kit` copies the file for a page to read; otherwise:

```bash
cp <base directory>/kit/diagram.js .
```

```html
<figure data-diagram>
  <pre>
User -> Router: prompt
Router -> Fast model: easy task
Router -> Strong model: hard task
Fast model -> Tools
Strong model -> Tools
Tools -> Result
Result -> User: answer
Router :: picks a model per request
[Harness] Router, Fast model, Strong model, Tools
accent: Router
step: User, Router | A prompt arrives and the router reads it.
step: Router, Fast model, Strong model | Easy work goes to the fast model.
  </pre>
  <figcaption>How a request is routed</figcaption>
</figure>
…
<script src="diagram.js"></script>   <!-- end of body, after motion.js -->
```

## The lines

| Line | Meaning |
|---|---|
| `A -> B` | An arrow from box A to box B. A name is the box's label; the same name is the same box |
| `A -> B: label` | An arrow with a label |
| `A -> B -> C` | A chain |
| `A --> B` | A dashed arrow: optional, async, or a fallback |
| `A <-> B` | An arrow both ways |
| `A :: a few words` | A second, smaller line inside box A |
| `[Group name] A, B, C` | A frame round those boxes |
| `accent: A` | Box A in the accent colour: the one box this section is about |
| `muted: A` | Box A dashed and quiet: external, optional, or out of scope |
| `step: A, B \| what happens here` | One step of a walkthrough. The reader presses Next; that step's boxes and arrows light up and its sentence shows |
| `# note` | A comment |

Names must match exactly between lines. An arrow back to an earlier box
(`Test -> Build: fail`) is drawn against the flow by itself.

## Rules

- Keep the `<pre>` directly inside the `<figure data-diagram>`, and give every
  figure a `<figcaption>` that says what it shows.
- Six to ten boxes read well. Past twelve, split it into two diagrams.
- Box names are two or three words; the detail goes in `::` or in the text.
- One `accent:` box per diagram, or none.
- Use `step:` lines when the order matters: a request path, a handshake, a
  pipeline. Three to six steps.
- The direction is chosen for you: left to right when it fits, top to bottom
  on a narrow screen. Force it only when the content demands it:
  `data-diagram="down"` or `data-diagram="right"`.
- With JavaScript off the lines themselves stay readable in the `<pre>`.

## What you get

Boxes arrive in order from the first to the last, arrows draw in, and a dot
runs along each arrow. Pointing at a box lights its arrows and dims the rest.
With `prefers-reduced-motion` it is drawn complete and still. Colours come from
the kit roles in tokens.css (`--k-surface`, `--k-text`, `--k-link`,
`--k-accent`), so the diagram matches the page.

## Check it

`ux_audit` with `url` reports a `diagram` finding when a diagram shows its
source lines instead of a drawing, with the line that did not parse. Fix the
line; do not replace the diagram with an image or a hand-made SVG.
