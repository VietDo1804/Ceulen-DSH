/**
 * The pack contract: what the published package must carry and what must never
 * ship. One list, two checks: check-pack.mjs reads it before a publish (over
 * `npm pack --dry-run`), smoke-install.mjs after one (over the installed copy).
 */

/** Paths every release carries. */
export const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'parity.json',
  'upstream.lock.json',
  'vendor.manifest.json',
  'lib/index.js',
  'lib/modules/skills/index.js',
  'lib/modules/web/index.js',
  'lib/modules/dashboard/index.js',
  'lib/modules/dashboard/model.js',
  'lib/modules/dashboard/scene.js',
  'lib/modules/dashboard/tokens.js',
  'lib/themes/generated.js',
]

/** Top-level folders that stay on the development machine: sources, the local test suite, internal notes, build output. */
export const FORBIDDEN_PREFIXES = ['src/', 'test/', 'docs/', 'release/', 'node_modules/', 'out/', '.dsh/', '.devhome/', '.scratch/']

/** Path segments that are private wherever they sit: the personal agent-mode plugin left the public bundle in 0.2.10. */
export const FORBIDDEN_SEGMENTS = [/^agent[-_]?mode/i]

/** Why `path` (relative to the package root, forward slashes) must not ship, or undefined when it may. */
export function forbiddenReason(path) {
  const prefix = FORBIDDEN_PREFIXES.find(entry => path === entry.slice(0, -1) || path.startsWith(entry))
  if (prefix !== undefined) return `${prefix} stays out of the package`
  const segment = path.split('/').find(part => FORBIDDEN_SEGMENTS.some(pattern => pattern.test(part)))
  if (segment !== undefined) return `"${segment}" is private`
  return undefined
}
