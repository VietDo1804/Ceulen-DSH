#!/usr/bin/env node
/**
 * In-pane runner for `delegate` runner:"herdr" (src/modules/subagent/herdr.ts).
 *
 *   node scripts/herdr-child.mjs <runDir>
 *
 * Reads <runDir>/run.json, runs `dsh --profile headless --json -` with the
 * assignment on stdin, prints readable progress to this herdr pane, keeps the
 * raw NDJSON in events.jsonl, and finally writes result.json (atomically): the
 * parent's only completion signal. Ctrl+C stops the child and still writes it.
 */
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, createWriteStream, readFileSync, renameSync, writeFileSync } from 'node:fs'

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

function oneLine(value, max = 110) {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function toolSummary(input) {
  if (input === null || typeof input !== 'object') return ''
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url']) {
    if (typeof input[key] === 'string') return oneLine(input[key], 90)
  }
  return oneLine(input, 90)
}

/** Fail-open: report this pane's state to herdr so its sidebar shows the child as an agent. */
function report(role, state) {
  const bin = process.env.HERDR_BIN_PATH
  const pane = process.env.HERDR_PANE_ID
  if (process.env.HERDR_ENV !== '1' || !bin || !pane) return Promise.resolve()
  const args = state === 'release'
    ? ['pane', 'release-agent', pane, '--source', 'custom:ceulen-delegate', '--agent', `ceulen-${role}`]
    : ['pane', 'report-agent', pane, '--source', 'custom:ceulen-delegate', '--agent', `ceulen-${role}`, '--state', state]
  return new Promise(resolve => execFile(bin, args, { timeout: 2_000 }, () => resolve()))
}

export function main(runDir) {
  const run = JSON.parse(readFileSync(`${runDir}/run.json`, 'utf8'))
  const state = { text: '', reason: '', error: undefined, toolCalls: 0, inputTokens: 0, outputTokens: 0, aborted: false, sessionId: '' }
  // Clear the echoed launch command so the pane opens on the child's own header.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
  console.log(`${BOLD}ceulen delegate · ${run.role}${RESET} ${DIM}${run.label}${RESET}`)
  console.log(`${DIM}${run.route} · ${run.permission} · ${run.cwd}${RESET}\n`)
  void report(run.role, 'working')

  const child = spawn(run.dsh, [
    '--profile', 'headless',
    '--patch', run.overlay,
    '--permission-mode', run.permission,
    '--approval-policy', 'never',
    '--json', '-',
  ], { cwd: run.cwd, env: { ...process.env, CEULEN_HERDR: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] })

  child.stdin.end(readFileSync(run.assignment))
  child.stderr.pipe(createWriteStream(run.stderr))

  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') handle(line)
      newline = buffer.indexOf('\n')
    }
  })

  function handle(line) {
    appendFileSync(run.events, `${line}\n`)
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    switch (event.type) {
      case 'session':
        state.sessionId = event.sessionId ?? ''
        break
      case 'thinking':
        console.log(`${DIM}· ${oneLine(event.text)}${RESET}`)
        break
      case 'tool_call':
        state.toolCalls++
        console.log(`${CYAN}▸ ${event.tool}${RESET} ${toolSummary(event.input)}`)
        break
      case 'tool_result':
        if (event.status !== 'completed') console.log(`${RED}  ✗ ${event.status}: ${oneLine(event.result)}${RESET}`)
        break
      case 'text':
        console.log(oneLine(event.text, 400))
        break
      case 'status':
        if (event.usage !== undefined) {
          state.inputTokens += event.usage.inputTokens ?? 0
          state.outputTokens += event.usage.outputTokens ?? 0
        }
        break
      case 'final':
        state.text = event.text ?? ''
        state.reason = event.reason?.kind ?? 'completed'
        break
      case 'error':
        state.error = event.message ?? 'error'
        console.log(`${RED}error: ${state.error}${RESET}`)
        break
    }
  }

  process.on('SIGINT', () => {
    state.aborted = true
    child.kill('SIGINT')
  })

  child.on('error', error => {
    state.error = `could not start ${run.dsh}: ${error.message}`
  })

  child.on('close', code => {
    if (buffer.trim() !== '') handle(buffer)
    const exitCode = typeof code === 'number' ? code : 1
    if (state.aborted && state.error === undefined) state.error = 'aborted'
    const result = {
      exitCode,
      text: state.text,
      reason: state.reason || (exitCode === 0 ? 'completed' : 'failed'),
      ...(state.error === undefined ? {} : { error: state.error }),
      toolCalls: state.toolCalls,
      usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
      sessionId: state.sessionId,
    }
    writeFileSync(`${run.result}.tmp`, `${JSON.stringify(result, null, 2)}\n`)
    renameSync(`${run.result}.tmp`, run.result)
    const ok = exitCode === 0 && state.error === undefined
    console.log(`\n${ok ? GREEN : RED}${BOLD}${ok ? '✓ done' : `✗ exit ${exitCode}`}${RESET}${DIM} · ${state.toolCalls} tool calls · ${state.inputTokens}/${state.outputTokens} tokens · ${runDir}${RESET}`)
    if (!ok) console.log(`${DIM}stderr: ${run.stderr}${RESET}`)
    void report(run.role, 'idle').then(() => report(run.role, 'release'))
  })
}

if (import.meta.main) {
  const runDir = process.argv[2]
  if (runDir === undefined) {
    console.error('usage: node scripts/herdr-child.mjs <runDir>')
    process.exitCode = 2
  } else {
    main(runDir)
  }
}
