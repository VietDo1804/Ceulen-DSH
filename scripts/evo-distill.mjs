#!/usr/bin/env node
/**
 * evo Phase 1 — turn finished sessions into compact digests for the evo pass.
 *
 * Reads $DSH_HOME/sessions/<workspace>/<uuid>/session.v4.jsonl.zstd, extracts
 * the parts that carry signal (requests, failures, outcome, artifacts), and
 * writes one small markdown digest per session into
 * $DSH_HOME/ceulen/self-evo/queue/. Never calls a model: judgment stays in the
 * /evo pass, this only cuts the transcript down to something worth reading.
 *
 *   node scripts/evo-distill.mjs            # new sessions since last run
 *   node scripts/evo-distill.mjs --all      # ignore the processed state
 *   node scripts/evo-distill.mjs --dry      # print, write nothing
 *   node scripts/evo-distill.mjs --limit 5  # cap this run
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { redact } from './evo-redact.mjs'

// DSH appends one zstd frame per flush; Node's zstd helper decodes only the
// first frame, so the CLI is used when present and the helper is the fallback.
function readTranscript(file) {
  try {
    return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return zstdDecompressSync(readFileSync(file)).toString('utf8')
  }
}

const NOISE = /^(Current runtime context\.|Time sampled while preparing|<system-reminder>|<skill_content|\[GLM-\d)/
const ACTIVE_MS = 5 * 60_000
const MAX_TEXT = 400
const MAX_ITEMS = 8
const DIGEST_VERSION = 3

const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const evoDir = () => join(dshHome(), 'ceulen', 'self-evo')

const cut = (text, n = MAX_TEXT) => {
  const one = redact(text).replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function textOf(message) {
  const parts = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message?.message?.content)
      ? message.message.content
      : []
  const text = parts.filter(part => part?.type === 'text').map(part => part.text ?? '').join(' ')
  return text || message?.text || ''
}

/** Pure: transcript events -> digest markdown. Exported for the unit test. */
export function buildDigest(events, meta = {}) {
  const requests = []
  const failures = []
  const recordFailure = (error, time) => failures.push({ error: cut(error, 600), at: Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null })
  const artifacts = []
  const tools = new Map()
  let turns = 0
  let steps = 0
  let retries = 0
  let tokens = 0
  const started = meta.createdAt ?? 0
  let ended = 0
  let outcome = ''

  for (const event of events) {
    const data = event?.data ?? {}
    const time = typeof event?.time === 'number' ? event.time : 0
    if (time > ended) ended = time

    switch (event?.type) {
      case 'user/message': {
        const text = textOf(data).trim()
        if (text.length === 0 || NOISE.test(text)) break
        requests.push(cut(text))
        break
      }
      case 'turn/start':
        turns += 1
        break
      case 'step/start':
        steps += 1
        break
      case 'assistant/message': {
        const text = textOf(data).trim()
        if (text.length > 0) outcome = cut(text, 600)
        const total = Number(data?.usage?.totalTokens ?? 0)
        if (total > tokens) tokens = total
        break
      }
      case 'tool/result': {
        for (const call of data?.meta?.calls ?? []) {
          const name = cut(call?.name ?? 'unknown', 80)
          tools.set(name, (tools.get(name) ?? 0) + 1)
        }
        const failed = data?.meta?.ok === false || data?.message?.isError === true
        if (failed) recordFailure(`tool ${data?.meta?.calls?.[0]?.name ?? '?'}: ${cut(textOf(data?.message), 200)}`, time)
        break
      }
      case 'job/settled': {
        const dirty = data?.status !== 'completed' || /exit code: [1-9]/.test(String(data?.detail ?? ''))
        if (dirty) recordFailure(`${data?.kind ?? 'job'} ${data?.status ?? '?'} (${cut(data?.detail ?? '', 60)}): ${cut(data?.label, 160)}`, time)
        break
      }
      case 'llm/retry':
        retries += 1
        recordFailure(`provider ${data?.provider ?? '?'} retry ${data?.retry ?? '?'}: ${cut(data?.failure?.message, 160)}`, time)
        break
      case 'todo/write':
        artifacts.push(`todos ${Array.isArray(data?.todos) ? data.todos.filter(t => t?.status === 'completed').length : 0} done`)
        break
      case 'deliverables/presented':
        for (const file of data?.files ?? []) artifacts.push(`delivered ${cut(file?.path, 160)}`)
        break
      default:
        break
    }
  }

  const startedAt = started > 0 ? new Date(started).toISOString() : '?'
  const minutes = started > 0 && ended > started ? Math.round((ended - started) / 60_000) : 0
  const toolLine = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => `${name}×${n}`).join(', ') || 'none'
  const unique = list => [...new Set(list)]
  const counts = new Map()
  for (const { error, at } of failures) {
    const found = counts.get(error) ?? { error, count: 0, times: [] }
    found.count += 1
    if (at !== null) found.times.push(at)
    counts.set(error, found)
  }

  return [
    `# session ${cut(meta.id ?? basename(meta.file ?? '', '.v4.jsonl.zstd'))}`,
    '',
    `workspace: ${cut(meta.workspace ?? '?', 800)}`,
    ...(meta.revision ? [`revision: ${meta.revision}`] : []),
    ...(meta.snapshotAt ? [`snapshot: ${meta.snapshotAt}`] : []),
    `activity: ${ended > 0 ? new Date(ended).toISOString() : startedAt}`,
    `started: ${startedAt}  duration: ${minutes}m  turns: ${turns}  steps: ${steps}  tokens: ${tokens}`,
    `tools: ${toolLine}`,
    '',
    '## requests',
    ...(requests.length > 0 ? unique(requests).slice(0, MAX_ITEMS).map(text => `- ${text}`) : ['- (none captured)']),
    '',
    `## failures (${failures.length})`,
    ...(failures.length > 0 ? [...counts.keys()].slice(0, MAX_ITEMS).map(text => `- ${text}`) : ['- none']),
    '',
    '## failure counts',
    '```json',
    JSON.stringify([...counts.values()]),
    '```',
    '',
    '## outcome',
    outcome.length > 0 ? outcome : '(no final assistant text)',
    '',
    '## artifacts',
    ...(artifacts.length > 0 ? unique(artifacts).slice(0, MAX_ITEMS).map(text => `- ${text}`) : ['- none']),
    '',
    `<!-- llm retries: ${retries} -->`,
  ].join('\n')
}

