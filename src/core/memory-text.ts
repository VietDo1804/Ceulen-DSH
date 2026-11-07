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
