/**
 * `/ceulen upgrade --apply`: install the newer bundle from inside the session.
 *
 * DSH has no update command of its own: `dsh plugin --profile <p> <args>` is
 * pnpm run in the profile folder. Measured on 2026-11-28 with pnpm 12, an hour
 * after a release: `add ceulen-dsh@latest` and `update ceulen-dsh` stayed on
 * the old version (pnpm does not resolve a tag or a range to a version younger
 * than its release-age window), while `add ceulen-dsh@<exact>` installed at
 * once. So the upgrade always names the exact version, and this command runs
 * it so nobody has to copy one.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome } from '../../core/paths.js'

export const PACKAGE = 'ceulen-dsh'
const RUN_TIMEOUT_MS = 300_000
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function profileDir(profile: string): string {
  return join(dshHome(), 'profiles', profile)
}

/**
 * The profile this process booted with: `--profile <name>`, or the launcher's
 * short form `dsh <name>`. A positional only counts when a profile folder of
 * that name exists, so an app argument is never taken for one.
 */
export function bootProfile(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.indexOf('--profile')
  const named = flag === -1 ? undefined : argv[flag + 1]
  if (named !== undefined && named.length > 0 && !named.startsWith('-')) return named
  const inline = argv.find(entry => entry.startsWith('--profile='))?.slice('--profile='.length)
  if (inline !== undefined && inline.length > 0) return inline
  const positional = argv.slice(2).find(entry => !entry.startsWith('-'))
  if (positional !== undefined && /^[A-Za-z0-9._-]+$/.test(positional) && existsSync(join(profileDir(positional), 'package.json'))) return positional
  return undefined
}

export type InstallKind = 'registry' | 'link' | 'tarball' | 'git' | 'missing'

/** How the profile got this bundle: only a registry install can be upgraded by version. */
export function installSource(profile: string): { kind: InstallKind; spec?: string } {
  let spec: unknown
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile), 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
    spec = manifest.dependencies?.[PACKAGE]
  } catch {
    return { kind: 'missing' }
  }
  if (typeof spec !== 'string' || spec.length === 0) return { kind: 'missing' }
  if (/^(?:link|workspace|portal):/.test(spec)) return { kind: 'link', spec }
  if (/^(?:git\+|github:|gitlab:|bitbucket:)|\.git(?:#|$)/.test(spec)) return { kind: 'git', spec }
  if (/^(?:file:|https?:)|\.tgz$/.test(spec)) return { kind: 'tarball', spec }
  return { kind: 'registry', spec }
}

/** The version the profile has on disk now, which is what the next start loads. */
export function installedInProfile(profile: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(profileDir(profile), 'node_modules', PACKAGE, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

export interface RunResult {
  code: number
  output: string
}

export type Runner = (args: readonly string[]) => Promise<RunResult>

/** Run the launcher that started this process, or `dsh` from PATH when it was something else. */
export const runLauncher: Runner = args => new Promise(resolve => {
  const script = process.argv[1]
  const own = script !== undefined && /^dsh(?:\.[cm]?js)?$/.test(basename(script))
  const [file, argv] = own ? [process.execPath, [script, ...args]] : ['dsh', [...args]]
  execFile(file, argv, { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
    const note = error !== null && (error as { killed?: boolean }).killed === true ? `\ntimed out after ${RUN_TIMEOUT_MS / 1000} s` : error !== null && (error as { code?: unknown }).code === 'ENOENT' ? '\ndsh was not found on PATH' : ''
    resolve({ code, output: `${stdout}${stderr}${note}` })
  })
})

function tail(output: string, lines: number): string {
  return output.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0).slice(-lines).map(line => `  ${line}`).join('\n')
}

export interface ApplyResult {
  ok: boolean
  text: string
}

/**
 * Install `latest` into `profile` and say what the user must do next.
 * Nothing is run for a checkout link, a tarball or a git install: a version
 * from the registry would silently change where the bundle comes from.
 */
export async function applyUpgrade(options: { profile: string | undefined; latest: string; installed: string; run?: Runner }): Promise<ApplyResult> {
  const { profile, latest, installed } = options
  if (!VERSION.test(latest)) return { ok: false, text: `npm answered with "${latest}", which is not a version. Nothing was changed.` }
  if (profile === undefined) {
    return { ok: false, text: `Cannot tell which profile this session runs in. Run it yourself:\n\n  dsh plugin --profile <profile> add ${PACKAGE}@${latest}` }
  }
  const source = installSource(profile)
  if (source.kind === 'link') {
    return { ok: false, text: `Profile ${profile} links a checkout (${source.spec}), so there is no package to replace. Update the checkout instead (git pull, then npm run build) and restart.` }
  }
  if (source.kind === 'tarball' || source.kind === 'git') {
    return { ok: false, text: `Profile ${profile} installed ${PACKAGE} from ${source.spec}, not from the registry. Install the newer build the same way, or switch to the registry yourself:\n\n  dsh plugin --profile ${profile} add ${PACKAGE}@${latest}` }
  }
  if (source.kind === 'missing') {
    return { ok: false, text: `Profile ${profile} does not list ${PACKAGE} in its package.json. Install it:\n\n  dsh plugin --profile ${profile} add ${PACKAGE}@${latest}` }
  }

  const command = ['plugin', '--profile', profile, 'add', `${PACKAGE}@${latest}`]
  const result = await (options.run ?? runLauncher)(command)
  const onDisk = installedInProfile(profile)
  if (result.code !== 0 || onDisk !== latest) {
    return {
      ok: false,
      text: [
        `The upgrade did not finish: \`dsh ${command.join(' ')}\` exited ${result.code} and the profile has ${PACKAGE} ${onDisk ?? 'unknown'}.`,
        tail(result.output, 12),
        '',
        'This session is unchanged. Fix the cause above, or run the command in a terminal to see it in full.',
      ].filter((line, index) => index !== 1 || line.length > 0).join('\n'),
    }
  }
  return {
    ok: true,
    text: [
      `${PACKAGE} ${latest} is installed in profile ${profile} (this session still runs ${installed}).`,
      '',
      `Restart to load it: quit, then \`dsh ${profile}\`. Plugin code is not hot-reloaded.`,
      'Settings and sessions are kept: only the package was replaced.',
    ].join('\n'),
  }
}
