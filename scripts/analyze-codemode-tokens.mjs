// Measure codemode vs direct tool-call token cost from DSH session logs.
// Usage: node scripts/analyze-codemode-tokens.mjs [sessionsDir]
// Default dir: this workspace's DSH sessions. Logs are multi-frame zstd; uses zstdcat.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const base =
  process.argv[2] ||
  `${process.env.HOME}/.dsh/sessions/--home-vietdo-vietdo_workspace-DHS-ceulen_dhs--`
const cutoff = Number(process.argv[3] ?? 0) // ms epoch; only sessions at/after this are compared per-turn

const sessions = []
for (const d of fs.readdirSync(base)) {
  const dir = path.join(base, d)
  if (!fs.statSync(dir).isDirectory()) continue
  const f = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl.zstd'))
  if (!f) continue
  let events
  try {
    const text = execFileSync('zstdcat', [path.join(dir, f)], { maxBuffer: 1 << 28 }).toString()
    events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { continue }
  const s = {
    id: d.slice(0, 8),
    createdAt: events.find((e) => e.type === 'session')?.createdAt ?? 0,
    steps: 0, outTok: 0, inTok: 0, cacheRead: 0,
    resultBytes: 0, cmCalls: 0, dirCalls: 0, nested: 0,
    cmResBytes: 0, cmResList: [], dirResList: [], turns: new Map(),
  }
  const T = (n) => (s.turns.has(n) ? s.turns.get(n) : s.turns.set(n, { steps: 0, out: 0, in: 0, res: 0, cm: 0, dir: 0 }).get(n))
  const callName = new Map()
  for (const e of events) {
    if (e.type === 'assistant/message') {
      const u = e.data?.usage ?? {}, t = T(e.data?.turn ?? 0)
      s.steps++; t.steps++
      s.outTok += u.outputTokens ?? 0; t.out += u.outputTokens ?? 0
      s.inTok += u.inputTokens ?? 0; t.in += u.inputTokens ?? 0
      s.cacheRead += u.cacheReadTokens ?? 0
    } else if (e.type === 'tool/call') {
      callName.set(e.data?.callId, e.data?.name)
      const t = T(e.data?.turn ?? 0)
      if (e.data?.name === 'codemode') {
        s.cmCalls++; t.cm++
        const code = JSON.parse(e.data.arguments ?? '{}').code ?? ''
        s.nested += (code.match(/tools\.\w+\s*\(/g) ?? []).length
      } else { s.dirCalls++; t.dir++ }
    } else if (e.type === 'tool/result') {
      const bytes = (e.data?.message?.content ?? [])
        .map((c) => (c.type === 'text' ? c.text.length : JSON.stringify(c).length))
        .reduce((a, b) => a + b, 0)
      const t = T(e.data?.turn ?? 0)
      s.resultBytes += bytes; t.res += bytes
      if (callName.get(e.data?.message?.toolCallId) === 'codemode') { s.cmResBytes += bytes; s.cmResList.push(bytes) }
      else s.dirResList.push(bytes)
    }
  }
  sessions.push(s)
}
sessions.sort((a, b) => a.createdAt - b.createdAt)

const med = (arr) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] }
const sum = (arr, f) => arr.reduce((a, s) => a + f(s), 0)
const big = sessions.filter((s) => s.steps > 3)
const cmS = big.filter((s) => s.cmCalls > 0), noS = big.filter((s) => s.cmCalls === 0)
const opsCm = sum(cmS, (s) => s.nested + s.dirCalls), opsNo = sum(noS, (s) => s.dirCalls)

console.log(`sessions=${sessions.length} (with codemode ${cmS.length}, direct-only ${noS.length}, steps>3)`)
console.log(`\n== per tool operation ==`)
console.log(`direct-era : calls=${opsNo} res mean/med=${Math.round(sum(noS, (s) => s.resultBytes) / opsNo)}/${med(noS.flatMap((s) => s.dirResList))}B out/op=${Math.round(sum(noS, (s) => s.outTok) / opsNo)} inUnc/op=${Math.round(sum(noS, (s) => s.inTok) / opsNo)}`)
console.log(`codemode   : nested=${sum(cmS, (s) => s.nested)} in ${sum(cmS, (s) => s.cmCalls)} calls (${(sum(cmS, (s) => s.nested) / Math.max(1, sum(cmS, (s) => s.cmCalls))).toFixed(2)} ops/call)`)
console.log(`             cm res mean/med=${Math.round(sum(cmS, (s) => s.cmResBytes) / Math.max(1, sum(cmS, (s) => s.cmCalls)))}/${med(cmS.flatMap((s) => s.cmResList))}B per call -> ${Math.round(sum(cmS, (s) => s.cmResBytes) / Math.max(1, sum(cmS, (s) => s.nested)))}B per nested op`)
console.log(`             out/op=${Math.round(sum(cmS, (s) => s.outTok) / opsCm)} inUnc/op=${Math.round(sum(cmS, (s) => s.inTok) / opsCm)} ops/step=${(opsCm / sum(cmS, (s) => s.steps)).toFixed(2)} (direct ${(opsNo / sum(noS, (s) => s.steps)).toFixed(2)})`)

const cmT = [], dirT = []
for (const s of sessions.filter((s) => s.createdAt >= cutoff))
  for (const [, t] of s.turns) { if (t.steps < 3) continue; (t.cm > 0 ? cmT : dirT).push(t) }
if (cmT.length + dirT.length) {
  const agg = (arr, label) => {
    const n = arr.length, steps = sum(arr, (t) => t.steps)
    console.log(`${label}: turns=${n} steps/turn=${(steps / n).toFixed(1)} outTok/turn=${Math.round(sum(arr, (t) => t.out) / n)} inUncTok/turn=${Math.round(sum(arr, (t) => t.in) / n)} resKB/turn=${(sum(arr, (t) => t.res) / n / 1e3).toFixed(1)} visibleCalls/turn=${(sum(arr, (t) => t.cm + t.dir) / n).toFixed(1)}`)
  }
  console.log(`\n== per user turn, sessions since ${new Date(cutoff).toISOString().slice(0, 10)} ==`)
  agg(cmT, 'codemode turns ')
  agg(dirT, 'direct-only turns')
}
console.log(`\nrun from ${path.dirname(fileURLToPath(import.meta.url))}`)
