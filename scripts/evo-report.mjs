#!/usr/bin/env node
/**
 * evo Phase 1.5 / Phase 2 — ledger, report and promotion packet.
 *
 * Deterministic only: this script counts and groups evidence, it never decides
 * what a rule should say. The model turns a promotion packet into rule lines.
 *
 *   node scripts/evo-report.mjs --drain     # queue digests -> ledger.jsonl
 *   node scripts/evo-report.mjs             # aggregate report (default)
 *   node scripts/evo-report.mjs --promote   # candidates above --min
 *   node scripts/evo-report.mjs --json      # machine-readable aggregate
 *   node scripts/evo-report.mjs --validate <proposal.md>  # scope check (M1-2)
 *
 * Options: --dir <self-evo dir>  --min <count>  --dry
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { redact } from './evo-redact.mjs'

const evoBase = () => process.env.EVO_DIR?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'ceulen', 'self-evo')
const queueDir = base => join(base, 'queue')
const doneDir = base => join(base, 'queue', 'done')
const reportsDir = base => join(base, 'reports')
const stamp = (date = new Date()) => date.toISOString().slice(0, 10)

const section = (text, name) => {
  const heading = new RegExp(`^## ${name}(?:[ \\t].*)?$`, 'm').exec(text)
  if (heading === null) return ''
  const rest = text.slice(heading.index + heading[0].length)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

const bullets = block => block.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()).filter(line => line !== 'none' && line !== '(none captured)')

/** Pure: one digest markdown -> one ledger entry. */
export function digestToEntry(text, file = '') {
  const id = /^# session (.+)$/m.exec(text)?.[1]?.trim() ?? basename(file).replace(/\.md$/, '')
  const workspace = redact(/^workspace: (.+)$/m.exec(text)?.[1]?.trim() ?? '')
  const started = /^started: (\S+)/m.exec(text)?.[1] ?? ''
  const outcome = redact(section(text, 'outcome').trim())
  const artifacts = bullets(section(text, 'artifacts')).map(redact)
  // The first request is the fixture's task prompt: /evo-probe replays it.
  const task = redact(bullets(section(text, 'requests'))[0] ?? '')
  const revision = /^revision: (\S+)$/m.exec(text)?.[1]
  const activityAt = /^activity: (\S+)$/m.exec(text)?.[1]
  const snapshotAt = /^snapshot: (\S+)$/m.exec(text)?.[1]
  const countsText = section(text, 'failure counts').trim()
  const counted = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(countsText)
  if (countsText && !counted) throw new Error('invalid failure counts block')
  const errors = counted ? JSON.parse(counted[1]) : bullets(section(text, 'failures'))
  if (!Array.isArray(errors) || errors.some(error => typeof error !== 'string' && (typeof error?.error !== 'string' || !Number.isSafeInteger(error.count) || error.count < 1))) throw new Error('invalid failure counts')
  if (errors.some(error => typeof error === 'object' && error.times !== undefined && (!Array.isArray(error.times) || error.times.length > error.count || error.times.some(at => typeof at !== 'string' || !Number.isFinite(Date.parse(at)))))) throw new Error('invalid failure timestamps')
  return {
    ts: started === '?' ? new Date().toISOString() : started,
    session_id: id,
    ...(revision ? { revision } : {}),
    ...(activityAt && Number.isFinite(Date.parse(activityAt)) ? { activity_at: activityAt } : {}),
    ...(snapshotAt && Number.isFinite(Date.parse(snapshotAt)) ? { snapshot_at: snapshotAt } : {}),
    ws: workspace.split('/').filter(Boolean).pop() ?? workspace,
    ...(task === '' ? {} : { task }),
    done: [...artifacts, ...(outcome.length > 0 ? [outcome.slice(0, 400)] : [])],
    errors: errors.map(error => typeof error === 'string' ? redact(error) : { ...error, error: redact(error.error) }),
    friction: [],
    improvements: [],
    source: 'distill',
  }
}

