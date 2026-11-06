import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, updateSettings } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerToolSafe } from '../../core/tools.js'
import { extractJson, streamText, type LlmRoute } from '../../core/llm.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-classifier'
export const inject = ['tools', 'commands', 'llm']

const RISKY: readonly RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/,
  /\bsudo\b/, /\bdoas\b/,
  /\bgit\s+push\b[^|;&]*--force/, /\bgit\s+push\s+-f\b/, /\bgit\s+reset\s+--hard\b/,
  /curl[^|;&]*\|\s*(ba)?sh/, /wget[^|;&]*\|\s*(ba)?sh/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/, /\bgh\s+release\s+(create|upload)\b/,
  /\bcargo\s+publish\b/, /\btwine\s+upload\b/, /\bgem\s+push\b/,
  /\bterraform\s+(apply|destroy)\b/, /\bkubectl\s+(delete|apply)\b/,
  /(^|\s)~?\/?\.?(ssh|aws|gnupg|kube)(\/|$)/, /id_rsa|\.pem\b|credentials\b/i,
]

export function isRisky(command: string): boolean {
  return RISKY.some(pattern => pattern.test(command))
}

/**
 * The enforcement set: only irreversible commands can be denied. RISKY above
 * stays audit-only because it fires on read-only commands
 * (`sed ~/.credentials.yaml`, `sudo -n -l`) that must never be blocked.
 *
 * These checks scan the raw command text, so a destructive tool inside quotes
 * still counts (`bash -c 'rm -rf /'`, `env X=1 rm -rf x`). Flags are matched
 * one token at a time: the earlier single-token regexes missed `rm -r -f`,
 * `rm --recursive --force`, `git -C dir reset --hard`, `git clean -d -f -x`
 * and `git push origin +main`.
 *
 * Limit: this is a lexical scan, not a shell evaluator. Variable indirection
 * (`X=rm; sh -c "$X -rf /"`) reads as safe; the model gate is the backstop for
 * anything the scan does flag, and the sandbox/approval boundary is the one
 * that actually contains a determined caller.
 */
const SQL_DESTRUCTIVE = /\b(drop|truncate)\s+(table|database)\b/i
const SHORT_FLAG = (letter: string): RegExp => new RegExp(`(?:^|\\s)-(?!-)[A-Za-z]*${letter}[A-Za-z]*(?=\\s|$)`)
const LONG_FLAG = (name: string): RegExp => new RegExp(`(?:^|\\s)${name}(?=\\s|$)`)

function hasFlag(args: string, letter: string): boolean {
  return SHORT_FLAG(letter).test(args)
}

