/**
 * Recognises bash calls that only search or read project files, and writes the
 * dedicated call that does the same job. Measured 2026-11-01..20: flash sent
 * 7688 bash calls (2292 more inside codemode) and opened 49% of its turns with
 * one; gpt-6.1-sol opened 73% of turns with a codemode batch of grep/glob/read.
 * `read` matters beyond style: `edit`/`write` refuse a file only seen through
 * bash.
 *
 * Deliberately narrow. Only whole commands made of these shapes match, so
 * pipelines that compute something (`| wc -l`, `| sort | uniq -c`, awk), `git
 * grep`, context flags (-A/-B/-C), and anything that writes, run unchanged.
 */

import { homedir } from 'node:os'
import { posix } from 'node:path'

export interface Replacement {
  /** The dedicated call, as the model would write it. */
  readonly call: string
}

/** Split a command into words, honouring single/double quotes and backslashes. */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      // Inside double quotes bash only unescapes $ ` " \ ; `\s` stays as typed.
      else if (char === '\\' && quote === '"' && '$`"\\'.includes(command[index + 1] ?? '')) word += command[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < command.length) {
      word += command[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else if (char === '~' && !started && command[index + 1] === '/') {
      word += homedir()
      started = true
    } else if ('*?[]'.includes(char) && /^--include=|^-g$/.test(word === '' ? (words.at(-1) ?? '') : word)) {
      // `--include=*.ts` and `-g *.ts` reach grep literally in practice.
      word += char
      started = true
    } else if ('$`<>(){}*?[]~!#'.includes(char)) {
      // Expansion, redirection, globbing or subshells: not a plain lookup.
      return undefined
    } else {
      word += char
      started = true
    }
  }
  if (quote !== undefined) return undefined
  if (started) words.push(word)
  return words
}

