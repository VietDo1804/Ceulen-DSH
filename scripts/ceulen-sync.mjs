#!/usr/bin/env node
/**
 * ceulen-sync — keep ceulen-dsh aligned with upstream Ceulen.
 *
 * Commands:
 *   check        compare the pinned upstream version with npm (exit 10 if behind)
 *   report       download the target tarball and write a port/upgrade report
 *   apply-vendor copy safely upgradable vendored files and update the lock
 *   vendor       copy vendor.manifest.json entries from a local Ceulen checkout
 *   parity       regenerate/check docs/parity.md from parity.json
 *   bump         move the bundle version to the target upstream base
 *
 * Safety: this script downloads and hashes upstream files. It never runs
 * upstream code, installs upstream dependencies, or edits adapter modules.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.log(`ceulen-sync <check|report|apply-vendor|vendor|parity|bump> [options]

Options:
  --version <v>     target upstream version (default: npm latest)
  --offline         use cached metadata/extraction only
  --json            machine-readable output
  --from <dir>      local Ceulen checkout/package root (vendor)
  --tarball <file>  use a local tarball instead of downloading
  --update-lock     update the pinned upstream version in upstream.lock.json
  --check           (parity) fail when docs/parity.md is stale
  --dry-run         show what apply-vendor would copy
`)
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        index += 1
      } else {
        options[key] = true
      }
    } else {
      options._.push(token)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const command = options._[0] ?? 'check'
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const cacheDir = resolve(options.cache ?? join(home, 'cache', 'ceulen'))
const lockPath = join(root, 'upstream.lock.json')
const parityPath = join(root, 'parity.json')
const manifestPath = join(root, 'vendor.manifest.json')
const docsPath = join(root, 'docs', 'parity.md')

const DEFAULT_REPO = 'ceulen-dev/ceulen'
const DEFAULT_PACKAGE = 'ceulen'

function log(message) {
  if (options.json !== true) console.log(message)
}

function fail(message, code = 1) {
  console.error(`ceulen-sync: ${message}`)
  process.exit(code)
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

function sha(text) {
  return createHash('sha256').update(normalize(text)).digest('hex')
}

function compareVersions(a, b) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim())
    if (match === null) return undefined
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === undefined || right === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1
    } else if (ln) return -1
    else if (rn) return 1
    else if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'ceulen-dsh-sync/1' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return await response.json()
}

async function npmMeta(version) {
  const url = version === undefined
    ? `https://registry.npmjs.org/${DEFAULT_PACKAGE}/latest`
    : `https://registry.npmjs.org/${DEFAULT_PACKAGE}/${version}`
  const payload = await fetchJson(url)
  const resolved = payload.version
  if (typeof resolved !== 'string') throw new Error('npm registry returned no version')
  return {
    version: resolved,
    tarball: payload.dist?.tarball ?? `https://registry.npmjs.org/${DEFAULT_PACKAGE}/-/${DEFAULT_PACKAGE}-${resolved}.tgz`,
    gitHead: payload.gitHead,
  }
}

function tarballPath(version) {
  return join(cacheDir, `${DEFAULT_PACKAGE}-${version}.tgz`)
}

function extractPath(version) {
  return join(cacheDir, 'extract', `${DEFAULT_PACKAGE}-${version}`)
}

async function ensureTarball(meta) {
  if (meta.local === true && existsSync(meta.tarball)) return meta.tarball
  const target = tarballPath(meta.version)
  if (existsSync(target)) return target
  if (options.offline === true) throw new Error(`offline: ${target} is not cached`)
  await mkdir(cacheDir, { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  const response = await fetch(meta.tarball, {
    headers: { 'user-agent': 'ceulen-dsh-sync/1' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`tarball download returned HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  await writeFile(temporary, bytes)
  await rename(temporary, target)
  return target
}

async function ensureExtracted(meta) {
  const packageRoot = join(extractPath(meta.version), 'package')
  if (existsSync(join(packageRoot, 'package.json'))) return packageRoot
  if (options.offline === true) throw new Error(`offline: ${packageRoot} is not extracted`)
  const tarball = await ensureTarball(meta)
  const destination = extractPath(meta.version)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await execFileAsync('tar', ['-xzf', tarball, '-C', destination], { timeout: 60_000 })
  if (!existsSync(join(packageRoot, 'package.json'))) throw new Error('tarball did not contain package/')
  return packageRoot
}

async function walk(directory) {
  const out = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

async function upstreamManifest(packageRoot) {
  const files = new Map()
  const prefixes = ['extensions/modules', 'extensions/lib', 'skills', 'themes']
  for (const prefix of prefixes) {
    for (const path of await walk(join(packageRoot, prefix))) {
      if (!/\.(ts|json|md)$/.test(path)) continue
      const relativePath = relative(packageRoot, path)
      files.set(relativePath, await readFile(path, 'utf8'))
    }
  }
  const moduleRoots = []
  try {
    for (const entry of await readdir(join(packageRoot, 'extensions', 'modules'), { withFileTypes: true })) {
      if (entry.isDirectory()) moduleRoots.push(entry.name)
    }
  } catch {
    // A malformed tarball is reported by the caller.
  }
  return { files, modules: moduleRoots.sort() }
}

async function loadLock() {
  return await loadJson(lockPath, { schemaVersion: 1, upstream: {}, vendored: {}, data: { skills: {}, themes: {} } })
}

async function loadParity() {
  return await loadJson(parityPath, { schemaVersion: 1, upstream: {}, modules: [] })
}

async function loadVendorManifest() {
  return await loadJson(manifestPath, { schemaVersion: 1, files: [] })
}

async function targetMeta() {
  if (typeof options.tarball === 'string') {
    if (!existsSync(options.tarball)) fail(`tarball not found: ${options.tarball}`)
    const version = typeof options.version === 'string' ? options.version : '0.0.0-local'
    return { version, tarball: resolve(options.tarball), gitHead: undefined, local: true }
  }
  return await npmMeta(typeof options.version === 'string' ? options.version : undefined)
}

async function cmdCheck() {
  const lock = await loadLock()
  const pinned = lock.upstream?.version ?? '0.0.0'
  if (options.offline === true) {
    const result = { pinned, latest: pinned, behind: false, offline: true }
    if (options.json === true) console.log(JSON.stringify(result, null, 2))
    else log(`pinned ${pinned} (offline check)`)
    return 0
  }
  let meta
  try {
    meta = await targetMeta()
  } catch (error) {
    if (options.json === true) console.log(JSON.stringify({ pinned, latest: null, behind: false, error: error.message }, null, 2))
    else log(`upstream check failed: ${error.message}`)
    return 0
  }
  const behind = compareVersions(meta.version, pinned) > 0
  const result = { pinned, latest: meta.version, behind, tarball: meta.tarball, gitHead: meta.gitHead }
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    log(`pinned ${pinned} · latest ${meta.version} · ${behind ? 'UPDATE AVAILABLE' : 'up to date'}`)
    if (behind) log(`run: node scripts/ceulen-sync.mjs report --version ${meta.version}`)
  }
  return behind ? 10 : 0
}

function classifyEntry(file, locked, localText, upstreamText) {
  const localSha = localText === undefined ? undefined : sha(localText)
  const upstreamSha = upstreamText === undefined ? undefined : sha(upstreamText)
  const lockedLocal = locked.localSha256
  const lockedUpstream = locked.upstreamSha256
  const patched = file.mode !== undefined && file.mode !== 'copy'
  if (upstreamSha === lockedUpstream && localSha === lockedLocal) return 'unchanged'
  if (upstreamSha === undefined) return localSha === lockedLocal ? 'remove-safe' : 'removed-conflict'
  if (localText === undefined) return 'missing-local'
  // A patched file keeps local edits: an upstream change is always a manual
  // merge, never an automatic overwrite.
  if (patched) {
    if (upstreamSha === lockedUpstream) return 'local-only'
    return 'conflict'
  }
  if (localSha === lockedLocal) return 'safe'
  if (upstreamSha === lockedUpstream) return 'local-only'
  return 'conflict'
}

async function analyze(target) {
  const meta = target
  const packageRoot = await ensureExtracted(meta)
  const upstream = await upstreamManifest(packageRoot)
  const vendor = await loadVendorManifest()
  const lock = await loadLock()
  const parity = await loadParity()

  const entries = []
  for (const file of vendor.files ?? []) {
    const upstreamText = upstream.files.get(file.source)
    let localText
    try {
      localText = await readFile(join(root, file.target), 'utf8')
    } catch {
      localText = undefined
    }
    const locked = lock.vendored?.[file.target] ?? {}
    entries.push({
      ...file,
      status: classifyEntry(file, locked, localText, upstreamText),
      localSha256: localText === undefined ? undefined : sha(localText),
      upstreamSha256: upstreamText === undefined ? undefined : sha(upstreamText),
    })
  }

  const classified = new Set(parity.modules.map(module => module.name))
  // Modules that live in parity.json but have no upstream counterpart, so the
  // "missing from the target" banner must not name them. `context` and `evo` are
  // DSH-only (parity status native); `codemode`/`skills`/`themes`/`upstream` are
  // renamed or bundle-owned. A new DSH-only module belongs here too.
  const extras = new Set(['themes', 'skills', 'upstream', 'codemode', 'context', 'evo'])
  const newModules = upstream.modules.filter(name => !classified.has(name))
  const removedModules = parity.modules
    .map(module => module.name)
    .filter(name => !extras.has(name) && !upstream.modules.includes(name) && upstream.modules.length > 0)

  const upstreamFiles = [...upstream.files.keys()]
  const knownSources = new Set((vendor.files ?? []).map(file => file.source))
  const targetDiffers = compareVersions(meta.version, parity.upstream?.version ?? '0.0.0') !== 0
  const newVendorCandidates = targetDiffers
    ? upstreamFiles.filter(path => path.startsWith('extensions/modules/') && !knownSources.has(path))
    : []

  return { meta, upstream, entries, newModules, removedModules, newVendorCandidates, vendor, lock, parity }
}

function summarizeAnalysis(analysis) {
  const counts = { safe: 0, conflict: 0, unchanged: 0, other: 0 }
  for (const entry of analysis.entries) {
    if (entry.status === 'safe') counts.safe += 1
    else if (entry.status === 'conflict') counts.conflict += 1
    else if (entry.status === 'unchanged') counts.unchanged += 1
    else counts.other += 1
  }
  return counts
}

function reportMarkdown(analysis) {
  const { meta, entries, newModules, removedModules, newVendorCandidates, parity } = analysis
  const counts = summarizeAnalysis(analysis)
  const lines = []
  lines.push(`# Ceulen upstream report — ${meta.version}`)
  lines.push('')
  lines.push(`- generated: ${new Date().toISOString()}`)
  lines.push(`- pinned: ${parity.upstream?.version ?? 'unknown'}`)
  lines.push(`- target: ${meta.version}${meta.gitHead === undefined ? '' : ` (${meta.gitHead.slice(0, 12)})`}`)
  lines.push(`- tarball: ${meta.tarball}`)
  lines.push(`- vendored files: ${entries.length} (safe ${counts.safe}, conflict ${counts.conflict}, unchanged ${counts.unchanged}, other ${counts.other})`)
  lines.push('')
  if (newModules.length > 0) {
    lines.push('## New upstream modules')
    lines.push('')
    for (const name of newModules) lines.push(`- \`${name}\` — classify it in parity.json and add a DSH adapter.`)
    lines.push('')
  }
  if (removedModules.length > 0) {
    lines.push('## Modules missing from the target')
    lines.push('')
    for (const name of removedModules) lines.push(`- \`${name}\` — retired or renamed upstream; update parity.json and the row.`)
    lines.push('')
  }
  const changed = entries.filter(entry => entry.status !== 'unchanged')
  if (changed.length > 0) {
    lines.push('## Vendored files')
    lines.push('')
    lines.push('| file | upstream source | status | action |')
    lines.push('|---|---|---|---|')
    for (const entry of changed) {
      const action = entry.status === 'safe'
        ? 'apply-vendor'
        : entry.status === 'conflict'
          ? 'manual merge required'
          : entry.status === 'local-only'
            ? 'upstream unchanged'
            : entry.status
      lines.push(`| \`${entry.target}\` | \`${entry.source}\` | ${entry.status} | ${action} |`)
    }
    lines.push('')
  }
  if (newVendorCandidates.length > 0) {
    lines.push('## Upstream module files not yet vendored')
    lines.push('')
    lines.push('These are candidates, not automatic copies. Port the ones the DSH bundle needs and add them to `vendor.manifest.json`.')
    lines.push('')
    const byModule = new Map()
    for (const path of newVendorCandidates) {
      const module = path.split('/')[2] ?? 'unknown'
      const list = byModule.get(module) ?? []
      list.push(path)
      byModule.set(module, list)
    }
    for (const [module, paths] of [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sample = paths.slice(0, 4).map(path => `\`${path.split('/').slice(3).join('/')}\``).join(', ')
      lines.push(`- **${module}** (${paths.length} files): ${sample}${paths.length > 4 ? ', …' : ''}`)
    }
    lines.push('')
  }
  lines.push('## Upgrade checklist')
  lines.push('')
  lines.push('1. Review this report and the upstream CHANGELOG.')
  lines.push('2. `node scripts/ceulen-sync.mjs apply-vendor` for safe copies.')
  lines.push('3. Merge conflicts by hand; keep the DSH adapter contract (no runtime harness imports).')
  lines.push('4. Update `parity.json`, run `node scripts/ceulen-sync.mjs parity`.')
  lines.push('5. Run `npm run check` and the TUI smoke checklist.')
  lines.push(`6. \`node scripts/ceulen-sync.mjs bump --version ${meta.version}\`.`)
  lines.push('')
  return lines.join('\n')
}

async function writeReport(analysis) {
  const dir = join(root, 'docs', 'upstream')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `ceulen-${analysis.meta.version}.md`)
  await writeFile(path, reportMarkdown(analysis), 'utf8')
  return path
}

async function cmdReport() {
  const meta = await targetMeta()
  const analysis = await analyze(meta)
  const path = await writeReport(analysis)
  const counts = summarizeAnalysis(analysis)
  if (options.json === true) {
    console.log(JSON.stringify({
      target: meta.version,
      report: relative(root, path),
      safe: counts.safe,
      conflict: counts.conflict,
      unchanged: counts.unchanged,
      newModules: analysis.newModules,
      files: analysis.entries.map(entry => ({ target: entry.target, status: entry.status, local: entry.localSha256, upstream: entry.upstreamSha256 })),
    }, null, 2))
  } else {
    log(`report: ${relative(root, path)}`)
    log(`target ${meta.version} · safe ${counts.safe} · conflicts ${counts.conflict} · new modules ${analysis.newModules.length}`)
    if (analysis.newModules.length > 0) log(`new modules: ${analysis.newModules.join(', ')}`)
  }
  if (options['update-lock'] === true) {
    const lock = await loadLock()
    lock.upstream = {
      ...(lock.upstream ?? {}),
      version: meta.version,
      tarball: meta.tarball,
      ...(meta.gitHead === undefined ? {} : { commit: meta.gitHead }),
      syncedAt: new Date().toISOString(),
    }
    await saveJson(lockPath, lock)
    log(`pinned upstream version updated to ${meta.version}`)
  }
  return 0
}

async function cmdApplyVendor() {
  const meta = await targetMeta()
  const analysis = await analyze(meta)
  const lock = analysis.lock
  const dry = options['dry-run'] === true
  let copied = 0
  const conflicts = []
  for (const entry of analysis.entries) {
    if (entry.status === 'safe') {
      if (!dry) {
        const packageRoot = await ensureExtracted(meta)
        await mkdir(dirname(join(root, entry.target)), { recursive: true })
        await cp(join(packageRoot, entry.source), join(root, entry.target))
        lock.vendored = lock.vendored ?? {}
        lock.vendored[entry.target] = {
          source: entry.source,
          upstreamSha256: entry.upstreamSha256,
          localSha256: entry.upstreamSha256,
          mode: entry.mode ?? 'copy',
        }
      }
      copied += 1
      log(`${dry ? 'would copy' : 'copied'} ${entry.target}`)
    } else if (entry.status === 'conflict' || entry.status === 'removed-conflict') {
      conflicts.push(entry)
      log(`conflict: ${entry.target} (${entry.status}) — merge by hand`)
    }
  }
  if (!dry) {
    lock.upstream = {
      ...(lock.upstream ?? {}),
      version: meta.version,
      tarball: meta.tarball,
      ...(meta.gitHead === undefined ? {} : { commit: meta.gitHead }),
      syncedAt: new Date().toISOString(),
    }
    await saveJson(lockPath, lock)
    await writeReport(analysis)
  }
  log(`apply-vendor: ${copied} file(s) ${dry ? 'would be ' : ''}updated, ${conflicts.length} conflict(s)`)
  return conflicts.length > 0 ? 2 : 0
}

async function cmdVendor() {
  const from = resolve(options.from ?? join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'ceulen'))
  if (!existsSync(join(from, 'package.json'))) fail(`not a Ceulen package root: ${from}`)
  const vendor = await loadVendorManifest()
  const lock = await loadLock()
  let copied = 0
  for (const file of vendor.files ?? []) {
    const source = join(from, file.source)
    if (!existsSync(source)) {
      log(`missing upstream file: ${file.source}`)
      continue
    }
    const target = join(root, file.target)
    const patched = file.mode !== undefined && file.mode !== 'copy'
    const targetExists = existsSync(target)
    // A patched target is never overwritten by `vendor`; it is only seeded when
    // missing. `apply-vendor` also refuses to auto-copy patched files.
    if (!patched || !targetExists) {
      await mkdir(dirname(target), { recursive: true })
      await cp(source, target)
    }
    const text = await readFile(source, 'utf8')
    const localText = await readFile(target, 'utf8')
    lock.vendored = lock.vendored ?? {}
    lock.vendored[file.target] = {
      source: file.source,
      upstreamSha256: sha(text),
      localSha256: sha(localText),
      mode: file.mode ?? 'copy',
    }
    copied += 1
  }
  await saveJson(lockPath, lock)
  log(`vendor: copied ${copied} file(s) from ${from}`)
  return 0
}

function parityMarkdown(parity) {
  const lines = []
  lines.push('# Ceulen → DeepSeek Harness parity')
  lines.push('')
  lines.push('<!-- Generated by scripts/ceulen-sync.mjs parity. Do not edit by hand. -->')
  lines.push('')
  lines.push(`Upstream: [${parity.upstream?.repo ?? DEFAULT_REPO}](https://github.com/${parity.upstream?.repo ?? DEFAULT_REPO}) \`${parity.upstream?.version ?? 'unknown'}\``)
  lines.push('')
  lines.push('Statuses: **ported** = code ported; **native config** = mapped to a DSH provider/settings surface; **partial** = core behavior with a documented gap; **native DSH** = already provided by Harness; **n/a** = not applicable; **deferred** = intentionally not in this release.')
  lines.push('')
  lines.push('| Module | Category | Status | DSH surface | Phase | Notes |')
  lines.push('|---|---|---|---|---|---|')
  for (const module of parity.modules ?? []) {
    const status = {
      port: 'ported',
      config: 'native config',
      partial: 'partial',
      native: 'native DSH',
      na: 'n/a',
      deferred: 'deferred',
    }[module.status] ?? module.status
    lines.push(`| \`${module.name}\` | ${module.category} | ${status} | ${String(module.dsh ?? '').replace(/\|/g, '\\|')} | ${module.phase} | ${String(module.notes ?? '').replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  const counts = (parity.modules ?? []).reduce((acc, module) => {
    acc.total += 1
    if (module.rowId !== undefined) acc.mounted += 1
    acc[module.status] = (acc[module.status] ?? 0) + 1
    return acc
  }, { total: 0, mounted: 0 })
  lines.push(`Totals: ${counts.total} modules, ${counts.mounted} mounted.`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Plan 5.4: `parity --check` also guards the vendored tree. A file copied from
 * upstream without `mode: patched` must still hash the way the lock recorded
 * it; otherwise a local edit silently rides along until the next sync. No
 * network is involved, so CI can run it offline.
 */
