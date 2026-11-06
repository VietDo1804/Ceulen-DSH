import { randomUUID } from 'node:crypto'
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { appendLog } from '../../core/log.js'

export const name = 'ceulen-a2a'
export const inject = ['tools']

interface Peer {
  name: string
  url: string
  token?: string
}

function peers(): Peer[] {
  const raw = loadSettingsSync().a2a.peers
  const out: Peer[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      try {
        const url = new URL(entry)
        out.push({ name: url.hostname, url: entry })
      } catch {
        // Ignore malformed entries.
      }
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      if (typeof record.name === 'string' && typeof record.url === 'string') {
        out.push({ name: record.name, url: record.url, ...(typeof record.token === 'string' ? { token: record.token } : {}) })
      }
    }
  }
  return out
}

function isBlocked(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return true
  return false
}

function authHeaders(peer: Peer): Record<string, string> {
  return peer.token === undefined ? {} : { authorization: `Bearer ${peer.token}` }
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => extractText(entry, depth + 1)).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (record.parts !== undefined) return extractText(record.parts, depth + 1)
    if (record.message !== undefined) return extractText(record.message, depth + 1)
    if (record.task !== undefined) return extractText(record.task, depth + 1)
    // A2A v1 returns a task whose reply lives under status.message, mirrored in artifacts.
    if (record.status !== undefined || record.artifacts !== undefined) {
      return extractText(record.status, depth + 1) || extractText(record.artifacts, depth + 1)
    }
    if (record.result !== undefined) return extractText(record.result, depth + 1)
    if (record.error !== undefined) return extractText(record.error, depth + 1)
  }
  return ''
}

async function rpc(peer: Peer, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  let url: URL
  try {
    url = new URL(peer.url)
  } catch {
    throw new Error(`peer "${peer.name}" has an invalid URL`)
  }
  if (isBlocked(url)) throw new Error(`peer "${peer.name}" points at a blocked address`)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(peer) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`peer "${peer.name}" returned HTTP ${response.status}: ${clampText(text, 300)}`)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`peer "${peer.name}" returned non-JSON: ${clampText(text, 300)}`)
  }
  const record = payload as { error?: unknown; result?: unknown }
  if (record.error !== undefined) throw new Error(`peer "${peer.name}" error: ${clampText(JSON.stringify(record.error), 500)}`)
  return record.result ?? payload
}

function pickPeer(name: string | undefined): Peer {
  const list = peers()
  if (list.length === 0) throw new Error('no A2A peers configured; add objects to settings.a2a.peers')
  if (name === undefined || name.length === 0) return list[0]!
  const match = list.find(peer => peer.name === name || peer.url === name)
  if (match === undefined) throw new Error(`unknown peer "${name}". Known: ${list.map(peer => peer.name).join(', ')}`)
  return match
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('a2a', settings)) return

  registerToolSafe(ctx, ceulenTool({
    name: 'a2a_peers',
    description: 'List configured A2A peers (name and URL) and whether the client is ready.',
    parameters: objectSchema({}),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute() {
      const list = peers()
      return list.length === 0
        ? 'No A2A peers configured. Add {name,url,token?} objects to settings.a2a.peers.'
        : list.map(peer => `${peer.name}\t${peer.url}${peer.token !== undefined ? '\t(token set)' : ''}`).join('\n')
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'a2a_call',
    description: 'Send one message to a remote A2A agent (JSON-RPC SendMessage) and return its reply text. Use a2a_peers to discover configured names.',
    parameters: objectSchema({
      peer: { type: 'string', description: 'Peer name or URL; defaults to the first peer.' },
      message: { type: 'string', description: 'Message text.' },
      contextId: { type: 'string', description: 'Optional conversation context id.' },
    }, ['message']),
    outputSchema: { type: 'string' },
    timeoutMs: 240_000,
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { peer?: string; message: string; contextId?: string }
      const peer = pickPeer(args.peer)
      const contextId = args.contextId ?? randomUUID()
      const params = {
        message: {
          role: 'ROLE_USER',
          messageId: randomUUID(),
          contextId,
          parts: [{ text: args.message }],
        },
      }
      const result = await rpc(peer, 'SendMessage', params, exec.signal)
      await appendLog('a2a', `call ${peer.name} context=${contextId}`)
      const text = extractText(result)
      return text.length > 0 ? text : `(peer ${peer.name} returned no text)\n${clampText(JSON.stringify(result), 2_000)}`
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'a2a_status',
    description: 'Fetch one task from an A2A peer by task id (JSON-RPC GetTask).',
    parameters: objectSchema({
      taskId: { type: 'string', description: 'Remote task id.' },
      peer: { type: 'string', description: 'Peer name or URL; defaults to the first peer.' },
    }, ['taskId']),
    outputSchema: { type: 'string' },
    timeoutMs: 60_000,
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { taskId: string; peer?: string }
      const peer = pickPeer(args.peer)
      const result = await rpc(peer, 'GetTask', { id: args.taskId }, exec.signal)
      return clampText(JSON.stringify(result, null, 2), 8_000)
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'a2a_list',
    description: 'List configured A2A peers (alias of a2a_peers kept for Ceulen parity).',
    parameters: objectSchema({}),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute() {
      return peers().map(peer => `${peer.name}\t${peer.url}`).join('\n') || 'No A2A peers configured.'
    },
  }))
}