const js = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Split on `separator` (a regex matched at each position) outside quotes. */
export function splitUnquoted(text: string, separator: RegExp): string[] {
  const parts: string[] = []
  let quote: '"' | "'" | undefined
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '\\') { index += 1; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    const match = new RegExp(`^(?:${separator.source})`).exec(text.slice(index))
    if (match !== null && match[0].length > 0) {
      parts.push(text.slice(start, index))
      index += match[0].length - 1
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** `| head -n 40` / `| head -40` / `| head` after a lookup: the tools cap their own output. */
function stripHead(segment: string): { body: string; limit?: number } | undefined {
  const parts = splitUnquoted(segment, /\|(?!\|)/)
  if (parts.length === 1) return { body: segment }
  if (parts.length !== 2) return undefined
  const head = /^\s*head(?:\s+-n\s*(\d+)|\s+-(\d+))?\s*$/.exec(parts[1]!)
  if (head === null) return undefined
  const limit = head[1] ?? head[2]
  return limit === undefined ? { body: parts[0]! } : { body: parts[0]!, limit: Number(limit) }
}

/** Paths in the replacement resolve against the session workspace, so fold in a `cd` prefix. */
function under(dir: string | undefined, path: string): string {
  return dir === undefined || posix.isAbsolute(path) ? path : posix.join(dir, path)
}

const GREP_SWITCHES = new Set(['-r', '-R', '-n', '-i', '-l', '-w', '-s', '-H', '-I', '-rn', '-rni', '-nr', '-Rn', '-nR', '-rl', '-ril', '-rli', '-rniE', '-rnE', '-rnI', '-rIn', '-nri', '-in', '-ni', '-li', '-il', '-ri', '-ir', '--line-number', '--recursive', '--ignore-case', '--no-heading', '--color=never', '-S', '--smart-case', '--hidden'])

const RG_META = '\\.^$|?*+()[]{}'
const BRE_SWAPPED = '(){}|+?'

/**
 * The grep tool takes a ripgrep (Rust) regex. GNU grep's default BRE reads
 * `(`, `|`, `{`, `+`, `?` literally and `\(`, `\|` … as operators, the reverse
 * of ripgrep, so `grep 'clampText('` must become `clampText\(`. -F escapes all.
 */
export function ripgrepPattern(pattern: string, syntax: 'bre' | 'ere' | 'fixed'): string {
  if (syntax === 'ere') return pattern
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (syntax === 'fixed') {
      out += RG_META.includes(char) ? `\\${char}` : char
    } else if (char === '\\' && index + 1 < pattern.length) {
      const next = pattern[++index]!
      out += BRE_SWAPPED.includes(next) ? next : `\\${next}`
    } else {
      out += BRE_SWAPPED.includes(char) ? `\\${char}` : char
    }
  }
  return out
}

function grepCall(words: string[], dir: string | undefined): Replacement | undefined {
  let include: string | undefined
  let syntax: 'bre' | 'ere' | 'fixed' = words[0] === 'rg' ? 'ere' : 'bre'
  let options = true
  const rest: string[] = []
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!
    if (!options) {
      rest.push(word)
    } else if (word === '--') {
      options = false
    } else if (word.startsWith('--include=')) {
      if (include !== undefined) return undefined
      include = word.slice('--include='.length)
    } else if ((word === '-g' || word === '--glob' || word === '-t') && index + 1 < words.length) {
      if (include !== undefined) return undefined
      const value = words[++index]!
      if (value.startsWith('!')) return undefined
      include = word === '-t' ? `*.${value}` : value
    } else if (word === '-e' && index + 1 < words.length) {
      rest.unshift(words[++index]!)
    } else if (word.startsWith('-')) {
      if (/^-[a-zA-Z]*[EF][a-zA-Z]*$/.test(word)) {
        const letters = word.slice(1)
        if (/[^rRnilwsHIEF]/.test(letters) || (letters.includes('E') && letters.includes('F'))) return undefined
        syntax = letters.includes('F') ? 'fixed' : 'ere'
      } else if (word === '--fixed-strings') syntax = 'fixed'
      else if (word === '--extended-regexp') syntax = 'ere'
      else if (!GREP_SWITCHES.has(word)) return undefined
    } else {
      rest.push(word)
    }
  }
  const [pattern, ...paths] = rest
  if (pattern === undefined || pattern === '' || paths.length > 1) return undefined
  const fields = [`pattern: ${js(ripgrepPattern(pattern, syntax))}`]
  const path = paths[0] === undefined ? dir : under(dir, paths[0])
  if (path !== undefined && path !== '.') fields.push(`path: ${js(path)}`)
  if (include !== undefined) fields.push(`include: ${js(include)}`)
  return { call: `grep({ ${fields.join(', ')} })` }
}

function readCall(words: string[], dir: string | undefined, piped: number | undefined): Replacement | undefined {
  const [name, ...args] = words
  const file = (path: string, limit?: number): Replacement =>
    ({ call: `read({ file_path: ${js(under(dir, path))}${limit === undefined ? '' : `, limit: ${limit}`} })` })
  if (name === 'cat' && args.length === 1 && !args[0]!.startsWith('-')) return file(args[0]!, piped)
  if (piped !== undefined) return undefined
  if (name === 'head') {
    if (args.length === 1 && !args[0]!.startsWith('-')) return file(args[0]!, 10)
    const count = args.length === 3 && args[0] === '-n' ? args[1] : args.length === 2 && /^-\d+$/.test(args[0]!) ? args[0]!.slice(1) : undefined
    const last = args.at(-1)
    if (count !== undefined && /^\d+$/.test(count) && last !== undefined && !last.startsWith('-')) return file(last, Number(count))
    return undefined
  }
  if (name === 'sed' && args.length === 3 && args[0] === '-n') {
    const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1]!)
    if (range === null || args[2]!.startsWith('-')) return undefined
    const first = Number(range[1])
    const last = range[2] === undefined ? first : Number(range[2])
    if (last < first) return undefined
    return { call: `read({ file_path: ${js(under(dir, args[2]!))}, offset: ${first}, limit: ${last - first + 1} })` }
  }
  return undefined
}

