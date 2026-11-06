#!/usr/bin/env node
/**
 * Bundle contract check:
 *
 * 1. every cordis.patch.yml row resolves to a built module that exports `apply`;
 * 2. the parity ledger agrees with the rows;
 * 3. the counts and version pins quoted in README.md, release/README.md,
 *    docs/parity.md and parity.json agree with the repo itself.
 *
 * Zero dependencies; runs in CI after `npm run build`.
 */
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`check-bundle: ${message}`)
  process.exitCode = 1
}

function parseRows(text) {
  const rows = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const id = /^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/.exec(line)
    if (id !== null) {
      if (current !== undefined) rows.push(current)
      current = { id: id[1] }
      continue
    }
    const name = /^\s*name:\s*['"]([^'"]+)['"]\s*$/.exec(line)
    if (name !== null && current !== undefined && current.name === undefined) current.name = name[1]
  }
  if (current !== undefined) rows.push(current)
  return rows
}

const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
const rows = parseRows(patch)
if (rows.length === 0) fail('cordis.patch.yml contains no rows')

const seen = new Set()
for (const row of rows) {
  if (row.name === undefined) {
    fail(`row ${row.id} has no name`)
    continue
  }
  if (seen.has(row.id)) fail(`duplicate row id ${row.id}`)
  seen.add(row.id)
  const match = /^ceulen-dsh\/modules\/([a-z0-9_-]+)$/.exec(row.name)
  if (match === null) {
    fail(`row ${row.id} does not point at ceulen-dsh/modules/*: ${row.name}`)
    continue
  }
  const entry = join(root, 'lib', 'modules', match[1], 'index.js')
  if (!existsSync(entry)) {
    fail(`row ${row.id} is built from a missing entry: ${entry}`)
    continue
  }
  const module = await import(pathToFileURL(entry).href)
  if (typeof module.apply !== 'function') fail(`${row.name} does not export apply()`)
}

const parity = JSON.parse(await readFile(join(root, 'parity.json'), 'utf8'))
for (const module of parity.modules) {
  if (module.rowId !== undefined && !seen.has(module.rowId)) {
    fail(`parity module ${module.name} names missing row ${module.rowId}`)
  }
  if (module.rowId === undefined && ['port', 'config', 'partial'].includes(module.status) && module.phase > 0) {
    // Planned modules are allowed to have no row yet, but the status document
    // must stay honest: only modules at or below the implemented phase may claim
    // they are mounted. This check catches a rowId removed by accident.
  }
}
const rowIds = new Set(rows.map(row => row.id))
for (const id of rowIds) {
  const owner = parity.modules.find(module => module.rowId === id)
  if (owner === undefined) fail(`row ${id} has no parity owner`)
}

// --- doc/version consistency (plan 0.4) ------------------------------------
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(root, 'upstream.lock.json'), 'utf8'))
const vendor = JSON.parse(await readFile(join(root, 'vendor.manifest.json'), 'utf8'))
const readme = await readFile(join(root, 'README.md'), 'utf8')
const releaseReadme = await readFile(join(root, 'release', 'README.md'), 'utf8')
const install = await readFile(join(root, 'release', 'install.sh'), 'utf8')
const parityDoc = await readFile(join(root, 'docs', 'parity.md'), 'utf8')
const liveVerification = await readFile(join(root, 'docs', 'live-verification.md'), 'utf8')
const skillsSource = await readFile(join(root, 'src', 'modules', 'skills', 'index.ts'), 'utf8')

/** Compare one regex's capture groups against the expected values. */
function expect(source, label, text, pattern, ...expected) {
  const match = pattern.exec(text)
  if (match === null) {
    fail(`${label}: no anchor found in ${source}`)
    return
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (String(match[index + 1]) !== String(expected[index])) {
      fail(`${label}: ${source} says "${match[index + 1]}", repo says "${expected[index]}"`)
      return
    }
  }
}

