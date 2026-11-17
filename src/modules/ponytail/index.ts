import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, PONYTAIL_LEVELS, updateSettings, type PonytailLevel } from '../../core/settings.js'
import { registerCommandSafe, registerPromptSection } from '../../core/tools.js'
import { getPonytailInstructions } from '../../vendor/ceulen/ponytail/instructions.js'

export const name = 'ceulen-ponytail'
export const inject = ['commands', 'systemPrompt']

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('ponytail', settings)) return

  let level: PonytailLevel = settings.ponytail.level

  registerPromptSection(ctx, {
    name: 'ceulen:ponytail',
    order: 120,
    text: () => (level === 'off' ? '' : getPonytailInstructions(level)),
  })

  registerCommandSafe(ctx, {
    name: 'ponytail',
    description: 'Lazy-senior-dev discipline: off, lite, full, or ultra',
    input: { hint: '[off|lite|full|ultra|status]' },
    async handler({ rawInput }) {
      const value = rawInput.trim().toLowerCase()
      if (value === '' || value === 'status') {
        return {
          kind: 'success',
          text: `Ponytail: ${level}${level === 'off' ? ' (inactive)' : ' — simplest solution that works; stdlib first; no speculative abstraction.'}\nSwitch with /ponytail off|lite|full|ultra.`,
        }
      }
      if (!(PONYTAIL_LEVELS as readonly string[]).includes(value)) {
        return { kind: 'error', text: `unknown level "${value}". Use off, lite, full, or ultra.` }
      }
      level = value as PonytailLevel
      await updateSettings(current => {
        current.ponytail.level = level
      })
      return {
        kind: 'success',
        text: level === 'off'
          ? 'Ponytail off. Normal engineering mode.'
          : `Ponytail ${level}. The discipline applies from the next request.`,
      }
    },
  })

  // Skill aliases match Ceulen's command surface. The DSH skill tool owns the
  // actual body; these commands keep the familiar entry points discoverable.
  for (const skill of ['ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']) {
    registerCommandSafe(ctx, {
      name: skill,
      description: `Load the ${skill} skill`,
      handler() {
        return { kind: 'success', text: `Use the skill tool with name "${skill}" to load its full instructions.` }
      },
    })
  }
}
