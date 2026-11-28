// Diagram kit. Copy this file next to the page, do not retype it.
// It turns plain lines into a laid-out, animated block diagram:
//
//   <figure data-diagram>
//     <pre>
//   User -> Router: prompt
//   Router -> Fast model: easy task
//   Router -> Strong model: hard task
//   Router :: picks a model per request
//   [Harness] Router, Fast model, Strong model
//   step: User, Router | A prompt arrives at the router
//     </pre>
//     <figcaption>How a request is routed</figcaption>
//   </figure>
//
// Never place a box or a line by hand. See references/diagram.md.
(() => {
  const root = document.documentElement
  if (root.dataset.diagramKit !== undefined) return
  root.dataset.diagramKit = 'on'
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const NS = 'http://www.w3.org/2000/svg'
  const out = 'cubic-bezier(0.22, 1, 0.36, 1)'
  let serial = 0

  const style = document.createElement('style')
  style.dataset.diagramKit = ''
  style.textContent = `
[data-diagram] { --d-bg: var(--k-bg, Canvas); --d-surface: var(--k-surface, Canvas); --d-text: var(--k-text, CanvasText); --d-muted: var(--k-muted, GrayText); --d-line: var(--k-link, var(--k-accent, CanvasText)); --d-accent: var(--k-accent, Highlight); --d-on-accent: var(--k-on-accent, HighlightText); --d-stroke: color-mix(in srgb, var(--d-text) 28%, transparent); }
[data-diagram] .d-scroll { max-width: 100%; overflow-x: auto; }
[data-diagram] .d-svg { display: block; height: auto; max-width: 100%; margin-inline: auto; font-family: inherit; overflow: visible; }
[data-diagram] .d-node rect { fill: var(--d-surface); stroke: var(--d-stroke); stroke-width: 1.5; transition: stroke 240ms, stroke-width 240ms; }
[data-diagram] .d-node text { fill: var(--d-text); font-size: 14px; font-weight: 600; }
[data-diagram] .d-node .d-note { fill: var(--d-muted); font-size: 12px; font-weight: 400; }
[data-diagram] .d-node[data-tone="accent"] rect { fill: var(--d-accent); stroke: var(--d-accent); }
[data-diagram] .d-node[data-tone="accent"] text, [data-diagram] .d-node[data-tone="accent"] .d-note { fill: var(--d-on-accent); }
[data-diagram] .d-node[data-tone="muted"] rect { fill: transparent; stroke-dasharray: 4 4; }
[data-diagram] .d-node[data-tone="muted"] text { fill: var(--d-muted); }
[data-diagram] .d-edge path { fill: none; stroke: var(--d-line); stroke-width: 1.75; stroke-linecap: round; }
[data-diagram] .d-edge[data-dashed] path { stroke-dasharray: 5 6; }
[data-diagram] .d-edge text { fill: var(--d-muted); font-size: 12px; font-weight: 500; }
[data-diagram] .d-edge .d-label-bg { fill: var(--d-bg); }
[data-diagram] .d-arrow { fill: var(--d-line); }
[data-diagram] .d-dot { fill: var(--d-line); opacity: 0; pointer-events: none; }
[data-diagram] .d-group rect { fill: color-mix(in srgb, var(--d-text) 4%, transparent); stroke: var(--d-stroke); stroke-width: 1; stroke-dasharray: 2 5; }
[data-diagram] .d-group text { fill: var(--d-muted); font-size: 12px; font-weight: 600; }
[data-diagram] .d-node, [data-diagram] .d-edge, [data-diagram] .d-group { transition: opacity 240ms; }
[data-diagram] .d-dim { opacity: 0.25; }
[data-diagram] .d-on rect { stroke: var(--d-line); stroke-width: 2.5; }
[data-diagram] .d-on[data-tone="accent"] rect { stroke: var(--d-text); }
[data-diagram] .d-steps { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 16px; }
[data-diagram] .d-steps p { flex: 1 1 14rem; margin: 0; color: var(--d-text); }
[data-diagram] .d-steps b { color: var(--d-muted); font-weight: 600; font-variant-numeric: tabular-nums; margin-right: 0.5em; }
[data-diagram] .d-steps button { flex: none; min-height: 44px; min-width: 44px; padding: 0 18px; border-radius: 999px; border: 1.5px solid var(--d-stroke); background: var(--d-surface); color: var(--d-text); font: inherit; font-weight: 600; cursor: pointer; transition: transform 150ms; }
[data-diagram] .d-steps .d-next { background: var(--d-accent); color: var(--d-on-accent); border-color: transparent; }
[data-diagram] .d-steps button:active { transform: scale(0.97); }
[data-diagram] .d-steps button:focus-visible { outline: 2px solid var(--d-line); outline-offset: 2px; }
[data-diagram] .d-steps button:disabled { opacity: 0.5; cursor: not-allowed; }
[data-diagram] .d-error { margin: 8px 0 0; color: var(--d-text); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { [data-diagram] * { transition: none !important; } }
`
  document.head.append(style)

  /* ---------- reading the lines ---------- */

  function parse (source) {
    const nodes = new Map()
    const edges = []
    const groups = []
    const steps = []
    const tones = []
    const errors = []
    const node = (name) => {
      const id = name.trim()
      if (id === '') return null
      if (!nodes.has(id)) nodes.set(id, { id, note: '', tone: '' })
      return nodes.get(id)
    }
    const list = (text) => text.split(',').map((part) => part.trim()).filter((part) => part !== '')
    source.split('\n').forEach((raw, index) => {
      const at = index + 1
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith('//')) return
      let match = /^step\s*:\s*(.*)$/i.exec(line)
      if (match !== null) {
        const bar = match[1].indexOf('|')
        steps.push({ at, ids: list(bar < 0 ? match[1] : match[1].slice(0, bar)), text: bar < 0 ? '' : match[1].slice(bar + 1).trim() })
        return
      }
      match = /^(accent|muted)\s*:\s*(.*)$/i.exec(line)
      if (match !== null) {
        tones.push({ at, tone: match[1].toLowerCase(), ids: list(match[2]) })
        return
      }
      match = /^\[(.+?)\]\s*(.*)$/.exec(line)
      if (match !== null) {
        groups.push({ at, label: match[1].trim(), ids: list(match[2]) })
        return
      }
      match = /^(.+?)\s*::\s*(.+)$/.exec(line)
      if (match !== null && !/->/.test(match[1])) {
        const target = node(match[1])
        if (target !== null) target.note = match[2].trim()
        return
      }
      if (/->/.test(line)) {
        const colon = line.indexOf(':', line.lastIndexOf('->'))
        const label = colon < 0 ? '' : line.slice(colon + 1).trim()
        const parts = (colon < 0 ? line : line.slice(0, colon)).split(/\s*(<->|-->|->)\s*/)
        for (let i = 0; i + 2 < parts.length; i += 2) {
          const from = node(parts[i])
          const to = node(parts[i + 2])
          if (from === null || to === null) { errors.push(`line ${at}: an arrow needs a name on both sides`); return }
          if (from === to) continue
          edges.push({ from: from.id, to: to.id, label: i + 3 === parts.length ? label : '', dashed: parts[i + 1] === '-->', both: parts[i + 1] === '<->' })
        }
        return
      }
      if (!/[:|]/.test(line)) { node(line); return }
      errors.push(`line ${at}: not understood: "${line.slice(0, 60)}"`)
    })
    const known = (entry, what) => {
      const missing = entry.ids.filter((id) => !nodes.has(id))
      if (missing.length > 0) errors.push(`line ${entry.at}: ${what} names "${missing.join('", "')}", which no arrow line has. Names must match exactly.`)
      return missing.length === 0
    }
    for (const entry of tones) if (known(entry, entry.tone)) for (const id of entry.ids) nodes.get(id).tone = entry.tone
    for (const group of groups) known(group, 'the group')
    for (const step of steps) known(step, 'the step')
    if (nodes.size === 0 && errors.length === 0) errors.push('no boxes: write lines such as "User -> Router: prompt"')
    return { nodes: [...nodes.values()], edges, groups, steps, errors }
  }

  /* ---------- measuring text ---------- */

  const canvas = document.createElement('canvas').getContext('2d')
  function wrap (text, font, maxWidth, maxLines) {
    canvas.font = font
    const lines = []
    let line = ''
    for (const word of text.split(/\s+/)) {
      const next = line === '' ? word : `${line} ${word}`
      if (line !== '' && canvas.measureText(next).width > maxWidth) { lines.push(line); line = word } else line = next
    }
    if (line !== '') lines.push(line)
    if (lines.length > maxLines) {
      lines.length = maxLines
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/.{2}$/, '')}…`
    }
    return { lines, width: Math.max(0, ...lines.map((entry) => canvas.measureText(entry).width)) }
  }

  /* ---------- layout: ranks, order, positions ---------- */

  function layout (graph, family, across, textMax) {
    const titleFont = `600 14px ${family}`
    const noteFont = `400 12px ${family}`
    const labelFont = `500 12px ${family}`
    const items = new Map()
    graph.nodes.forEach((node, index) => {
      const title = wrap(node.id, titleFont, textMax, 3)
      const note = node.note === '' ? { lines: [], width: 0 } : wrap(node.note, noteFont, textMax, 3)
      items.set(node.id, {
        ...node, index, title: title.lines, noteLines: note.lines, real: true,
        w: Math.max(96, Math.ceil(Math.max(title.width, note.width)) + 32),
        h: 24 + title.lines.length * 18 + (note.lines.length === 0 ? 0 : 4 + note.lines.length * 16),
        ins: [], outs: [], rank: 0,
      })
    })

    /* a cycle is drawn against the flow: find the arrows that close one */
    const links = []
    const state = new Map()
    const outgoing = new Map(graph.nodes.map((node) => [node.id, []]))
    for (const edge of graph.edges) outgoing.get(edge.from).push(edge)
    const back = new Set()
    const visit = (id) => {
      state.set(id, 1)
      for (const edge of outgoing.get(id)) {
        if (state.get(edge.to) === 1) back.add(edge)
        else if (state.get(edge.to) === undefined) visit(edge.to)
      }
      state.set(id, 2)
    }
    for (const node of graph.nodes) if (state.get(node.id) === undefined) visit(node.id)
    for (const edge of graph.edges) {
      const rev = back.has(edge)
      links.push({ edge, rev, s: rev ? edge.to : edge.from, t: rev ? edge.from : edge.to })
    }
    for (const link of links) { items.get(link.s).outs.push(link); items.get(link.t).ins.push(link) }

    /* rank = longest path from a start; a start then moves up beside what it feeds */
    const order = []
    const seen = new Set()
    const topo = (id) => { if (seen.has(id)) return; seen.add(id); for (const link of items.get(id).ins) topo(link.s); order.push(id) }
    for (const node of graph.nodes) topo(node.id)
    for (const id of order) { const item = items.get(id); item.rank = Math.max(0, ...item.ins.map((link) => items.get(link.s).rank + 1)) }
    for (const id of order) {
      const item = items.get(id)
      if (item.ins.length === 0 && item.outs.length > 0) item.rank = Math.max(0, Math.min(...item.outs.map((link) => items.get(link.t).rank)) - 1)
    }

    /* an arrow across several ranks gets a waypoint in each, so it bends round boxes */
    const layers = []
    const put = (item) => {
      layers[item.rank] ??= []
      layers[item.rank].push(item)
    }
    for (const node of graph.nodes) put(items.get(node.id))
    for (const link of links) {
      const from = items.get(link.s)
      const to = items.get(link.t)
      link.path = [from]
      for (let rank = from.rank + 1; rank < to.rank; rank++) {
        const way = { real: false, rank, index: from.index, w: across ? 0 : 16, h: across ? 16 : 0, ins: [], outs: [], id: `way-${links.indexOf(link)}-${rank}` }
        put(way)
        link.path.push(way)
      }
      link.path.push(to)
      for (let i = 0; i + 1 < link.path.length; i++) { link.path[i].next = (link.path[i].next ?? []).concat(link.path[i + 1]); link.path[i + 1].prev = (link.path[i + 1].prev ?? []).concat(link.path[i]) }
    }
    for (let rank = 0; rank < layers.length; rank++) layers[rank] ??= []

    /* order inside a rank: each box sits at the average place of its neighbours, group members together */
    const groupOf = new Map()
    graph.groups.forEach((group, index) => { for (const id of group.ids) if (!groupOf.has(id)) groupOf.set(id, index) })
    for (const layer of layers) {
      layer.sort((a, b) => a.index - b.index)
      for (const [place, item] of layer.entries()) item.place = place
    }
    const sweep = (layer, side) => {
      const keyed = layer.map((item) => {
        const near = item[side] ?? []
        return { item, key: near.length === 0 ? item.place : near.reduce((sum, other) => sum + other.place, 0) / near.length }
      })
      const groupKey = new Map()
      for (const entry of keyed) {
        const group = entry.item.real ? groupOf.get(entry.item.id) : undefined
        if (group === undefined) continue
        const bucket = groupKey.get(group) ?? { sum: 0, count: 0 }
        bucket.sum += entry.key; bucket.count += 1
        groupKey.set(group, bucket)
      }
      for (const entry of keyed) {
        const group = entry.item.real ? groupOf.get(entry.item.id) : undefined
        entry.cluster = group === undefined ? entry.key : groupKey.get(group).sum / groupKey.get(group).count
      }
      keyed.sort((a, b) => a.cluster - b.cluster || a.key - b.key || a.item.place - b.item.place)
      keyed.forEach((entry, place) => { entry.item.place = place })
      layer.sort((a, b) => a.place - b.place)
    }
    for (let round = 0; round < 4; round++) {
      for (let rank = 1; rank < layers.length; rank++) sweep(layers[rank], 'prev')
      for (let rank = layers.length - 2; rank >= 0; rank--) sweep(layers[rank], 'next')
    }

    /* positions. "main" runs along the flow, "cross" runs across it */
    const hasGroups = graph.groups.length > 0
    const main = (item) => (across ? item.w : item.h)
    const cross = (item) => (across ? item.h : item.w)
    const crossGap = (across ? 22 : 28) + (hasGroups ? 14 : 0)
    canvas.font = labelFont
    const labelSize = (rank) => {
      let size = 0
      for (const link of links) {
        if (link.edge.label === '') continue
        const middle = link.path[Math.floor((link.path.length - 1) / 2)].rank
        if (middle === rank) size = Math.max(size, across ? canvas.measureText(link.edge.label).width + 28 : 30)
      }
      return size
    }
    let cursor = 0
    const rankStart = []
    layers.forEach((layer, rank) => {
      rankStart[rank] = cursor
      const size = Math.max(0, ...layer.map(main))
      for (const item of layer) item.m = cursor + (size - main(item)) / 2
      cursor += size + Math.max(across ? 64 : 52, labelSize(rank)) + (hasGroups ? 16 : 0)
    })
    for (const layer of layers) {
      let at = 0
      for (const item of layer) { item.c = at; at += cross(item) + crossGap }
      const shift = (at - crossGap) / 2
      for (const item of layer) item.c -= shift
    }
    const settle = (layer, side) => {
      const wanted = layer.map((item) => {
        const near = item[side] ?? []
        return near.length === 0 ? item.c + cross(item) / 2 : near.reduce((sum, other) => sum + other.c + cross(other) / 2, 0) / near.length
      })
      let edge = -Infinity
      let drift = 0
      layer.forEach((item, i) => {
        item.c = Math.max(wanted[i] - cross(item) / 2, edge)
        edge = item.c + cross(item) + crossGap
        drift += item.c + cross(item) / 2 - wanted[i]
      })
      drift /= Math.max(1, layer.length)
      for (const item of layer) item.c -= drift
    }
    for (let round = 0; round < 3; round++) {
      for (let rank = 1; rank < layers.length; rank++) settle(layers[rank], 'prev')
      for (let rank = layers.length - 2; rank >= 0; rank--) settle(layers[rank], 'next')
    }
    const all = layers.flat()
    const pad = hasGroups ? 34 : 14
    const low = Math.min(...all.map((item) => item.c))
    for (const item of all) {
      item.x = (across ? item.m : item.c - low) + pad
      item.y = (across ? item.c - low : item.m) + pad
    }

    /* groups: a frame round the members, unless another box would end up inside it */
    const frames = []
    for (const group of graph.groups) {
      const members = group.ids.map((id) => items.get(id)).filter((item) => item !== undefined)
      if (members.length === 0) continue
      const frame = {
        label: group.label, ids: group.ids,
        x: Math.min(...members.map((item) => item.x)) - 14,
        y: Math.min(...members.map((item) => item.y)) - 30,
        right: Math.max(...members.map((item) => item.x + item.w)) + 14,
        bottom: Math.max(...members.map((item) => item.y + item.h)) + 14,
      }
      const crowded = all.some((item) => item.real && !group.ids.includes(item.id) && item.x < frame.right && item.x + item.w > frame.x && item.y < frame.bottom && item.y + item.h > frame.y)
      if (!crowded) frames.push(frame)
    }

    /* arrows: a smooth curve through the waypoints, two arrows between one pair kept apart */
    const pairCount = new Map()
    const pairKey = (link) => [link.s, link.t].sort().join('\u0000')
    for (const link of links) pairCount.set(pairKey(link), (pairCount.get(pairKey(link)) ?? 0) + 1)
    const pairSeen = new Map()
    const routes = links.map((link) => {
      const total = pairCount.get(pairKey(link))
      const nth = pairSeen.get(pairKey(link)) ?? 0
      pairSeen.set(pairKey(link), nth + 1)
      const offset = (nth - (total - 1) / 2) * 16
      const points = link.path.map((item, i) => {
        const first = i === 0
        const last = i === link.path.length - 1
        const centre = { x: item.x + item.w / 2, y: item.y + item.h / 2 }
        if (across) return { x: first ? item.x + item.w : last ? item.x : centre.x, y: centre.y + (item.real ? offset : 0) }
        return { x: centre.x + (item.real ? offset : 0), y: first ? item.y + item.h : last ? item.y : centre.y }
      })
      let d = `M${points[0].x},${points[0].y}`
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i]
        const b = points[i + 1]
        d += across
          ? ` C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`
          : ` C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}`
      }
      const half = Math.floor((points.length - 1) / 2)
      const from = points[half]
      const to = points[half + 1]
      return { link, d, label: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, width: link.edge.label === '' ? 0 : canvas.measureText(link.edge.label).width }, rank: items.get(link.s).rank }
    })

    const width = Math.max(...all.map((item) => item.x + item.w), ...frames.map((frame) => frame.right)) + pad
    const height = Math.max(...all.map((item) => item.y + item.h), ...frames.map((frame) => frame.bottom)) + pad
    return { boxes: all.filter((item) => item.real), routes, frames, width, height, across }
  }

  /* ---------- drawing ---------- */

  const svgEl = (name, attributes = {}, text) => {
    const el = document.createElementNS(NS, name)
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value))
    if (text !== undefined) el.textContent = text
    return el
  }

  function pageBackground (el) {
    for (let node = el; node !== null; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor
      if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour
    }
    return ''
  }

  function draw (figure) {
    const source = figure.querySelector(':scope > pre, :scope > script[type="text/plain"]')
    if (source === null) return
    const graph = parse(source.textContent ?? '')
    for (const el of figure.querySelectorAll(':scope > .d-scroll, :scope > .d-steps, :scope > .d-error')) el.remove()
    if (graph.errors.length > 0) {
      figure.dataset.diagramState = 'error'
      source.hidden = false
      const note = document.createElement('p')
      note.className = 'd-error'
      note.setAttribute('role', 'alert')
      note.textContent = `Diagram not drawn — ${graph.errors.join('; ')}`
      source.after(note)
      console.error(`diagram.js: ${graph.errors.join('; ')}`)
      return
    }

    const family = getComputedStyle(figure).fontFamily
    const room = Math.max(280, figure.clientWidth)
    const wanted = figure.dataset.diagram
    const textMax = room < 520 ? 132 : 176
    let plan
    if (wanted === 'down') plan = layout(graph, family, false, textMax)
    else if (wanted === 'right') plan = layout(graph, family, true, textMax)
    else {
      plan = layout(graph, family, true, textMax)
      if (room / plan.width < 0.8) {
        const tall = layout(graph, family, false, textMax)
        if (room / tall.width > room / plan.width) plan = tall
      }
    }
    const background = pageBackground(figure)
    if (background !== '') figure.style.setProperty('--d-bg', background)

    const id = `d${++serial}`
    const caption = figure.querySelector(':scope > figcaption')
    const svg = svgEl('svg', { class: 'd-svg', viewBox: `0 0 ${Math.ceil(plan.width)} ${Math.ceil(plan.height)}`, width: Math.ceil(plan.width), height: Math.ceil(plan.height), role: 'img' })
    svg.setAttribute('aria-label', (caption?.textContent ?? 'Diagram').trim())
    svg.append(svgEl('desc', {}, graph.edges.map((edge) => `${edge.from} to ${edge.to}${edge.label === '' ? '' : `: ${edge.label}`}`).join('. ')))
    /* text stays readable: below 70% the figure scrolls sideways instead of shrinking further */
    if (room / plan.width < 0.7) svg.style.minWidth = `${Math.ceil(plan.width * 0.7)}px`
    const defs = svgEl('defs')
    /* one arrowhead for both ends: auto-start-reverse turns it round at the start of a line */
    const marker = svgEl('marker', { id: `${id}-arrow`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' })
    marker.append(svgEl('path', { class: 'd-arrow', d: 'M0,1 L10,5 L0,9 z' }))
    defs.append(marker)
    svg.append(defs)

    const groupLayer = svgEl('g', { class: 'd-groups' })
    for (const frame of plan.frames) {
      const g = svgEl('g', { class: 'd-group' })
      g.append(svgEl('rect', { x: frame.x, y: frame.y, width: frame.right - frame.x, height: frame.bottom - frame.y, rx: 14 }))
      g.append(svgEl('text', { x: frame.x + 14, y: frame.y + 19 }, frame.label))
      g.mIds = frame.ids
      groupLayer.append(g)
    }
    const edgeLayer = svgEl('g', { class: 'd-edges' })
    const edges = plan.routes.map((route) => {
      const g = svgEl('g', { class: 'd-edge' })
      const edge = route.link.edge
      if (edge.dashed) g.setAttribute('data-dashed', '')
      const path = svgEl('path', { d: route.d })
      const forward = !route.link.rev
      if (edge.both || forward) path.setAttribute('marker-end', `url(#${id}-arrow)`)
      if (edge.both || !forward) path.setAttribute('marker-start', `url(#${id}-arrow)`)
      g.append(path)
      if (edge.label !== '') {
        g.append(svgEl('rect', { class: 'd-label-bg', x: route.label.x - route.label.width / 2 - 6, y: route.label.y - 10, width: route.label.width + 12, height: 20, rx: 4 }))
        g.append(svgEl('text', { x: route.label.x, y: route.label.y + 4, 'text-anchor': 'middle' }, edge.label))
      }
      const dot = svgEl('circle', { class: 'd-dot', r: 4 })
      g.append(dot)
      edgeLayer.append(g)
      return { g, path, dot, from: edge.from, to: edge.to, rank: route.rank, forward, dashed: edge.dashed }
    })
    const nodeLayer = svgEl('g', { class: 'd-nodes' })
    const nodes = plan.boxes.map((box) => {
      const g = svgEl('g', { class: 'd-node' })
      if (box.tone !== '') g.setAttribute('data-tone', box.tone)
      g.append(svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 10 }))
      const text = svgEl('text', { 'text-anchor': 'middle' })
      let y = box.y + 12 + 14
      for (const line of box.title) { text.append(svgEl('tspan', { x: box.x + box.w / 2, y }, line)); y += 18 }
      y += 2
      for (const line of box.noteLines) { text.append(svgEl('tspan', { class: 'd-note', x: box.x + box.w / 2, y }, line)); y += 16 }
      g.append(text)
      nodeLayer.append(g)
      return { g, id: box.id, rank: box.rank }
    })
    svg.append(groupLayer, edgeLayer, nodeLayer)
    const scroll = document.createElement('div')
    scroll.className = 'd-scroll'
    scroll.append(svg)
    source.hidden = true
    source.after(scroll)
    figure.dataset.diagramState = 'ok'

    /* ---------- motion ---------- */

    const run = (entry) => {
      if (calm) return
      const length = entry.path.getTotalLength()
      const start = performance.now()
      const frame = (now) => {
        const t = Math.min(1, (now - start) / 720)
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        const point = entry.path.getPointAtLength((entry.forward ? eased : 1 - eased) * length)
        entry.dot.setAttribute('cx', point.x)
        entry.dot.setAttribute('cy', point.y)
        entry.dot.style.opacity = t < 1 ? '1' : '0'
        if (t < 1 && entry.dot.isConnected) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }
    const beat = 120
    const enter = () => {
      if (calm) return
      for (const node of nodes) node.g.animate({ opacity: [0, 1], transform: [plan.across ? 'translateX(-10px)' : 'translateY(-10px)', 'none'] }, { duration: 520, delay: node.rank * beat, easing: out, fill: 'backwards' })
      for (const group of groupLayer.children) group.animate({ opacity: [0, 1] }, { duration: 600, easing: out })
      for (const entry of edges) {
        const delay = entry.rank * beat + 260
        entry.g.animate({ opacity: [0, 1] }, { duration: 260, delay, fill: 'backwards' })
        if (!entry.dashed) {
          const length = entry.path.getTotalLength()
          entry.path.animate({ strokeDasharray: [`${length} ${length}`, `${length} ${length}`], strokeDashoffset: entry.forward ? [length, 0] : [-length, 0] }, { duration: 560, delay, easing: out, fill: 'backwards' })
        }
        setTimeout(() => run(entry), delay + 420)
      }
    }

    /* the reader's pointer: a box lights its own arrows and sends a dot down each */
    const light = (ids) => {
      for (const node of nodes) { node.g.classList.toggle('d-on', ids !== null && ids.has(node.id)); node.g.classList.toggle('d-dim', ids !== null && !ids.has(node.id)) }
      for (const entry of edges) entry.g.classList.toggle('d-dim', ids !== null && !(ids.has(entry.from) && ids.has(entry.to)))
      for (const group of groupLayer.children) group.classList.toggle('d-dim', ids !== null && !group.mIds.some((member) => ids.has(member)))
    }
    let step = -1
    const showStep = () => {
      if (graph.steps.length === 0 || step < 0) { light(null); return }
      const ids = new Set(graph.steps[step].ids)
      light(ids)
      for (const entry of edges) if (ids.has(entry.from) && ids.has(entry.to)) run(entry)
    }
    for (const node of nodes) {
      node.g.addEventListener('pointerenter', () => {
        const ids = new Set([node.id])
        for (const entry of edges) if (entry.from === node.id || entry.to === node.id) { ids.add(entry.from); ids.add(entry.to) }
        light(ids)
        for (const entry of edges) if (entry.from === node.id) run(entry)
      })
      node.g.addEventListener('pointerleave', showStep)
    }

    /* steps: the reader sets the pace */
    if (graph.steps.length > 0) {
      const bar = document.createElement('div')
      bar.className = 'd-steps'
      const prev = Object.assign(document.createElement('button'), { type: 'button', className: 'd-prev', textContent: 'Back' })
      const next = Object.assign(document.createElement('button'), { type: 'button', className: 'd-next', textContent: 'Next' })
      const text = document.createElement('p')
      text.setAttribute('aria-live', 'polite')
      const paint = () => {
        const total = graph.steps.length
        prev.disabled = step <= 0
        next.textContent = step === total - 1 ? 'Show all' : step < 0 ? 'Start' : 'Next'
        text.replaceChildren()
        if (step < 0) text.append(`${total} steps. Press Start to walk through them.`)
        else { const count = document.createElement('b'); count.textContent = `${step + 1}/${total}`; text.append(count, graph.steps[step].text) }
        showStep()
      }
      prev.addEventListener('click', () => { step = Math.max(0, step - 1); paint() })
      next.addEventListener('click', () => { step = step === graph.steps.length - 1 ? -1 : step + 1; paint() })
      bar.append(prev, text, next)
      scroll.after(bar)
      paint()
    }

    /* it draws itself once, when the reader gets to it; a redraw after a resize stays still */
    if (figure.mSeen === true) return
    if (calm || !('IntersectionObserver' in window)) { figure.mSeen = true; return }
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      watcher.disconnect()
      figure.mSeen = true
      enter()
    }, { threshold: 0.25 })
    watcher.observe(figure)
  }

  /* ---------- finding diagrams, now and later ---------- */

  const widths = new WeakMap()
  const resized = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const before = widths.get(entry.target)
      const now = Math.round(entry.contentRect.width)
      if (before !== undefined && Math.abs(before - now) < 48) continue
      widths.set(entry.target, now)
      if (before !== undefined) draw(entry.target)
    }
  })
  function adopt (figure) {
    if (figure.dataset.diagramState !== undefined) return
    figure.dataset.diagramState = 'pending'
    draw(figure)
    widths.set(figure, Math.round(figure.clientWidth))
    resized.observe(figure)
  }
  function scan () { document.querySelectorAll('[data-diagram]').forEach(adopt) }
  const start = () => {
    scan()
    new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true })
  }
  const ready = () => Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 1200))]).then(start)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
