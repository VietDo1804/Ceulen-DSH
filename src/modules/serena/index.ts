import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, updateSettings } from '../../core/settings.js'
import { registerCommandSafe } from '../../core/tools.js'

export const name = 'ceulen-serena'

export const inject = ['commands']

const execFileAsync = promisify(execFile)

/**
 * The tools a model reaches for instead of read/grep. They stay in the tool
 * list: a navigation tool that has to be discovered first is never the one
 * that triggers the discovery, so held back it goes unused (upstream Ceulen
 * counted one Serena call in 56 sessions before it promoted them).
 */
export const NAVIGATION_TOOLS: readonly string[] = [
  'get_symbols_overview',
  'find_symbol',
  'find_referencing_symbols',
  'find_declaration',
  'find_implementations',
  'get_diagnostics_for_file',
  'search_for_pattern',
]

/**
 * Everything else the `ide-assistant` context declares on serena-agent 1.5.3
 * and 2.1.0 (listed over MCP on 2026-11-24): editing, memories, onboarding.
 * About 12k characters of schema that DSH's own edit tools and Munin already
 * cover, so `/serena cold` holds them behind ceulen_tools. A name the
 * installed version does not declare is skipped.
 */
export const COLD_TOOLS: readonly string[] = [
  'replace_content',
  'replace_in_files',
  'replace_symbol_body',
  'insert_after_symbol',
  'insert_before_symbol',
  'rename_symbol',
  'safe_delete_symbol',
  'write_memory',
  'read_memory',
  'list_memories',
  'delete_memory',
  'rename_memory',
  'edit_memory',
  'onboarding',
  'initial_instructions',
]

const PREFIX = 'mcp__serena__'

async function serenaVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('serena', ['--version'], { timeout: 3_000 })
    return stdout.trim().split('\n')[0] ?? 'present'
  } catch {
    return null
  }
}

/** Major version out of `serena --version` ("Serena 2.1.0"), or undefined when it cannot be read. */
export function serenaMajor(version: string | null): number | undefined {
  const match = version === null ? null : /(\d+)\.\d+/.exec(version)
  return match === null ? undefined : Number(match[1])
}

/**
 * The MCP row. serena-agent 2 answers a new config with the REPL interface:
 * one `serena_repl` tool and none of the `mcp__serena__<tool>` names. The
 * `--agent-interface tools` pair brings the separate tools back; version 1
 * rejects that option, so it is only written for 2 and later (and when the
 * version is unknown, since a fresh install gets 2).
 */
export function recipe(cwd: string, major: number | undefined): string {
  const args = ['start-mcp-server', '--context', 'ide-assistant', '--project', cwd.replace(/'/g, "''"), '--open-web-dashboard', 'False']
  if (major === undefined || major >= 2) args.push('--agent-interface', 'tools')
  return [
    '- id: mcp-serena',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: serena',
    '    transport: stdio',
    '    command: serena',
    `    args: [${args.map(arg => `'${arg}'`).join(', ')}]`,
    '    toolCallTimeoutMs: 120000',
  ].join('\n')
}

function recipeNote(major: number | undefined): string {
  if (major === undefined) return 'Written for serena-agent 2 (what a new install gets). On serena-agent 1.x drop the last two args: it rejects --agent-interface.'
  if (major >= 2) return 'serena-agent 2 defaults a new config to one serena_repl tool; "--agent-interface tools" keeps the separate mcp__serena__<tool> tools.'
  return 'serena-agent 1.x has no --agent-interface option. After an upgrade to 2.x run /serena recipe again and replace the row.'
}

/** How many of the cold tools `steering.cold` already lists, and the routes that hold them. */
function coldState(): { listed: number; routes: string } {
  const steering = loadSettingsSync().steering
  const listed = COLD_TOOLS.filter(tool => steering.cold.includes(PREFIX + tool)).length
  const routes = [...new Set([...steering.models, ...steering.coldModels])]
  return { listed, routes: routes.length === 0 ? 'no route (steering.models and steering.coldModels are empty)' : routes.join(', ') }
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('serena', settings)) return

  registerCommandSafe(ctx, {
    name: 'serena',
    description: 'Serena MCP recipe and status: binary, project index, the exact dsh-mcp-client row, and which Serena tools to hold cold',
    input: { hint: '[status|recipe|cold]' },
    async handler({ agent, rawInput }) {
      const action = rawInput.trim().split(/\s+/).filter(Boolean)[0] ?? 'status'
      const cwd = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd ?? process.cwd()
      if (action === 'cold') {
        const added: string[] = []
        const saved = await updateSettings(current => {
          for (const tool of COLD_TOOLS) {
            if (current.steering.cold.includes(PREFIX + tool)) continue
            current.steering.cold.push(PREFIX + tool)
            added.push(tool)
          }
        })
        return {
          kind: 'success',
          text: [
            added.length === 0
              ? `steering.cold already lists all ${COLD_TOOLS.length} Serena editing, memory and onboarding tools.`
              : `Added ${added.length} Serena tool(s) to steering.cold (${saved.steering.cold.length} entries now): ${added.join(', ')}.`,
            `Held for: ${coldState().routes}. They stay callable through ceulen_tools; restart the session to apply.`,
            `Kept in the tool list: ${NAVIGATION_TOOLS.join(', ')}.`,
          ].join('\n'),
        }
      }
      const version = await serenaVersion()
      const major = serenaMajor(version)
      const project = existsSync(join(cwd, '.serena', 'project.yml'))
      if (action === 'recipe' || action === 'config') {
        return {
          kind: 'success',
          text: [
            "Add this row to the profile's cordis.patch.yml, then restart:",
            '',
            recipe(cwd, major),
            '',
            recipeNote(major),
            `Then run /serena cold: it keeps the ${NAVIGATION_TOOLS.length} navigation tools in the tool list and holds the other ${COLD_TOOLS.length} (about 12k characters of schema) behind ceulen_tools.`,
          ].join('\n'),
        }
      }
      if (action !== 'status') return { kind: 'error', text: 'usage: /serena [status|recipe|cold]' }
      const state = coldState()
      return {
        kind: 'success',
        text: [
          `serena: ${version === null ? 'not found in PATH (install: uv tool install -p 3.11 serena-agent)' : version}`,
          `project index: ${project ? `present (${join(cwd, '.serena', 'project.yml')})` : 'not indexed; run "serena project index" in the workspace'}`,
          `cold tools: ${state.listed}/${COLD_TOOLS.length} of the editing, memory and onboarding tools are in steering.cold${state.listed === COLD_TOOLS.length ? '' : ' (run /serena cold)'}; held for ${state.routes}`,
          '',
          'DSH uses Serena through its native MCP client, not a bundled Python worker.',
          'After adding the MCP row and restarting, tools appear as mcp__serena__<tool>.',
          recipeNote(major),
          '',
          'Recipe:',
          recipe(cwd, major),
        ].join('\n'),
      }
    },
  })
}
