import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLike, CommandResult, PluginContext } from '../../core/types.js'
import { loadSettingsSync, redactSettings, setModuleEnabled } from '../../core/settings.js'
import { loadParity, formatParity, summary, isImplemented } from '../../core/parity.js'
import {
  bundleStatusLine,
  checkBundleUpdate,
  checkUpstream,
  currentBundleUpdate,
  currentUpstreamState,
  formatAge,
  formatBundleUpdate,
  formatUpstream,
  isCacheFresh,
  readPinnedVersion,
  statusLine,
  type BundleUpdateState,
  type UpstreamState,
} from '../../core/upstream.js'
import { pluginVersion, releaseDistTag, releaseLine } from '../../core/version.js'
import { packageFile, settingsPath, dshHome, displayPath } from '../../core/paths.js'
import { clampText, coldToolEntries, registerCommandSafe, resetToolBudget, toolBudgetEntries, tuiStatusPublisher } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { credential } from '../../core/credentials.js'
import { readJson } from '../../core/fsx.js'
import { upstreamCachePath } from '../../core/paths.js'
import { applyConfig } from '../config/index.js'
import { compatReport, formatCompat } from '../providers/index.js'

const execFileAsync = promisify(execFile)

const STATUS_KEY = 'ceulen:upstream'

/** `ceulen-dsh 0.1.1 (stable)` — the release line is part of the identity. */
function bundleLabel(): string {
  const line = releaseLine()
  return `ceulen-dsh ${pluginVersion()}${line === undefined ? '' : ` (${line})`}`
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}

/** The profile this process booted with, for copy-paste upgrade commands. */
function profileName(): string {
  const index = process.argv.indexOf('--profile')
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value !== undefined && value.length > 0 ? value : '<profile>'
}

function composeLine(upstream: UpstreamState, bundle: BundleUpdateState): string | undefined {
  const parts = [statusLine(upstream, pluginVersion()), bundleStatusLine(bundle)]
  const text = parts.filter((part): part is string => part !== undefined).join(' · ')
  return text.length > 0 ? text : undefined
}

async function applyStatusLine(publish: (text: string | undefined) => void): Promise<void> {
  try {
    const [upstream, bundle] = await Promise.all([currentUpstreamState(), currentBundleUpdate()])
    publish(composeLine(upstream, bundle))
  } catch {
    // A status line must never break the plugin.
  }
}

