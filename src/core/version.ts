import { readFileSync } from 'node:fs'
import { packageFile } from './paths.js'

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(input: string): Semver | undefined {
  const match = SEMVER_RE.exec(input.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // A release without a prerelease sorts above one with a prerelease.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Standard semver precedence; returns -1, 0 or 1; invalid input throws. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined) throw new Error(`invalid semver: ${a}`)
  if (right === undefined) throw new Error(`invalid semver: ${b}`)
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function isNewer(candidate: string, baseline: string): boolean {
  try {
    return compareSemver(candidate, baseline) > 0
  } catch {
    return false
  }
}

export interface PackageManifest {
  name?: string
  version?: string
  /** A manifest with a release line carries its own semver (`0.1.1`). */
  release?: { line?: string; distTag?: string }
}

interface UpstreamLock {
  upstream?: { version?: string }
}

export function readManifest(): PackageManifest {
  try {
    return JSON.parse(readFileSync(packageFile('package.json'), 'utf8')) as PackageManifest
  } catch {
    return {}
  }
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function pluginVersion(manifest: PackageManifest = readManifest()): string {
  return manifest.version ?? '0.0.0'
}

/** Release line declared by the manifest (`stable`); absent on legacy manifests. */
export function releaseLine(manifest: PackageManifest = readManifest()): string | undefined {
  return trimmed(manifest.release?.line)
}

/** npm dist-tag the bundle check follows: `release.distTag`, else the line. */
export function releaseDistTag(manifest: PackageManifest = readManifest()): string | undefined {
  return trimmed(manifest.release?.distTag) ?? trimmed(manifest.release?.line)
}

function readLockedUpstreamVersion(): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(new URL('../../upstream.lock.json', import.meta.url), 'utf8')) as UpstreamLock
    return trimmed(lock.upstream?.version)
  } catch {
    return undefined
  }
}

/**
 * Upstream base of the bundle version, e.g. `0.23.0` from `0.23.0-dsh.1`.
 * A manifest with a `release.line` carries its own line version (`0.1.1`), so
 * its upstream base comes from `upstream.lock.json` instead of the dash split;
 * a legacy version-only manifest keeps the dash behaviour.
 */
export function upstreamBaseVersion(
  manifest: PackageManifest = readManifest(),
  locked = readLockedUpstreamVersion(),
): string {
  if (releaseLine(manifest) !== undefined) return locked ?? '0.0.0'
  const version = pluginVersion(manifest)
  const dash = version.indexOf('-')
  return dash === -1 ? version : version.slice(0, dash)
}
