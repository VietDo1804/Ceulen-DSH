/**
 * Hard read-only for the reviewer and scout roles.
 *
 * A native `delegate` child inherits its parent's sandbox, so "read-only" in a
 * role persona was only an instruction. For these two roles the harness now
 * holds it:
 * - the child's own session is switched to the `read-only` sandbox before its
 *   first tool call runs, which confines bash and every filesystem tool;
 * - `edit`, `write` and `apply_patch` are refused outright, with a reason the
 *   child can act on;
 * - a `sandbox_permissions` request for wider access is refused, so a parent
 *   in Auto mode cannot approve the child out of the sandbox.
 *
 * The role is read from the child's own first message (the line `delegate`
 * prepends), so it holds for a resumed child and after a restart. Where the
 * session cannot be put in the read-only sandbox, shell access is refused
 * instead: the role fails closed.
 */
import type { PluginContext, SessionLike } from '../../core/types.js'
import { sessionSandboxPolicy } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { EDITING } from './nudge.js'

/** Roles the harness keeps read-only. The planner stays on its persona alone. */
export const HARD_READ_ONLY: ReadonlySet<string> = new Set(['reviewer', 'scout'])

/** Appended to the role prompt, so the child does not spend calls finding the wall. */
export const READ_ONLY_NOTE = 'This role runs read-only and the harness enforces it: the session sandbox is read-only, and `edit`, `write`, `apply_patch` and requests for wider access are refused. Do not try to change a file. Say in your reply what should change, and name any check you could not run for this reason.'

const ROLE_LINE = /^You are the "([a-z]+)" subagent role\./

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const block = content.find(part => (part as { type?: unknown } | null)?.type === 'text') as { text?: unknown } | undefined
  return typeof block?.text === 'string' ? block.text : ''
}

/** The `delegate` role a child session was started with, read from its own first message. */
export function roleOfChild(session: SessionLike | undefined): string | undefined {
  if (session?.header?.parentSession === undefined) return undefined
  try {
    const first = session.deriveMessages?.().find(message => message.role === 'user' && (message.source?.kind ?? 'user') === 'user')
    return first === undefined ? undefined : ROLE_LINE.exec(textOf(first.content))?.[1]
  } catch {
    return undefined
  }
}

function modeOf(ctx: PluginContext, session: SessionLike): string | undefined {
  const mode = (sessionSandboxPolicy(ctx, session) as { mode?: unknown } | undefined)?.mode
  return typeof mode === 'string' ? mode : undefined
}

/** Put the session in the read-only sandbox; true when the resolved policy says so afterwards. */
function seal(ctx: PluginContext, session: SessionLike, role: string): boolean {
  try {
    if (modeOf(ctx, session) === 'read-only') return true
    session.append?.('sandbox/mode', { mode: 'read-only' })
    const sealed = modeOf(ctx, session) === 'read-only'
    logLine('subagent', `read-only ${role} ${session.id}: ${sealed ? 'sandbox set to read-only' : 'sandbox could not be set, shell refused'}`)
    return sealed
  } catch (error) {
    logLine('subagent', `read-only ${role} ${session.id}: sandbox switch failed (${error instanceof Error ? error.message : String(error)}), shell refused`)
    return false
  }
}

function asksWider(raw: unknown): boolean {
  try {
    const input = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw
    const wider = (input as { sandbox_permissions?: unknown } | null)?.sandbox_permissions
    return typeof wider === 'string' && wider.length > 0
  } catch {
    return false
  }
}

interface Standing {
  readonly role: string
  readonly sealed: boolean
}

export function installReadOnlyRoles(ctx: PluginContext): void {
  // null: looked at, not one of the roles.
  const standing = new WeakMap<object, Standing | null>()
  ctx.on('tools/pre-execute', async (exec: { agent?: { session?: SessionLike }; name?: unknown; arguments?: unknown } | undefined, next: () => Promise<unknown>) => {
    const session = exec?.agent?.session
    if (session === undefined || session === null || typeof exec?.name !== 'string') return next()
    let state = standing.get(session)
    if (state === undefined) {
      const role = roleOfChild(session)
      state = role !== undefined && HARD_READ_ONLY.has(role) ? { role, sealed: seal(ctx, session, role) } : null
      standing.set(session, state)
    }
    if (state === null) return next()
    const refuse = (what: string, then: string) => {
      logLine('subagent', `read-only ${state.role} ${session.id}: refused ${what}`)
      return { kind: 'deny', reason: `The ${state.role} role is read-only and the harness enforces it: ${what} is refused. ${then}` }
    }
    if (EDITING.has(exec.name)) return refuse(`\`${exec.name}\``, 'Do not retry and do not write the file another way. Say in your reply what should change, with the file and the lines.')
    if (asksWider(exec.arguments)) return refuse('a request for wider sandbox access', 'Run the command without `sandbox_permissions`; if it needs to write, name it in your reply as a check you could not run.')
    if (exec.name === 'bash' && !state.sealed) return refuse('shell access (this session could not be put in the read-only sandbox)', 'Work with the read and search tools, and name in your reply what you could not check.')
    return next()
  })
}