async function refreshStatusLine(publish: (text: string | undefined) => void): Promise<void> {
  try {
    const settings = loadSettingsSync()
    if (!settings.upstream.enabled) return
    const [upstream, bundle] = await Promise.all([
      checkUpstream({ intervalHours: settings.upstream.intervalHours }),
      checkBundleUpdate({ intervalHours: settings.upstream.intervalHours }),
    ])
    publish(composeLine(upstream, bundle))
  } catch (error) {
    logLine('upstream', `status refresh failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function statusText(): Promise<string> {
  const parity = loadParity()
  const settings = loadSettingsSync()
  const upstream = await currentUpstreamState()
  const bundle = await currentBundleUpdate()
  const counts = summary(parity)
  const mounted = parity.modules.filter(isImplemented).map(module => module.name)
  const natives = parity.modules.filter(module => module.status === 'native' || module.status === 'na').map(module => module.name)
  const planned = parity.modules.filter(module => !isImplemented(module) && module.status !== 'native' && module.status !== 'na')
  return [
    `${bundleLabel()} · upstream ${upstream.pinned}`,
    `upstream check · ${formatUpstream(upstream)}`,
    `bundle npm · ${formatBundleUpdate(bundle)}`,
    `modules ${counts.implemented}/${counts.total} mounted · ${settings.disabled.length} disabled`,
    `mounted: ${mounted.length > 0 ? mounted.join(', ') : '(none yet)'}`,
    `native DSH: ${natives.join(', ')}`,
    `planned: ${planned.map(module => `${module.name}@P${module.phase}`).join(', ')}`,
    '',
    '/ceulen modules   full module table',
    '/ceulen-config    full-screen settings panel',
    '/ceulen config    open the settings panel (--raw for JSON)',
    '/ceulen update    check the upstream release and notes',
    '/ceulen doctor    environment and service diagnostics',
  ].join('\n')
}

async function updateText(flags: string[]): Promise<string> {
  const settings = loadSettingsSync()
  const force = true
  const offline = flags.includes('--offline')
  const wantNotes = flags.includes('--notes')
  const wantSync = flags.includes('--sync')
  const state = await checkUpstream({ force, offline, intervalHours: settings.upstream.intervalHours })
  const lines: string[] = []
  lines.push(`${bundleLabel()} · pinned upstream ${readPinnedVersion()}`)
  lines.push(formatUpstream(state))
  if (state.behind && state.latest !== null) {
    lines.push('')
    lines.push(`A newer ceulen (${state.latest}) is available. The DSH port tracks ${state.pinned}.`)
    lines.push('Run the sync pipeline in the checkout:')
    lines.push(`  node ${packageFile('scripts', 'ceulen-sync.mjs')} report`)
    lines.push(`  node ${packageFile('scripts', 'ceulen-sync.mjs')} apply-vendor`)
    if (wantNotes && state.release?.body !== undefined) {
      lines.push('')
      lines.push(clampText(state.release.body, 3_500))
    } else if (wantNotes) {
      lines.push('')
      lines.push('No release notes in the cache. Run /ceulen update --notes with network access.')
    }
    if (wantSync) {
      lines.push('')
      lines.push('The sync command above only upgrades cleanly vendored files; adapter changes stay a reviewed checklist.')
    }
  } else if (state.latest !== null) {
    lines.push('')
    lines.push('No upgrade needed. /ceulen update --notes still forces a fresh check.')
  }
  const bundle = await checkBundleUpdate({ force, offline, intervalHours: settings.upstream.intervalHours })
  lines.push('')
  lines.push(`npm ${formatBundleUpdate(bundle)}`)
  if (bundle.behind && bundle.latest !== null) {
    lines.push(`  dsh plugin --profile ${profileName()} add ceulen-dsh@${bundle.latest}`)
    lines.push(`  dsh --profile ${profileName()}   # restart`)
    lines.push('')
  }
  return lines.join('\n')
}

async function upgradeText(flags: string[]): Promise<string> {
  const settings = loadSettingsSync()
  const state = await checkBundleUpdate({
    force: !flags.includes('--cached'),
    offline: flags.includes('--offline'),
    intervalHours: settings.upstream.intervalHours,
  })
  if (!state.behind || state.latest === null) {
    return [
      `ceulen-dsh ${pluginVersion()} is current.`,
      `npm: ${formatBundleUpdate(state)}`,
      ...(state.error === undefined ? [] : ['(the check is best-effort; npm view ceulen-dsh confirms)']),
    ].join('\n')
  }
  return [
    `ceulen-dsh ${state.latest} is available (installed ${pluginVersion()}).`,
    '',
    `  dsh plugin --profile ${profileName()} add ceulen-dsh@${state.latest}`,
    `  dsh --profile ${profileName()}`,
    '',
    'The second command restarts the profile — plugin code is not hot-reloaded.',
    'Settings and sessions survive: only the package is replaced.',
  ].join('\n')
}

async function binaryVersion(binary: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, { timeout: 1_500 })
    return stdout.trim().split('\n')[0] ?? 'present'
  } catch {
    return 'missing'
  }
}

/**
 * Whether the optional dsh-tui patches are applied (advisor transcript block,
 * /context redirect, tool-name aliases, plan-mode polish). They live in the
 * installed profile tree, so a dsh-tui update silently reverts them;
 * `/ceulen doctor` must make that visible instead of letting the loss rot
 * until someone notices a missing segment.
 *
 * Each marker below mirrors the anchor a patch script's `check` uses; when an
 * anchor moves in scripts/tui-*-patch.mjs, update the marker here too.
 */