async function vendoredDrift() {
  const manifest = await loadJson(manifestPath, { files: [] })
  const lock = await loadLock()
  const drifted = []
  for (const file of manifest.files ?? []) {
    if (file.mode !== undefined && file.mode !== 'copy') continue
    const locked = lock.vendored?.[file.target]?.localSha256
    if (locked === undefined) continue
    let text
    try {
      text = await readFile(join(root, file.target), 'utf8')
    } catch {
      drifted.push(`${file.target} (missing)`)
      continue
    }
    if (sha(text) !== locked) drifted.push(file.target)
  }
  return drifted
}

async function cmdParity() {
  const parity = await loadParity()
  const expected = parityMarkdown(parity)
  if (options.check === true) {
    let current
    try {
      current = await readFile(docsPath, 'utf8')
    } catch {
      fail('docs/parity.md is missing; run node scripts/ceulen-sync.mjs parity')
    }
    if (current !== expected) fail('docs/parity.md is stale; run node scripts/ceulen-sync.mjs parity')
    const drifted = await vendoredDrift()
    if (drifted.length > 0) {
      fail(
        `vendored file(s) edited without a manifest mode: ${drifted.join(', ')}. `
        + 'A `copy` file must stay byte-identical to upstream; set "mode": "patched" in vendor.manifest.json '
        + 'and add a line to docs/upstream-sync.md saying why.',
      )
    }
    if (options.json === true) console.log(JSON.stringify({ ok: true, modules: parity.modules.length }, null, 2))
    else log(`parity: ${parity.modules.length} modules, docs up to date, vendored hashes match`)
    return 0
  }
  await mkdir(dirname(docsPath), { recursive: true })
  await writeFile(docsPath, expected, 'utf8')
  log(`parity: wrote ${relative(root, docsPath)} (${parity.modules.length} modules)`)
  return 0
}

