import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '../../core/types.js'
import { packageFile } from '../../core/paths.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-skills'
export const inject = ['skills']

interface Frontmatter {
  meta: Record<string, string>
  body: string
}

function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  let key: string | undefined
  let mode: '>' | '|' | undefined
  let buffer: string[] = []
  const flush = () => {
    if (key !== undefined) meta[key] = mode === '|' ? buffer.join('\n') : buffer.join(' ').replace(/\s+/g, ' ').trim()
    key = undefined
    mode = undefined
    buffer = []
  }
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field !== null) {
      flush()
      key = field[1]
      if (key === undefined) continue
      const value = field[2]?.trim() ?? ''
      if (value === '>' || value === '|') {
        mode = value
      } else {
        meta[key] = value.replace(/^['"]|['"]$/g, '')
        key = undefined
      }
      continue
    }
    if (key !== undefined && /^\s+/.test(line)) buffer.push(line.trim())
  }
  flush()
  return { meta, body: text.slice(match[0].length) }
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return !/^(false|no|0)$/i.test(value.trim())
}

export function apply(ctx: PluginContext): void {
  if (ctx.skills === undefined) return
  const root = packageFile('skills')
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    logLine('skills', `no bundled skills directory at ${root}`)
    return
  }

  let registered = 0
  for (const entry of entries.sort()) {
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const file = join(dir, 'SKILL.md')
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseFrontmatter(raw)
    const skillName = (meta.name ?? entry).trim()
    const description = (meta.description ?? '').trim()
    if (skillName.length === 0 || description.length === 0) {
      logLine('skills', `skipping ${entry}: missing name or description`)
      continue
    }
    const modelInvocable = !/^(true|yes|1)$/i.test((meta['disable-model-invocation'] ?? '').trim())
    const userInvocable = flag(meta['user-invocable'], true)
    const candidates = [skillName, `ceulen-${skillName}`]
    let ok = false
    for (const candidate of candidates) {
      try {
        ctx.skills.register({
          name: candidate,
          description,
          content: body.trim(),
          source: 'bundled',
          whenToUse: meta.whenToUse,
          invocation: { modelInvocable, userInvocable },
          provider: 'ceulen-dsh',
          path: file,
          resourceBase: { kind: 'directory', path: dir },
          metadata: { upstream: 'ceulen', upstreamVersion: '0.23.0' },
        })
        registered += 1
        if (candidate !== skillName) logLine('skills', `${skillName} collided; registered as ${candidate}`)
        ok = true
        break
      } catch {
        // Duplicate name; try the namespaced alias.
      }
    }
    if (!ok) logLine('skills', `failed to register ${skillName}`)
  }
  logLine('skills', `registered ${registered} skill(s)`)
}