export function tuiFooterState(): string {
  const root = join(dshHome(), 'profiles')
  let profiles: string[]
  try {
    profiles = readdirSync(root)
  } catch {
    return 'dsh-tui not installed'
  }
  const states: string[] = []
  for (const profile of profiles) {
    const dir = join(root, profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    const chat = join(dir, 'lib', 'types', 'screens', 'Chat.js')
    if (!existsSync(chat)) continue
    let version = '?'
    try {
      version = String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? '?')
    } catch {
      // Report the profile anyway.
    }
    let native = false
    try {
      native = readFileSync(join(dir, 'lib', 'types', 'dsh-adapter', 'status.js'), 'utf8').includes('setField(')
    } catch {
      // No status adapter (0.16.x): the usage segment stays above the prompt.
    }
    const footer = native ? 'footer-native' : 'footer-stock (0.16.x has no footer slot; usage renders above the prompt)'
    let advisor = false
    try {
      const projection = readFileSync(join(dir, 'lib', 'types', 'channel', 'projection.js'), 'utf8')
      advisor = projection.includes("event.source === 'advisor'")
    } catch {
      // Unreadable projection counts as not applied.
    }
    let contextRedirect = false
    try {
      contextRedirect = readFileSync(chat, 'utf8').includes("runExternalCommandOutcome('context'")
    } catch {
      // Unreadable Chat.js counts as not applied.
    }
    let toolNames = false
    try {
      toolNames = readFileSync(join(dir, 'lib', 'types', 'components', 'messages', 'AssistantToolUseMessage.js'), 'utf8').includes('TOOL_NAME_ALIASES')
    } catch {
      // Unreadable tool card counts as not applied.
    }
    let planMode = false
    try {
      planMode = readFileSync(chat, 'utf8').includes('ceulen-plan: bare `/plan` toggles') &&
        readFileSync(join(dir, 'lib', 'types', 'dsh-adapter', 'channel', 'mode-permission-actions.js'), 'utf8').includes("id: 'plan',")
    } catch {
      // Unreadable sources count as not applied.
    }
    states.push(`${profile}:${version} ${footer} · advisor-block ${advisor ? 'applied' : 'stock (advisor notes stay out of the transcript; run scripts/tui-advisor-patch.mjs apply)'} · context-redirect ${contextRedirect ? 'applied' : 'stock (the built-in /context dump stays; run scripts/tui-context-patch.mjs apply)'} · tool-names ${toolNames ? 'applied' : 'stock (fff_grep renders as Fff_grep; run scripts/tui-toolname-patch.mjs apply)'} · plan-mode ${planMode ? 'applied' : 'stock (/plan asks on/off and the footer may not name plan mode; run scripts/tui-plan-patch.mjs apply)'}`)
  }
  return states.length === 0 ? 'dsh-tui not installed' : states.join(' · ')
}

/**
 * One compat line per active route: the session's own route first, then every
 * registered provider id. A missing tool-loop flag is named, not summarized.
 */
async function compatLines(ctx: PluginContext, agent?: AgentLike): Promise<string[]> {
  const routes: string[] = []
  const active = agent?.options.provider !== undefined && agent.options.model !== undefined
    ? `${agent.options.provider}/${agent.options.model}`
    : undefined
  if (active !== undefined) routes.push(active)
  try {
    for (const entry of ctx.llm?.listProviders?.() ?? []) {
      const id = typeof entry === 'string' ? entry : (entry as { id?: string }).id
      if (typeof id === 'string' && id.length > 0 && !routes.some(route => route.split('/')[0] === id)) routes.push(id)
    }
  } catch {
    // The llm service is optional in a headless composition.
  }
  if (routes.length === 0) return ['compat: no active route — /provider-compat <provider/model> checks one']
  return routes.map(route => formatCompat(compatReport(route)))
}

