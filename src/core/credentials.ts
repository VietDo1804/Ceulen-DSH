import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.js'

interface RefCache {
  mtimeMs: number
  size: number
  refs: Record<string, string>
}

let cache: RefCache | undefined

/**
 * Read the `refs:` mapping from the DSH credential document
 * (`$DSH_HOME/.credentials.yaml`). This is a deliberately narrow parser: the
 * file is a flat YAML mapping of reference name → secret string. Values are
 * never logged or returned to callers except through {@link credential}.
 */
function readRefs(): Record<string, string> {
  const path = join(dshHome(), '.credentials.yaml')
  let mtimeMs = -1
  let size = -1
  try {
    const info = statSync(path)
    mtimeMs = info.mtimeMs
    size = info.size
  } catch {
    return {}
  }
  if (cache !== undefined && cache.mtimeMs === mtimeMs && cache.size === size) return cache.refs
  const refs: Record<string, string> = {}
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    let inRefs = false
    let baseIndent = 0
    for (const line of lines) {
      if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      const trimmed = line.trim()
      if (!inRefs) {
        if (/^refs:\s*$/.test(trimmed)) {
          inRefs = true
          baseIndent = indent
          continue
        }
        continue
      }
      if (indent <= baseIndent) break
      const match = /^([A-Za-z0-9_./-]+):\s*(.*)$/.exec(trimmed)
      if (match === null) continue
      const key = match[1]!
      let value = (match[2] ?? '').trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      // A nested mapping/block scalar is not a credential ref; skip it.
      if (value.length === 0 || value === '{}' || value === 'null' || value === '~') continue
      refs[key] = value
    }
  } catch {
    // Unreadable credentials behave as unset.
  }
  cache = { mtimeMs, size, refs }
  return refs
}

export interface CredentialResolution {
  value?: string
  source?: 'env' | 'dsh-credential'
  ref?: string
}

/** Resolve the first present reference: environment wins, then the DSH store. */
export function credential(...refs: string[]): CredentialResolution {
  for (const ref of refs) {
    if (ref.length === 0) continue
    const env = process.env[ref]
    if (env !== undefined && env.trim().length > 0) return { value: env.trim(), source: 'env', ref }
  }
  const stored = readRefs()
  for (const ref of refs) {
    if (ref.length === 0) continue
    const value = stored[ref]
    if (value !== undefined && value.length > 0) return { value, source: 'dsh-credential', ref }
  }
  return {}
}

/** Whether a reference resolves, without exposing the value. */
export function hasCredential(...refs: string[]): boolean {
  return credential(...refs).value !== undefined
}

/** Reset the credential cache (tests). */
export function resetCredentialCache(): void {
  cache = undefined
}
