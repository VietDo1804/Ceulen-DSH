#!/usr/bin/env node
/**
 * Run the cold steering fixtures (scripts/steer-fixtures/fixtures.mjs) on a
 * real model and say whether steering helps or hurts.
 *
 * Each fixture runs once per loadout — steering on, steering off, steering
 * module unloaded — as a headless one-shot in its own copy of the fixture
 * workspace, under its own DSH home, so nothing touches ~/.dsh, the user's
 * settings or a real memory store. The bundle under test is this checkout
 * (lib/ must be built). The provider row and the credential store are read
 * from an existing profile.
 *
 * This spends real model calls (18 short runs by default). It is a release
 * gate for changes to src/modules/steering, the playbook, steering.cold or the
 * bash redirect, not part of `npm run check`.
 *
 * Usage: node scripts/steer-fixtures.mjs [--route provider/model] [--effort level]
 *          [--configs on,off,unloaded] [--only id,id] [--out dir]
 *          [--source-home dir] [--source-profile name] [--timeout seconds] [--list]
 * Exit: 0 steering on scores at least the best loadout without it · 1 it scores
 *       lower, or a run could not start · 2 bad usage.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIGS, FIXTURES, finalText, settingsFor, toolCalls, verdict } from './steer-fixtures/fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const template = join(root, 'scripts', 'steer-fixtures', 'ws')

function usage(message) {
  console.error(`steer-fixtures: ${message}\nusage: steer-fixtures.mjs [--route provider/model] [--effort level] [--configs on,off,unloaded] [--only id,id] [--out dir] [--source-home dir] [--source-profile name] [--timeout seconds] [--list]`)
  process.exit(2)
}

const options = { route: 'opencode-go/deepseek-v4.1-flash', effort: 'high', configs: CONFIGS, only: undefined, out: undefined, sourceHome: process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), sourceProfile: 'tui', timeout: 300, list: false }
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  const value = () => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) usage(`${token} needs a value`)
    index += 1
    return next
  }
  if (token === '--route') options.route = value()
  else if (token === '--effort') options.effort = value()
  else if (token === '--configs') options.configs = value().split(',').filter(Boolean)
  else if (token === '--only') options.only = value().split(',').filter(Boolean)
  else if (token === '--out') options.out = resolve(value())
  else if (token === '--source-home') options.sourceHome = resolve(value())
  else if (token === '--source-profile') options.sourceProfile = value()
  else if (token === '--timeout') options.timeout = Number(value())
  else if (token === '--list') options.list = true
  else usage(`unknown option: ${token}`)
}
const slash = options.route.indexOf('/')
if (slash <= 0 || slash === options.route.length - 1) usage('--route must be provider/model')
const provider = options.route.slice(0, slash)
const model = options.route.slice(slash + 1)
for (const config of options.configs) if (!CONFIGS.includes(config)) usage(`unknown config "${config}" (${CONFIGS.join(', ')})`)
const fixtures = options.only === undefined ? FIXTURES : FIXTURES.filter(fixture => options.only.includes(fixture.id))
if (fixtures.length === 0) usage(`no fixture matches --only (${FIXTURES.map(fixture => fixture.id).join(', ')})`)
if (!Number.isFinite(options.timeout) || options.timeout <= 0) usage('--timeout must be a positive number of seconds')

if (options.list) {
  for (const fixture of FIXTURES) console.log(`${fixture.id.padEnd(11)} ${fixture.prompt}`)
  process.exit(0)
}

function die(message) {
  console.error(`steer-fixtures: ${message}`)
  process.exit(1)
}

if (!existsSync(join(root, 'lib', 'modules', 'subagent', 'herdr.js'))) die('lib/ is not built; run npm run build first')
const { overlayText } = await import(join(root, 'lib', 'modules', 'subagent', 'herdr.js'))
const profilePatch = join(options.sourceHome, 'profiles', options.sourceProfile, 'cordis.patch.yml')
if (!existsSync(profilePatch)) die(`no provider row to copy: ${profilePatch} does not exist (--source-home, --source-profile)`)

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
// Outside the checkout by default: each loadout's home links the credential store and keeps session logs.
const out = options.out ?? join(tmpdir(), 'ceulen-steer-fixtures', stamp)
mkdirSync(out, { recursive: true })
const overlay = join(out, 'overlay.yml')
writeFileSync(overlay, overlayText(readFileSync(profilePatch, 'utf8'), { provider, model, effort: options.effort }), { mode: 0o600 })

/** One DSH home per loadout: the headless bundles plus this checkout, its own settings, the source credential store. */
function makeHome(config) {
  const home = join(out, `home-${config}`)
  const profile = join(home, 'profiles', 'fixture')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'ceulen'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-fixture', private: true, dependencies: { 'ceulen-dsh': `link:${root}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'ceulen-dsh'] } } }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  symlinkSync(root, join(profile, 'node_modules', 'ceulen-dsh'))
  writeFileSync(join(home, 'ceulen', 'settings.json'), `${JSON.stringify(settingsFor(config, model), null, 2)}\n`)
  const credentials = join(options.sourceHome, '.credentials.yaml')
  if (existsSync(credentials)) symlinkSync(credentials, join(home, '.credentials.yaml'))
  return home
}

