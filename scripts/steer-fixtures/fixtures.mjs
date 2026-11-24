/**
 * Cold fixtures for steering changes: six one-shot tasks, each started in a
 * fresh session, with a pass rule read from the run's own events.
 *
 * Why they exist: upstream Ceulen shipped a first-request bootstrap for
 * DeepSeek flash in 0.28.2 and deleted it in 0.29.0 after exactly this kind of
 * run showed 3/5 with it on against 5/5 with it off. Guidance that reads well
 * can still make the model worse, and only a run on the model tells. Each
 * fixture is one way steering has gone wrong, here or upstream:
 *
 *   held-tool   the user names a tool steering holds cold; it must still be called
 *   read-first  "read X, then run its command": the read comes first
 *   run         a plain run request goes straight to bash
 *   symbol      a definition is found and cited with its line
 *   edit        a one-line change touches one line
 *   verbatim    a lookup command the user typed out runs as typed
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Tool calls of a run, in order, each with the result that answered it. */
export function toolCalls(events) {
  const results = new Map()
  for (const event of events) if (event.type === 'tool_result') results.set(event.callId, event)
  return events
    .filter(event => event.type === 'tool_call')
    .map((event, index) => {
      const result = results.get(event.callId)
      return { index, tool: event.tool, input: event.input ?? {}, status: result?.status, result: typeof result?.result === 'string' ? result.result : JSON.stringify(result?.result ?? '') }
    })
}

export function finalText(events) {
  const final = events.findLast(event => event.type === 'final')
  return typeof final?.text === 'string' ? final.text : ''
}

const text = call => JSON.stringify(call.input)

/** True when the call runs tool `name`: directly, through ceulen_tools, or inside a codemode script. */
export function reaches(call, name) {
  if (call.tool === name) return true
  if (call.tool === 'ceulen_tools') return call.input.action === 'call' && call.input.name === name
  if (call.tool === 'codemode') return new RegExp(`tools\\.${name}\\b|["']${name}["']`).test(String(call.input.code ?? ''))
  return false
}

/** A shell command in the call: a direct bash call, or one inside a codemode script. */
function runs(call, fragment) {
  return (call.tool === 'bash' || call.tool === 'codemode') && text(call).includes(fragment)
}

const ok = { pass: true, why: 'ok' }
const fail = why => ({ pass: false, why })

export const FIXTURES = [
  {
    id: 'held-tool',
    prompt: 'Use the read_slice tool (not read) to show lines 3 to 5 of src/format.js. Reply with those three lines.',
    check({ events }) {
      const calls = toolCalls(events)
      if (calls.length === 0) return fail('the turn ended without a tool call')
      if (!calls.some(call => reaches(call, 'read_slice'))) return fail(`read_slice was never called (calls: ${calls.map(call => call.tool).join(', ')})`)
      return finalText(events).includes('String(value)') ? ok : fail('the reply does not show the lines')
    },
  },
  {
    id: 'read-first',
    prompt: 'Read fixtures/runbook.txt, then run its command and report the exact stdout.',
    check({ events }) {
      const calls = toolCalls(events)
      const read = calls.find(call => text(call).includes('runbook.txt'))
      const run = calls.find(call => runs(call, 'stamp.js'))
      if (read === undefined) return fail('the runbook was never read')
      if (run === undefined) return fail('the runbook command was never run')
      if (run.index < read.index) return fail('the command ran before the runbook was read')
      return finalText(events).includes('steer-fixture-42') ? ok : fail('the reply does not carry the stdout (steer-fixture-42)')
    },
  },
  {
    id: 'run',
    prompt: 'Run `node sum.js` and tell me the number it prints.',
    check({ events }) {
      const calls = toolCalls(events)
      if (calls.length === 0) return fail('the turn ended without a tool call')
      if (!runs(calls[0], 'sum.js')) return fail(`the first call was ${calls[0].tool}, not the command`)
      return finalText(events).includes('4950') ? ok : fail('the reply does not carry the number (4950)')
    },
  },
  {
    id: 'symbol',
    prompt: 'Where is the function computeTotal defined? Answer as file:line.',
    check({ events }) {
      if (toolCalls(events).length === 0) return fail('the turn ended without a tool call')
      return /cart\.js(?::|,? line )10\b/.test(finalText(events)) ? ok : fail('the reply does not say src/cart.js:10')
    },
  },
  {
    id: 'edit',
    prompt: 'In src/cart.js change the value of TAX_RATE from 0.08 to 0.1. Change nothing else.',
    check({ ws, template }) {
      const want = readFileSync(join(template, 'src', 'cart.js'), 'utf8').replace('TAX_RATE = 0.08', 'TAX_RATE = 0.1')
      const got = readFileSync(join(ws, 'src', 'cart.js'), 'utf8')
      if (got === want) return ok
      return got.includes('TAX_RATE = 0.1') ? fail('TAX_RATE changed, and so did something else') : fail('TAX_RATE was not changed')
    },
  },
  {
    id: 'verbatim',
    // `grep -n` on purpose: a plain lookup, exactly what the steered redirect turns into the grep tool.
    prompt: 'Run `grep -n TODO src/cart.js` and paste the exact output.',
    check({ events }) {
      const calls = toolCalls(events)
      const typed = calls.filter(call => runs(call, 'grep -n TODO src/cart.js'))
      if (typed.length === 0) return fail('the command the user typed was never sent')
      if (!typed.some(call => call.status === 'completed' && !call.result.includes('Not run:'))) return fail('the command the user typed was refused')
      const reply = finalText(events)
      return ['load discounts', 'round per line item', 'more than one currency'].every(part => reply.includes(part)) ? ok : fail('the reply does not carry the three matching lines')
    },
  },
]

/** The three loadouts a steering change is judged across. Everything else is the same in all of them. */
export const CONFIGS = ['on', 'off', 'unloaded']

const QUIET = ['advisor', 'munin', 'agentmem', 'evo', 'cron', 'a2a', 'notebooklm', 'ux', 'usage', 'dashboard']

/** ceulen settings for one loadout. Memory, review and background modules are off in all three: a fixture must not write to a real memory store. */
export function settingsFor(config, model) {
  const base = { schemaVersion: 1, upstream: { enabled: false } }
  if (config === 'on') return { ...base, disabled: QUIET, steering: { models: [model], bashLookups: 'redirect', cold: ['read_slice'], coldModels: [] } }
  const off = { models: [], bashLookups: 'off', cold: [], coldModels: [] }
  if (config === 'off') return { ...base, disabled: QUIET, steering: off }
  if (config === 'unloaded') return { ...base, disabled: [...QUIET, 'steering'], steering: off }
  throw new Error(`unknown config "${config}" (${CONFIGS.join(', ')})`)
}

/**
 * Steering must not make the model worse: with it on, the score is at least
 * the best score without it. `results` is { config: { fixtureId: { pass } } }.
 */
export function verdict(results) {
  const score = config => Object.values(results[config] ?? {}).filter(run => run.pass).length
  const scores = Object.fromEntries(Object.keys(results).map(config => [config, score(config)]))
  const baseline = Math.max(0, ...Object.keys(results).filter(config => config !== 'on').map(score))
  const ok = results.on === undefined || scores.on >= baseline
  return { ok, scores, baseline }
}
