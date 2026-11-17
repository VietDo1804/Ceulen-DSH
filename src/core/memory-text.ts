/**
 * The vendored munin/agentmem formatter (helpers.ts) is hash-checked, so long
 * search results are clipped here, at the adapter. The most relevant hits stay
 * whole — one extra retrieve step costs far more than the tokens saved.
 */
const HIT_HEADER = /^--- Memory \d+ ---$/
const KEY_LINE = /^Key: \S+/
const TOTAL_LINE = /^Total: \d+$/

function clipHit(block: readonly string[], maxBody: number): string[] {
  // Without a Key there is no way back to the full memory: never clip.
  if (!block.some(line => KEY_LINE.test(line))) return [...block]
  const contentIndex = block.findIndex(line => line === 'Content:')
  if (contentIndex === -1) return [...block]
  const header = block.slice(0, contentIndex + 1)
  const bodyLines = block.slice(contentIndex + 1)
  const trailing = bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === '' ? [bodyLines.pop()!] : []
  const body = bodyLines.join('\n')
  if (body.length <= maxBody) return [...block]
  return [...header, body.slice(0, maxBody), `… (${body.length - maxBody} chars; retrieve with the Key)`, ...trailing]
}

/**
 * Clip memory-search output past the first `keepFull` hits to `maxBody` chars
 * of Content, keeping every header line (Key, Title, Score, …) and any trailing
 * `Total: N` footer. Text without hit markers passes through unchanged.
 */
export function clipSearchHits(text: string, keepFull = 3, maxBody = 800): string {
  if (!/^--- Memory \d+ ---$/m.test(text)) return text
  const lines = text.split('\n')
  const starts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (HIT_HEADER.test(lines[index]!)) starts.push(index)
  }
  // The vendored formatter appends `\n\nTotal: N` after the last hit.
  let tail: string[] = []
  if (TOTAL_LINE.test((lines[lines.length - 1] ?? '').trim()) && (lines[lines.length - 2] ?? '').trim() === '') {
    tail = lines.splice(lines.length - 2, 2)
  }
  const out = [...lines.slice(0, starts[0]!)]
  for (let hit = 0; hit < starts.length; hit += 1) {
    const from = starts[hit]!
    const to = hit + 1 < starts.length ? starts[hit + 1]! : lines.length
    out.push(...(hit < keepFull ? lines.slice(from, to) : clipHit(lines.slice(from, to), maxBody)))
  }
  return [...out, ...tail].join('\n')
}

/** Both shapes: opimem `{versions, currentVersion}`, cloud `{data:[…]}`. */
function versionList(result: unknown): { list: Record<string, unknown>[]; current?: number } {
  const body = (result ?? {}) as Record<string, unknown>
  const data = (body.data ?? body) as Record<string, unknown> | unknown[]
  const holder = (Array.isArray(data) ? { data } : data) as Record<string, unknown>
  const raw = holder.versions ?? holder.data
  const list = Array.isArray(raw) ? raw as Record<string, unknown>[] : []
  const current = typeof holder.currentVersion === 'number' ? holder.currentVersion : undefined
  return { list, ...(current === undefined ? {} : { current }) }
}

export function formatVersions(key: string, result: unknown): string {
  const { list, current } = versionList(result)
  if (list.length === 0) return `No history for \`${key}\` (the server keeps versions only for stores it recorded).`
  const newest = current ?? (typeof list[0]?.version === 'number' ? list[0].version as number : undefined)
  const lines = list.slice(0, 20).map(entry => {
    const version = entry.version ?? '?'
    const stamp = typeof entry.createdAt === 'string' ? entry.createdAt.slice(0, 16).replace('T', ' ') : ''
    const title = typeof entry.title === 'string' ? entry.title : (entry.snapshot as Record<string, unknown> | undefined)?.title
    const size = typeof entry.bytes === 'number' ? ` ${entry.bytes}B` : ''
    return `  v${version} ${stamp} · ${String(title ?? '')}${size}`
  })
  return [`Versions for \`${key}\`${newest === undefined ? '' : ` (current v${newest})`}:`, ...lines,
    list.length > 20 ? `  … ${list.length - 20} older, newest 20 shown` : ''].filter(Boolean).join('\n')
}

/**
 * Minimal consecutive-call dampener for one memory tool family; `reset` on any
 * tool result from outside the family.
 */
export function callDampener(prefix: string): { check(toolName: string): string | undefined; reset(): void } {
  let tool = ''
  let count = 0
  return {
    check(toolName) {
      if (tool !== toolName) {
        tool = toolName
        count = 1
        return undefined
      }
      count += 1
      if (count < 6) return undefined
      count = 0
      return `${toolName} has been called 6 times in a row with no new result. Stop repeating it; state what you found or call ${prefix}_store directly.`
    },
    reset() {
      tool = ''
      count = 0
    },
  }
}

interface BriefMemory {
  title?: unknown
  key?: unknown
  pinned?: unknown
  updatedAt?: unknown
  createdAt?: unknown
  validFrom?: unknown
  verified?: unknown
  status?: unknown
  tags?: unknown
}

function memoryDate(memory: BriefMemory): number | undefined {
  for (const value of [memory.updatedAt, memory.createdAt, memory.validFrom]) {
    if (typeof value !== 'string') continue
    const time = Date.parse(value)
    if (Number.isFinite(time)) return time
  }
  return undefined
}

/** Pure: memories -> the brief block (`''` when nothing qualifies). */
export function composeMemoryBrief(
  memories: readonly unknown[],
  options: { maxChars: number; recencyDays: number; now?: number; header: string },
): string {
  const now = options.now ?? Date.now()
  const cutoff = now - options.recencyDays * 24 * 60 * 60 * 1000
  const rows: { pinned: boolean; time: number; line: string }[] = []
  for (const raw of memories) {
    if (raw === null || typeof raw !== 'object') continue
    const memory = raw as BriefMemory
    if (memory.verified === false || memory.status === 'unverified') continue
    if (Array.isArray(memory.tags) && memory.tags.includes('unverified')) continue
    const title = typeof memory.title === 'string' && memory.title.trim() !== ''
      ? memory.title.trim()
      : typeof memory.key === 'string' ? memory.key.trim() : ''
    if (title === '') continue
    const pinned = memory.pinned === true
    const time = memoryDate(memory)
    // Pinned anchors are exempt from recency; everything else needs a date to
    // prove it is current. A pinned memory with no date renders as `pinned`.
    if (!pinned && (time === undefined || time < cutoff)) continue
    const stamp = time === undefined ? 'pinned' : new Date(time).toISOString().slice(0, 10)
    rows.push({ pinned, time: time ?? 0, line: `${stamp} · ${title}` })
  }
  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.time - a.time)
  const header = options.header
  const lines: string[] = []
  let used = header.length + 1
  for (const row of rows) {
    if (used + row.line.length + 1 > options.maxChars) break
    lines.push(row.line)
    used += row.line.length + 1
  }
  return lines.length === 0 ? '' : [header, ...lines].join('\n')
}