function runOne(fixture, config, home) {
  const ws = join(out, 'ws', `${config}-${fixture.id}`)
  cpSync(template, ws, { recursive: true })
  const eventsFile = join(out, `${config}-${fixture.id}.events.jsonl`)
  const env = { ...process.env, DSH_HOME: home, CEULEN_HERDR: 'off' }
  const started = Date.now()
  return new Promise(done => {
    const child = spawn('dsh', ['--profile', 'fixture', '--patch', overlay, '--permission-mode', 'workspace-write', '--approval-policy', 'never', '--json', '-'], { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeout * 1000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      done({ fixture: fixture.id, config, pass: false, why: `could not start dsh: ${error.message}`, broken: true, calls: 0, seconds: 0, tokens: 0, first: '' })
    })
    child.on('close', code => {
      clearTimeout(timer)
      writeFileSync(eventsFile, stdout)
      if (stderr.trim() !== '') writeFileSync(join(out, `${config}-${fixture.id}.stderr.log`), stderr)
      const events = stdout.split('\n').flatMap(line => {
        try {
          return line.trim() === '' ? [] : [JSON.parse(line)]
        } catch {
          return []
        }
      })
      const calls = toolCalls(events)
      const error = events.find(event => event.type === 'error')
      const tokens = events.reduce((sum, event) => sum + (event.type === 'status' ? (event.usage?.inputTokens ?? 0) + (event.usage?.outputTokens ?? 0) : 0), 0)
      const base = { fixture: fixture.id, config, calls: calls.length, seconds: Math.round((Date.now() - started) / 1000), tokens, first: calls[0]?.tool ?? '' }
      // A run that never reached the model says nothing about steering: report it apart from a failed fixture.
      if (timedOut) return done({ ...base, pass: false, why: `timed out after ${options.timeout}s` })
      if (events.length === 0 || (error !== undefined && calls.length === 0 && finalText(events) === '')) {
        return done({ ...base, pass: false, broken: true, why: `run did not start (exit ${code}): ${String(error?.message ?? stderr).trim().split('\n').at(-1)?.slice(0, 200) ?? ''}` })
      }
      let result
      try {
        result = fixture.check({ events, ws, template })
      } catch (thrown) {
        result = { pass: false, why: `check threw: ${thrown instanceof Error ? thrown.message : String(thrown)}` }
      }
      done({ ...base, ...result })
    })
    child.stdin.end(fixture.prompt)
  })
}

console.log(`steer-fixtures: ${fixtures.length} fixture(s) x ${options.configs.length} loadout(s) on ${options.route} (${options.effort}) -> ${out}`)
const homes = Object.fromEntries(options.configs.map(config => [config, makeHome(config)]))
const results = Object.fromEntries(options.configs.map(config => [config, {}]))
const rows = []
for (const fixture of fixtures) {
  // One fixture at a time, its loadouts side by side: they share no workspace and no home.
  const runs = await Promise.all(options.configs.map(config => runOne(fixture, config, homes[config])))
  for (const run of runs) {
    results[run.config][run.fixture] = run
    rows.push(run)
    console.log(`${run.pass ? 'pass' : 'FAIL'}  ${run.fixture.padEnd(11)} ${run.config.padEnd(9)} ${String(run.calls).padStart(2)} call(s) ${String(run.seconds).padStart(3)}s ${String(run.tokens).padStart(6)} tok  first: ${(run.first || '-').padEnd(12)} ${run.pass ? '' : run.why}`)
  }
}

const outcome = verdict(results)
const broken = rows.filter(run => run.broken === true)
writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ route: options.route, effort: options.effort, at: new Date().toISOString(), ...outcome, broken: broken.length, runs: rows }, null, 2)}\n`)
console.log('')
for (const config of options.configs) console.log(`${config.padEnd(9)} ${outcome.scores[config]}/${fixtures.length}`)
if (broken.length > 0) die(`${broken.length} run(s) did not start; the scores above are not a verdict. See ${out}`)
if (!outcome.ok) die(`steering on scores ${outcome.scores.on}/${fixtures.length}, below ${outcome.baseline}/${fixtures.length} without it. See ${out}`)
console.log(`steer-fixtures: steering on is not worse than without it (${out})`)
