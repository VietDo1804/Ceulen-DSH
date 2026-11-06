import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { registerCommandSafe } from '../../core/tools.js'

export const name = 'ceulen-serena'

export const inject = ['commands']

const execFileAsync = promisify(execFile)

async function serenaVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('serena', ['--version'], { timeout: 3_000 })
    return stdout.trim().split('\n')[0] ?? 'present'
  } catch {
    return null
  }
}

function recipe(cwd: string): string {
  return [
    '- id: mcp-serena',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: serena',
    '    transport: stdio',
    '    command: serena',
    `    args: ['start-mcp-server', '--context', 'ide-assistant', '--project', '${cwd.replace(/'/g, "''")}']`,
    '    toolCallTimeoutMs: 120000',
  ].join('\n')
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('serena', settings)) return

  registerCommandSafe(ctx, {
    name: 'serena',
    description: 'Serena MCP recipe and status: binary, project index, and the exact dsh-mcp-client row',
    input: { hint: '[status|recipe]' },
    async handler({ agent, rawInput }) {
      const action = rawInput.trim().split(/\s+/).filter(Boolean)[0] ?? 'status'
      const cwd = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd ?? process.cwd()
      const version = await serenaVersion()
      const project = existsSync(join(cwd, '.serena', 'project.yml'))
      if (action === 'recipe' || action === 'config') {
        return { kind: 'success', text: `Add this row to the profile's cordis.patch.yml, then restart:\n\n${recipe(cwd)}` }
      }
      if (action !== 'status') return { kind: 'error', text: 'usage: /serena [status|recipe]' }
      return {
        kind: 'success',
        text: [
          `serena: ${version === null ? 'not found in PATH (install: uv tool install -p 3.11 serena-agent)' : version}`,
          `project index: ${project ? `present (${join(cwd, '.serena', 'project.yml')})` : 'not indexed; run `serena project index` in the workspace'}`,
          '',
          'DSH uses Serena through its native MCP client, not a bundled Python worker.',
          'After adding the MCP row and restarting, tools appear as mcp__serena__<tool>.',
          '',
          'Recipe:',
          recipe(cwd),
        ].join('\n'),
      }
    },
  })
}
