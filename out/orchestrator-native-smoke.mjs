import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installOrchestrator } from '../lib/modules/subagent/orchestrator.js'

const core = process.env.ORCHESTRATOR_DSH_ROOT
assert(core, 'Set ORCHESTRATOR_DSH_ROOT to the installed @deepseek-ai/dsh package')
const require = createRequire(`${core}/package.json`)
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const ctx = new Context()
const prompt = new SystemPrompt(ctx, { includeHarnessIdentity: false })
const commands = new Map()
const messages = []
// Only command registration and spawning availability are stubbed; assembly is the real native service.
installOrchestrator({
  systemPrompt: prompt,
  commands: { register(command) { commands.set(command.name, command); return () => commands.delete(command.name) } },
  tools: { get: () => ({ name: 'delegate' }) },
  get: () => ({ startActivation() {} }),
  effect: ctx.effect.bind(ctx),
  on: ctx.on.bind(ctx),
})
const lead = { session: { id: 'native-smoke-lead' }, followup(message) { messages.push(message) } }
const child = { session: { id: 'native-smoke-child', header: { parentSession: lead.session.id } } }
const command = commands.get('orchestrator')
const text = async scope => (await prompt.assemble({ scope })).sections.map(section => section.text).join('\n')
assert.equal((await text(lead)).includes('ORCHESTRATOR MODE ACTIVE'), false)
assert.equal(command.handler({ agent: lead, rawInput: 'Check {{literal}} input' }).kind, 'success')
assert.equal(messages[0].content[0].text, 'Check {{literal}} input')
assert.match(await text(lead), /ORCHESTRATOR MODE ACTIVE/)
assert.equal((await text(child)).includes('ORCHESTRATOR MODE ACTIVE'), false)
assert.equal((await text({})).includes('ORCHESTRATOR MODE ACTIVE'), false)
assert.equal(command.handler({ agent: lead, rawInput: 'off' }).kind, 'success')
assert.equal((await text(lead)).includes('ORCHESTRATOR MODE ACTIVE'), false)
console.log('Native SystemPrompt assembly: scoped on/task/off and child isolation passed')