/** `rm` with a recursive+force combination in any spelling. */
function rmDestructive(command: string): boolean {
  for (const match of command.matchAll(/\brm\b([^;|&\n]*)/gu)) {
    // Quotes are stripped before flag matching so `sh -c 'rm -rf x'` and
    // `rm -rf "dir"` read the same as the bare spelling.
    const rest = (match[1] ?? '').replace(/["']/g, '')
    const recursive = hasFlag(rest, 'r') || hasFlag(rest, 'R') || LONG_FLAG('--recursive').test(rest)
    const force = hasFlag(rest, 'f') || LONG_FLAG('--force').test(rest)
    if (recursive && force) return true
  }
  return false
}

/** `git reset --hard`, `git clean` with force+ignored, and force pushes. */
function gitDestructive(command: string): boolean {
  for (const match of command.matchAll(/\bgit\b([^;|&\n]*)/gu)) {
    const rest = (match[1] ?? '').replace(/["']/g, '')
    const sub = /(?:^|\s)(reset|clean|push)\b/.exec(rest)
    if (sub === null) continue
    const args = rest.slice(sub.index + sub[0].length)
    if (sub[1] === 'reset' && LONG_FLAG('--hard').test(args)) return true
    // `-f` alone deletes untracked files (i.e. uncommitted new work); `-x` only
    // widens that to ignored files, so force is the condition that matters.
    if (sub[1] === 'clean' && (hasFlag(args, 'f') || LONG_FLAG('--force').test(args))) return true
    if (sub[1] === 'push') {
      if (/(?:^|\s)--force/.test(args) || hasFlag(args, 'f')) return true
      if (/(?:^|\s)\+\S/.test(args)) return true // +<refspec> is a force push
    }
  }
  return false
}

export function isIrreversible(command: string): boolean {
  return rmDestructive(command) || gitDestructive(command) || SQL_DESTRUCTIVE.test(command)
}

/**
 * Enforce-mode reading of a command the shell cannot even parse. `bash -n`
 * parses without executing; an unterminated heredoc gets an empty stdin so it
 * fails instead of hanging. Denying is safe — bash would reject the command
 * anyway, and the caller gets a reason instead of a shell syntax error. A
 * missing or wedged bash also fails closed.
 */
export function isUnparseable(command: string): boolean {
  try {
    execFileSync('bash', ['-n', '-c', command], { input: '', stdio: ['pipe', 'ignore', 'ignore'], timeout: 2_000 })
    return false
  } catch (error) {
    // A missing or non-executable bash is not a statement about the command:
    // the bash tool cannot run anything either, so do not block on it. A syntax
    // error (status 1/2) or a wedged parse fails closed.
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'EACCES') return false
    return true
  }
}

export const GATE_THRESHOLD = 0.5
const GATE_TIMEOUT_MS = 25_000

/**
 * Working-tree summary for the gate state. Without it the model cannot tell a
 * clean-tree `git reset --hard` from one that drops uncommitted work.
 */
export function repoStatus(cwd: string): string {
  try {
    const out = execFileSync('git', ['status', '--porcelain=v1', '-b'], {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return clampText(out.trim(), 1_500)
  } catch {
    return ''
  }
}

/**
 * The session's current directory, through the same service the bash tool
 * calls before it spawns: `workingDirectory.ensure(agent)`. Without it, a
 * relative `workdir` would resolve against the harness process cwd instead of
 * the session workspace.
 */
async function sessionCwd(ctx: PluginContext, exec: { agent?: AgentLike; signal?: AbortSignal }): Promise<string> {
  const service = ctx.get('workingDirectory', false) as
    | { ensure?(owner: AgentLike, signal?: AbortSignal): Promise<string> }
    | undefined
  if (exec.agent !== undefined && typeof service?.ensure === 'function') {
    try {
      const cwd = await service.ensure(exec.agent, exec.signal)
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // No session directory mounted: fall back to the durable header below.
    }
  }
  const recorded = exec.agent?.session.header?.cwd
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : process.cwd()
}

/** The bash call's own `workdir`, resolved against `base` like the bash tool does. */
function commandCwd(base: string, args: unknown): string {
  const raw = (args as { workdir?: unknown } | null | undefined)?.workdir
  if (typeof raw !== 'string' || raw.trim().length === 0) return base
  return resolve(base, raw)
}

export interface Question {
  id: string
  type: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: unknown
}

function parseRoute(value: string): LlmRoute | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/** Primary route first, then the configured fallbacks, in the order tried. */
function routesFor(agent: AgentLike | undefined): LlmRoute[] {
  const settings = loadSettingsSync()
  const sessionId = agent === undefined ? undefined : String(agent.session.id)
  const withSession = (route: LlmRoute): LlmRoute => sessionId === undefined ? route : { ...route, sessionId }
  const primary = settings.classifier.provider !== null && settings.classifier.model !== null
    ? { provider: settings.classifier.provider, model: settings.classifier.model }
    : agent?.options.provider !== undefined && agent.options.model !== undefined
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
  return [primary, ...settings.classifier.fallbacks.map(parseRoute)]
    .filter((route): route is LlmRoute => route !== undefined)
    .map(withSession)
}

const SYSTEM = `You are a decision classifier, not an assistant. Read the state and answer every question with calibrated typed values. You cannot use tools and you must not explain.

Return exactly one JSON object keyed by question id:
- "noul": {"probability": <0..1>} — probability the answer is yes.
- "choice": {"option": "<exactly one criteria key>", "probabilities": {"<option>": <0..1>}, "confidence": <0..1>}
- "score": {"score": <expected level index, 0..criteria.length-1>, "confidence": <0..1>}

Use only the options/criteria supplied. If the state is insufficient, choose the closest answer and lower confidence. JSON only.`

/** Probability-like fields must be finite and inside 0..1. */
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function answerError(question: Question, problem: string): Error {
  return new Error(`classifier answer "${question.id}" ${problem}`)
}

/**
 * Reject answers the caller cannot act on: an out-of-range probability or a
 * choice outside the supplied criteria would otherwise reach a gate that then
 * has to fail closed. A rejected answer lets the next route try instead.
 */
function checkAnswer(question: Question, answer: Record<string, unknown>): void {
  if (answer.confidence !== undefined && !probability(answer.confidence)) {
    throw answerError(question, 'needs a confidence between 0 and 1 when present')
  }
  if (question.type === 'noul') {
    if (!probability(answer.probability)) throw answerError(question, 'needs a probability between 0 and 1')
    return
  }
  if (question.type === 'choice') {
    const option = answer.option
    if (typeof option !== 'string' || option.length === 0) throw answerError(question, 'needs a string option')
    const criteria = question.criteria
    if (criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria) && !Object.hasOwn(criteria, option)) {
      throw answerError(question, `chose "${option}", which is not one of the supplied criteria`)
    }
    const probabilities = answer.probabilities
    if (probabilities !== undefined) {
      if (probabilities === null || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
        throw answerError(question, 'needs probabilities as an object when present')
      }
      for (const [label, value] of Object.entries(probabilities)) {
        if (!probability(value)) throw answerError(question, `has probability "${label}" outside 0..1`)
      }
    }
    return
  }
  const score = answer.score
  if (typeof score !== 'number' || !Number.isFinite(score)) throw answerError(question, 'needs a finite score')
  const criteria = question.criteria
  if (Array.isArray(criteria) && criteria.length > 1 && (score < 0 || score > criteria.length - 1)) {
    throw answerError(question, `score ${score} is outside the level range 0..${criteria.length - 1}`)
  }
}

/**
 * Models sometimes key the answer by question *type* ("noul") instead of *id*
 * ("safe") — accept either, then normalize to the id the caller reads.
 */
export function normalizeAnswers(parsed: unknown, questions: readonly Question[]): Record<string, unknown> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('classifier returned no valid JSON object')
  const raw = parsed as Record<string, unknown>
  // The type fallback is only unambiguous when exactly one question has that type
  // and no question uses it as an id; otherwise one answer would satisfy two questions.
  const typeCounts = new Map<string, number>()
  for (const question of questions) typeCounts.set(question.type, (typeCounts.get(question.type) ?? 0) + 1)
  const ids = new Set(questions.map(question => question.id))
  const answers: Record<string, unknown> = {}
  for (const question of questions) {
    const byType = typeCounts.get(question.type) === 1 && !ids.has(question.type) ? raw[question.type] : undefined
    const answer = raw[question.id] ?? byType
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw new Error(`classifier omitted answer "${question.id}"`)
    const record = answer as Record<string, unknown>
    // Chat models sometimes echo a criteria description instead of its key; map it back.
    const criteria = question.criteria
    if (question.type === 'choice' && typeof record.option === 'string'
      && criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria) && !Object.hasOwn(criteria, record.option)) {
      const match = Object.entries(criteria).find(([, description]) => description === record.option)
      if (match !== undefined) record.option = match[0]
    }
    checkAnswer(question, record)
    answers[question.id] = record
  }
  return answers
}

/**
 * Pi caps concurrent classifier calls per script at four. Match it so a
 * codemode `Promise.all` over a batch queues instead of opening one stream per
 * item. The gate stays out of this queue: a destructive command waiting behind
 * four tool calls would only hit its own deadline and fail closed.
 */
const MAX_CONCURRENT_CALLS = 4
let inFlight = 0
const waiting: (() => void)[] = []

async function withModelSlot<T>(task: () => Promise<T>): Promise<T> {
  // The releasing call hands its slot over without decrementing, so no third
  // caller can slip in between the release and the waiter resuming.
  if (inFlight < MAX_CONCURRENT_CALLS) inFlight += 1
  else await new Promise<void>(release => waiting.push(release))
  try {
    return await task()
  } finally {
    const next = waiting.shift()
    if (next === undefined) inFlight -= 1
    else next()
  }
}

async function askClassifier(ctx: PluginContext, agent: AgentLike | undefined, state: unknown, questions: Question[], deadline: number): Promise<Record<string, unknown>> {
  const routes = routesFor(agent)
  if (routes.length === 0) throw new Error('no classifier route: set classifier.provider/model or use an agent with a configured route')
  const prompt = [
    `State:\n${clampText(JSON.stringify(state, null, 2), 12_000)}`,
    '',
    `Questions:\n${JSON.stringify(questions, null, 2)}`,
    '',
    'Return the JSON answer object now.',
  ].join('\n')
  let lastError: unknown
  const failures: string[] = []
  for (const route of routes) {
    const remaining = deadline - Date.now()
    if (remaining <= 500) break
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    timer.unref?.()
    try {
      const answers = normalizeAnswers(extractJson(await streamText(ctx, route, SYSTEM, prompt, controller.signal, 900)), questions)
      // The resolved route, not call success, is what a smoke test can assert on.
      logLine('classifier', JSON.stringify({ at: new Date().toISOString(), command: 'classify:resolved', model: `${route.provider}/${route.model}`, via: 'llm' }))
      return answers
    } catch (error) {
      lastError = error
      failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  // One route keeps its own message; several name every route so a validation
  // error is not masked by a later timeout.
  if (failures.length > 1) throw new Error(`every classifier route failed: ${failures.join('; ')}`)
  throw lastError instanceof Error ? lastError : new Error('classifier unavailable: every route failed')
}

/**
 * Ask the classifier itself — the gate does not depend on the agent calling
 * `classify`. The run context is threaded through because opencode-go rejects
 * auxiliary calls without the session id (`MissingSessionID`); the host always
 * hands it to the hook as `exec.agent`.
 */
async function gateCommand(ctx: PluginContext, command: string, cwd: string, agent?: AgentLike): Promise<{ probability: number | null; error?: string }> {
  try {
    const answers = await askClassifier(
      ctx,
      agent,
      { cwd, gitStatus: repoStatus(cwd), command },
      [{
        id: 'safe',
        type: 'noul',
        instructions: 'Is it safe to run this shell command in the working directory shown? Answer no when it can destroy uncommitted work, source, data, or credentials.',
        criteria: { yes: 'reversible or regenerable target, intended by the task', no: 'irreversible loss in the current state' },
      }],
      Date.now() + GATE_TIMEOUT_MS,
    )
    const answer = answers.safe as { probability?: unknown } | undefined
    return { probability: typeof answer?.probability === 'number' ? answer.probability : null }
  } catch (error) {
    return { probability: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function auditVerdict(command: string, verdict: unknown): void {
  logLine('classifier', JSON.stringify({ at: new Date().toISOString(), command: clampText(command, 500), verdict }))
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('classifier', settings)) return

  registerToolSafe(ctx, ceulenTool({
    name: 'classify',
    description: 'Ask a decision model typed questions about a state and get structured answers: noul (yes probability), choice (option + probabilities + confidence), or score (position + confidence). Use for gating, routing, and verification — not open-ended prose.',
    parameters: objectSchema({
      state: { description: 'Everything the classifier should judge, as JSON (transcript, records, policy).' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Answer key.' },
            type: { type: 'string', enum: ['noul', 'choice', 'score'] },
            instructions: { type: 'string', description: 'The question about the state.' },
            criteria: { description: 'choice: {option: description}; score: [levels]; noul: {yes,no}.' },
          },
          required: ['id', 'type', 'instructions'],
          additionalProperties: false,
        },
        description: 'One entry per independent judgment.',
      },
    }, ['state', 'questions']),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { state: unknown; questions: Question[] }
      if (!Array.isArray(args.questions) || args.questions.length === 0) throw new Error('questions must be a non-empty array')
      // The deadline starts inside the slot, not while queueing for one.
      const answers = await withModelSlot(() => askClassifier(ctx, exec.agent, args.state, args.questions, Date.now() + 30_000))
      auditVerdict(`classify:${args.questions.map(question => question.id).join(',')}`, answers)
      return JSON.stringify(answers, null, 2)
    },
  }))

  // Audits every bash call and, with classifier.enforce on, denies irreversible
  // commands whose in-code gate score is below GATE_THRESHOLD.
  ctx.on('tools/pre-execute', async (exec: { name?: string; arguments?: unknown; agent?: AgentLike; signal?: AbortSignal }, next: () => Promise<unknown>) => {
    if (exec?.name === 'bash') {
      const settings = loadSettingsSync()
      const command = String((exec.arguments as { command?: unknown })?.command ?? '')
      if (command.length > 0) {
        if (settings.classifier.enforce && isUnparseable(command)) {
          auditVerdict(command, { static: 'unparseable' })
          return { kind: 'deny', reason: 'classify gate: the command cannot be parsed (bash -n rejects it), so its safety cannot be judged. Fix the syntax, or run /classifier enforce off.' }
        }
        if (settings.classifier.enforce && isIrreversible(command)) {
          const gate = await gateCommand(ctx, command, commandCwd(await sessionCwd(ctx, exec), exec.arguments), exec.agent)
          auditVerdict(command, { static: 'irreversible', gate: gate.probability ?? gate.error })
          if (gate.probability === null) {
            return { kind: 'deny', reason: `classify gate unavailable (${gate.error ?? 'no answer'}): destructive command refused. Set /classifier model provider/model, or run /classifier enforce off.` }
          }
          if (gate.probability < GATE_THRESHOLD) {
            return { kind: 'deny', reason: `classify gate: safe=${gate.probability.toFixed(2)} < ${GATE_THRESHOLD}: destructive command refused. Do not rephrase or work around it; ask the user.` }
          }
          return next()
        }
        if (!settings.classifier.audit) return next()
        const risky = isRisky(command)
        if (risky) {
          auditVerdict(command, { static: 'risky', model: 'skipped' })
        } else {
          const route = routesFor(exec.agent)[0]
          if (route !== undefined) {
            const controller = new AbortController()
            // Detached audit: it never delays the turn, so give a reasoning
            // model room to answer (3 s aborted every opencode-go call).
            const timer = setTimeout(() => controller.abort(), 10_000)
            timer.unref?.()
            void streamText(
              ctx,
              route,
              'You audit shell commands for another agent. Answer with one JSON object: {"reversible": true|false, "serves_task": true|false, "confidence": 0..1}. Be strict about destructive or credential-touching commands. JSON only.',
              `Command:\n${clampText(command, 2_000)}`,
              controller.signal,
              200,
            ).then(text => {
              auditVerdict(command, { static: 'ok', model: extractJson(text) ?? { raw: clampText(text, 300) } })
            }).catch((error: unknown) => {
              // Log the real failure — a bare "unavailable" hid the system-one routing bug for weeks.
              auditVerdict(command, { static: 'ok', model: `unavailable: ${error instanceof Error ? error.message : String(error)}` })
            }).finally(() => clearTimeout(timer))
          } else {
            auditVerdict(command, { static: 'ok', model: 'no-route' })
          }
        }
      }
    }
    return next()
  })

  registerCommandSafe(ctx, {
    name: 'classifier',
    description: 'Classifier status, audit toggle, enforcement, and model route',
    input: { hint: '[status|on|off|enforce on|off|model provider/model]' },
    async handler({ rawInput }) {
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const action = args[0] ?? 'status'
      const current = loadSettingsSync()
      if (action === 'on' || action === 'off') {
        await updateSettings(settings => {
          settings.classifier.audit = action === 'on'
        })
        return { kind: 'success', text: `Classifier audit ${action === 'on' ? 'enabled' : 'disabled'}.` }
      }
      if (action === 'enforce') {
        const value = args[1]
        if (value !== 'on' && value !== 'off') return { kind: 'error', text: 'usage: /classifier enforce on|off' }
        await updateSettings(settings => {
          settings.classifier.enforce = value === 'on'
        })
        return { kind: 'success', text: `Classifier enforcement ${value}.` }
      }
      if (action === 'model') {
        const parsed = args.slice(1).join(' ').split(/[,\s]+/).filter(Boolean).map(value => {
          const slash = value.indexOf('/')
          return slash <= 0 || slash === value.length - 1 ? undefined : { provider: value.slice(0, slash), model: value.slice(slash + 1) }
        })
        const primary = parsed[0]
        if (primary === undefined) return { kind: 'error', text: 'usage: /classifier model provider/model[,provider/model…] — first is primary, rest fallbacks' }
        const fallbacks = parsed.slice(1).filter((route): route is { provider: string; model: string } => route !== undefined).map(route => `${route.provider}/${route.model}`)
        await updateSettings(settings => {
          settings.classifier.provider = primary.provider
          settings.classifier.model = primary.model
          settings.classifier.fallbacks = fallbacks
        })
        return { kind: 'success', text: `Classifier route: ${primary.provider}/${primary.model}${fallbacks.length > 0 ? ` (fallback: ${fallbacks.join(', ')})` : ''}` }
      }
      return {
        kind: 'success',
        text: [
          `classifier route: ${current.classifier.provider !== null && current.classifier.model !== null ? `${current.classifier.provider}/${current.classifier.model}` : 'agent route'}`,
          `audit: ${current.classifier.audit ? 'on' : 'off'}`,
          `fallbacks: ${current.classifier.fallbacks.length > 0 ? current.classifier.fallbacks.join(', ') : '(none)'}`,
          `enforce: ${current.classifier.enforce ? 'on (irreversible bash denied below safe 0.5)' : 'off'}`,
          'Logs every bash verdict to $DSH_HOME/ceulen/logs/classifier.log.',
        ].join('\n'),
      }
    },
  })

  logLine('classifier', 'loaded')
}
