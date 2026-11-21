import { readFileSync } from 'node:fs'
import { writeJsonAtomic } from './fsx.js'
import { settingsPath } from './paths.js'

export const PONYTAIL_LEVELS = ['off', 'lite', 'full', 'ultra'] as const
export type PonytailLevel = (typeof PONYTAIL_LEVELS)[number]
/** `auto` picks off/keep/lite/strict per user request through the classifier route. */
export const UX_MODES = ['off', 'lite', 'strict', 'auto'] as const
export type UxMode = (typeof UX_MODES)[number]
/** Behaviour-scoped rule guards: off, audit (log), or enforce (deny). */
export const RULE_GUARD_MODES = ['off', 'audit', 'enforce'] as const
export type RuleGuardMode = (typeof RULE_GUARD_MODES)[number]
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface CeulenSettings {
  schemaVersion: 1
  disabled: string[]
  upstream: {
    enabled: boolean
    intervalHours: number
  }
  advisor: {
    provider: string | null
    model: string | null
    reasoningEffort: ReasoningEffort | null
    fallbacks: string[]
    skipModels: string[]
    watch: boolean
    showStatus: boolean
    minToolCalls: number
  }
  classifier: {
    provider: string | null
    model: string | null
    audit: boolean
    /** Block irreversible bash when the gate score is below 0.5. */
    enforce: boolean
    /** provider/model routes tried in order when the primary route fails. */
    fallbacks: string[]
  }
  munin: {
    project: string
    baseUrl: string
    allowProjectConfig: boolean
    /**
     * Secondary endpoint, tried when the primary is unreachable (munin cloud ->
     * the opimem bridge on the Pi). Empty baseUrl = failover off. The key never lives in
     * this file: it resolves from MUNIN_FALLBACK_API_KEY (env or DSH store).
     */
    fallback: {
      baseUrl: string
    }
    /** First-turn memory brief: evidence, not instructions (default off). */
    brief: {
      enabled: boolean
      maxChars: number
      recencyDays: number
    }
  }
  /**
   * Second memory family: one opimem server (same wire protocol as Munin) on
   * its own project and key, so `munin_*` and `agentmem_*` can point at two
   * servers at once. No fallback and no project config by design — this store
   * sits on the LAN and answers ~50x faster than the cloud; since 2026-11-02
   * it holds the Pi replica that `munin.fallback` fails over to.
   */
  agentmem: {
    project: string
    baseUrl: string
    /** First-turn memory brief: evidence, not instructions (default off). */
    brief: {
      enabled: boolean
      maxChars: number
      recencyDays: number
    }
  }
  cron: {
    enabled: boolean
    tickMs: number
  }
  /** Prompt-budget knobs for the tool surface. */
  tools: {
    /** Tool names held out of the prompt and reachable through `ceulen_tools`. */
    cold: string[]
  }
  rules: {
    /** `when-*` guards: `audit` logs matches, `enforce` denies `when-action: deny`. */
    guards: RuleGuardMode
  }
  ponytail: {
    level: PonytailLevel
  }
  ux: {
    mode: UxMode
  }
  /** Model routes that switch a session mode on by default. */
  agentMode: {
    /** `provider/model[:effort]` routes that load Agent Mode without a command. */
    models: string[]
  }
  web: Record<string, unknown>
  a2a: {
    peers: unknown[]
  }
  gh: {
    enabled: boolean
  }
  codemode: {
    enabled: boolean
    /** Hint after N consecutive single read-only steps; 0 disables. */
    chainHintAfter: number
  }
  rtk: {
    enabled: boolean
  }
  /** Harness playbook and bash-lookup redirect for lead routes matching `models` (substring; `*` = all; [] = off). */
  steering: {
    models: string[]
    /** `redirect` denies bash calls that only grep/cat/sed -n/find files and names the dedicated call; `off` lets them run. */
    bashLookups: 'redirect' | 'off'
    /** Tool names held out of the prompt (behind `ceulen_tools`) for these routes only; `tools.cold` applies to every route. */
    cold: string[]
  }
  subagent: {
    /** Function alias (`fast`, `coder`, `smart`) -> ordered `provider/model[:effort]` chain. */
    roles: Record<string, string[]>
    /** Per-role selector override; beats the role's own function alias. */
    models: Record<string, string>
    /** Per-role reasoning-effort override; a matched chain suffix still wins. */
    thinking: Record<string, ReasoningEffort>
    /** Per-role DSH agent preset; omission inherits the parent's composition. */
    presets: Record<string, string>
    /** Delegation notices for lead routes matching `models` (substring of provider/model; `*` = all; [] = off). */
    nudge: {
      models: string[]
      /** Recon notice after N local discovery calls in one turn with no delegation; 0 disables. */
      discoveryAfter: number
      /** Review notice once a turn has edited N distinct files with no reviewer; 0 disables. */
      reviewAfterFiles: number
      /** Recon notice waits for this much lead context (tokens); 0 = no floor. */
      reconMinContext: number
    }
  }
  /** Per-phase routes over the native plan mode: plan on one model, execute on another. */
  plan: {
    /** Route used while plan mode is active; empty inherits the client route. */
    model: string
    /** Route used once a plan was submitted; empty inherits the client route. */
    implement: string
    /** Ordered provider/model[:effort] alternatives for each phase. */
    fallbacks: string[]
    implementFallbacks: string[]
  }
  usage: {
    enabled: boolean
    showStatus: boolean
    intervalMinutes: number
    providers: string[]
  }
  agentbar: {
    /** Open the Subagents side panel when a delegate starts (needs the tui-panel patch). */
    autoOpen: boolean
  }
  [key: string]: unknown
}

