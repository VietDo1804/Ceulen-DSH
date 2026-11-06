import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve `$DSH_HOME`, falling back to `~/.dsh` (same precedence as DSH). */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/** Ceulen-owned state under the harness home. */
export function ceulenHome(): string {
  return join(dshHome(), 'ceulen')
}

/** Cache directory for upstream metadata and tarballs. */
export function ceulenCache(): string {
  return join(dshHome(), 'cache', 'ceulen')
}

export function settingsPath(): string {
  return join(ceulenHome(), 'settings.json')
}

export function logsDir(): string {
  return join(ceulenHome(), 'logs')
}

export function upstreamCachePath(): string {
  return join(ceulenCache(), 'upstream.json')
}

/** Cache for this bundle's own npm version check. */
export function bundleCachePath(): string {
  return join(ceulenCache(), 'bundle.json')
}

/** Absolute package root (the directory holding package.json). */
export function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

export function packageFile(...segments: string[]): string {
  return join(packageRoot(), ...segments)
}

/** Resolve a path against the session cwd, leaving absolute paths alone. */
export function resolveProjectPath(cwd: string, path: string): string {
  return path.startsWith('/') ? path : join(cwd, path)
}

export function displayPath(path: string): string {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}
