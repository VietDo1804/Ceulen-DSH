#!/usr/bin/env node
/**
 * Post-publish smoke: install the package the way a user gets it, into a
 * throwaway directory, and assert the payload. check-pack.mjs looks at what
 * `npm pack` would ship; this looks at what a registry (or a tarball) really
 * delivered, so a wrong `files` list, a stale `lib/` or a version that never
 * landed shows up before anyone else installs it.
 *
 * Every assertion is fatal and the exit code is the verdict:
 *   - npm install's own exit status
 *   - the installed package.json version is the one asked for
 *   - every required path exists (pack-contract.mjs plus --require)
 *   - no forbidden path exists (pack-contract.mjs plus --forbid)
 *   - no file names this machine's home directory
 *
 * Usage: node scripts/smoke-install.mjs <version> [--package <name>] [--tarball <file>]
 *          [--require <path>]... [--forbid <path>]... [--expect-version <v>]
 *          [--no-contract] [--no-private-scan]
 * Exit: 0 installed and every assertion held · 1 a check failed · 2 bad usage.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { REQUIRED, forbiddenReason } from './pack-contract.mjs'

const USAGE = 'usage: smoke-install.mjs <version> [--package name] [--tarball file] [--require p]... [--forbid p]... [--expect-version v] [--no-contract] [--no-private-scan]'

function usage(message) {
  console.error(`smoke-install: ${message}\n${USAGE}`)
  process.exit(2)
}

const options = { package: 'ceulen-dsh', require: [], forbid: [], contract: true, privateScan: true }
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  const value = () => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) usage(`${token} needs a value`)
    index += 1
    return next
  }
  if (token === '--package') options.package = value()
  else if (token === '--tarball') options.tarball = value()
  else if (token === '--require') options.require.push(value())
  else if (token === '--forbid') options.forbid.push(value())
  else if (token === '--expect-version') options.expectVersion = value()
  else if (token === '--no-contract') options.contract = false
  else if (token === '--no-private-scan') options.privateScan = false
  else if (token.startsWith('--')) usage(`unknown option: ${token}`)
  else if (options.version === undefined) options.version = token
  else usage(`unexpected argument: ${token}`)
}
if (options.version === undefined) usage('no version given')
if (options.tarball !== undefined && !existsSync(options.tarball)) usage(`tarball not found: ${options.tarball}`)

const expected = options.expectVersion ?? options.version
const spec = options.tarball !== undefined ? resolve(options.tarball) : `${options.package}@${options.version}`
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const work = mkdtempSync(join(tmpdir(), 'ceulen-smoke-install-'))
const failures = []
const fail = message => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}
const ok = message => console.log(`ok   ${message}`)

/** Every file under `dir`, as forward-slash paths relative to it. */
function walk(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), path))
    else out.push(path)
  }
  return out
}

try {
  writeFileSync(join(work, 'package.json'), '{ "name": "smoke-install", "private": true }\n')
  try {
    // npm's own exit status: execFileSync throws on a non-zero exit, with no pipeline in between.
    execFileSync(npm, ['install', spec, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: work, encoding: 'utf8', stdio: 'pipe' })
    ok(`npm install ${spec}`)
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim().split('\n').slice(-12).join('\n')
    fail(`npm install ${spec} exited ${error.status ?? 'without a status'}\n${detail}`)
  }

  const base = join(work, 'node_modules', ...options.package.split('/'))
  if (failures.length === 0 && !existsSync(join(base, 'package.json'))) fail(`${options.package} is not in node_modules after the install`)

  if (failures.length === 0) {
    const installed = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version
    if (installed === expected) ok(`version ${installed}`)
    else fail(`installed version is ${installed}, expected ${expected}`)

    const files = walk(base)
    const present = new Set(files)
    const has = path => present.has(path) || existsSync(join(base, path))
    const required = [...(options.contract ? REQUIRED : []), ...options.require]
    const missing = required.filter(path => !has(path))
    for (const path of missing) fail(`required path is missing: ${path}`)
    if (missing.length === 0) ok(`${required.length} required path(s) present`)

    if (options.contract) {
      const skills = join(base, 'skills')
      const packs = existsSync(skills) ? readdirSync(skills).filter(entry => statSync(join(skills, entry)).isDirectory()) : []
      const empty = packs.filter(entry => !has(`skills/${entry}/SKILL.md`))
      for (const entry of empty) fail(`skill pack has no SKILL.md: skills/${entry}`)
      if (packs.length === 0) fail('no skill pack in the package')
      else if (empty.length === 0) ok(`${packs.length} skill pack(s)`)
    }

    const banned = []
    for (const path of options.forbid) if (has(path)) banned.push(`${path} (--forbid)`)
    if (options.contract) {
      for (const path of files) {
        const reason = forbiddenReason(path)
        if (reason !== undefined) banned.push(`${path} (${reason})`)
      }
    }
    for (const entry of banned.slice(0, 20)) fail(`forbidden path is present: ${entry}`)
    if (banned.length > 20) fail(`…and ${banned.length - 20} more forbidden path(s)`)
    if (banned.length === 0) ok(`no forbidden path in ${files.length} file(s)`)

    if (options.privateScan) {
      const home = homedir()
      const leaks = home.length < 4 ? [] : files.filter(path => {
        const file = join(base, path)
        return statSync(file).size <= 4 * 1024 * 1024 && readFileSync(file).includes(home)
      })
      for (const path of leaks.slice(0, 20)) fail(`file names this machine's home directory (${home}): ${path}`)
      if (leaks.length === 0) ok('no file names the home directory')
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`smoke-install: ${failures.length} check(s) failed for ${spec}`)
  process.exit(1)
}
console.log(`smoke-install: ${spec} — ok`)