export function defaultSettings(): CeulenSettings {
  return {
    schemaVersion: 1,
    disabled: [],
    upstream: { enabled: true, intervalHours: 24 },
    // ponytail: one shipped default (Z.AI GLM-5.3 at max thinking); clear the
    // panel's route row to fall back to the parent agent's route.
    advisor: { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max', fallbacks: [], skipModels: ['gpt-6-astra'], watch: false, showStatus: true, minToolCalls: 1 },
    classifier: { provider: null, model: null, audit: true, enforce: false, fallbacks: [] },
    munin: { project: '', baseUrl: '', allowProjectConfig: false, fallback: { baseUrl: '' }, brief: { enabled: false, maxChars: 600, recencyDays: 30 } },
    agentmem: { project: '', baseUrl: '', brief: { enabled: false, maxChars: 600, recencyDays: 30 } },
    cron: { enabled: true, tickMs: 30_000 },
    // ponytail: the cold half is measured, not guessed — see docs/live-verification.md
    // (M4-2). These 12 tools were 6.3 KB of a 16.5 KB surface and none is named by
    // an always-on prompt section.
    tools: {
      cold: [
        'a2a_call', 'a2a_list', 'a2a_peers', 'a2a_status',
        'jfind',
        'munin_delete', 'munin_share',
        // `web_interact` stays in the prompt: 400 calls through ceulen_tools in
        // nine days of November 2026 sessions, 18 of them argument-shape errors
        // because a cold tool shows the model no schema.
        // `web_screenshot` too: 48 calls in 19 sessions is at the break-even
        // for its 0.9 KB, and it belongs to the same capture flow.
        'web_map', 'web_pdf',
        // Measured 2026-10-31 on the 40.9 KB / 53-tool TUI surface: these add
        // ~9.1 KB and are named by no always-on prompt section. Native names
        // are hidden per agent (tools.restrict); ceulen ones at register time.
        'notebooklm', 'web_status', 'web_chat',
        'munin_capabilities', 'munin_list', 'munin_recent',
        'munin_versions', 'munin_diff', 'munin_rollback',
        // AgentMem is the default store: only its search/get/store earn prompt
        // bytes. Munin is the backup — its one store call stays warm; its reads
        // would just duplicate agentmem_search/get.
        'munin_search', 'munin_get',
        'agentmem_capabilities', 'agentmem_list', 'agentmem_recent',
        'agentmem_versions', 'agentmem_diff', 'agentmem_rollback',
        'agentmem_delete', 'agentmem_share',
        // `read_image` stays in the prompt: 720 direct calls in nine days of
        // November 2026 sessions against 389 bytes of schema. A tool the model
        // reaches for by name every session is not cold.
        'workflow', 'list_agents', 'interrupt_agent',
        // Audit of 142 sessions, 1-9 Nov 2026: 0-2 direct calls each, ~7.7 KB
        // together with web_chat. One wasted request re-reads the whole
        // context (~151k tokens), about what a 1 KB schema costs over 600
        // requests, so a tool is cold when fewer than bytes x 0.019 of those
        // sessions used it.
        'plugin_manager', 'github', 'cron',
        'validate_schema', 'list_subagent_models', 'related_files', 'working_directory',
        // MCP resource tools: 0 calls in the same audit. The MCP prompt section
        // still names them, so a direct call gets the held-tool hint.
        'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
      ],
    },
    rules: { guards: 'audit' },
    ponytail: { level: 'full' },
    ux: { mode: 'off' },
    // Agent Mode is a translation role: no route loads it by default.
    agentMode: { models: [] },
    web: {},
    a2a: { peers: [] },
    gh: { enabled: true },
    codemode: { enabled: true, chainHintAfter: 2 },
    rtk: { enabled: true },
    steering: { models: ['deepseek-v4.1-flash', 'deepseek-flash'], bashLookups: 'redirect', cold: [] },
    // ponytail: `*` = inherit the parent route, so a fresh install assumes no provider.
    subagent: { roles: { fast: ['*'], coder: ['*'], smart: ['*'] }, models: {}, thinking: {}, presets: {}, nudge: { models: ['deepseek-v4.1-flash', 'deepseek-flash'], discoveryAfter: 10, reviewAfterFiles: 3, reconMinContext: 60_000 } },
    // Both phases inherit the client's model until a route is configured.
    plan: { model: '', implement: '', fallbacks: [], implementFallbacks: [] },
    usage: { enabled: true, showStatus: true, intervalMinutes: 5, providers: [] },
    agentbar: { autoOpen: true },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim()) : []
}

/** `provider/model[:effort]` without the effort suffix. */
export function routeBase(route: string): string {
  const colon = route.lastIndexOf(':')
  return colon < 0 ? route.trim() : route.slice(0, colon).trim()
}

/**
 * One fallback entry per model: a list that names the same provider/model with
 * and without an `:effort` suffix (stale panel writes, hand-edited files) keeps
 * only its first entry.
 */
export function dedupeRoutes(routes: readonly string[]): string[] {
  const seen = new Set<string>()
  return routes.filter(route => {
    const base = routeBase(route)
    if (seen.has(base)) return false
    seen.add(base)
    return true
  })
}

/** Role-function chain map: string (comma chain) or array -> trimmed non-empty entries. */
function chainRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(value)) {
    const name = key.trim()
    if (name.length === 0) continue
    const list = typeof entry === 'string' ? entry.split(',') : Array.isArray(entry) ? entry : []
    const chain = list.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item.length > 0)
    if (chain.length > 0) out[name] = chain
  }
  return out
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim().length > 0) out[key.trim()] = entry.trim()
  }
  return out
}