function sessions() {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace)
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = join(dir, entry, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      found.push({ workspace, id: entry, file })
    }
  }
  return found.sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs)
}

function loadState() {
  try {
    return JSON.parse(readFileSync(join(evoDir(), 'state.json'), 'utf8'))
  } catch {
    return { processed: {}, lastRun: null }
  }
}

function main(argv) {
  const all = argv.includes('--all')
  const dry = argv.includes('--dry')
  const limitAt = argv.indexOf('--limit')
  const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) || 0 : 0
  const now = Date.now()
  const state = loadState()
  const processed = state.processed ?? {}

  const queue = join(evoDir(), 'queue')
  if (!dry) mkdirSync(queue, { recursive: true })

  let wrote = 0
  for (const session of sessions()) {
    if (limit > 0 && wrote >= limit) break
    if (session.id === process.env.DSH_SESSION_ID) continue
    const stat = statSync(session.file)
    if (now - stat.mtimeMs < ACTIVE_MS) continue
    const fingerprint = `${stat.size}:${stat.mtimeMs}`
    if (!all && processed[session.id]?.fingerprint === fingerprint && processed[session.id]?.digestVersion === DIGEST_VERSION) continue
    let events
    let revision
    try {
      const transcript = readTranscript(session.file)
      revision = createHash('sha256').update(`digest-v${DIGEST_VERSION}\n`).update(transcript).digest('hex')
      events = transcript.split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch (error) {
      console.error(`skip ${session.id}: ${error.message}`)
      continue
    }

    const header = events.find(event => event.type === 'session') ?? {}
    const firstRequest = events.find(event => event.type === 'user/message')
    const requestText = textOf(firstRequest?.data).trimStart()
    if (!all && /^\[(cron )?evo/.test(requestText)) continue // the pass's own sessions

    const digest = buildDigest(events.filter(event => event.type !== 'session'), {
      id: header.id ?? session.id,
      workspace: header.cwd ?? session.workspace,
      createdAt: header.createdAt,
      file: session.file,
      revision,
      snapshotAt: new Date(now).toISOString(),
    })

    const name = `${new Date(header.createdAt ?? now).toISOString().replace(/[:.]/g, '-')}_${session.id}.md`
    if (dry) {
      console.log(`--- ${name} (${digest.length}B)\n${digest}\n`)
    } else {
      writeFileSync(join(queue, name), digest)
      processed[session.id] = { at: new Date().toISOString(), file: name, fingerprint, revision, digestVersion: DIGEST_VERSION }
    }
    wrote += 1
  }

  if (!dry) {
    writeFileSync(join(evoDir(), 'state.json'), JSON.stringify({ processed, lastRun: new Date().toISOString() }, null, 2))
  }
  console.log(`evo-distill: ${wrote} digest(s)${dry ? ' (dry run)' : ''} → ${queue}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
