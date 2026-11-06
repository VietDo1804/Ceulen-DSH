#!/usr/bin/env node
// UX bench: run the same briefs through two builds of this bundle and compare.
//
//   node scripts/ux-bench.mjs prepare            build each arm in its own worktree and DSH_HOME
//   node scripts/ux-bench.mjs run --yes          paid: 3 briefs x 3 runs x 2 arms, stops at --budget
//   node scripts/ux-bench.mjs score              free: same scorer and screenshots for every run
//   node scripts/ux-bench.mjs summary            free: per-arm table
//   node scripts/ux-bench.mjs review             free: blind pairwise page
//   node scripts/ux-bench.mjs report --picks f   free: unblind the picks
//   node scripts/ux-bench.mjs clean              remove worktrees and homes, keep run output
//
// Run options: --arms A,D --briefs dashboard,landing --runs 3 --budget 5 --timeout-min 25 --parallel 2
// A finished run is kept; delete its folder under .ux-bench/runs to repeat it.
//
// Everything lands in .ux-bench/ (gitignored). Each run works in an empty temp
// directory with a neutral name, so it cannot read other runs or this repo.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ARMS, BRIEFS, benchSettings, buildPairs, estimateCost, mergeMetrics, profilePackage, profilePatch, readSession, reviewPage, routeProblem, runPlan, sessionMetrics, summarize, summaryTable, tallyPicks } from './ux-bench/lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH = join(ROOT, '.ux-bench')
const BUILDS = join(BENCH, 'builds')
const HOMES = join(BENCH, 'homes')
const RUNS = join(BENCH, 'runs')
const REVIEW = join(BENCH, 'review')
const MANIFEST = join(BENCH, 'manifest.json')
const PROFILE = 'ux-bench'
const USER_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

