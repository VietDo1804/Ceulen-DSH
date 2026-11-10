#!/usr/bin/env node
/**
 * evo — ledger and report.
 *
 * Deterministic only: this script counts and groups evidence and never calls
 * a model. What to fix is decided in a review the user starts (skills/evo).
 *
 *   node scripts/evo-report.mjs --drain     # queue digests -> ledger.jsonl
 *   node scripts/evo-report.mjs             # report-<date>.md (default)
 *   node scripts/evo-report.mjs --json      # machine-readable aggregate
 *   node scripts/evo-report.mjs --fixed "<signature text>" --note "<commit or what changed>"
 *                                           # record a landed fix; later reports compare before/after
 *
 * Options: --dir <self-evo dir>  --min <count>  --dry  --at <ISO time of the fix>
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { redact } from './evo-redact.mjs'

const evoBase = () => process.env.EVO_DIR?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'ceulen', 'self-evo')
const queueDir = base => join(base, 'queue')
const doneDir = base => join(base, 'queue', 'done')
const reportsDir = base => join(base, 'reports')
const stamp = (date = new Date()) => date.toISOString().slice(0, 10)
const DAY = 86_400_000

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
  // The first request says what the session was asked to do: context for whoever reviews its failures.
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
// Our own tools append advice to an error ("Call as: …", "Current region: …",
// "— read the file, then retry"). The advice changes whenever a message is
// reworded, so it is cut before grouping: otherwise every rewording restarts
// the count at zero and one bug shows up as two half-sized signatures.
const HINT_TAIL = / (?:call as|current region|candidates|calls before|did you mean|closest tool)\b[\s\S]*$| — [\s\S]*$| at <anonymous>[\s\S]*$/
export const normalize = text => String(text)
  .toLowerCase()
  .replace(/^tool [^:]+: /, '')
  .replace(/script failed \([^)]*\)\s*/g, '')
  .replace(/script error \(exception\):\s*/g, '')
  .replace(/at eval[\s\S]*$/, '')
  .replace(/ at [\w$.]+ \(eval at runprogram[\s\S]*$/, '')
  .replace(/\(+intermediate value\)+\(?/g, '')
  .replace(/[\w.@~-]*\/[^\s"',)]+/g, '<path>')
  .replace(/[0-9a-f]{8,}/g, '<id>')
  .replace(/\d+(\.\d+)?/g, '<n>')
  .replace(/\(*([a-z_$][\w.$[\]()|'" ]{0,32})\.(slice|trim|split|map|filter|find|some|length)\b/g, '<expr>.$2')
  .replace(HINT_TAIL, '')
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
      const seen = (bounded ? times.filter(inWindow) : times).sort()
      return { text: redact(typeof error === 'string' ? error : error?.error ?? ''), count: bounded ? seen.length : count, seen }
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
    for (const { text, count, seen } of texts) {
      const key = normalize(text)
      // When the error itself is timed, date it by its occurrences: a long session can start days before its last failure.
      const from = seen[0] ?? ts
      const to = seen[seen.length - 1] ?? ts
      const found = signatures.get(key) ?? { count: 0, sessions: new Set(), first: from, last: to, example: String(text).slice(0, 220) }
      found.count += count
      found.sessions.add(id)
      if (from !== '' && (found.first === '' || from < found.first)) found.first = from
      if (to > found.last) found.last = to
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

/** A provider retry is an outage this repo cannot fix, unless the provider refused a malformed tool call. */
export const signatureKind = signature => (/^provider \S+ retry/.test(signature) && !signature.includes('tool call "') ? 'external' : 'repo')

/** The last 7 days, the 7 days before, and everything. */
export function windows(entries, now = new Date()) {
  const until = now.toISOString()
  const since = new Date(now.getTime() - 7 * DAY).toISOString()
  return {
    since,
    until,
    week: aggregate(entries, { since, until }),
    previous: aggregate(entries, { since: new Date(now.getTime() - 14 * DAY).toISOString(), until: since }),
    history: aggregate(entries),
  }
}

/** Fixes recorded with `--fixed`: one `{ at, signature, example, note }` per line. */
export function loadFixes(base) {
  const file = join(base, 'fixes.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        const fix = JSON.parse(line)
        return typeof fix?.signature === 'string' && Number.isFinite(Date.parse(fix?.at)) ? [fix] : []
      } catch {
        return []
      }
    })
}

/**
 * Did a recorded fix hold? Counts the signature in the 14 days before the fix
 * and from the fix until now, each with the sessions active in that window, so
 * a quiet week is not mistaken for a working fix.
 */
export function fixOutcomes(entries, fixes, now = new Date()) {
  return fixes.map(fix => {
    const keys = new Set([fix.signature, normalize(fix.signature), normalize(fix.example ?? fix.signature)])
    const pick = agg => ({ count: agg.signatures.filter(row => keys.has(row.signature)).reduce((sum, row) => sum + row.count, 0), sessions: agg.sessions })
    const at = new Date(fix.at)
    const before = pick(aggregate(entries, { since: new Date(at.getTime() - 14 * DAY).toISOString(), until: at.toISOString() }))
    const after = at.getTime() < now.getTime() ? pick(aggregate(entries, { since: at.toISOString(), until: now.toISOString() })) : { count: 0, sessions: 0 }
    return { signature: normalize(fix.signature), example: redact(fix.example ?? fix.signature), note: redact(fix.note ?? ''), at: at.toISOString(), before, after }
  })
}

/**
 * Signatures that share one place to fix. A group is one piece of work: three
 * wordings of "the edit did not match" are one fix, not three. First match
 * wins, so the narrow tests come before the broad ones. A signature no test
 * claims becomes a group of its own, which is the cue to add a row here.
 */
export const FIX_GROUPS = [
  { id: 'edit-freshness', title: 'Edits refused: file not read, or changed since the read', vi: 'Sửa file khi chưa đọc hoặc file đã đổi', where: 'src/modules/repair', test: /file has not been read|file changed since it was read/ },
  { id: 'edit-match', title: 'Edits that do not match the file', vi: 'Đoạn sửa không khớp nội dung file', where: 'src/modules/repair', test: /hunk is ambiguous|hunk does not match|old_string was not found/ },
  { id: 'web', title: 'Web tools: step shape, capture scope, crashes', vi: 'Tool web: dạng step, phạm vi chụp, crash', where: 'src/modules/web', test: /\bweb_\w+|capture must stay inside/ },
  { id: 'classify', title: 'Classify gate refusals', vi: 'Classify gate từ chối lệnh', where: 'src/modules/classifier', note: 'A refusal of a destructive command is the gate working; only "gate unavailable" is a defect.', noteVi: 'Từ chối một lệnh phá huỷ là cổng an toàn chạy đúng; chỉ trường hợp gate không gọi được model mới là lỗi cần sửa.', test: /classify gate/ },
  { id: 'codemode', title: 'codemode scripts: result shape and return value', vi: 'Script codemode: dạng kết quả và giá trị trả về', where: 'src/modules/codemode/script.ts', test: /is not a function|lossless json|script error|cannot read properties of/ },
  { id: 'arguments', title: 'Tool calls with wrong or missing arguments', vi: 'Gọi tool sai hoặc thiếu tham số', where: 'src/core/toolguard.ts', test: /invalid arguments|missing required|unknown tool|pass a stylesheet/ },
  { id: 'paths', title: 'Paths and write access', vi: 'Đường dẫn và quyền ghi', where: 'DSH fs/sandbox (upstream); the error text is in src/modules/repair', test: /: not found$|file access denied|outside the workspace/ },
]

/** Work-list rows -> fix groups, the group with the most occurrences this week first. */
export function fixGroups(rows) {
  const groups = new Map()
  for (const row of rows) {
    const known = FIX_GROUPS.find(group => group.test.test(row.signature))
    const label = row.signature.slice(0, 70)
    const { id, title, vi, where, note, noteVi } = known ?? { id: `ungrouped:${row.signature}`, title: `Ungrouped: ${label}`, vi: `Chưa phân nhóm: ${label}`, where: '' }
    const group = groups.get(id) ?? { id, title, vi, where, ...(note === undefined ? {} : { note, noteVi }), week: 0, previous: 0, count: 0, items: [] }
    group.week += row.week
    group.previous += row.previous
    group.count += row.count
    group.items.push(row)
    groups.set(id, group)
  }
  return [...groups.values()].sort((a, b) => b.week - a.week || b.count - a.count)
}

/**
 * Split the eligible signatures into what is worth working on now.
 * `work`: still occurring this week and raised inside this repo, most frequent
 * this week first; `groups` is the same rows gathered by where they are fixed. `quiet`: nothing this week (or nothing since its fix).
 * `external`: provider incidents. The cumulative threshold alone would keep a
 * long-dead signature at the top of the list forever.
 */
export function triage(data, outcomes = []) {
  const fixed = new Map(outcomes.map(outcome => [outcome.signature, outcome]))
  const count = (agg, signature) => agg.signatures.find(row => row.signature === signature)?.count ?? 0
  const rows = eligibleCandidates(data.history).map(item => {
    const outcome = fixed.get(item.signature)
    const week = count(data.week, item.signature)
    return {
      ...item,
      kind: signatureKind(item.signature),
      // A fix that landed inside the window resets the count to what came after it.
      week: outcome !== undefined && outcome.at >= data.since ? Math.min(week, outcome.after.count) : week,
      previous: count(data.previous, item.signature),
      ...(outcome === undefined ? {} : { fixedAt: outcome.at }),
    }
  })
  const byWeek = (a, b) => b.week - a.week || b.count - a.count
  const work = rows.filter(row => row.kind === 'repo' && row.week > 0).sort(byWeek)
  return {
    work,
    groups: fixGroups(work),
    quiet: rows.filter(row => row.kind === 'repo' && row.week === 0),
    external: rows.filter(row => row.kind === 'external').sort(byWeek),
  }
}

/** Pure: aggregate -> markdown report. */
export function reportText(agg, min = 5, lists) {
  min = Math.max(5, min)
  const pct = n => (agg.sessions === 0 ? '0' : ((n / agg.sessions) * 100).toFixed(0))
  const candidates = eligibleCandidates(agg, min)
  const cell = text => `\`${text.replace(/\|/g, '\\|')}\``
  const groups = lists?.groups ?? (lists === undefined ? [] : fixGroups(lists.work))
  const work = lists === undefined
    ? []
    : [
        `## fix groups (${groups.length} groups, ${lists.work.length} signatures live this week, raised inside this repo)`,
        '',
        ...(groups.length > 0
          ? groups.flatMap((group, index) => [
              `### ${index + 1}. ${group.title}`,
              '',
              `${group.week} this week · ${group.previous} the week before · ${group.count} total${group.where === '' ? '' : ` · fix in ${group.where}`}`,
              ...(group.note === undefined ? [] : [group.note]),
              '',
              '| this week | week before | total | sessions | last seen | signature |',
              '|---|---|---|---|---|---|',
              ...group.items.map(item => `| ${item.week} | ${item.previous} | ${item.count} | ${item.sessions} | ${item.last.slice(0, 10)} | ${cell(item.signature)} |`),
              '',
              // One real occurrence each: the signature is normalised, the reviewer needs the tool and the values.
              ...group.items.map(item => `- ${cell(item.signature)}${item.fixedAt === undefined ? '' : ` (fix recorded ${item.fixedAt.slice(0, 10)}, still occurring)`}: ${item.example}`),
              '',
            ])
          : ['- nothing live: every eligible signature is quiet this week or is a provider incident.', '']),
        `Left out: ${lists.quiet.length} quiet this week, ${lists.external.length} provider incidents.`,
        '',
      ]
  return [
    `# evo report — ${stamp()}`,
    '',
    'Counts only: nothing here was applied. To act on it, follow "Weekly review" in skills/evo/SKILL.md.',
    '',
    `sessions: ${agg.sessions}  failures: ${agg.failures}  sessions with failures: ${agg.withFailures} (${pct(agg.withFailures)}%)  ledger lines: ${agg.entries}`,
    `window: ${agg.first || '?'} → ${agg.last || '?'}`,
    '',
    ...work,
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
    `## above the threshold (>= ${min} occurrences across >= 3 sessions)`,
    '',
    ...(candidates.length > 0
      ? candidates.map(item => `- **${item.count}×** (${item.sessions} sessions, ${item.first.slice(0, 10)} → ${item.last.slice(0, 10)}): ${item.example}`)
      : ['- none above the threshold yet.']),
    '',
  ].join('\n')
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

  if (argv.includes('--fixed')) {
    const wanted = at('--fixed')
    if (wanted === undefined || wanted.startsWith('--')) {
      console.error('evo-report: --fixed needs the signature (or a distinctive part of it)')
      process.exitCode = 2
      return
    }
    const when = at('--at') ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(when))) {
      console.error(`evo-report: --at is not a date: ${when}`)
      process.exitCode = 2
      return
    }
    const known = aggregate(loadLedger(base)).signatures
    const exact = known.filter(row => row.signature === normalize(wanted))
    const matches = exact.length > 0 ? exact : known.filter(row => row.signature.includes(wanted.toLowerCase().trim()))
    if (matches.length !== 1) {
      console.error(matches.length === 0 ? `evo-report: no signature matches "${redact(wanted)}"` : `evo-report: ${matches.length} signatures match; pass one whole signature for an exact match:`)
      for (const row of matches.slice(0, 10)) console.error(`  ${row.count}×  ${row.signature}`)
      process.exitCode = 1
      return
    }
    const fix = { at: new Date(when).toISOString(), signature: matches[0].signature, example: matches[0].example, note: redact(at('--note') ?? '') }
    if (!dry) appendFileSync(join(base, 'fixes.jsonl'), `${JSON.stringify(fix)}\n`)
    console.log(`evo-report: fix recorded for "${fix.signature}" at ${fix.at}${dry ? ' (dry run)' : ''}`)
    return
  }

  const entries = loadLedger(base)
  const data = windows(entries)
  const agg = data.history
  const lists = triage(data, fixOutcomes(entries, loadFixes(base)))
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...agg, lists }, null, 2))
    return
  }
  const text = reportText(agg, min, lists)
  if (!dry) {
    mkdirSync(reportsDir(base), { recursive: true })
    writeFileSync(join(reportsDir(base), `report-${stamp()}.md`), text)
  }
  process.stdout.write(text)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