async function cmdBump() {
  const lock = await loadLock()
  const base = typeof options.version === 'string' ? options.version : lock.upstream?.version
  if (typeof base !== 'string' || base.length === 0) fail('no target version; pass --version')
  const manifest = await loadJson(join(root, 'package.json'), {})
  const current = String(manifest.version ?? '0.0.0')
  const prefix = `${base}-dsh.`
  let revision = 1
  if (current.startsWith(prefix)) {
    const parsed = Number(current.slice(prefix.length))
    if (Number.isInteger(parsed) && parsed > 0) revision = parsed + 1
  }
  manifest.version = `${prefix}${revision}`
  await saveJson(join(root, 'package.json'), manifest)
  lock.upstream = { ...(lock.upstream ?? {}), version: base }
  await saveJson(lockPath, lock)
  log(`version: ${current} -> ${manifest.version}`)
  return 0
}

async function main() {
  if (command === 'help' || options.help === true) {
    usage()
    return 0
  }
  if (command === 'check') return await cmdCheck()
  if (command === 'report') return await cmdReport()
  if (command === 'apply-vendor') return await cmdApplyVendor()
  if (command === 'vendor') return await cmdVendor()
  if (command === 'parity') return await cmdParity()
  if (command === 'bump') return await cmdBump()
  usage()
  return 2
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`ceulen-sync: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