const skillPacks = (await readdir(join(root, 'skills'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md'))).length
const ceulenSkills = (vendor.files ?? []).filter(file => String(file.target).startsWith('skills/')).length
const themes = (await readFile(join(root, 'src', 'themes', 'generated.ts'), 'utf8')).match(/"name": "ceulen-/g)?.length ?? 0
const skillsModule = parity.modules.find(module => module.name === 'skills')

if (lock.upstream?.version !== parity.upstream?.version) {
  fail(`upstream version drift: upstream.lock.json ${lock.upstream?.version}, parity.json ${parity.upstream?.version}`)
}
if (lock.upstream?.repo !== parity.upstream?.repo) {
  fail(`upstream repo drift: upstream.lock.json ${lock.upstream?.repo}, parity.json ${parity.upstream?.repo}`)
}

// Version pins have one home: package.json (engines.dsh, dshTui, version).
expect('README.md', 'README dsh pin', readme, /^- DSH `([^`]+)`/m, pkg.engines?.dsh)
expect('README.md', 'README dsh-tui pin', readme, /`dsh-tui` ([0-9][0-9.]*) profile/, pkg.dshTui)
expect('README.md', 'README bundle version', readme, /`ceulen-dsh ([0-9][^` ]*) \(/, pkg.version)
expect('README.md', 'README upstream pin', readme, /`upstream\.lock\.json` \(`([^`]+)`\)/, lock.upstream?.version)
expect('release/README.md', 'release README dsh pin', releaseReadme, /^\| DSH CLI \| `([^`]+)`/m, pkg.engines?.dsh)
expect('release/README.md', 'release README dsh-tui pin', releaseReadme, /dsh-tui@([0-9][0-9.]*)/, pkg.dshTui)
// The live-verification header is a claim about what was last verified, so an
// upgrade that leaves it stale fails here instead of misleading the next reader.
expect(
  'docs/live-verification.md',
  'live verification pins',
  liveVerification,
  /^Date: \d{4}-\d\d-\d\d, DSH `([^`]+)`, TUI `([^`]+)`\.$/m,
  pkg.engines?.dsh,
  pkg.dshTui,
)
if (/@deepseek-ai\/dsh@[0-9]|dsh-tui@[0-9]/.test(install)) {
  fail('release/install.sh hardcodes a version pin; read package.json (engines.dsh, dshTui)')
}
expect('src/modules/skills/index.ts', 'skills upstream version', skillsSource, /upstreamVersion: '([^']+)'/, lock.upstream?.version)

// Counts are derived, never typed twice.
expect('README.md', 'README rows', readme, /The bundle composes\s+(\d+) rows/, rows.length)
expect('README.md', 'README skills', readme, /all (\d+) bundled skill packs registered \((\d+) ported from Ceulen\)/, skillPacks, ceulenSkills)
expect('README.md', 'README themes', readme, /(\d+) Ceulen Pi themes/, themes)
expect('release/README.md', 'release README rows', releaseReadme, /\((\d+) composed rows\)/, rows.length)
expect('release/README.md', 'release README skills', releaseReadme, /`skills\/`\s*\((\d+) skill packs\)/, skillPacks)
expect('release/README.md', 'release README themes', releaseReadme, /\+ (\d+) themes/, themes)
if (skillsModule === undefined) fail('parity.json has no skills module')
else expect('parity.json', 'parity skills', skillsModule.dsh ?? '', /(\d+) Ceulen-origin skills/, ceulenSkills)
expect('docs/parity.md', 'parity totals', parityDoc, /Totals: (\d+) modules, (\d+) mounted/, parity.modules.length, rows.length)

if (process.exitCode === undefined) {
  console.log(
    `check-bundle: ${rows.length} row(s), ${parity.modules.length} parity modules, ${skillPacks} skill packs (${ceulenSkills} Ceulen), ${themes} themes — ok`,
  )
}
