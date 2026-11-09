---
name: Storefront
description: A shop where the products are the page. Warm canvas, product tiles in two tints, a grotesk with weight, one deep glaze blue for buying, black for adding.
colors:
  canvas: "#F4F2EF"
  card: "#FDFCFA"
  tile: "#E9E5DE"
  tile-blue: "#DCE4EA"
  ink: "#1A1A1A"
  ink-muted: "#5E5B57"
  glaze: "#1E4D6B"
  on-glaze: "#F4F8FB"
  sale: "#9B1C14"
  sale-soft: "#FCE7E4"
typography:
  display: { fontFamily: Bricolage Grotesque, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.06 }
  body: { fontFamily: Onest, fontSize: 1rem, lineHeight: 1.55 }
  price: { fontFamily: Onest, fontWeight: 700, fontSize: 1.125rem }
rounded: { sm: 8px, md: 14px, pill: 999px }
spacing: { 1: 4px, 2: 8px, 3: 16px, 4: 24px, 5: 32px, 6: 56px, 7: 96px }
components:
  button-buy: { backgroundColor: "{colors.glaze}", textColor: "{colors.on-glaze}", rounded: "{rounded.pill}", height: 48px }
  button-add: { backgroundColor: "{colors.ink}", textColor: "{colors.card}", rounded: "{rounded.pill}", height: 44px }
  product-shot: { backgroundColor: "{colors.tile}", rounded: "{rounded.md}" }
  sale-tag: { textColor: "{colors.sale}", backgroundColor: "{colors.sale-soft}", rounded: "{rounded.pill}" }
  chip: { backgroundColor: "{colors.card}", pressedText: "{colors.glaze}", rounded: "{rounded.pill}", height: 44px }
motion:
  m-rise: 32px
  m-arrive: 700ms
  m-gap: 75ms
  m-surface: "{colors.card}"
---

## Overview

A small-batch shop: the product sits large on a soft tile, the name and price
sit plainly under it, and the add button is always one tap away. One brand
colour, taken from the product itself.

Use for: e-commerce, product catalogues, shops, marketplaces, D2C brands,
menus with ordering, booking with prices.
Not for: dashboards, long articles.

## Colors

- **canvas** is the page, **card** the chips and info panels.
- **tile** and **tile-blue** alternate behind product shots (every third tile
  is blue). Products never sit on white.
- **glaze** is the main call to action and the brand. Swap it for the colour of
  the real product if the request gives one as hex.
- **ink** is the add-to-cart button and the cart pill. **sale** only on
  discount tags, with the old price struck through in **ink-muted**.

## Typography

Bricolage Grotesque 800 for the hero, section heads and big numbers, tight
tracking. Onest for everything else. Prices use `tabular-nums`.

## Layout

Hero split: claim and button left, one featured product tile right with a
name-and-price card overlapping its corner. A 4-column product grid (2 below
1000px) with filter chips beside the heading. Three reassurance panels near the
end (shipping, making, returns).

## Signature

The product drawn large: real photos when the project has them, otherwise a
flat silhouette of the object in the glaze colour, centred on its tile.

## Motion character

32px over 700ms, 75ms apart. The headline rises word by word, products arrive
in reading order, sale tags pop, the featured product drifts slightly with the
scroll, the shipping bar fills, numbers count. Chips filter with the kit's
sliding pill.

## Do / Don't

- DO show price and add button on every product, on one line.
- DO keep tiles at a 4:5 ratio so the grid lines up.
- DON'T use orange or terracotta as the brand by default.
- DON'T put more than one sale colour on a page.

## Audit pairs

```json
[
  { "fg": "#1A1A1A", "bg": "#F4F2EF", "label": "ink on canvas", "size": 16 },
  { "fg": "#1A1A1A", "bg": "#FDFCFA", "label": "ink on card", "size": 16 },
  { "fg": "#5E5B57", "bg": "#F4F2EF", "label": "muted on canvas", "size": 15, "role": "secondary" },
  { "fg": "#1A1A1A", "bg": "#E9E5DE", "label": "ink on tile", "size": 16 },
  { "fg": "#1A1A1A", "bg": "#DCE4EA", "label": "ink on tile-blue", "size": 16 },
  { "fg": "#F4F8FB", "bg": "#1E4D6B", "label": "on glaze", "weight": 600, "size": 16 },
  { "fg": "#1E4D6B", "bg": "#FDFCFA", "label": "glaze text on card", "size": 16 },
  { "fg": "#FDFCFA", "bg": "#1A1A1A", "label": "add button", "weight": 600, "size": 15 },
  { "fg": "#9B1C14", "bg": "#FCE7E4", "label": "sale tag", "weight": 700, "size": 13 }
]
```

Derived from the E-commerce rows of ui-ux-pro-max-skill's product list and its Flat Design row (MIT, see `../NOTICE`); palette, type and motion rebuilt for this module's gates.
