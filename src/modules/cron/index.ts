import { randomUUID } from 'node:crypto'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenHome } from '../../core/paths.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerToolSafe } from '../../core/tools.js'
import {
  addJob,
  dueJobs,
  findJob,
  jobsDir,
  loadJobs,
  markFired,
  removeJob,
  saveJobs,
  setJobEnabled,
  setJobResult,
  type CronJob,
} from '../../vendor/ceulen/cron/jobs.js'
import { nextFires, validateSchedule } from '../../vendor/ceulen/cron/schedule.js'
import { appendLog, logLine } from '../../core/log.js'

export const name = 'ceulen-cron'
export const inject = ['tools', 'commands']

const ACTIONS = ['list', 'add', 'remove', 'run', 'enable', 'disable', 'test', 'export', 'logs'] as const

function dir(): string {
  return jobsDir(ceulenHome())
}

function formatJob(job: CronJob): string {
  const next = new Date(job.nextRun)
  const status = job.enabled ? 'on' : 'off'
  return `${job.name.padEnd(20)} ${status.padEnd(3)} ${job.schedule.padEnd(18)} next ${Number.isNaN(next.getTime()) ? '?' : next.toLocaleString()}  ${clampText(job.prompt, 80)}`
}

function jobs(): CronJob[] {
  return loadJobs(dir())
}

function persist(list: CronJob[]): void {
  saveJobs(dir(), list)
}

function deliver(agent: AgentLike, job: CronJob): void {
  const message = {
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `[cron ${job.name}] ${job.prompt}` }],
    source: { kind: 'cron', form: 'notice', summary: `cron ${job.name}` },
  }
  try {
    agent.followup(message)
  } catch {
    agent.followup({ ...message, source: { kind: 'user' } })
  }
}

function exportCrontab(list: CronJob[]): string {
  return list.filter(job => job.enabled).map(job => `${job.schedule} cd ${JSON.stringify(job.cwd)} && dsh --profile "${process.env.DSH_PROFILE ?? 'tui'}" ${JSON.stringify(job.prompt)} # ceulen-cron:${job.name}`).join('\n')
}