async function doctorText(ctx: PluginContext, agent?: AgentLike): Promise<string> {
  const parity = loadParity()
  const settings = loadSettingsSync()
  const cache = await readJson<UpstreamState>(upstreamCachePath())
  const services = [
    ['tools', ctx.get('tools', false) !== undefined],
    ['commands', ctx.get('commands', false) !== undefined],
    ['systemPrompt', ctx.get('systemPrompt', false) !== undefined],
    ['skills', ctx.get('skills', false) !== undefined],
    ['llm', ctx.get('llm', false) !== undefined],
    ['tuiStatus', ctx.get('tuiStatus', false) !== undefined],
    ['tuiThemes', ctx.get('tuiThemes', false) !== undefined],
  ] as const
  const envNames = ['MUNIN_API_KEY', 'ROUTER_API_KEY', 'ROUTER_BASE_URL', 'ZAI_ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'BRAVE_API_KEY', 'GITHUB_TOKEN']
  const env = envNames.map(name => {
    if (process.env[name] !== undefined) return `${name}=set`
    return `${name}=${credential(name).value !== undefined ? 'stored' : 'unset'}`
  })
  const bins = await Promise.all([
    binaryVersion('git', ['--version']),
    binaryVersion('gh', ['--version']),
    binaryVersion('sg', ['--version']),
    binaryVersion('tar', ['--version']),
  ])
  return [
    `Ceulen DSH ${pluginVersion()}`,
    `release ${releaseLine() ?? '(none)'} · dist-tag ${releaseDistTag() ?? 'latest'} · upstream pinned ${readPinnedVersion()}`,
    `node ${process.version} · dsh home ${displayPath(dshHome())} · profile ${process.env.DSH_PROFILE ?? 'unknown'}`,
    `settings ${existsSync(settingsPath()) ? 'present' : 'defaults'} (${displayPath(settingsPath())})`,
    `upstream cache ${cache === undefined ? 'missing' : `checked ${formatAge(cache.checkedAt)}`}`,
    `parity ${parity.modules.length} modules · ${summary(parity).implemented} mounted`,
    `services: ${services.map(([name, present]) => `${name}=${present ? 'yes' : 'no'}`).join(' ')}`,
    `env: ${env.join(' ')}`,
    `binaries: git=${bins[0]} gh=${bins[1]} sg=${bins[2]} tar=${bins[3]}`,
    ...(await compatLines(ctx, agent)),
    `tui footer: ${tuiFooterState()}`,
    `disabled: ${settings.disabled.length > 0 ? settings.disabled.join(', ') : '(none)'}`,
  ].join('\n')
}

async function moduleText(args: string[]): Promise<CommandResult> {
  const parity = loadParity()
  const settings = loadSettingsSync()
  const action = args[0] ?? 'list'
  const name = args[1]
  if (action === 'list') {
    return ok(formatParity(parity, settings.disabled))
  }
  if (action === 'on' || action === 'off') {
    if (name === undefined || name.length === 0) return err(`usage: /ceulen module ${action} <name>`)
    const module = parity.modules.find(entry => entry.name === name)
    if (module === undefined) return err(`unknown module "${name}". Run /ceulen modules.`)
    if (module.status === 'native' || module.status === 'na') {
      return err(`"${name}" is provided natively by DSH; there is no Ceulen row to toggle.`)
    }
    await setModuleEnabled(name, action === 'on')
    return ok(`${name} ${action === 'on' ? 'enabled' : 'disabled'} in ${displayPath(settingsPath())}. Run /reload to apply.`)
  }
  return err('usage: /ceulen module list | on <name> | off <name>')
}

async function configText(): Promise<string> {
  const settings = loadSettingsSync()
  return [
    `settings: ${displayPath(settingsPath())}`,
    'Secrets belong in the environment and are never written here.',
    'Edit values in the /ceulen-config panel; this command is the raw read-only view.',
    '',
    clampText(JSON.stringify(redactSettings(settings), null, 2), 5_000),
  ].join('\n')
}

interface ToolRow {
  name: string
  descriptionBytes: number
  parameterBytes: number
  measured: boolean
}

function toolRows(ctx: PluginContext): ToolRow[] {
  const recorded = new Map(toolBudgetEntries().map(entry => [entry.name, entry]))
  let live: readonly { name: string; description?: string; parameters?: unknown }[] = []
  try {
    live = ctx.tools?.schemas?.() ?? []
  } catch {
    live = []
  }
  // The recorded ledger is the bundle's own surface (one entry per row
  // registration). After a session boundary it is empty by design, so fall
  // back to the live registry — which also carries native DSH tools.
  if (recorded.size > 0) return [...recorded.values()].map(entry => ({ ...entry, measured: true }))
  return live.map(entry => {
    const parameters = entry.parameters
    return {
      name: entry.name,
      descriptionBytes: Buffer.byteLength(String(entry.description ?? ''), 'utf8'),
      parameterBytes: parameters === undefined ? 0 : Buffer.byteLength(JSON.stringify(parameters), 'utf8'),
      measured: parameters !== undefined,
    }
  })
}

function toolModule(name: string): string {
  const cut = name.indexOf('_')
  return cut <= 0 ? 'core' : name.slice(0, cut)
}

/** The schema budget line: how many tools, how many bytes, and where they go. */
export function toolsText(ctx: PluginContext): string {
  const rows = toolRows(ctx)
  if (rows.length === 0) return 'tools 0 · no schemas registered in this process'
  const kb = (bytes: number) => (bytes / 1024).toFixed(1)
  const size = (row: ToolRow) => row.descriptionBytes + row.parameterBytes
  const total = rows.reduce((sum, row) => sum + size(row), 0)
  const unmeasured = rows.filter(row => !row.measured).length
  const top = [...rows].sort((a, b) => size(b) - size(a)).slice(0, 5)
  const groups = new Map<string, { count: number; bytes: number }>()
  for (const row of rows) {
    const key = toolModule(row.name)
    const group = groups.get(key) ?? { count: 0, bytes: 0 }
    group.count += 1
    group.bytes += size(row)
    groups.set(key, group)
  }
  const cold = coldToolEntries()
  const coldBytes = cold.reduce((sum, entry) => sum + entry.descriptionBytes + entry.parameterBytes, 0)
  const scope = toolBudgetEntries().length > 0 ? 'bundle registrations' : 'live registry'
  return [
    `tools ${rows.length} · ~${kb(total)} KB (${scope})${unmeasured > 0 ? ` (${unmeasured} without measured parameters)` : ''}`,
    ...(cold.length === 0 ? [] : [`cold ${cold.length} tools · ~${kb(coldBytes)} KB held behind ceulen_tools`]),
    'top 5 by bytes:',
    ...top.map(row => `  ${row.name.padEnd(24)} ${kb(size(row)).padStart(7)} KB`),
    'by module (tool-name prefix):',
    ...[...groups.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([name, group]) => `  ${name.padEnd(12)} ${String(group.count).padStart(2)} tools ${kb(group.bytes).padStart(7)} KB`),
    unmeasured > 0 ? 'Parameter bytes are recorded at registration; /reload re-measures them.' : '',
  ].filter(Boolean).join('\n')
}

function helpText(): string {
  return [
    'Usage: /ceulen [status|modules|tools|update|upgrade|config|doctor|module ...]',
    '',
    '  status           bundle, upstream and module summary (default)',
    '  modules          full parity table',
    '  update           check upstream Ceulen and this bundle on npm; --notes, --offline, --sync',
    '  upgrade          print the dsh plugin command for a newer bundle (--offline for cache only)',
    '  config           open the settings panel; --raw prints the JSON file',
    '  doctor           check services, credentials, binaries, compat flags and parity',
    '  tools            tool-schema prompt budget (count, KB, top 5, per module)',
    '  module list      list modules',
    '  module on|off    toggle a Ceulen module (needs /reload)',
  ].join('\n')
}

/** The Central status/settings surface for the bundle. */
export const name = 'ceulen-status'
export const inject = ['commands']

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()

  registerCommandSafe(ctx, {
    name: 'ceulen',
    description: 'Ceulen bundle status, upstream releases, modules and diagnostics',
    input: { hint: '[status|modules|tools|update|upgrade|config|doctor|module]' },
    async handler({ rawInput, agent }) {
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const head = args[0] ?? 'status'
      try {
        if (head === 'status') return ok(await statusText())
        if (head === 'modules' || head === 'module') {
          if (head === 'module') return await moduleText(args.slice(1))
          const parity = loadParity()
          return ok(formatParity(parity, loadSettingsSync().disabled))
        }
        if (head === 'tools') return ok(toolsText(ctx))
        if (head === 'update' || head === 'check') return ok(await updateText(args.slice(1)))
        if (head === 'upgrade') return ok(await upgradeText(args.slice(1)))
        if (head === 'config') {
          if (args.includes('--raw')) return ok(await configText())
          const filter = args.slice(1).find(entry => entry !== '--raw')
          if (filter !== undefined) return configPanel.text(filter)
          if (configPanel.open()) return ok('')
          return configPanel.text()
        }
        if (head === 'doctor') return ok(await doctorText(ctx, agent))
        if (head === 'help' || head === '--help' || head === '-h') return ok(helpText())
        return err(`unknown subcommand "${head}"\n\n${helpText()}`)
      } catch (error) {
        return err(`/ceulen ${head} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })

  // The central settings panel rides the status row: `/ceulen-config` (and
  // `/ceulen config`) open it, and the scene disappears with this module.
  const configPanel = applyConfig(ctx)

  // Root-activation status writes are rejected by the TUI; publish through
  // an injected child activation (same fix as the usage module).
  const publishUpstream = tuiStatusPublisher(ctx, STATUS_KEY)

  // Publish a cached "update available" line immediately, then refresh in the
  // background. The check is detached and unref'd: it must never delay or keep
  // alive a TUI/headless process.
  const timer = setTimeout(() => {
    void (async () => {
      await applyStatusLine(publishUpstream)
      const current = await currentUpstreamState()
      if (!settings.upstream.enabled) return
      if (!isCacheFresh(current, settings.upstream.intervalHours)) await refreshStatusLine(publishUpstream)
    })()
  }, 750)
  timer.unref?.()
  ctx.effect(() => () => clearTimeout(timer), 'ceulen upstream status timer')

  // Keep the line honest after an explicit update check in the same process.
  ctx.on('session/created', () => {
    // A session boundary starts a fresh measurement window; the live registry
    // still answers the count, and a /reload re-records the parameter bytes.
    resetToolBudget()
    void applyStatusLine(publishUpstream)
  })
}
