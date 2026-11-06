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

const evoBase = () => process.env.EVO_DIR?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'ceulen', 'self-evo')
const queueDir = base => join(base, 'queue')
const doneDir = base => join(base, 'queue', 'done')
const reportsDir = base => join(base, 'reports')
const stamp = (date = new Date()) => date.toISOString().slice(0, 10)

const section = (text, name) => {
  const start = text.indexOf(`## ${name}`)
  if (start < 0) return ''
  const rest = text.slice(start + name.length + 3)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

const bullets = block => block.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()).filter(line => line !== 'none' && line !== '(none captured)')

/** Pure: one digest markdown -> one ledger entry. */
export function digestToEntry(text, file = '') {
  const id = /^# session (.+)$/m.exec(text)?.[1]?.trim() ?? basename(file).replace(/\.md$/, '')
  const workspace = /^workspace: (.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const started = /^started: (\S+)/m.exec(text)?.[1] ?? ''
  const outcome = section(text, 'outcome').trim()
  const artifacts = bullets(section(text, 'artifacts'))
  // The first request is the fixture's task prompt: /evo-probe replays it.
  const task = bullets(section(text, 'requests'))[0] ?? ''
  return {
    ts: started === '?' ? new Date().toISOString() : started,
    session_id: id,
    ws: workspace.split('/').filter(Boolean).pop() ?? workspace,
    ...(task === '' ? {} : { task }),
    done: [...artifacts, ...(outcome.length > 0 ? [outcome.slice(0, 400)] : [])],
    errors: bullets(section(text, 'failures')),
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

/** Pure: ledger entries -> ranked failure signatures + workspace totals. */
export function aggregate(entries) {
  const signatures = new Map()
  const workspaces = new Map()
  const sessions = new Set()
  let failures = 0
  let withFailures = 0
  let first = ''
  let last = ''

  for (const entry of entries) {
    const id = entry.session_id ?? '?'
    if (sessions.has(id)) continue
    sessions.add(id)
    const ts = String(entry.ts ?? '')
    if (ts !== '' && (first === '' || ts < first)) first = ts
    if (ts > last) last = ts
    const errors = Array.isArray(entry.errors) ? entry.errors : []
    const texts = errors.map(error => (typeof error === 'string' ? error : error?.error ?? '')).filter(Boolean)
    failures += texts.length
    if (texts.length > 0) withFailures += 1
    const ws = entry.ws ?? '?'
    workspaces.set(ws, (workspaces.get(ws) ?? 0) + texts.length)
    for (const text of texts) {
      const key = normalize(text)
      const found = signatures.get(key) ?? { count: 0, sessions: new Set(), first: ts, last: ts, example: String(text).slice(0, 220) }
      found.count += 1
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

  return { sessions: sessions.size, entries: entries.length, failures, withFailures, first, last, signatures: ranked, workspaces: byWorkspace }
}

/** Pure: aggregate -> markdown report. */
export function reportText(agg, min = 5) {
  const pct = n => (agg.sessions === 0 ? '0' : ((n / agg.sessions) * 100).toFixed(0))
  const candidates = agg.signatures.filter(item => item.count >= min)
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
    `## promotion candidates (>= ${min} occurrences)`,
    '',
    ...(candidates.length > 0
      ? candidates.map(item => `- **${item.count}×** (${item.sessions} sessions, ${item.first.slice(0, 10)} → ${item.last.slice(0, 10)}): ${item.example}`)
      : ['- none above the threshold — the loop has nothing to promote yet.']),
    '',
  ].join('\n')
}

/** Pure: aggregate -> promotion packet for the model to turn into rules. */
export function promotionText(agg, min = 5) {
  const candidates = agg.signatures.filter(item => item.count >= min)
  return [
    `# evo promotion packet — ${stamp()}`,
    '',
    `Evidence window: ${agg.first || '?'} → ${agg.last || '?'} (${agg.sessions} sessions, ${agg.failures} failures).`,
    'Rule: a signature qualifies only at >= min occurrences (default 5). One occurrence proves nothing.',
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
    if (/^[\w.-]+\.(md|json|ya?ml|toml|mjs|ts|js)$/.test(token) && existsSync(join(repoRoot, token))) return token
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

function loadLedger(base) {
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

function drain(base, dry) {
  const queue = queueDir(base)
  if (!existsSync(queue)) return { drained: 0, skipped: 0 }
  const seen = new Set(loadLedger(base).map(entry => entry.session_id))
  const files = readdirSync(queue).filter(file => file.endsWith('.md'))
  let drained = 0
  let skipped = 0
  for (const file of files) {
    const text = readFileSync(join(queue, file), 'utf8')
    const entry = digestToEntry(text, file)
    if (seen.has(entry.session_id)) {
      skipped += 1
    } else {
      if (!dry) {
        writeFileSync(join(base, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a' })
        seen.add(entry.session_id)
      }
      drained += 1
    }
    if (!dry) {
      mkdirSync(doneDir(base), { recursive: true })
      renameSync(join(queue, file), join(doneDir(base), file))
    }
  }
  return { drained, skipped }
}

function main(argv) {
  const at = flag => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined)
  const base = at('--dir') ?? evoBase()
  const min = Number(at('--min') ?? 5) || 5
  const dry = argv.includes('--dry')

  if (argv.includes('--drain')) {
    const result = drain(base, dry)
    console.log(`evo-drain: ${result.drained} new, ${result.skipped} already in ledger${dry ? ' (dry run)' : ''}`)
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
