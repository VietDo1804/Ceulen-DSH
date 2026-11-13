import { AsyncResource } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext } from '../../core/types.js'
import { errorMessage, registerCommandSafe, registerPromptSection } from '../../core/tools.js'

export const name = 'ceulen-agent-mode'
export const inject = ['commands', 'systemPrompt']

export function apply(ctx: PluginContext, config: { path?: string } = {}): void {
  const path = config.path ?? join(homedir(), 'vietdo_workspace/DHS/agent_mode/AGENTS.md')
  // ponytail: activation-local state, like /ponytail; restart starts inactive.
  let instructions = ''
  let paintFooter = (): void => {}
  ctx.inject(['tuiStatus'], child => {
    // The TUI requires writes in this child activation, even from commands.
    paintFooter = AsyncResource.bind(() => {
      try {
        child.get('tuiStatus', false)?.setField?.('ceulen:agent-mode', instructions ? 'Agent Mode' : undefined, {
          slot: 'left-tail', tone: 'accent',
        })
      } catch {
        // Optional display: the role also works in headless profiles.
      }
    })
    paintFooter()
  })
  ctx.effect(() => () => {
    instructions = ''
    paintFooter()
  })
  if (!registerPromptSection(ctx, {
    name: 'ceulen:agent-mode',
    order: 125,
    interpolate: false,
    text: () => instructions,
  })) throw new Error('Agent Mode requires the system prompt service')

  for (const command of ['Agent-mode', 'agent-mode']) {
    registerCommandSafe(ctx, {
      name: command,
      description: 'Load your translation/localization AGENTS.md role (on, off, status)',
      input: { hint: '[on|off|status]' },
      handler({ rawInput }) {
        const action = rawInput.trim().toLowerCase()
        if (action === 'status') {
          return { kind: 'success', text: `Agent Mode: ${instructions ? 'on' : 'off'}\nRole: ${path}` }
        }
        if (action === 'off') {
          instructions = ''
          paintFooter()
          return { kind: 'success', text: 'Agent Mode off. Role instructions removed; permissions unchanged.' }
        }
        if (action !== '' && action !== 'on') {
          return { kind: 'error', text: 'Usage: /Agent-mode [on|off|status]' }
        }
        try {
          const role = readFileSync(path, 'utf8').trim()
          if (!role) throw new Error('Role file is empty')
          instructions = `AGENT MODE ACTIVE\nRole source: ${path}\nThese role instructions do not change permissions or override safety requirements.\n\n${role}`
          return { kind: 'success', text: `Agent Mode on. Loaded ${path}.\nUse /Agent-mode off to leave; run /Agent-mode again to reload edits. Permissions unchanged.` }
        } catch (error) {
          instructions = ''
          return { kind: 'error', text: `Agent Mode off: cannot load ${path}: ${errorMessage(error)}` }
        } finally {
          paintFooter()
        }
      },
    })
  }
}