function findCall(words: string[], dir: string | undefined): Replacement | undefined {
  const [, root, ...args] = words
  if (root === undefined || root.startsWith('-')) return undefined
  let name: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!
    if ((word === '-name' || word === '-iname') && index + 1 < args.length) {
      if (name !== undefined) return undefined
      name = args[++index]!
    } else if (word === '-type' && args[index + 1] === 'f') index += 1
    else if (word === '-maxdepth' && /^\d+$/.test(args[index + 1] ?? '')) index += 1
    else return undefined
  }
  if (name === undefined) return undefined
  const fields = [`pattern: ${js(`**/${name}`)}`]
  const path = root === '.' ? dir : under(dir, root)
  if (path !== undefined) fields.push(`path: ${js(path)}`)
  return { call: `glob({ ${fields.join(', ')} })` }
}

function oneLookup(segment: string, dir: string | undefined): Replacement | undefined {
  const quiet = segment.replace(/\s+2>(?:\/dev\/null|&1)(?=\s*(?:\||$))/g, '')
  const piped = stripHead(quiet)
  if (piped === undefined) return undefined
  const words = shellWords(piped.body.trim())
  if (words === undefined || words.length === 0) return undefined
  const head = words[0]!
  if (head === 'grep' || head === 'rg') return grepCall(words, dir)
  if (head === 'find') return findCall(words, dir)
  return readCall(words, dir, piped.limit)
}

/** Separators that only sequence lookups; `pwd` and `echo` between them are noise. */
const FILLER = /^\s*(?:pwd|true|echo(?:\s+(?:"[^"$`\\]*"|'[^']*'|[^\s"'$`|;&<>]+))*)\s*$/

/**
 * The dedicated calls that replace `command`, or undefined when any part of it
 * is not a plain lookup. A leading `cd <dir> &&` is dropped: tools take paths.
 */
export function lookupReplacements(command: string): Replacement[] | undefined {
  let text = command.trim()
  let dir: string | undefined
  const cd = /^cd\s+(\S+)\s*&&\s*/.exec(text)
  if (cd !== null) {
    const words = shellWords(cd[1]!)
    if (words?.length !== 1) return undefined
    dir = words[0]
    text = text.slice(cd[0].length)
  }
  if (text === '' || /\n|\|\||;;|&\s*$/.test(text)) return undefined
  // `;` and `&&` only sequence the parts here; every part must be a lookup.
  const segments = splitUnquoted(text, /;|&&/).filter(segment => segment.trim() !== '')
  const calls: Replacement[] = []
  for (const segment of segments) {
    if (FILLER.test(segment)) continue
    const call = oneLookup(segment, dir)
    if (call === undefined) return undefined
    calls.push(call)
  }
  return calls.length > 0 ? calls : undefined
}

/** The deny text: the exact replacement, and why it is better. Never a way to switch the check off. */
export function redirectText(command: string, calls: readonly Replacement[]): string {
  const shown = command.length > 160 ? `${command.slice(0, 159)}…` : command
  const lines = [`Not run: \`${shown}\` only searches or reads files, and the dedicated tools do that better here.`]
  if (calls.length === 1) {
    lines.push(`Call instead: ${calls[0]!.call}`)
  } else {
    lines.push('Call instead, in one codemode script:')
    lines.push(`const r = await Promise.allSettled([${calls.map(call => `tools.${call.call}`).join(', ')}])`)
    lines.push("return r.map((x, i) => ({ i, text: (x.status === 'fulfilled' ? (x.value.lines ? x.value.lines.map(l => l.text).join('\\n') : JSON.stringify(x.value)) : String(x.reason)).slice(0, 1500) }))")
  }
  lines.push('grep returns file:line matches grouped by file; read makes the file editable by edit/write. Keep bash for running builds, tests, git and scripts. If the tool truly cannot do this job, send the same bash command again unchanged and it will run.')
  return lines.join('\n')
}
