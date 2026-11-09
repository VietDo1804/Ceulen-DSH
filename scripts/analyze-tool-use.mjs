// Tool-selection report from DSH session logs: which tool a model reaches for,
// how often each one fails, and what it does after a failure. Written for the
// cheap-model question "does it call the right tool?" — re-run it after a
// change and compare with the previous numbers.
// Usage: node scripts/analyze-tool-use.mjs [--dir <sessionsRoot>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--model <substring>] [--json]
// `--model flash` keeps the calls made while a model whose id contains "flash" was selected.
// Logs are multi-frame zstd; uses zstdcat.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch'])
const WRITES_FILE = /(python3?|node)\b[\s\S]*(write_text|open\([^)]*['"][wa]['"]|writeFileSync)|\bsed\s+-i\b/
const NESTED_CALL = /tools(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*\(/g

function parseArgs(call) {
  try {
    const parsed = JSON.parse(call.arguments ?? '{}')
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** What a bash command is for, judged from its first real word. */
export function bashJob(command) {
  const body = String(command).trim().replace(/^(?:cd\s+[^&;\n]+\s*(?:&&|;)\s*)+/, '')
  if (WRITES_FILE.test(body)) return 'script file edit'
  const first = (body.split(/\s+/)[0] ?? '').replace(/^rtk$/, body.split(/\s+/)[1] ?? '')
  if (['grep', 'rg', 'ag'].includes(first)) return 'search'
  if (['cat', 'sed', 'head', 'tail', 'nl', 'wc', 'awk', 'less', 'bat'].includes(first)) return /^\s*cat\s*>|<<\s*['"]?\w+/.test(body) ? 'other' : 'read file'
  if (['ls', 'find', 'tree', 'fd', 'stat', 'file', 'du'].includes(first)) return 'list/find'
  if (first === 'git') return 'git'
  if (['npm', 'npx', 'pnpm', 'yarn', 'vitest', 'tsc', 'pytest', 'cargo', 'make', 'biome', 'go'].includes(first)) return 'build/test'
  if (['python3', 'python', 'node'].includes(first)) return 'inline script'
  return 'other'
}

/** Fold one session's ordered tool calls (each `{ name, arguments, result, isError }`) into `report`. */
export function addCalls(report, calls) {
  const bump = (bag, key, by = 1) => {
    bag[key] = (bag[key] ?? 0) + by
  }
  for (const [index, call] of calls.entries()) {
    report.calls += 1
    bump(report.byTool, call.name)
    const result = call.result ?? ''
    if (call.isError) {
      report.hardErrors += 1
      bump(report.errorsByTool, call.name)
      if (/unknown tool/i.test(result)) report.unknownTool += 1
    }
    const args = parseArgs(call)
    if (call.name === 'bash') {
      const command = String(args.command ?? '')
      bump(report.bashJobs, bashJob(command))
      if (/^\s*(?:cd\s+[^&;\n]+\s*(?:&&|;)\s*)*rtk\s/.test(command)) report.rtkPrefixed += 1
      if (bashJob(command) === 'script file edit' && (command.match(/\.replace\(/g) ?? []).length > 1) report.multiReplaceScripts += 1
    }
    if (call.name === 'codemode') {
      report.codemode.scripts += 1
      const nested = [...String(args.code ?? '').matchAll(NESTED_CALL)]
      if (nested.length === 1) report.codemode.oneNestedCall += 1
      if (/^Script failed/.test(result) || result.includes('Script error (')) report.codemode.failed += 1
    }
    if (call.name === 'ceulen_tools' && args.action === 'call') {
      const name = String(args.name ?? '?')
      bump(report.coldCalls, name)
      if (call.isError) bump(report.coldErrors, name)
    }
    if (call.isError && (call.name === 'edit' || call.name === 'write') && /has not been read|changed since it was read/.test(result)) report.notReadOrStale += 1
    if (call.isError && call.name === 'apply_patch') {
      bump(report.applyPatchErrors, /hunk is ambiguous/.test(result) ? 'ambiguous' : /hunk does not match/.test(result) ? 'no match' : 'other')
    }
    if (call.isError && EDIT_TOOLS.has(call.name)) {
      report.afterEditError.errors += 1
      const next = calls.slice(index + 1, index + 4)
      if (next[0]?.name === call.name && !next[0].isError) report.afterEditError.sameToolNext += 1
      if (next.some(follow => follow.name === 'bash' && bashJob(parseArgs(follow).command ?? '') === 'script file edit')) report.afterEditError.bashScriptWithin3 += 1
    }
  }
  return report
}

export function emptyReport() {
  return {
    sessions: 0,
    calls: 0,
    hardErrors: 0,
    unknownTool: 0,
    byTool: {},
    errorsByTool: {},
    bashJobs: {},
    rtkPrefixed: 0,
    multiReplaceScripts: 0,
    notReadOrStale: 0,
    applyPatchErrors: {},
    afterEditError: { errors: 0, sameToolNext: 0, bashScriptWithin3: 0 },
    coldCalls: {},
    coldErrors: {},
    codemode: { scripts: 0, failed: 0, oneNestedCall: 0 },
    prompt: { sessions: 0, stickyTruncated: 0, toolsDeclared: 0, schemaBytes: 0 },
  }
}

/** Ordered tool calls of one session, each tagged with the model selected when it was made. */
export function callsOf(events, { sinceMs, untilMs, model } = {}) {
  const byId = new Map()
  const calls = []
  let current
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'model/selection') current = data.model
    else if (event.type === 'assistant/message') current = data.message?.source?.model ?? current
    else if (event.type === 'tool/call') {
      const time = event.time ?? 0
      if (sinceMs !== undefined && time < sinceMs) continue
      if (untilMs !== undefined && time >= untilMs) continue
      if (model !== undefined && !String(current ?? '').includes(model)) continue
      const call = { name: data.name, arguments: data.arguments, model: current, isError: false, result: '' }
      byId.set(data.callId, call)
      calls.push(call)
    } else if (event.type === 'tool/result') {
      const call = byId.get(data.message?.toolCallId)
      if (call === undefined) continue
      call.isError = data.message.isError === true
      call.result = (data.message.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
    }
  }
  return calls
}

function sessionFiles(root) {
  const files = []
  for (const entry of fs.readdirSync(root)) {
    const workspace = path.join(root, entry)
    if (!fs.statSync(workspace).isDirectory()) continue
    for (const id of fs.readdirSync(workspace)) {
      const dir = path.join(workspace, id)
      if (!fs.statSync(dir).isDirectory()) continue
      const file = fs.readdirSync(dir).find(name => name.endsWith('.jsonl.zstd'))
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

function top(bag, limit = 99) {
  return Object.entries(bag).sort((a, b) => b[1] - a[1]).slice(0, limit)
}

export function renderText(report, label) {
  const pct = (part, whole) => `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`
  const n = name => report.byTool[name] ?? 0
  const bashEdits = report.bashJobs['script file edit'] ?? 0
  const toolEdits = n('edit') + n('write') + n('apply_patch')
  const after = report.afterEditError
  const lines = [
    `tool use — ${label}: sessions=${report.sessions} calls=${report.calls} hardErrors=${report.hardErrors} (${pct(report.hardErrors, report.calls)}) unknownTool=${report.unknownTool}`,
    `by tool: ${top(report.byTool, 14).map(([name, count]) => `${name} ${count}${report.errorsByTool[name] ? ` (${report.errorsByTool[name]} err)` : ''}`).join(' · ')}`,
    `bash is ${pct(n('bash'), report.calls)} of calls: ${top(report.bashJobs).map(([job, count]) => `${job} ${count}`).join(' · ')} · rtk-prefixed ${report.rtkPrefixed}`,
    `dedicated tools: grep ${n('grep')} · fff_grep ${n('fff_grep')} · read ${n('read')} · read_slice ${n('read_slice')} · glob ${n('glob')} · find_files ${n('find_files')} · rtk ${n('rtk')}`,
    `edit path: edit ${n('edit')} · apply_patch ${n('apply_patch')} · write ${n('write')} · bash script ${bashEdits} (multi-replace ${report.multiReplaceScripts}) → edit tools ${pct(toolEdits, toolEdits + bashEdits)}`,
    `edit/write refused as not-read or stale: ${report.notReadOrStale}`,
    `apply_patch errors: ${top(report.applyPatchErrors).map(([kind, count]) => `${kind} ${count}`).join(' · ') || 'none'}`,
    `after an edit-tool error (${after.errors}): same tool succeeds next ${after.sameToolNext} · bash script edit within 3 calls ${after.bashScriptWithin3}`,
    `cold tools via ceulen_tools: ${top(report.coldCalls, 8).map(([name, count]) => `${name} ${count}${report.coldErrors[name] ? ` (${report.coldErrors[name]} err)` : ''}`).join(' · ') || 'none'}`,
    `codemode: scripts ${report.codemode.scripts} · failed ${report.codemode.failed} · one nested call ${report.codemode.oneNestedCall}`,
    `prompt: "STICKY RULES TRUNCATED" in ${report.prompt.stickyTruncated}/${report.prompt.sessions} sessions · latest request declares ${report.prompt.toolsDeclared} tools, ${(report.prompt.schemaBytes / 1024).toFixed(1)} KB of schema`,
  ]
  return lines.join('\n')
}

/**
 * One pass over the session logs. Each window `{ sinceMs, untilMs, model }`
 * gets its own report, so a week and the week before cost one read per file.
 */
export function collectReports(root, windows) {
  const reports = windows.map(() => emptyReport())
  const latest = windows.map(() => 0)
  const earliest = Math.min(...windows.map(window => window.sinceMs ?? 0))
  for (const file of sessionFiles(root)) {
    if (fs.statSync(file).mtimeMs < earliest) continue
    const events = loadEvents(file)
    for (const [index, window] of windows.entries()) {
      const calls = callsOf(events, window)
      if (calls.length === 0) continue
      const report = reports[index]
      report.sessions += 1
      addCalls(report, calls)
      const system = events.find(event => event.type === 'system/message')
      const header = events.findLast(event => event.type === 'request/header')
      if (system !== undefined) {
        report.prompt.sessions += 1
        const text = (system.data?.message?.content ?? []).map(block => block.text ?? '').join('')
        if (text.includes('STICKY RULES TRUNCATED')) report.prompt.stickyTruncated += 1
      }
      const time = header?.time ?? 0
      if (header !== undefined && time > latest[index]) {
        latest[index] = time
        const tools = header.data?.header?.tools ?? []
        report.prompt.toolsDeclared = tools.length
        report.prompt.schemaBytes = tools.reduce((total, tool) => total + Buffer.byteLength(`${tool.description ?? ''}${JSON.stringify(tool.parameters ?? {})}`), 0)
      }
    }
  }
  return reports
}

function main() {
  const args = process.argv.slice(2)
  const readArg = flag => {
    const at = args.indexOf(flag)
    return at >= 0 ? args[at + 1] : undefined
  }
  const root = readArg('--dir') ?? path.join(os.homedir(), '.dsh', 'sessions')
  const since = readArg('--since')
  const until = readArg('--until')
  const model = readArg('--model')
  const sinceMs = since ? Date.parse(`${since}T00:00:00`) : undefined
  const untilMs = until ? Date.parse(`${until}T00:00:00`) : undefined

  const [report] = collectReports(root, [{ sinceMs, untilMs, model }])
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(renderText(report, `${model ? `model~${model}` : 'all models'}${since ? `, since ${since}` : ''}${until ? `, until ${until}` : ''}`))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
