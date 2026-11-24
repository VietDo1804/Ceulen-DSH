#!/usr/bin/env node
/**
 * Print one part of a spilled tool output.
 *
 * codemode keeps the head and tail of an oversized result and writes the whole
 * text to a file. Reading that file back is where a model loops: `read` caps
 * long lines (a JSON result is one line), `cat` returns everything over the
 * budget again, and a byte cut (`head -c`) splits multi-byte characters. The
 * cut notice names this command instead. Parts are counted in characters,
 * never split a surrogate pair, and are sized from the budget that was active,
 * so each one fits.
 *
 * Usage: node scripts/spill-page.mjs <file> <part> [chars-per-part]
 * Exit: 0 printed · 1 no such part, or the file cannot be read · 2 bad usage.
 */
import { readFileSync } from 'node:fs'

const DEFAULT_CHARS = 2400

function usage(message) {
  console.error(`spill-page: ${message}\nusage: spill-page.mjs <file> <part> [chars-per-part]`)
  process.exit(2)
}

/** `index`, moved back by one when it would fall between the two halves of a surrogate pair. */
function safeCut(text, index) {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? index - 1 : index
}

function shellArg(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

const [file, partArg, charsArg, ...rest] = process.argv.slice(2)
if (file === undefined || partArg === undefined || rest.length > 0) usage('expected a file and a part number')
if (!/^[1-9]\d*$/.test(partArg)) usage(`part must be a positive integer, got "${partArg}"`)
if (charsArg !== undefined && !/^[1-9]\d*$/.test(charsArg)) usage(`chars-per-part must be a positive integer, got "${charsArg}"`)
const part = Number(partArg)
const chars = charsArg === undefined ? DEFAULT_CHARS : Number(charsArg)

let text
try {
  text = readFileSync(file, 'utf8')
} catch (error) {
  console.error(`spill-page: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const parts = Math.max(1, Math.ceil(text.length / chars))
if (part > parts) {
  console.error(`spill-page: ${file} has ${parts} part(s) of ${chars} chars; there is no part ${part}`)
  process.exit(1)
}

const start = safeCut(text, (part - 1) * chars)
const end = safeCut(text, part * chars)
const next = part < parts
  ? `next: ${[process.execPath, process.argv[1], file, String(part + 1), String(chars)].map(shellArg).join(' ')}`
  : 'end of output'
process.stdout.write(`${text.slice(start, end)}\n[part ${part} of ${parts} · chars ${start + 1}-${end} of ${text.length} · ${next}]\n`)
