#!/usr/bin/env node
/**
 * Rebuild skills/herdr/SKILL.md from the installed herdr binary.
 *
 *   node scripts/herdr-skill-sync.mjs           rewrite the upstream part, keep the ceulen note + addendum
 *   node scripts/herdr-skill-sync.mjs --check   exit 1 when the bundled copy drifted from `herdr --skill`
 *
 * `herdr --skill` is the source of truth for the CLI syntax; the ceulen-owned
 * blocks (the note after the frontmatter, the DSH addendum at the end) carry
 * what that text does not know about DSH. Requires a built lib/ (npm run build).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { bundledSkillPath, ceulenParts, composeSkill, upstreamPart } from '../lib/core/herdr.js'

function main(argv) {
  const bin = process.env.HERDR_BIN_PATH?.trim() || 'herdr'
  let live
  try {
    live = execFileSync(bin, ['--skill'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch (error) {
    console.error(`herdr --skill failed: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const file = bundledSkillPath()
  const current = readFileSync(file, 'utf8')
  const inSync = upstreamPart(current) === live
  if (argv.includes('--check')) {
    console.log(inSync ? 'herdr skill: in sync' : 'herdr skill: drift (run node scripts/herdr-skill-sync.mjs)')
    return inSync ? 0 : 1
  }
  const { note, addendum } = ceulenParts(current)
  if (addendum === '') {
    console.error(`${file} has no ceulen addendum marker; refusing to drop the DSH addendum`)
    return 2
  }
  const next = composeSkill(live, note, addendum)
  if (next === current) {
    console.log('herdr skill: already in sync')
    return 0
  }
  writeFileSync(file, next)
  console.log(`herdr skill: ${inSync ? 'reformatted' : 'updated from herdr --skill'} (${file})`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
