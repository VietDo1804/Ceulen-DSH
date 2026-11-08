// Agent-efficiency report from DSH session logs: codemode failure classes,
// single-call scripts, read-step chains, advisor notes, memory-search cost,
// and context size per step. Re-run after changes to compare against baseline.
// Usage: node scripts/analyze-agent-efficiency.mjs [--dir <sessionsRoot>] [--since YYYY-MM-DD] [--json] [--advisor-sample N]
// Logs are multi-frame zstd; uses zstdcat.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const readArg = (flag) => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const root = readArg('--dir') ?? path.join(os.homedir(), '.dsh', 'sessions')
const since = readArg('--since')
const asJson = args.includes('--json')
const advisorSample = Number(readArg('--advisor-sample') ?? 0)

const NESTED_CALL = /tools(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*\(/g
// Baseline definition from the 2026-11 research: a for/map/forEach makes it a
// real loop even with one nested call; Promise.all does not (it is fan-out).
const SCRIPT_LOOP = /\bfor\s*\(|\.map\(|\.forEach\(/
// Same read-only rule as the codemode chain hint, kept in sync deliberately.
const READ_ONLY_TOOLS = new Set(['read', 'read_slice', 'grep', 'glob', 'fff_grep', 'ls', 'jfind'])
const READ_ONLY_BASH = /^\s*(?:cd [^&;]+(?:&&|;)\s*)?(cat|sed -n|head|tail|ls|grep|rg|find|wc|git (log|show|diff|status|blame)|nl|tree|stat|file|jq)\b/
const SEARCH_TOOLS = new Set(['munin_search', 'agentmem_search'])
const GET_TOOLS = new Set(['munin_get', 'agentmem_get'])

function isReadOnlyCall(call) {
  if (READ_ONLY_TOOLS.has(call.name)) return true
  if (call.name === 'bash') {
    try {
      return READ_ONLY_BASH.test(JSON.parse(call.arguments ?? '{}').command ?? '')
    } catch {
      return false
    }
  }
  return false
}

function classifyFailure(kind, message) {
  if (/\.slice|\.split|\.trim|\.match|\.includes|\.replace|\.length|Cannot read prop|undefined/.test(message)) return 'shape'
  if (/SyntaxError|Unexpected token|Identifier/.test(message)) return 'syntax'
  if (/lossless|invalid-output/.test(kind + message)) return 'non-JSON'
  if (/is not a function/.test(message)) return 'wrong tool name'
  if (/deadline|timeout|timed out/i.test(kind + message)) return 'deadline'
  if (/cannot (edit|modify)|not found|must read|required|invalid|is unavailable/i.test(message)) return 'nested tool'
  return 'other'
}

function sessionFiles() {
  const files = []
  for (const entry of fs.readdirSync(root)) {
    const workspace = path.join(root, entry)
    if (!fs.statSync(workspace).isDirectory()) continue
    for (const id of fs.readdirSync(workspace)) {
      const dir = path.join(workspace, id)
      if (!fs.statSync(dir).isDirectory()) continue
      const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl.zstd'))
      if (file) files.push(path.join(dir, file))
    }
  }
  return files
}

function loadEvents(file) {
  let text
  try {
    text = execFileSync('zstdcat', [file], { maxBuffer: 1 << 29 }).toString()
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Skip torn frames.
    }
  }
  return events
}

const report = {
  sessions: 0,
  steps: 0,
  toolSteps: 0,
  codemode: { scripts: 0, failed: 0, codeChars: 0, resultChars: 0, oneNestedCall: 0, oneNestedBashOnly: 0, failGroups: {} },
  chains: { runsGE2: 0, stepsGE2: 0, runsGE3: 0, stepsGE3: 0, months: {} },
  advisor: { notes: { nit: 0, concern: 0, blocker: 0 }, userRequestInWindow: 0, notesChecked: 0, concernSteps: 0, concernToolCalls: 0, samples: [] },
  memory: { searchCalls: 0, searchChars: 0, followedByGet: 0 },
  context: { p50: 0, p90: 0, mean: 0, over200k: 0, over300k: 0, over400k: 0, steps: 0 },
}
const contextSamples = []

const sinceMs = since ? Date.parse(`${since}T00:00:00`) : undefined

for (const file of sessionFiles()) {
  let events = loadEvents(file)
  if (sinceMs !== undefined) {
    // Filter per event, not per session: a session that spans the date would
    // otherwise count its pre-change steps as post-change. event.time is epoch ms.
    events = events.filter((event) => event.time === undefined || (new Date(event.time).getTime() || 0) >= sinceMs)
    if (!events.some((event) => event.time !== undefined)) continue
  }
  if (events.length === 0) continue
  report.sessions += 1

  const callsById = new Map()
  const steps = []
  let month = null
  for (const event of events) {
    if (!month && event.time) month = new Date(event.time).toISOString().slice(0, 7)
    if (event.type === 'assistant/message') {
      report.steps += 1
      const usage = event.data?.usage ?? {}
      const tokens = (usage.cacheReadTokens ?? 0) + (usage.inputTokens ?? 0)
      if (tokens > 0) contextSamples.push(tokens)
    } else if (event.type === 'tool/call') {
      callsById.set(event.data.callId, event.data)
      const key = `${event.data.turn}/${event.data.step}`
      let step = steps.at(-1)
      if (!step || step.key !== key) {
        step = { key, calls: [] }
        steps.push(step)
      }
      step.calls.push(event.data)
    } else if (event.type === 'tool/result') {
      const call = callsById.get(event.data?.message?.toolCallId)
      if (!call) continue
      call.result = (event.data.message.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
    }
  }

  const monthKey = month ?? 'unknown'
  const monthStats = report.chains.months[monthKey] ?? { sessions: 0, steps: 0, stepsGE2: 0, stepsGE3: 0 }
  report.chains.months[monthKey] = monthStats
  monthStats.sessions += 1
  monthStats.steps += steps.length

  // Consecutive single read-only steps. Runs >= 2 match the research baseline;
  // runs >= 3 are what the codemode chain hint actually targets.
  const closeRun = (length) => {
    if (length >= 2) {
      report.chains.runsGE2 += 1
      report.chains.stepsGE2 += length
      monthStats.stepsGE2 += length
    }
    if (length >= 3) {
      report.chains.runsGE3 += 1
      report.chains.stepsGE3 += length
      monthStats.stepsGE3 += length
    }
  }
  let runLength = 0
  for (const step of steps) {
    report.toolSteps += 1
    if (step.calls.length === 1 && isReadOnlyCall(step.calls[0])) runLength += 1
    else {
      closeRun(runLength)
      runLength = 0
    }
  }
  closeRun(runLength)

  for (let index = 0; index < steps.length; index += 1) {
    for (const call of steps[index].calls) {
      if (call.name === 'codemode') {
        report.codemode.scripts += 1
        let code = ''
        try {
          code = JSON.parse(call.arguments ?? '{}').code ?? ''
        } catch {
          // Malformed arguments still count as a run.
        }
        report.codemode.codeChars += code.length
        const nested = [...code.matchAll(NESTED_CALL)].map((match) => match[1] ?? match[2])
        if (nested.length === 1 && !SCRIPT_LOOP.test(code)) {
          report.codemode.oneNestedCall += 1
          if (nested[0] === 'bash') report.codemode.oneNestedBashOnly += 1
        }
        const result = call.result ?? ''
        report.codemode.resultChars += result.length
        const failed = /^Script failed/.test(result) || result.includes('Script error (')
        if (failed) {
          report.codemode.failed += 1
          const match = /Script error \(([\w-]+)\): ?([\s\S]*)/.exec(result)
          const group = classifyFailure(match?.[1] ?? '', (match?.[2] ?? result).slice(0, 200))
          report.codemode.failGroups[group] = (report.codemode.failGroups[group] ?? 0) + 1
        }
      }
      if (SEARCH_TOOLS.has(call.name)) {
        report.memory.searchCalls += 1
        report.memory.searchChars += (call.result ?? '').length
        const follow = steps.slice(index + 1, index + 3).flat().map((step) => step.calls).flat()
        if (follow.some((next) => GET_TOOLS.has(next.name))) report.memory.followedByGet += 1
      }
    }
  }

  // Advisor notes: severity, follow-up work, and whether the user request
  // would still be inside a 14k render window at note time.
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'ceulen-advisor') continue
    const severity = (event.data.source.summary ?? '').split(':')[0]
    report.advisor.notes[severity] = (report.advisor.notes[severity] ?? 0) + 1
    let chars = 0
    let requestFound = false
    for (let back = index - 1; back >= 0; back -= 1) {
      const prior = events[back]
      if (prior.type === 'user/message') {
        const kind = prior.data?.source?.kind
        const text = (prior.data.content ?? []).map((block) => block.text ?? '').join('')
        if ((kind === 'user' || kind === undefined) && text.length > 0) {
          requestFound = true
          break
        }
      }
      if (prior.type === 'tool/result') chars += (prior.data.message.content ?? []).map((block) => block.text ?? '').join('').length + 8
      if (prior.type === 'tool/call') chars += Math.min((prior.data.arguments ?? '').length, 600) + 20
      if (prior.type === 'assistant/message') {
        chars += ((prior.data?.content ?? prior.data?.message?.content ?? []).map((block) => block.text ?? '').join('')).length
      }
    }
    report.advisor.notesChecked += 1
    if (requestFound && chars <= 14_000) report.advisor.userRequestInWindow += 1
    if (severity === 'concern') {
      let assistantSteps = 0
      let toolCalls = 0
      for (let next = index + 1; next < events.length; next += 1) {
        const after = events[next]
        if (after.type === 'turn/end') break
        if (after.type === 'user/message' && (after.data?.source?.kind ?? 'user') === 'user') break
        if (after.type === 'assistant/message') assistantSteps += 1
        if (after.type === 'tool/call') toolCalls += 1
      }
      report.advisor.concernSteps += assistantSteps
      report.advisor.concernToolCalls += toolCalls
      const note = (event.data.content ?? [])[0]?.text ?? ''
      let reply = ''
      for (let next = index + 1; next < Math.min(events.length, index + 400); next += 1) {
        const after = events[next]
        if (after.type !== 'assistant/message') continue
        reply = ((after.data?.content ?? after.data?.message?.content ?? [])
          .filter((block) => block.type === 'text').map((block) => block.text).join('')).trim()
        if (reply) break
      }
      report.advisor.samples.push({ note: note.slice(0, 330), reply: reply.slice(0, 230) })
    }
  }
}

contextSamples.sort((a, b) => a - b)
const at = (fraction) => contextSamples[Math.floor(contextSamples.length * fraction)] ?? 0
report.context = {
  p50: at(0.5),
  p90: at(0.9),
  mean: contextSamples.length ? Math.round(contextSamples.reduce((a, b) => a + b, 0) / contextSamples.length) : 0,
  over200k: contextSamples.filter((tokens) => tokens > 200_000).length,
  over300k: contextSamples.filter((tokens) => tokens > 300_000).length,
  over400k: contextSamples.filter((tokens) => tokens > 400_000).length,
  steps: contextSamples.length,
}
report.memory.avgSearchChars = report.memory.searchCalls
  ? Math.round(report.memory.searchChars / report.memory.searchCalls)
  : 0

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const cm = report.codemode
  console.log(`sessions=${report.sessions} steps=${report.steps} toolSteps=${report.toolSteps}`)
  console.log(`codemode: scripts=${cm.scripts} failed=${cm.failed} avgCode=${Math.round(cm.codeChars / Math.max(1, cm.scripts))} avgResult=${Math.round(cm.resultChars / Math.max(1, cm.scripts))}`)
  console.log(`  one-nested-call scripts=${cm.oneNestedCall} (bash-only ${cm.oneNestedBashOnly})`)
  console.log(`  failures by group: ${Object.entries(cm.failGroups).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`)
  console.log(`read chains: runs>=2=${report.chains.runsGE2} steps=${report.chains.stepsGE2}; runs>=3 (hint target)=${report.chains.runsGE3} steps=${report.chains.stepsGE3}`)
  for (const [month, stats] of Object.entries(report.chains.months).sort()) {
    console.log(`  ${month}: sessions=${stats.sessions} steps=${stats.steps} chainSteps>=2=${stats.stepsGE2} chainSteps>=3=${stats.stepsGE3}`)
  }
  const notes = report.advisor.notes
  console.log(`advisor: notes nit=${notes.nit} concern=${notes.concern} blocker=${notes.blocker}; user request in 14k window ${report.advisor.userRequestInWindow}/${report.advisor.notesChecked}`)
  console.log(`  avg steps after a concern=${(report.advisor.concernSteps / Math.max(1, notes.concern)).toFixed(1)} toolCalls=${(report.advisor.concernToolCalls / Math.max(1, notes.concern)).toFixed(1)}`)
  console.log(`memory search: calls=${report.memory.searchCalls} avgChars=${report.memory.avgSearchChars} followedByGet<=2steps=${report.memory.followedByGet}`)
  const ctx = report.context
  const pct = (n) => ((n / Math.max(1, ctx.steps)) * 100).toFixed(1)
  console.log(`context/step: p50=${ctx.p50} p90=${ctx.p90} mean=${ctx.mean} >200k=${pct(ctx.over200k)}% >300k=${pct(ctx.over300k)}% >400k=${pct(ctx.over400k)}% (of ${ctx.steps} steps)`)
  if (advisorSample > 0) {
    const pool = [...report.advisor.samples]
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 300)
    console.log(`\n| # | advisor note | agent's first reply | đúng/sai |`)
    console.log(`|---|---|---|---|`)
    pool.slice(0, advisorSample).forEach((sample, index) => {
      console.log(`| ${index + 1} | ${cell(sample.note)} | ${cell(sample.reply)} | |`)
    })
  }
}
