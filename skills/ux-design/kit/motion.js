// Motion kit. Copy this file and motion.css next to the page, do not retype them.
// It reads data-* attributes, so the page only marks up what it has.
// See references/motion.md for the attributes.
(() => {
  const root = document.documentElement
  /* a framework effect can load this twice, and the kit runs once */
  if (root.dataset.motionKit !== undefined) return
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const out = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const spring = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
  const all = (selector, scope = document) => [...scope.querySelectorAll(selector)]
  root.dataset.motionKit = calm ? 'calm' : 'on'

  /* the page may render after this file loads, so every part below is a scanner:
     it runs once at the start, then again on whatever appears later */
  const scanners = []
  function scan (roots) {
    const find = (selector) => roots.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...all(selector, node)])
    for (const run of scanners) run(find)
  }
  const kitOwn = '.m-leaving, .m-word, .m-head, .m-pill, .m-progress, [data-fill] > i'
  function boot () {
    scan([root])
    const fresh = new Set()
    let queuedScan = false
    let rowsChanged = false
    const isRow = (node) => node instanceof Element && !node.classList.contains('m-leaving')
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') fresh.add(record.target)
        for (const node of record.addedNodes) if (node instanceof Element && !node.matches(kitOwn)) fresh.add(node)
        if (record.target.matches?.('[data-filter-list]') && [...record.addedNodes, ...record.removedNodes].some(isRow)) rowsChanged = true
      }
      if (queuedScan || (fresh.size === 0 && !rowsChanged)) return
      queuedScan = true
      requestAnimationFrame(() => {
        queuedScan = false
        const roots = [...fresh].filter((node) => node.isConnected)
        fresh.clear()
        scan(roots)
        if (rowsChanged) refilter()
        rowsChanged = false
        queueScroll()
      })
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-fill', 'data-from', 'data-start', 'data-end', 'data-time'] })
  }

  /* React keeps references to the text nodes it made, so text it split across several nodes is left alone */
  const tangled = (el) => el.childNodes.length > 1 && Object.keys(el).some((key) => key.startsWith('__react'))

  /* numbers: reads the number already in the text, keeps $, %, commas, and decimals */
  const counting = new WeakSet()
  function countUp (el) {
    const found = el.textContent.match(/-?[\d,]*\.?\d+/)
    if (found === null || counting.has(el) || tangled(el)) return
    counting.add(el)
    const end = Number(found[0].replaceAll(',', ''))
    const places = (found[0].split('.')[1] ?? '').length
    const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: places, maximumFractionDigits: places, useGrouping: found[0].includes(',') })
    const [before, after] = el.textContent.split(found[0])
    const start = performance.now()
    let written = el.textContent
    const tick = (now) => {
      /* the app changed the number meanwhile, and the app is right */
      if (el.textContent !== written) { counting.delete(el); return }
      const t = Math.min((now - start) / 1400, 1)
      written = before + format.format(end * (1 - (1 - t) ** 3)) + after
      el.textContent = written
      if (t < 1) requestAnimationFrame(tick)
      else counting.delete(el)
    }
    requestAnimationFrame(tick)
  }

  /* bars are built in every mode, so they read the same with motion off */
  const filled = new WeakSet()
  scanners.push((find) => {
    for (const el of find('[data-fill]')) {
      el.style.setProperty('--m-fill', el.dataset.fill)
      el.style.setProperty('--m-from', el.dataset.from ?? 0)
      if (filled.has(el)) continue
      filled.add(el)
      el.classList.add('m-track')
      el.setAttribute('aria-hidden', 'true')
      el.append(document.createElement('i'))
    }
  })

  /* chart marks sit where their time falls on the line, in every mode, so nobody works out a percentage */
  const clockOf = (text) => {
    const found = /(?:^|T)(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/.exec(String(text).trim())
    return found === null ? NaN : found[1] * 60 + Number(found[2]) + Number(found[3] ?? 0) / 60
  }
  const stamp = (text) => {
    const number = Number(text)
    return Number.isNaN(number) ? Date.parse(text) : number
  }
  /* 19:14 reads as a clock even against a span written as 18:55 UTC or a full date, and a clock can cross midnight */
  function fractionOf (svg, mark) {
    const time = String(mark.dataset.time).trim()
    if (!/^\d{1,2}:\d{2}/.test(time)) {
      const start = stamp(svg.dataset.start)
      return (stamp(time) - start) / (stamp(svg.dataset.end) - start)
    }
    const start = clockOf(svg.dataset.start)
    const end = clockOf(svg.dataset.end)
    const wraps = end < start
    const at = clockOf(time)
    return ((wraps && at < start ? at + 1440 : at) - start) / ((wraps ? end + 1440 : end) - start)
  }
  const outside = new WeakSet()
  function placeMarks (svg) {
    const line = svg.querySelector('[data-line]') ?? svg.querySelector('path, polyline')
    const view = svg.viewBox.baseVal
    const shape = line === null ? { x: view.x, width: view.width } : line.getBBox()
    const matrix = svg.getScreenCTM()
    if (matrix === null || shape.width === 0) return
    const lanes = new Map()
    for (const mark of all('[data-time]', svg.parentElement)) {
      const at = fractionOf(svg, mark)
      if (!(at >= 0 && at <= 1)) {
        console.error(`motion kit: ${mark.dataset.time} is outside ${svg.dataset.start} to ${svg.dataset.end}`)
        mark.hidden = true
        mark.classList.remove('m-timed')
        outside.add(mark)
        continue
      }
      if (outside.delete(mark)) mark.hidden = false
      const x = shape.x + at * shape.width
      mark.classList.add('m-timed')
      if (mark instanceof SVGElement) {
        for (const name of { line: ['x1', 'x2'], circle: ['cx'], ellipse: ['cx'], text: ['x'] }[mark.tagName] ?? []) mark.setAttribute(name, x)
        continue
      }
      const lane = mark.closest('[data-axis]') ?? mark.parentElement
      if (!lanes.has(lane)) lanes.set(lane, [])
      lanes.get(lane).push({ mark, x: matrix.a * x + matrix.e })
    }
    for (const [lane, marks] of lanes) {
      if (getComputedStyle(lane).position === 'static') lane.style.position = 'relative'
      const box = lane.getBoundingClientRect()
      const ends = []
      for (const { mark, x } of marks.sort((a, b) => a.x - b.x)) {
        mark.style.position = 'absolute'
        const width = mark.offsetWidth
        const left = Math.max(0, Math.min(x - box.left - width / 2, box.width - width))
        let row = ends.findIndex((end) => left >= end + 10)
        if (row === -1) row = ends.length
        ends[row] = left + width
        Object.assign(mark.style, { left: `${left}px`, right: 'auto', transform: 'none' })
        if (lane.matches('[data-axis]')) mark.style.top = `${row * mark.offsetHeight}px`
      }
      if (lane.matches('[data-axis]')) lane.style.minHeight = `${ends.length * marks[0].mark.offsetHeight}px`
    }
  }
  const charted = new WeakSet()
  scanners.push((find) => {
    if (find('svg[data-draw], [data-time]').length === 0) return
    for (const svg of all('svg[data-draw][data-start][data-end]')) {
      const place = () => placeMarks(svg)
      place()
      if (charted.has(svg)) continue
      charted.add(svg)
      new ResizeObserver(place).observe(svg)
      document.fonts?.ready.then(place)
    }
  })

  /* the chart line wipes in while a dot runs along it; [data-at] and [data-time] marks land as it passes */
  function drawLine (svg) {
    const duration = 2200
    const box = svg.getBoundingClientRect()
    const view = svg.viewBox.baseVal
    const line = svg.querySelector('[data-line]') ?? svg.querySelector('path, polyline')
    svg.animate({ clipPath: ['inset(-20% 100% -20% 0)', 'inset(-20% -2% -20% 0)'] }, { duration, fill: 'backwards' })
    const holder = svg.parentElement
    if (line !== null && view.width > 0) {
      if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative'
      const head = document.createElement('span')
      head.className = 'm-head'
      head.setAttribute('aria-hidden', 'true')
      holder.append(head)
      const left = box.left - holder.getBoundingClientRect().left
      const top = box.top - holder.getBoundingClientRect().top
      const total = line.getTotalLength()
      let offset = 0
      const path = Array.from({ length: 64 }, (_, i) => {
        const point = line.getPointAtLength(total * i / 63)
        offset = Math.min(Math.max(offset, (point.x - view.x) / view.width), 1)
        return { transform: `translate(${left + (point.x - view.x) / view.width * box.width}px, ${top + (point.y - view.y) / view.height * box.height}px)`, offset }
      })
      path[0].offset = 0
      path[63].offset = 1
      head.animate(path, { duration, fill: 'both' }).finished.then(() => head.animate({ opacity: [1, 0] }, { duration: 360, fill: 'forwards' }).finished).then(() => head.remove())
    }
    for (const mark of all('[data-at], [data-time]', holder)) {
      if (mark instanceof SVGElement || mark.hidden) continue
      const at = mark.dataset.at === undefined ? fractionOf(svg, mark) : Number(mark.dataset.at)
      mark.animate({ opacity: [0, 1], scale: [0.6, 1] }, { duration: 460, delay: (Number.isFinite(at) ? at : 0) * duration, easing: spring, fill: 'backwards' })
    }
  }

  /* filter: survivors glide, leavers fade where they stood, newcomers slide in, sections below glide */
  const listNow = () => document.querySelector('[data-filter-list]')
  const followers = (el) => {
    const found = []
    for (let at = el; at !== null && at !== document.body; at = at.parentElement) {
      for (let next = at.nextElementSibling; next !== null; next = next.nextElementSibling) if (next.tagName !== 'SCRIPT') found.push(next)
    }
    return found
  }
  const rowsOf = () => [...(listNow()?.children ?? [])].filter((row) => row.dataset.type !== undefined && !row.classList.contains('m-leaving'))
  function apply (type) {
    const rows = rowsOf()
    let shown = 0
    for (const row of rows) {
      row.hidden = type !== 'all' && row.dataset.type !== type
      if (!row.hidden) shown++
    }
    const count = document.querySelector('[data-filter-count]')
    if (count !== null) count.textContent = `${shown} of ${rows.length}`
    const empty = document.querySelector('[data-filter-empty]')
    if (empty !== null) empty.hidden = shown > 0
    document.dispatchEvent(new CustomEvent('motion:filtered', { detail: { type, shown, total: rows.length } }))
  }
  function glide (type) {
    const list = listNow()
    const rows = rowsOf()
    const below = followers(list)
    const listTop = list.getBoundingClientRect().top
    const was = new Map(rows.filter((row) => !row.hidden).map((row) => [row, row.getBoundingClientRect()]))
    const tops = below.map((el) => el.getBoundingClientRect().top)
    for (const [row, box] of was) {
      if (type === 'all' || row.dataset.type === type) continue
      const ghost = row.cloneNode(true)
      ghost.classList.remove('m-wait', 'm-in')
      ghost.classList.add('m-leaving')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.style.top = `${box.top - listTop}px`
      list.append(ghost)
      ghost.animate({ opacity: [1, 0], transform: ['none', 'translateX(-24px)'] }, { duration: 280, easing: 'ease-out' }).finished.then(() => ghost.remove())
    }
    for (const row of rows) for (const animation of row.getAnimations()) animation.cancel()
    apply(type)
    let fresh = 0
    for (const row of rows) {
      if (row.hidden) continue
      const box = row.getBoundingClientRect()
      if (box.top >= innerHeight) {
        row.classList.remove('m-in')
        row.classList.add('m-wait')
        seen.observe(row)
        continue
      }
      seen.unobserve(row)
      row.classList.remove('m-wait', 'm-in')
      const before = was.get(row)
      if (before === undefined) {
        row.animate({ opacity: [0, 1], transform: ['translateX(24px)', 'none'] }, { duration: 560, delay: 90 + fresh++ * 45, easing: out, fill: 'backwards' })
      } else if (before.top !== box.top) {
        row.animate({ transform: [`translateY(${before.top - box.top}px)`, 'none'] }, { duration: 560, easing: out })
      }
    }
    below.forEach((el, i) => {
      const dy = tops[i] - el.getBoundingClientRect().top
      if (dy !== 0) el.animate({ transform: [`translateY(${dy}px)`, 'none'] }, { duration: 560, easing: out })
    })
    const count = document.querySelector('[data-filter-count]')
    if (count !== null) count.animate({ opacity: [0, 1], transform: ['translateY(8px)', 'none'] }, { duration: 340, easing: out })
    queueScroll()
    setTimeout(queueScroll, 600)
  }

  /* the pill behind the active filter button */
  let pill = null
  function movePill (chip) {
    if (pill === null) return
    const bar = chip.parentElement.getBoundingClientRect()
    const box = chip.getBoundingClientRect()
    pill.style.height = `${box.height}px`
    pill.style.transform = `translate(${box.left - bar.left}px, ${box.top - bar.top}px) scaleX(${box.width / 100})`
  }
  const activeChip = () => {
    const chips = all('[data-filter]')
    return chips.find((chip) => chip.getAttribute('aria-pressed') === 'true') ?? chips[0]
  }
  function refilter () {
    const chip = activeChip()
    if (chip !== undefined && listNow() !== null) apply(chip.dataset.filter)
  }
  scanners.push((find) => {
    if (find('[data-filter]').length === 0) return
    const chip = activeChip()
    if (pill === null || pill.parentElement !== chip.parentElement) {
      pill?.remove()
      const made = document.createElement('span')
      pill = made
      made.className = 'm-pill'
      made.setAttribute('aria-hidden', 'true')
      chip.parentElement.classList.add('m-pilled')
      chip.parentElement.prepend(made)
      requestAnimationFrame(() => made.classList.add('m-ready'))
    }
    chip.setAttribute('aria-pressed', 'true')
    movePill(chip)
  })
  const repill = () => {
    const chip = activeChip()
    if (chip !== undefined) movePill(chip)
  }
  addEventListener('resize', repill)
  document.fonts?.ready.then(repill)
  document.addEventListener('click', (event) => {
    const chip = event.target.closest?.('[data-filter]')
    if (chip === null || chip === undefined) return
    for (const other of all('[data-filter]')) other.setAttribute('aria-pressed', String(other === chip))
    movePill(chip)
    if (listNow() === null) return
    if (calm) apply(chip.dataset.filter)
    else glide(chip.dataset.filter)
  })

  /* arrivals: each item waits for itself, never for its list */
  const seen = new IntersectionObserver((entries) => {
    let n = 0
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target
      el.style.setProperty('--m-n', Math.min(n++, 5))
      el.classList.add('m-in')
      if (el.matches('[data-count]')) countUp(el)
      all('[data-count]', el).forEach(countUp)
      if (el.matches('svg[data-draw]')) drawLine(el)
      all('svg[data-draw]', el).forEach(drawLine)
      seen.unobserve(el)
    }
  }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' })

  /* everything below the calm check only ever runs with motion on */
  const scrollers = []
  let queued = false
  function queueScroll () {
    if (queued || calm) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      for (const run of [...scrollers]) if (run() === false) scrollers.splice(scrollers.indexOf(run), 1)
    })
  }
  if (calm) {
    boot()
    return
  }

  const split = new WeakSet()
  scanners.push((find) => {
    for (const headline of find('[data-words]')) {
      if (split.has(headline) || tangled(headline)) continue
      split.add(headline)
      let index = 0
      let last = null
      for (const node of [...headline.childNodes]) {
        if (node.nodeType !== Node.TEXT_NODE) {
          if (last !== null) last.append(node)
          continue
        }
        const parts = node.textContent.split(/(\s+)/).filter((part) => part !== '')
        const frag = document.createDocumentFragment()
        for (const part of parts) {
          if (/^\s+$/.test(part)) { frag.append(' '); last = null; continue }
          const word = document.createElement('span')
          const inner = document.createElement('span')
          word.className = 'm-word'
          inner.textContent = part
          inner.style.setProperty('--m-w', index++)
          word.append(inner)
          frag.append(word)
          last = word
        }
        node.replaceWith(frag)
      }
    }
  })

  const loaded = new WeakSet()
  scanners.push((find) => {
    let order = 0
    for (const el of find('[data-load]')) {
      if (loaded.has(el)) continue
      loaded.add(el)
      el.classList.add('m-load')
      el.style.setProperty('--m-n', order++)
      if (el.matches('[data-count]')) countUp(el)
    }
  })

  const placed = new WeakSet()
  scanners.push((find) => {
    for (const el of find('[data-arrive], [data-sweep], h2, svg[data-draw], [data-fill], [data-count]')) {
      if (placed.has(el)) continue
      placed.add(el)
      if (el.closest('[data-load]') !== null) { if (el.matches('[data-count]') && !el.matches('[data-load]')) countUp(el); continue }
      const covered = el.parentElement?.closest('[data-arrive]') ?? null
      if (covered !== null) continue
      if (el.matches('h2')) el.classList.add('m-wipe')
      if (el.matches('[data-arrive], [data-sweep], h2')) el.classList.add('m-wait')
      seen.observe(el)
    }
  })

  /* scroll: progress, parallax, the rail */
  let progress = null
  scanners.push(() => {
    if (progress !== null || root.scrollHeight <= innerHeight * 2) return
    const bar = document.createElement('div')
    progress = bar
    bar.className = 'm-progress'
    bar.setAttribute('aria-hidden', 'true')
    document.body.append(bar)
    scrollers.push(() => {
      const max = root.scrollHeight - innerHeight
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`
    })
  })
  const drifters = []
  const placeDrifter = (item) => { item.el.style.translate = `${item.x.toFixed(1)}px ${(scrollY * item.speed + item.y).toFixed(1)}px` }
  const drifting = new WeakSet()
  scanners.push((find) => {
    for (const el of find('[data-parallax]')) {
      if (drifting.has(el)) continue
      drifting.add(el)
      const item = { el, speed: Number(el.dataset.parallax) || 0.2, x: 0, y: 0 }
      drifters.push(item)
      scrollers.push(() => {
        if (el.isConnected) { placeDrifter(item); return true }
        drifters.splice(drifters.indexOf(item), 1)
        return false
      })
    }
  })
  let railHeld = null
  const railed = new WeakSet()
  function watchRail (rail) {
    rail.classList.add('m-railed')
    const place = () => {
      if (!rail.isConnected) return false
      const box = rail.getBoundingClientRect()
      const rows = [...rail.children].filter((row) => !row.hidden && !row.classList.contains('m-leaving') && row.querySelector('[data-dot]') !== null)
      if (rows.length === 0) return true
      const dots = rows.map((row) => row.querySelector('[data-dot]').getBoundingClientRect())
      const first = dots[0].top + dots[0].height / 2
      const end = dots[dots.length - 1].top + dots[dots.length - 1].height / 2
      const line = rail === railHeld?.rail ? railHeld.y : innerHeight * 0.62
      rail.style.setProperty('--m-rail-x', `${dots[0].left + dots[0].width / 2 - box.left}px`)
      rail.style.setProperty('--m-rail-top', `${first - box.top}px`)
      rail.style.setProperty('--m-rail-h', `${end - first}px`)
      rail.style.setProperty('--m-p', Math.min(Math.max((line - first) / Math.max(end - first, 1), 0), 1).toFixed(4))
      rows.forEach((row, i) => { row.classList.toggle('m-lit', dots[i].top < line) })
      return true
    }
    rail.mPlace = place
    scrollers.push(place)
  }
  scanners.push((find) => {
    for (const rail of find('[data-rail]')) {
      if (railed.has(rail)) continue
      railed.add(rail)
      watchRail(rail)
    }
  })
  addEventListener('scroll', queueScroll, { passive: true })
  addEventListener('resize', queueScroll)
  document.fonts?.ready.then(queueScroll)

  /* pointer. Two kinds of motion, both on transform-like properties only:
     the wave is a continuous response that falls off with distance, so what sits
     near the cursor moves and settles behind it; the replays fire once when the
     cursor arrives at something. No touch, because touch has no resting pointer. */
  const reach = 220
  const pull = (distance) => (distance >= reach ? 0 : (1 - distance / reach) ** 2)
  const gap = (box, x, y) => Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom))

  const kinds = [
    ['li[data-arrive]', 'row'],
    ['[data-arrive]:not(li)', 'card'],
    ['[data-filter]', 'chip'],
    ['[data-count]', 'number'],
    ['.m-word', 'word'],
    ['[data-pop]', 'pill'],
    ['[data-dot]', 'dot'],
  ]
  let targets = []
  const tracked = new WeakSet()
  scanners.push((find) => {
    for (const [selector, kind] of kinds) {
      for (const el of find(selector)) {
        if (tracked.has(el)) continue
        tracked.add(el)
        targets.push({ el, kind, anchor: kind === 'dot' ? el.closest('li') ?? el : el, now: 0, x: 0, y: 0 })
      }
    }
  })
  const paint = {
    row: (item) => item.el.style.setProperty('--m-lean', `${(item.now * 12).toFixed(2)}px`),
    dot: (item) => { item.el.style.scale = (1 + item.now * 0.9).toFixed(3) },
    pill: (item) => { item.el.style.scale = (1 + item.now * 0.1).toFixed(3) },
    number: (item) => { item.el.style.translate = `0 ${(item.now * -5).toFixed(2)}px` },
    word: (item) => { item.el.style.translate = `0 ${(item.now * -5).toFixed(2)}px` },
    chip: (item) => { item.el.style.translate = `${(item.x * 6).toFixed(2)}px ${(item.y * 6).toFixed(2)}px` },
    card: (item) => {
      item.el.style.translate = `${(item.x * 5).toFixed(2)}px ${(item.y * 5).toFixed(2)}px`
      // A wide panel tilted by the same angle swings far at its edges, so only cards tilt.
      if (item.el.offsetWidth > 520) return
      item.el.style.transform = item.now < 0.002 ? '' : `perspective(900px) rotateX(${(item.y * -3).toFixed(2)}deg) rotateY(${(item.x * 3).toFixed(2)}deg)`
    },
  }

  let pointerX = -9999
  let pointerY = -9999
  let waving = false
  const step = () => {
    targets = targets.filter((item) => item.el.isConnected)
    const boxes = targets.map((item) => item.anchor.getBoundingClientRect())
    const own = targets.map((item, i) => (item.anchor === item.el ? boxes[i] : item.el.getBoundingClientRect()))
    let moving = false
    targets.forEach((item, i) => {
      const hidden = boxes[i].width === 0
      const want = hidden ? 0 : pull(gap(boxes[i], pointerX, pointerY))
      const box = own[i]
      const unit = Math.max(Math.hypot(box.width, box.height) / 2, 1)
      const wantX = want === 0 ? 0 : Math.max(-1, Math.min(1, (pointerX - (box.left + box.width / 2)) / unit)) * want
      const wantY = want === 0 ? 0 : Math.max(-1, Math.min(1, (pointerY - (box.top + box.height / 2)) / unit)) * want
      const before = item.now + Math.abs(item.x) + Math.abs(item.y)
      item.now += (want - item.now) * 0.16
      item.x += (wantX - item.x) * 0.16
      item.y += (wantY - item.y) * 0.16
      if (Math.abs(want - item.now) + Math.abs(wantX - item.x) + Math.abs(wantY - item.y) > 0.004) moving = true
      else if (want === 0) { item.now = 0; item.x = 0; item.y = 0 }
      if (before !== 0 || item.now !== 0) paint[item.kind](item)
    })
    const middleX = innerWidth / 2
    const middleY = innerHeight / 2
    for (const item of drifters) {
      const wantX = pointerX < -999 ? 0 : (middleX - pointerX) / middleX * 16
      const wantY = pointerX < -999 ? 0 : (middleY - pointerY) / middleY * 10
      item.x += (wantX - item.x) * 0.08
      item.y += (wantY - item.y) * 0.08
      if (Math.abs(wantX - item.x) + Math.abs(wantY - item.y) > 0.05) moving = true
      placeDrifter(item)
    }
    waving = moving
    if (moving) requestAnimationFrame(step)
  }
  const stir = () => {
    if (waving) return
    waving = true
    requestAnimationFrame(step)
  }
  addEventListener('scroll', () => { if (pointerX > -999) stir() }, { passive: true })

  /* replays: what the cursor arrives at plays again */
  const chartHead = new Map()
  function followChart (svg, x) {
    const line = svg.querySelector('[data-line]') ?? svg.querySelector('path, polyline')
    const view = svg.viewBox.baseVal
    if (line === null || view.width === 0) return
    const holder = svg.parentElement
    let head = chartHead.get(svg)
    if (head === undefined) {
      if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative'
      head = document.createElement('span')
      head.className = 'm-head'
      head.setAttribute('aria-hidden', 'true')
      holder.append(head)
      chartHead.set(svg, head)
    }
    const box = svg.getBoundingClientRect()
    const hold = holder.getBoundingClientRect()
    const wanted = view.x + (x - box.left) / box.width * view.width
    const total = line.getTotalLength()
    let low = 0
    let high = total
    for (let i = 0; i < 18; i++) {
      const middle = (low + high) / 2
      if (line.getPointAtLength(middle).x < wanted) low = middle
      else high = middle
    }
    const point = line.getPointAtLength(low)
    head.style.opacity = '1'
    head.style.transform = `translate(${box.left - hold.left + (point.x - view.x) / view.width * box.width}px, ${box.top - hold.top + (point.y - view.y) / view.height * box.height}px)`
  }
  let arrivedAt = null
  function arrive (el) {
    if (el.closest('.m-wait:not(.m-in)') !== null) return
    if (root.dataset.recount !== 'off') {
      all('[data-count]', el).forEach(countUp)
      if (el.matches('[data-count]')) countUp(el)
    }
    for (const bar of all('[data-fill] > i', el)) bar.animate({ transform: ['scaleX(0)', 'none'] }, { duration: 800, easing: out })
    for (const pop of all('[data-pop]', el)) pop.animate({ transform: ['scale(0.7)', 'none'] }, { duration: 420, easing: spring })
    for (const dot of all('[data-dot]', el)) dot.animate({ transform: ['scale(0.5)', 'scale(2)', 'none'] }, { duration: 520, easing: spring })
  }
  const stage = '[data-arrive], [data-count], [data-fill], [data-sweep], tr'

  addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return
    pointerX = event.clientX
    pointerY = event.clientY
    stir()
    const under = event.target instanceof Element ? event.target : null
    const landed = under?.closest(stage) ?? null
    if (landed !== arrivedAt) {
      arrivedAt = landed
      if (landed !== null) arrive(landed)
    }
    const rail = under?.closest('[data-rail]') ?? null
    const was = railHeld?.rail
    railHeld = rail === null ? null : { rail, y: pointerY }
    if (rail !== null) rail.mPlace()
    else if (was !== undefined) was.mPlace()
    const chart = under?.closest('svg[data-draw]') ?? null
    if (chart !== null) followChart(chart, pointerX)
    for (const [svg, head] of chartHead) {
      if (svg !== chart) head.style.opacity = '0'
      if (!svg.isConnected) { head.remove(); chartHead.delete(svg) }
    }
  }, { passive: true })
  root.addEventListener('pointerleave', () => {
    pointerX = -9999
    pointerY = -9999
    arrivedAt = null
    if (railHeld !== null) { const { rail } = railHeld; railHeld = null; rail.mPlace() }
    stir()
  })

  boot()
  queueScroll()
})()