function effortRecord(value: unknown): Record<string, ReasoningEffort> {
  if (!isRecord(value)) return {}
  const out: Record<string, ReasoningEffort> = {}
  for (const [key, entry] of Object.entries(value)) {
    const effort = oneOf(REASONING_EFFORTS, entry, null)
    if (effort !== null) out[key.trim()] = effort
  }
  return out
}

function oneOf<T extends string, F>(allowed: readonly T[], value: unknown, fallback: F): T | F {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback
}

/**
 * Merge a raw settings document over the defaults, coercing every known field
 * and preserving unknown top-level/section keys for forward compatibility.
 * `env: false` leaves out the process overrides (`CEULEN_DISABLED`,
 * `CEULEN_UPSTREAM_CHECK`): that is the document an edit must write back.
 */
export function normalizeSettings(raw: unknown, env = true): CeulenSettings {
  const base = defaultSettings()
  if (!isRecord(raw)) return base

  const disabled = new Set(strArray(raw.disabled))
  for (const entry of (env ? process.env.CEULEN_DISABLED ?? '' : '').split(',')) {
    const name = entry.trim()
    if (name.length > 0) disabled.add(name)
  }

  const upstream = isRecord(raw.upstream) ? raw.upstream : {}
  const advisor = isRecord(raw.advisor) ? raw.advisor : {}
  const classifier = isRecord(raw.classifier) ? raw.classifier : {}
  const munin = isRecord(raw.munin) ? raw.munin : {}
  const brief = isRecord(munin.brief) ? munin.brief : {}
  const muninFallback = isRecord(munin.fallback) ? munin.fallback : {}
  const agentmem = isRecord(raw.agentmem) ? raw.agentmem : {}
  const agentmemBrief = isRecord(agentmem.brief) ? agentmem.brief : {}
  const cron = isRecord(raw.cron) ? raw.cron : {}
  const rules = isRecord(raw.rules) ? raw.rules : {}
  const ponytail = isRecord(raw.ponytail) ? raw.ponytail : {}
  const ux = isRecord(raw.ux) ? raw.ux : {}
  const a2a = isRecord(raw.a2a) ? raw.a2a : {}
  const gh = isRecord(raw.gh) ? raw.gh : {}
  const codemode = isRecord(raw.codemode) ? raw.codemode : {}
  const rtk = isRecord(raw.rtk) ? raw.rtk : {}
  const steering = isRecord(raw.steering) ? raw.steering : {}
  const subagent = isRecord(raw.subagent) ? raw.subagent : {}
  const nudge = isRecord(subagent.nudge) ? subagent.nudge : {}
  const plan = isRecord(raw.plan) ? raw.plan : {}
  const usage = isRecord(raw.usage) ? raw.usage : {}
  const agentbar = isRecord(raw.agentbar) ? raw.agentbar : {}
  const agentMode = isRecord(raw.agentMode) ? raw.agentMode : {}

  const settings: CeulenSettings = {
    ...base,
    ...raw,
    schemaVersion: 1,
    disabled: [...disabled],
    upstream: {
      enabled: bool(upstream.enabled, base.upstream.enabled) && !(env && process.env.CEULEN_UPSTREAM_CHECK === '0'),
      intervalHours: num(upstream.intervalHours, base.upstream.intervalHours, 1, 24 * 30),
    },
    advisor: {
      provider: nullableStr(advisor.provider),
      model: nullableStr(advisor.model),
      reasoningEffort: oneOf(REASONING_EFFORTS, advisor.reasoningEffort, null),
      fallbacks: dedupeRoutes(strArray(advisor.fallbacks)),
      skipModels: strArray(advisor.skipModels ?? base.advisor.skipModels),
      watch: bool(advisor.watch, base.advisor.watch),
      showStatus: bool((advisor as Record<string, unknown>).showStatus, base.advisor.showStatus),
      minToolCalls: num(advisor.minToolCalls, base.advisor.minToolCalls, 0, 100),
    },
    classifier: {
      provider: nullableStr(classifier.provider),
      model: nullableStr(classifier.model),
      audit: bool(classifier.audit, base.classifier.audit),
      enforce: bool(classifier.enforce, base.classifier.enforce),
      fallbacks: dedupeRoutes(strArray(classifier.fallbacks)),
    },
    munin: {
      project: str(munin.project, base.munin.project),
      baseUrl: str(munin.baseUrl, base.munin.baseUrl),
      allowProjectConfig: bool(munin.allowProjectConfig, base.munin.allowProjectConfig),
      fallback: {
        baseUrl: str(muninFallback.baseUrl, base.munin.fallback.baseUrl),
      },
      brief: {
        enabled: bool(brief.enabled, base.munin.brief.enabled),
        maxChars: num(brief.maxChars, base.munin.brief.maxChars, 200, 4_000),
        recencyDays: num(brief.recencyDays, base.munin.brief.recencyDays, 1, 365),
      },
    },
    agentmem: {
      project: str(agentmem.project, base.agentmem.project),
      baseUrl: str(agentmem.baseUrl, base.agentmem.baseUrl),
      brief: {
        enabled: bool(agentmemBrief.enabled, base.agentmem.brief.enabled),
        maxChars: num(agentmemBrief.maxChars, base.agentmem.brief.maxChars, 200, 4_000),
        recencyDays: num(agentmemBrief.recencyDays, base.agentmem.brief.recencyDays, 1, 365),
      },
    },
    cron: {
      enabled: bool(cron.enabled, base.cron.enabled),
      tickMs: num(cron.tickMs, base.cron.tickMs, 5_000, 600_000),
    },
    tools: {
      // Absent keeps the measured default; an explicit [] turns hold-back off.
      cold: Array.isArray((isRecord(raw.tools) ? raw.tools : {}).cold) ? strArray((raw.tools as Record<string, unknown>).cold) : base.tools.cold,
    },
    rules: {
      guards: oneOf(RULE_GUARD_MODES, rules.guards, base.rules.guards),
    },
    ponytail: { level: oneOf(PONYTAIL_LEVELS, ponytail.level, base.ponytail.level) },
    ux: { mode: oneOf(UX_MODES, ux.mode, base.ux.mode) },
    agentMode: {
      // An explicit [] turns the default off; absent keeps the shipped routes.
      models: Array.isArray(agentMode.models) ? dedupeRoutes(strArray(agentMode.models)) : base.agentMode.models,
    },
    web: isRecord(raw.web) ? raw.web : {},
    a2a: { peers: Array.isArray(a2a.peers) ? a2a.peers : [] },
    gh: { enabled: bool(gh.enabled, base.gh.enabled) },
    codemode: {
      enabled: bool(codemode.enabled, base.codemode.enabled),
      chainHintAfter: num((codemode as Record<string, unknown>).chainHintAfter, base.codemode.chainHintAfter, 0, 20),
    },
    rtk: { enabled: bool(rtk.enabled, base.rtk.enabled) },
    steering: {
      models: Array.isArray(steering.models) ? strArray(steering.models) : base.steering.models,
      bashLookups: steering.bashLookups === 'off' ? 'off' : 'redirect',
      cold: Array.isArray(steering.cold) ? strArray(steering.cold) : base.steering.cold,
    },
    subagent: {
      roles: { ...base.subagent.roles, ...chainRecord(subagent.roles) },
      models: stringRecord(subagent.models),
      thinking: effortRecord(subagent.thinking),
      presets: stringRecord(subagent.presets),
      nudge: {
        models: Array.isArray(nudge.models) ? strArray(nudge.models) : base.subagent.nudge.models,
        discoveryAfter: num(nudge.discoveryAfter, base.subagent.nudge.discoveryAfter, 0, 50),
        reviewAfterFiles: num(nudge.reviewAfterFiles, base.subagent.nudge.reviewAfterFiles, 0, 50),
        reconMinContext: num(nudge.reconMinContext, base.subagent.nudge.reconMinContext, 0, 1_000_000),
      },
    },
    plan: {
      model: str(plan.model, base.plan.model).trim(),
      implement: str(plan.implement, base.plan.implement).trim(),
      fallbacks: dedupeRoutes(strArray(plan.fallbacks)),
      implementFallbacks: dedupeRoutes(strArray(plan.implementFallbacks)),
    },
    usage: {
      enabled: bool(usage.enabled, base.usage.enabled),
      showStatus: bool(usage.showStatus, base.usage.showStatus),
      intervalMinutes: num(usage.intervalMinutes, base.usage.intervalMinutes, 1, 60),
      providers: strArray(usage.providers),
    },
    agentbar: {
      autoOpen: bool(agentbar.autoOpen, base.agentbar.autoOpen),
    },
  }
  return settings
}

