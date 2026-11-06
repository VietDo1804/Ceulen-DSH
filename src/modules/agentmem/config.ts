// AgentMem config resolution.
//
// The Munin vendor resolver reads MUNIN_* / the `munin` section and a trusted
// project file; AgentMem must do none of those — it is pinned to one opimem
// server, so there is no default endpoint, no project file and no fallback.
// Only the three-field precedence and the vendor URL validator are shared.

import { credential } from '../../core/credentials.js'
import type { CeulenSettings } from '../../core/settings.js'
import { normalizeBaseUrl } from '../../vendor/ceulen/munin/helpers.js'

export const AGENTMEM_ENV_KEYS = ['AGENTMEM_API_KEY', 'AGENTMEM_PROJECT', 'AGENTMEM_BASE_URL'] as const

export type AgentMemConfigSource = 'param' | 'env' | 'store' | 'global'

export interface AgentMemResolvedConfig {
  apiKey: string
  projectId: string
  baseUrl: string
  sources: { apiKey: AgentMemConfigSource; projectId: AgentMemConfigSource; baseUrl: AgentMemConfigSource }
}

function pick(
  param: string | undefined,
  env: string | undefined,
  stored: string | undefined,
  fromSettings: string | undefined,
): { value: string | undefined; source: AgentMemConfigSource } {
  if (param !== undefined) return { value: param, source: 'param' }
  if (env !== undefined) return { value: env, source: 'env' }
  if (stored !== undefined) return { value: stored, source: 'store' }
  if (fromSettings !== undefined) return { value: fromSettings, source: 'global' }
  return { value: undefined, source: 'global' }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Precedence per field: explicit tool param > AGENTMEM_* env > DSH credential
 * store (key only) > the `agentmem` settings section. There is no default base
 * URL: an unconfigured AgentMem refuses to run rather than guess a server, and
 * a `base_url` override without its own `api_key` throws (a caller that
 * redirects the endpoint must own the credential).
 */
export function resolveAgentMemConfig(params: Record<string, unknown> = {}, settings: CeulenSettings): AgentMemResolvedConfig {
  const paramKey = text(params.api_key)
  const paramUrl = text(params.base_url)
  const paramProject = text(params.project)
  if (paramUrl !== undefined && paramKey === undefined) {
    throw new Error('An explicit api_key is required when overriding base_url')
  }
  const storedKey = paramKey === undefined ? credential('AGENTMEM_API_KEY').value : undefined
  const apiKey = pick(paramKey, text(process.env.AGENTMEM_API_KEY), storedKey, undefined)
  const projectId = pick(paramProject, text(process.env.AGENTMEM_PROJECT), undefined, text(settings.agentmem.project))
  const baseUrl = pick(paramUrl, text(process.env.AGENTMEM_BASE_URL), undefined, text(settings.agentmem.baseUrl))

  if (apiKey.value === undefined) {
    throw new Error('AgentMem API key is not configured. Set it via /ceulen-config → Memory → AgentMem (DSH credential store), the AGENTMEM_API_KEY env, or a per-call api_key.')
  }
  if (projectId.value === undefined) {
    throw new Error('AgentMem project is not configured. Set it via /ceulen-config → Memory → AgentMem, the AGENTMEM_PROJECT env, or a per-call project.')
  }
  if (baseUrl.value === undefined) {
    throw new Error('AgentMem base URL is not configured. Set it via /ceulen-config → Memory → AgentMem or the AGENTMEM_BASE_URL env.')
  }
  return {
    apiKey: apiKey.value,
    projectId: projectId.value,
    baseUrl: normalizeBaseUrl(baseUrl.value),
    sources: { apiKey: apiKey.source, projectId: projectId.source, baseUrl: baseUrl.source },
  }
}