function fail(message) {
  console.error(`ux-bench: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) options._.push(arg)
    else if (arg === '--yes') options.yes = true
    else options[arg.slice(2)] = argv[++i]
  }
  return options
}

const listOption = (value, fallback) => (value === undefined ? fallback : value.split(',').map(item => item.trim()).filter(Boolean))

function numberOption(value, fallback, name) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`--${name} must be a positive number`)
  return parsed
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback)
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const runDir = ({ arm, brief, run }) => join(RUNS, arm, brief, String(run))
// Models start their own Chrome here, and one profile can be 100 MB.
const keepFile = source => !/(^|\/)(node_modules|\.chrome[^/]*)(\/|$)/.test(source) && !source.endsWith('.log') && !source.endsWith('.pid')

function prepareArm(arm, commit) {
  const build = join(BUILDS, arm)
  const home = join(HOMES, arm)
  if (existsSync(build)) git('worktree', 'remove', '--force', build)
  git('worktree', 'add', '--detach', build, commit)
  symlinkSync(join(ROOT, 'node_modules'), join(build, 'node_modules'))
  console.log(`ux-bench: building arm ${arm} at ${commit.slice(0, 7)}`)
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: build, stdio: 'inherit' })

  rmSync(home, { recursive: true, force: true })
  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'ceulen'), { recursive: true })
  writeJson(join(profile, 'package.json'), profilePackage(build))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), profilePatch())
  symlinkSync(build, join(profile, 'node_modules', 'ceulen-dsh'))
  writeJson(join(home, 'ceulen', 'settings.json'), benchSettings(readJson(join(USER_HOME, 'ceulen', 'settings.json'), {})))
  // A link, not a copy: the keys stay in one file.
  symlinkSync(join(USER_HOME, '.credentials.yaml'), join(home, '.credentials.yaml'))
}

function prepare(options) {
  const arms = listOption(options.arms, Object.keys(ARMS))
  if (git('status', '--porcelain') !== '') console.warn('ux-bench: the tree has uncommitted changes; arms build from commits, so those are not included')
  mkdirSync(BUILDS, { recursive: true })
  const manifest = readJson(MANIFEST, { arms: {} })
  for (const arm of arms) {
    if (ARMS[arm] === undefined) fail(`unknown arm ${arm}`)
    const commit = git('rev-parse', ARMS[arm].ref)
    prepareArm(arm, commit)
    manifest.arms[arm] = { ...ARMS[arm], commit }
  }
  writeJson(MANIFEST, manifest)
  console.log(`ux-bench: ready: ${arms.map(arm => `${arm}=${manifest.arms[arm].commit.slice(0, 7)}`).join(' ')}`)
}

function listSessions(home) {
  const found = []
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl.zstd')) found.push(path)
    }
  }
  walk(join(home, 'sessions'))
  return found
}

function runDsh({ home, task, cwd, timeoutMs, logFile }) {
  return new Promise(done => {
    const child = spawn('dsh', ['--profile', PROFILE, task], {
      cwd,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      writeFileSync(logFile, log)
      done({ code, timedOut })
    })
  })
}

async function runOne(item, { timeoutMs, tasks }) {
  const home = join(HOMES, item.arm)
  const dir = runDir(item)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const task = tasks[item.brief]
  const work = mkdtempSync(join(tmpdir(), `work-${randomBytes(3).toString('hex')}-`))
  const before = new Set(listSessions(home))
  const started = Date.now()
  const result = await runDsh({ home, task, cwd: work, timeoutMs, logFile: join(dir, 'dsh.log') })
  const sessions = listSessions(home).filter(file => !before.has(file))
  const metrics = mergeMetrics(sessions.map(file => sessionMetrics(readSession(file))))
  cpSync(work, join(dir, 'work'), { recursive: true, filter: keepFile })
  rmSync(work, { recursive: true, force: true })
  const hasPage = existsSync(join(dir, 'work', 'index.html'))
  const problem = routeProblem(metrics)
  const record = {
    ...item,
    // A timed-out page still counts: both arms get the same clock, and dropping
    // it would punish whichever arm iterates longer. `timedOut` reports it.
    ok: (result.code === 0 || result.timedOut) && hasPage && problem === null,
    exitCode: result.code,
    timedOut: result.timedOut,
    hasPage,
    routeProblem: problem,
    seconds: Math.round((Date.now() - started) / 1000),
    sessions: sessions.map(file => relative(BENCH, file)),
    cost: estimateCost(metrics),
    metrics,
  }
  writeJson(join(dir, 'record.json'), record)
  return record
}

async function run(options) {
  const arms = listOption(options.arms, Object.keys(ARMS))
  const briefs = listOption(options.briefs, BRIEFS)
  const runs = numberOption(options.runs, 3, 'runs')
  const budget = numberOption(options.budget, 5, 'budget')
  const timeoutMs = numberOption(options['timeout-min'], 25, 'timeout-min') * 60_000
  const parallel = numberOption(options.parallel, 2, 'parallel')
  for (const arm of arms) if (!existsSync(join(HOMES, arm))) fail(`arm ${arm} is not prepared; run: node scripts/ux-bench.mjs prepare`)
  for (const brief of briefs) if (!BRIEFS.includes(brief)) fail(`unknown brief ${brief}`)
  // Read now: a branch switch during a multi-hour bench removes these files.
  const rules = readFileSync(join(ROOT, 'scripts/ux-bench/briefs/_rules.txt'), 'utf8')
  const tasks = Object.fromEntries(briefs.map(brief => [brief, `${readFileSync(join(ROOT, 'scripts/ux-bench/briefs', `${brief}.md`), 'utf8')}\n${rules}`]))
  const plan = runPlan({ arms, briefs, runs })
  if (options.yes !== true) {
    console.log(`ux-bench: this spends real model credit: ${plan.length} runs, stopping at $${budget}.`)
    console.log('Add --yes to run.')
    return
  }
  // Finished runs stay finished, so an interrupted bench resumes without paying twice.
  const recordFile = item => join(runDir(item), 'record.json')
  const pending = plan.filter(item => !existsSync(recordFile(item)))
  let spent = plan.filter(item => existsSync(recordFile(item))).reduce((total, item) => total + readJson(recordFile(item)).cost, 0)
  if (pending.length < plan.length) console.log(`ux-bench: resuming: ${plan.length - pending.length} done, $${spent.toFixed(2)} spent`)
  let next = 0
  const worker = async () => {
    while (next < pending.length && spent < budget) {
      const index = next++
      const item = pending[index]
      console.log(`ux-bench: [${index + 1}/${pending.length}] start arm ${item.arm} ${item.brief} run ${item.run}`)
      const record = await runOne(item, { timeoutMs, tasks })
      spent += record.cost
      console.log(`ux-bench: [${index + 1}/${pending.length}] ${record.ok ? 'ok' : 'NOT OK'} arm ${item.arm} ${item.brief} run ${item.run}: ${record.seconds}s $${record.cost.toFixed(3)}${record.timedOut ? ' timed out' : ''} (total $${spent.toFixed(2)})${record.routeProblem === null ? '' : ` route: ${record.routeProblem}`}`)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  if (next < pending.length) console.log(`ux-bench: stopped at the $${budget} budget; ${pending.length - next} run(s) left. Rerun with a higher --budget to continue.`)
}

function allRecords() {
  const records = []
  if (!existsSync(RUNS)) return records
  for (const arm of readdirSync(RUNS)) {
    for (const brief of readdirSync(join(RUNS, arm))) {
      for (const number of readdirSync(join(RUNS, arm, brief))) {
        const file = join(RUNS, arm, brief, number, 'record.json')
        if (existsSync(file)) records.push(readJson(file))
      }
    }
  }
  return records
}

/** The newest build scores every arm, so no arm is judged by its own rules. */
async function score() {
  const lib = join(ROOT, 'lib')
  if (!existsSync(join(lib, 'modules/ux/review.js'))) fail('lib/ is missing; run: npm run build')
  const { runRuntimeAudit } = await import(pathToFileURL(join(lib, 'modules/ux/review.js')).href)
  const { audit } = await import(pathToFileURL(join(lib, 'vendor/ceulen/ux/audit.js')).href)
  for (const record of allRecords()) {
    const dir = runDir(record)
    const work = join(dir, 'work')
    if (!record.hasPage) {
      console.log(`ux-bench: ${record.arm} ${record.brief} ${record.run}: no index.html, not scored`)
      continue
    }
    const page = await runRuntimeAudit({ url: pathToFileURL(join(work, 'index.html')).href, cwd: work })
    if (page.inconclusive !== undefined) {
      console.log(`ux-bench: ${record.arm} ${record.brief} ${record.run}: could not render: ${page.inconclusive}`)
      continue
    }
    const shots = join(dir, 'shots')
    mkdirSync(shots, { recursive: true })
    const [mobile, desktop] = [...page.shots].sort((a, b) => a.width - b.width).filter((_, index, all) => index === 0 || index === all.length - 1)
    writeFileSync(join(shots, 'mobile.png'), Buffer.from(mobile.base64, 'base64'))
    writeFileSync(join(shots, 'desktop.png'), Buffer.from(desktop.base64, 'base64'))
    const stylesheet = join(work, 'styles.css')
    const gates = existsSync(stylesheet) ? audit({ css: readFileSync(stylesheet, 'utf8'), pairs: [] }).gates : null
    record.shots = { mobile: mobile.width, desktop: desktop.width }
    record.score = {
      high: page.findings.filter(finding => finding.severity === 'high').length,
      total: page.findings.length,
      checks: page.findings.map(finding => `${finding.severity}:${finding.check}`),
      staticStatus: gates?.status ?? 'no stylesheet',
    }
    writeJson(join(dir, 'record.json'), record)
    console.log(`ux-bench: ${record.arm} ${record.brief} ${record.run}: ${record.score.high} high, ${record.score.total} total, static ${record.score.staticStatus}`)
  }
}

function summary() {
  const records = allRecords()
  if (records.length === 0) fail('no runs yet')
  const table = summaryTable(summarize(records))
  console.log(table)
  const bad = records.filter(record => !record.ok)
  for (const record of bad) console.log(`not ok: ${record.arm} ${record.brief} ${record.run} (exit ${record.exitCode}, timed out ${record.timedOut}, page ${record.hasPage}, route ${record.routeProblem ?? 'ok'})`)
  writeFileSync(join(BENCH, 'summary.md'), `${table}\n`)
}

function review() {
  const pairs = buildPairs(allRecords())
  if (pairs.length === 0) fail('nothing to review; run score first')
  rmSync(REVIEW, { recursive: true, force: true })
  mkdirSync(join(REVIEW, 'img'), { recursive: true })
  const key = {}
  const place = (record, view) => {
    const name = `img/${randomBytes(8).toString('hex')}.png`
    copyFileSync(join(runDir(record), 'shots', `${view}.png`), join(REVIEW, name))
    return name
  }
  // Screenshots stop at the first viewport, so the reviewer also gets the live
  // page: below-the-fold layout and animation are part of what is judged.
  const site = record => {
    const name = `site/${randomBytes(8).toString('hex')}`
    cpSync(join(runDir(record), 'work'), join(REVIEW, name), { recursive: true, filter: keepFile })
    return `${name}/index.html`
  }
  const side = record => ({ desktop: place(record, 'desktop'), mobile: place(record, 'mobile'), page: site(record) })
  const page = pairs.map(pair => {
    key[pair.id] = { brief: pair.brief, left: pair.left.arm, right: pair.right.arm, run: pair.left.run }
    return { id: pair.id, brief: pair.brief, left: side(pair.left), right: side(pair.right) }
  })
  writeFileSync(join(REVIEW, 'index.html'), reviewPage(page))
  // Outside review/, so the page folder holds nothing that names an arm.
  writeJson(join(BENCH, 'review-key.json'), key)
  console.log(`ux-bench: ${page.length} pairs: ${join(REVIEW, 'index.html')}`)
}

function report(options) {
  if (options.picks === undefined) fail('pass --picks <path to picks.json>')
  const key = readJson(join(BENCH, 'review-key.json'))
  if (key === undefined) fail('no review key; run review first')
  const { totals, unanswered } = tallyPicks(key, readJson(resolve(options.picks), {}))
  const lines = ['| Arm | Wins | Losses | Ties |', '|---|---|---|---|']
  for (const [arm, row] of Object.entries(totals).sort()) lines.push(`| ${arm} | ${row.wins} | ${row.losses} | ${row.ties} |`)
  if (unanswered > 0) lines.push('', `${unanswered} pair(s) unanswered.`)
  console.log(lines.join('\n'))
  writeFileSync(join(BENCH, 'picks-report.md'), `${lines.join('\n')}\n`)
}

function clean() {
  if (existsSync(BUILDS)) {
    for (const arm of readdirSync(BUILDS)) git('worktree', 'remove', '--force', join(BUILDS, arm))
  }
  git('worktree', 'prune')
  rmSync(BUILDS, { recursive: true, force: true })
  rmSync(HOMES, { recursive: true, force: true })
  console.log(`ux-bench: removed builds and homes; run output kept in ${RUNS}`)
}

const options = parseArgs(process.argv.slice(2))
const commands = { prepare, run, score, summary, review, report, clean }
const command = commands[options._[0]]
if (command === undefined) fail(`usage: ux-bench.mjs ${Object.keys(commands).join('|')}`)
await command(options)