// Signature = the failure with its incidental parts removed: tool prefix,
// timings, stack tail, paths, ids, numbers, and the local variable an error
// happened to name. Without the last one the same bug logs as `r.stdout.slice`,
// `tree.stdout.slice` and `rule.value.stdout.slice` and never crosses a gate.
const normalize = text => String(text)
  .toLowerCase()
  .replace(/^tool [^:]+: /, '')
  .replace(/script failed \([^)]*\)\s*/g, '')
  .replace(/script error \(exception\):\s*/g, '')
  .replace(/at eval[\s\S]*$/, '')
  .replace(/ at [\w$.]+ \(eval at runprogram[\s\S]*$/, '')
  .replace(/\(+intermediate value\)+\(?/g, '')
  .replace(/\/[^\s"',)]+/g, '<path>')
  .replace(/[0-9a-f]{8,}/g, '<id>')
  .replace(/\d+(\.\d+)?/g, '<n>')
  .replace(/([a-z_$][\w.$[\]()|'" ]{0,32})\.(slice|trim|split|map|filter|find|some|length)\b/g, '<expr>.$2')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 140)

/** Append-only ledger snapshots are superseded, not counted again. */
export function latestEntries(entries) {
  const latest = new Map()
  for (const entry of entries) {
    const id = entry.session_id ?? '?'
    const previous = latest.get(id)
    if (!previous || (entry.revision && (!previous.snapshot_at || !entry.snapshot_at || entry.snapshot_at >= previous.snapshot_at))) latest.set(id, entry)
  }
  return [...latest.values()]
}

/** Optional half-open window: undated failures are disclosed, never guessed. */
export function aggregate(entries, { since, until } = {}) {
  const signatures = new Map()
  const workspaces = new Map()
  let failures = 0
  let withFailures = 0
  let sessions = 0
  let untimedFailures = 0
  let first = ''
  let last = ''

  const bounded = since !== undefined || until !== undefined
  const lower = since === undefined ? -Infinity : Date.parse(since)
  const upper = until === undefined ? Infinity : Date.parse(until)
  if (Number.isNaN(lower) || Number.isNaN(upper) || lower >= upper) throw new Error('invalid report window')
  const inWindow = at => { const time = Date.parse(at); return time >= lower && time < upper }
  for (const entry of latestEntries(entries)) {
    const id = entry.session_id ?? '?'
    const ts = String((bounded ? entry.activity_at : undefined) ?? entry.ts ?? '')
    const errors = Array.isArray(entry.errors) ? entry.errors : []
    const texts = errors.map(error => {
      const count = typeof error === 'object' && Number.isSafeInteger(error?.count) && error.count > 0 ? error.count : 1
      const times = Array.isArray(error?.times) ? error.times.filter(at => typeof at === 'string' && Number.isFinite(Date.parse(at))).slice(0, count) : []
      untimedFailures += count - times.length
      return { text: redact(typeof error === 'string' ? error : error?.error ?? ''), count: bounded ? times.filter(inWindow).length : count }
    }).filter(item => item.text && item.count > 0)
    if (bounded && !inWindow(ts) && texts.length === 0) continue
    sessions += 1
    if (ts !== '' && (first === '' || ts < first)) first = ts
    if (ts > last) last = ts
    const count = texts.reduce((sum, item) => sum + item.count, 0)
    failures += count
    if (texts.length > 0) withFailures += 1
    const ws = redact(entry.ws ?? '?')
    workspaces.set(ws, (workspaces.get(ws) ?? 0) + count)
    for (const { text, count } of texts) {
      const key = normalize(text)
      const found = signatures.get(key) ?? { count: 0, sessions: new Set(), first: ts, last: ts, example: String(text).slice(0, 220) }
      found.count += count
      found.sessions.add(id)
      if (ts !== '' && ts < found.first) found.first = ts
      if (ts > found.last) found.last = ts
      if (String(text).length > found.example.length) found.example = String(text).slice(0, 220)
      signatures.set(key, found)
    }
  }

  const ranked = [...signatures.entries()]
    .map(([signature, value]) => ({ signature, count: value.count, sessions: value.sessions.size, first: value.first, last: value.last, example: value.example }))
    .sort((a, b) => b.count - a.count || b.sessions - a.sessions)
  const byWorkspace = [...workspaces.entries()].map(([workspace, count]) => ({ workspace, count })).sort((a, b) => b.count - a.count)

  return { sessions, entries: entries.length, failures, withFailures, untimedFailures, first, last, signatures: ranked, workspaces: byWorkspace }
}

export const eligibleCandidates = (agg, min = 5) => agg.signatures.filter(item => item.count >= Math.max(5, min) && item.sessions >= 3)

/** Pure: aggregate -> markdown report. */
export function reportText(agg, min = 5) {
  min = Math.max(5, min)
  const pct = n => (agg.sessions === 0 ? '0' : ((n / agg.sessions) * 100).toFixed(0))
  const candidates = eligibleCandidates(agg, min)
  return [
    `# evo report — ${stamp()}`,
    '',
    `sessions: ${agg.sessions}  failures: ${agg.failures}  sessions with failures: ${agg.withFailures} (${pct(agg.withFailures)}%)  ledger lines: ${agg.entries}`,
    `window: ${agg.first || '?'} → ${agg.last || '?'}`,
    '',
    `## top signatures (${agg.signatures.length} distinct)`,
    '',
    '| count | sessions | first | last | signature |',
    '|---|---|---|---|---|',
    ...agg.signatures.slice(0, 25).map(item => `| ${item.count} | ${item.sessions} | ${item.first.slice(0, 10)} | ${item.last.slice(0, 10)} | \`${item.signature.replace(/\|/g, '\\|')}\` |`),
    '',
    '## by workspace',
    '',
    '| failures | workspace |',
    '|---|---|',
    ...agg.workspaces.slice(0, 12).map(item => `| ${item.count} | ${item.workspace} |`),
    '',
    `## promotion candidates (>= ${min} occurrences across >= 3 sessions)`,
    '',
    ...(candidates.length > 0
      ? candidates.map(item => `- **${item.count}×** (${item.sessions} sessions, ${item.first.slice(0, 10)} → ${item.last.slice(0, 10)}): ${item.example}`)
      : ['- none above the threshold — the loop has nothing to promote yet.']),
    '',
  ].join('\n')
}

/** Pure: aggregate -> promotion packet for the model to turn into rules. */
export function promotionText(agg, min = 5) {
  min = Math.max(5, min)
  const candidates = eligibleCandidates(agg, min)
  return [
    `# evo promotion packet — ${stamp()}`,
    '',
    `Evidence window: ${agg.first || '?'} → ${agg.last || '?'} (${agg.sessions} sessions, ${agg.failures} failures).`,
    `Qualified candidates: ${candidates.length}`,
    'Rule: >= 5 occurrences across >= 3 distinct sessions. Audit and propose only; never apply automatically. A proposed rule requires a passing probe and valid scope before application.',
    '',
    ...candidates.flatMap((item, index) => [
      `## ${index + 1}. ${item.count}× across ${item.sessions} sessions`,
      '',
      `signature: \`${item.signature}\``,
      `first seen: ${item.first.slice(0, 10)}  last seen: ${item.last.slice(0, 10)}`,
      `example: ${item.example}`,
      '',
      'Write ONE of: a sticky rule line for `$DSH_HOME/ceulen/RULES.md` (`## Learnings (auto)` section),',
      'a skill, or a script fix. If it is not fixable by a rule, say so and drop it.',
      '',
      'Every proposed line under `## Add to RULES.md` MUST carry a scope tag:',
      '- `- scope: invariant — <repo-agnostic rule>` lands in `$DSH_HOME/ceulen/RULES.md` and applies to every repo.',
      '- `- scope: domain — <rule naming this repo>` lands in `<repo>/.dsh/RULES.md` and applies here only.',
      'An invariant line may not contain an absolute path, a repo file name, or an import from this repo.',
      '',
    ]),
    candidates.length === 0 ? 'No candidate crossed the threshold.\n' : '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Proposal scoping (M1-2): a repo convention adopted as a global law is how a
// rules file becomes a liability. Every proposed line names its destination.
// ---------------------------------------------------------------------------

const SCOPE_LINE = /^-\s*scope:\s*(invariant|domain)\s*(?:—|–|-|:)\s*(.+)$/i
const ABSOLUTE_PATH = /(^|[\s(`"'])\/(?:home|Users|tmp|var|opt|srv|workspace|mnt|Volumes)\/\S+/
const REPO_IMPORT = /\b(?:from|require\()\s*['"]((?:\.{1,2}\/)[^'"]*|(?:src|test|scripts|lib)\/[^'"]*)['"]/

/** The narrow, data-driven rejection list: paths, repo-local file names, repo imports. */
export function offendingToken(text, repoRoot = process.cwd()) {
  const absolute = ABSOLUTE_PATH.exec(text)
  if (absolute) return absolute[0].trim().replace(/^[(`"']/, '')
  const imported = REPO_IMPORT.exec(text)
  if (imported) return imported[1]
  const repoName = basename(repoRoot)
  for (const raw of text.split(/[^\w./@-]+/)) {
    const token = raw.replace(/[.,;:!?)\]}"']+$/, '')
    if (token === '' ) continue
    if (token === repoName) return token
    if (/^(?:\.{1,2}\/)?[\w./@-]+\.(md|json|ya?ml|toml|mjs|ts|js)$/.test(token) && existsSync(join(repoRoot, token))) return token
  }
  return undefined
}

/**
 * Pure: one proposal document -> destination-scoped lines plus rejections.
 * Only the `## Add to RULES.md` section carries rule lines; other sections are
 * scripts/skills/drops and are not rules.
 */
export function parseProposal(text, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd()
  const proposed = []
  const errors = []
  for (const line of section(text, 'Add to RULES.md').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ') || trimmed === '- none' || trimmed === '- (none)') continue
    const match = SCOPE_LINE.exec(trimmed)
    if (match === null) {
      errors.push({ line: trimmed, reason: 'missing scope: prefix — every line must start with "- scope: invariant — " or "- scope: domain — "' })
      continue
    }
    const scope = match[1].toLowerCase()
    const body = match[2].trim()
    if (scope === 'invariant') {
      const bad = offendingToken(body, repoRoot)
      if (bad !== undefined) {
        errors.push({
          line: trimmed,
          reason: `invariant proposal names repo-specific "${bad}" — move it to scope: domain, destination ${join(repoRoot, '.dsh', 'RULES.md')}`,
        })
        continue
      }
    }
    proposed.push({
      scope,
      text: body,
      destination: scope === 'invariant' ? '~/.dsh/ceulen/RULES.md' : join(repoRoot, '.dsh', 'RULES.md'),
    })
  }
  return { proposed, errors }
}

export function loadLedger(base) {
  const file = join(base, 'ledger.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/** Redact prose and parsed values, never run a prose regex over serialized JSON. */
function archiveDigest(text, errors) {
  const heading = /^## failure counts[^\n]*\n/m.exec(text)
  if (heading === null) return redact(text)
  const tail = text.indexOf('\n## ', heading.index + heading[0].length)
  return redact(text.slice(0, heading.index)) + '## failure counts\n```json\n' + JSON.stringify(errors) + '\n```\n' + (tail < 0 ? '' : redact(text.slice(tail)))
}

function drain(base, dry) {
  const queue = queueDir(base)
  if (!existsSync(queue)) return { drained: 0, skipped: 0, invalid: 0 }
  const seen = new Map(loadLedger(base).map(entry => [entry.session_id, entry.revision]))
  const files = readdirSync(queue).filter(file => file.endsWith('.md'))
  let drained = 0
  let skipped = 0
  let invalid = 0
  for (const file of files) {
    let text
    let entry
    try {
      text = readFileSync(join(queue, file), 'utf8')
      entry = digestToEntry(text, file)
    } catch (error) {
      invalid += 1
      console.error(`skip ${file}: ${redact(error.message)}`)
      continue // Preserve invalid evidence for repair; do not block other sessions.
    }
    if (seen.has(entry.session_id) && (!entry.revision || seen.get(entry.session_id) === entry.revision)) {
      skipped += 1
    } else {
      if (!dry) {
        writeFileSync(join(base, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a' })
        seen.set(entry.session_id, entry.revision)
      }
      drained += 1
    }
    if (!dry) {
      mkdirSync(doneDir(base), { recursive: true })
      writeFileSync(join(queue, file), archiveDigest(text, entry.errors))
      renameSync(join(queue, file), join(doneDir(base), file))
    }
  }
  return { drained, skipped, invalid }
}

function main(argv) {
  const at = flag => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined)
  const base = at('--dir') ?? evoBase()
  const min = Number(at('--min') ?? 5) || 5
  const dry = argv.includes('--dry')

  if (argv.includes('--drain')) {
    const result = drain(base, dry)
    console.log(`evo-drain: ${result.drained} new, ${result.skipped} already in ledger, ${result.invalid} invalid (left in queue)${dry ? ' (dry run)' : ''}`)
    return
  }

  if (argv.includes('--validate')) {
    const file = at('--validate')
    if (file === undefined) {
      console.error('evo-report: --validate needs a proposal file')
      process.exitCode = 2
      return
    }
    const report = parseProposal(readFileSync(file, 'utf8'), { repoRoot: process.cwd() })
    for (const item of report.proposed) console.log(`ok ${item.scope}: ${item.text}  -> ${item.destination}`)
    for (const item of report.errors) console.error(`invalid: ${item.reason}\n  ${item.line}`)
    if (report.errors.length > 0) process.exitCode = 1
    else console.log(`evo-report: ${report.proposed.length} proposal line(s) valid`)
    return
  }

  const agg = aggregate(loadLedger(base))
  if (argv.includes('--json')) {
    console.log(JSON.stringify(agg, null, 2))
    return
  }
  const promote = argv.includes('--promote')
  const text = promote ? promotionText(agg, min) : reportText(agg, min)
  if (!dry) {
    mkdirSync(reportsDir(base), { recursive: true })
    writeFileSync(join(reportsDir(base), `${promote ? 'promotion' : 'report'}-${stamp()}.md`), text)
  }
  process.stdout.write(text)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
