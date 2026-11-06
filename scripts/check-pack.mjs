#!/usr/bin/env node
/**
 * Pack contract check (plan 5.3): the tarball actually published must carry the
 * built modules, every skill pack, the compiled themes and the bundle patch.
 * Runs `npm pack --dry-run --json`, which writes no tarball.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function fail(message) {
  console.error(`check-pack: ${message}`)
  process.exitCode = 1
}

const output = execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
// npm <= 11 prints an array of reports, npm 12 prints one object keyed by name.
const parsed = JSON.parse(output)
const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
const files = new Set(report.files.map(file => file.path))

const required = [
  'package.json',
  'cordis.patch.yml',
  'parity.json',
  'upstream.lock.json',
  'vendor.manifest.json',
  'lib/index.js',
  'lib/modules/skills/index.js',
  'lib/modules/web/index.js',
  'lib/themes/generated.js',
]
for (const path of required) {
  if (!files.has(path)) fail(`missing from the tarball: ${path}`)
}

for (const entry of readdirSync(join(root, 'skills'))) {
  const skill = join(root, 'skills', entry)
  if (!statSync(skill).isDirectory()) continue
  if (!files.has(`skills/${entry}/SKILL.md`)) fail(`missing skill pack: skills/${entry}/SKILL.md`)
}

for (const path of files) {
  if (path.startsWith('src/') || path.startsWith('test/') || path.startsWith('release/') || path.startsWith('node_modules/')) {
    fail(`tarball must not carry ${path}`)
  }
}

if (process.exitCode === undefined) {
  console.log(`check-pack: ${files.size} file(s) in the tarball — ok`)
}