async function logsText(lines = 30): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(`${ceulenHome()}/logs/cron.log`, 'utf8')
    return text.trim().split('\n').slice(-lines).join('\n') || '(no cron log entries)'
  } catch {
    return '(no cron log entries)'
  }
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('cron', settings) || !settings.cron.enabled) return

  const agents = new Map<string, AgentLike>()
  const noteAgent = (agent: AgentLike | undefined): void => {
    if (agent === undefined) return
    agents.set(String(agent.session.id), agent)
  }
  ctx.on('agent/created', (payload: { agent?: AgentLike }) => noteAgent(payload?.agent))
  ctx.on('agent/status', (payload: { agent?: AgentLike }) => noteAgent(payload?.agent))
  ctx.on('agent/disposed', (payload: { agent?: AgentLike }) => {
    if (payload?.agent !== undefined) agents.delete(String(payload.agent.session.id))
  })

  const firing = new Set<string>()
  const currentAgent = (): AgentLike | undefined => [...agents.values()].at(-1)

  const tick = async (): Promise<void> => {
    const list = jobs()
    const now = Date.now()
    const due = dueJobs(list, now)
    if (due.length === 0) return
    const agent = currentAgent()
    if (agent === undefined) return
    for (const job of due) {
      if (firing.has(job.name)) continue
      firing.add(job.name)
      try {
        deliver(agent, job)
        markFired(job, now)
        const latest = loadJobs(dir())
        const index = latest.findIndex(entry => entry.name === job.name)
        if (index >= 0) latest[index] = job
        persist(latest)
        setJobResult(dir(), job.name, 'ok')
        await appendLog('cron', `fired ${job.name}: ${job.prompt}`)
      } catch (error) {
        setJobResult(dir(), job.name, 'fail', error instanceof Error ? error.message : String(error))
        await appendLog('cron', `failed ${job.name}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        firing.delete(job.name)
      }
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, settings.cron.tickMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'ceulen cron timer')
  setTimeout(() => void tick(), 1_000).unref?.()

  const tool = ceulenTool({
    name: 'cron',
    description: 'Manage scheduled prompts that fire into this session. Actions: list, add, remove, run, enable, disable, test (preview next fire times), export (crontab lines), logs.',
    parameters: objectSchema({
      action: { type: 'string', enum: [...ACTIONS], description: 'Operation.' },
      name: { type: 'string', description: 'Job name (letters, digits, _ . -).' },
      schedule: { type: 'string', description: 'Five-field Vixie cron expression (add).' },
      prompt: { type: 'string', description: 'Prompt delivered as a follow-up turn (add).' },
    }, ['action']),
    outputSchema: { type: 'string' },
    async execute(raw) {
      const args = raw as { action: string; name?: string; schedule?: string; prompt?: string }
      const list = jobs()
      if (args.action === 'list') {
        return list.length === 0 ? 'No cron jobs. Use action:"add" with name, schedule, and prompt.' : list.map(formatJob).join('\n')
      }
      if (args.action === 'add') {
        const job = addJob(dir(), { name: args.name, schedule: args.schedule, prompt: args.prompt, cwd: process.cwd() }, Date.now())
        return `Added cron job "${job.name}" (${job.schedule}). Next fire ${new Date(job.nextRun).toLocaleString()}.`
      }
      if (args.action === 'remove') {
        if (args.name === undefined) throw new Error('name is required')
        return removeJob(dir(), args.name) ? `Removed cron job "${args.name}".` : `No cron job named "${args.name}".`
      }
      if (args.action === 'run') {
        if (args.name === undefined) throw new Error('name is required')
        const job = findJob(list, args.name)
        if (job === undefined) throw new Error(`No cron job named "${args.name}".`)
        const agent = currentAgent()
        if (agent === undefined) throw new Error('no live agent to fire into')
        deliver(agent, job)
        await appendLog('cron', `manual run ${job.name}`)
        return `Fired cron job "${job.name}".`
      }
      if (args.action === 'enable' || args.action === 'disable') {
        if (args.name === undefined) throw new Error('name is required')
        const job = setJobEnabled(dir(), args.name, args.action === 'enable', Date.now())
        return `${job.name} ${job.enabled ? 'enabled' : 'disabled'}; next fire ${new Date(job.nextRun).toLocaleString()}.`
      }
      if (args.action === 'test') {
        if (args.schedule === undefined) {
          if (args.name === undefined) throw new Error('schedule or name is required')
          const job = findJob(list, args.name)
          if (job === undefined) throw new Error(`No cron job named "${args.name}".`)
          args.schedule = job.schedule
        }
        const problem = validateSchedule(args.schedule)
        if (problem !== null) throw new Error(problem)
        const fires = nextFires(args.schedule, 5, new Date())
        return fires.length === 0 ? 'That expression never fires.' : fires.map(date => date.toLocaleString()).join('\n')
      }
      if (args.action === 'export') {
        const text = exportCrontab(list)
        return text.length === 0 ? 'No enabled jobs to export.' : text
      }
      if (args.action === 'logs') return await logsText()
      throw new Error(`unknown cron action "${args.action}"`)
    },
  })
  registerToolSafe(ctx, tool)

  registerCommandSafe(ctx, {
    name: 'cron',
    description: 'List or manage scheduled prompts',
    input: { hint: '[list|test <name>|run <name>|remove <name>|enable|disable|export|logs]' },
    async handler({ rawInput }) {
      const parts = rawInput.trim().split(/\s+/).filter(Boolean)
      const action = parts[0] ?? 'list'
      const name = parts[1]
      const list = jobs()
      if (action === 'list') return { kind: 'success', text: list.length === 0 ? 'No cron jobs.' : list.map(formatJob).join('\n') }
      if (action === 'export') {
        const text = exportCrontab(list)
        return { kind: text.length > 0 ? 'success' : 'error', text: text.length > 0 ? text : 'No enabled jobs.' }
      }
      if (action === 'logs') return { kind: 'success', text: await logsText() }
      if (name === undefined) return { kind: 'error', text: `usage: /cron ${action} <name>` }
      if (action === 'run') {
        const job = findJob(list, name)
        const agent = currentAgent()
        if (job === undefined) return { kind: 'error', text: `No cron job named "${name}".` }
        if (agent === undefined) return { kind: 'error', text: 'No live agent to fire into.' }
        deliver(agent, job)
        return { kind: 'success', text: `Fired "${name}".` }
      }
      if (action === 'remove') {
        const removed = removeJob(dir(), name)
        return { kind: removed ? 'success' : 'error', text: removed ? `Removed "${name}".` : `No job "${name}".` }
      }
      if (action === 'enable' || action === 'disable') {
        try {
          const job = setJobEnabled(dir(), name, action === 'enable', Date.now())
          return { kind: 'success', text: `${job.name} ${job.enabled ? 'enabled' : 'disabled'}.` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      if (action === 'test') {
        const job = findJob(list, name)
        if (job === undefined) return { kind: 'error', text: `No job "${name}".` }
        return { kind: 'success', text: nextFires(job.schedule, 5, new Date()).map(date => date.toLocaleString()).join('\n') }
      }
      return { kind: 'error', text: `unknown /cron action "${action}"` }
    },
  })

  logLine('cron', `loaded ${jobs().length} job(s), tick ${settings.cron.tickMs}ms`)
}