/** Read the settings document synchronously; malformed/missing → defaults. */
export function loadSettingsSync(env = true): CeulenSettings {
  try {
    const text = readFileSync(settingsPath(), 'utf8')
    return normalizeSettings(JSON.parse(text), env)
  } catch {
    return normalizeSettings(undefined, env)
  }
}

export async function saveSettings(settings: CeulenSettings): Promise<void> {
  await writeJsonAtomic(settingsPath(), settings, 0o600)
}

export async function updateSettings(mutator: (settings: CeulenSettings) => void): Promise<CeulenSettings> {
  // Without env overrides, or a one-off CEULEN_DISABLED would be saved for good.
  const settings = loadSettingsSync(false)
  mutator(settings)
  await saveSettings(settings)
  return settings
}

export function isModuleEnabled(name: string, settings = loadSettingsSync()): boolean {
  return !settings.disabled.includes(name)
}

export async function setModuleEnabled(name: string, enabled: boolean): Promise<CeulenSettings> {
  return updateSettings(settings => {
    const set = new Set(settings.disabled)
    if (enabled) set.delete(name)
    else set.add(name)
    settings.disabled = [...set]
  })
}

/** Reject obvious secret-bearing keys in settings; secrets belong in env. */
export function looksSecretKey(key: string): boolean {
  return /(?:api[-_]?key|token|secret|password|credential)/i.test(key)
}

/** Copy with secret-looking values masked; used by `/ceulen config`. */
export function redactSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSettings)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = looksSecretKey(key) && typeof entry === 'string' ? '[redacted]' : redactSettings(entry)
    }
    return out
  }
  return value
}
