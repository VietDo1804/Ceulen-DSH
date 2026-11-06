import { EXIT_SENTINEL } from './script.js'
import type { BindingNamespace, Json } from './types.js'

/** Store caps, Pi's numbers: one value and the whole store in JSON characters. */
const STORE_VALUE_CAP = 262_144
const STORE_TOTAL_CAP = 1_048_576

/**
 * Pi's `exit()`, in the one shape the PTC runtime allows: a namespace binding
 * that unwinds by throwing a sentinel the executor recognizes, so a nested
 * helper can end the script successfully. The transport requires a lossless
 * JSON argument (`null`) and `await` so the rejection unwinds at the call site
 * — a floating `codemode.exit(null)` never reaches the executor. Normal
 * success rules apply: pending store writes commit, console lines survive.
 */
export function exitBindings(): BindingNamespace {
  return {
    global: 'codemode',
    functions: {
      async exit() {
        // ponytail: the sentinel is catchable inside the script (Pi's exit is not); a script that swallows it just keeps running.
        throw new Error(EXIT_SENTINEL)
      },
    },
  }
}

/** One committed `codemode-store` session event's payload. */
interface StoreEvent {
  store: Record<string, Json>
}

function readCommittedStore(session: { snapshotEvents?(): readonly { type: string; data?: unknown }[] }): Map<string, Json> | undefined {
  if (typeof session.snapshotEvents !== 'function') return undefined
  const committed = new Map<string, Json>()
  const events = session.snapshotEvents()
  for (const event of events) {
    if (event.type !== 'codemode-store') continue
    const data = event.data as StoreEvent | undefined
    if (data === null || typeof data !== 'object') continue
    for (const [key, value] of Object.entries(data.store ?? {})) committed.set(key, value)
  }
  return committed
}

function jsonLength(value: Json): number {
  return JSON.stringify(value)?.length ?? 0
}

/**
 * `state.store({ key, value })` / `state.load({ key })`: small JSON values that
 * survive across codemode calls. Committed values live as `codemode-store`
 * session events (so resumed sessions and branches keep the right path); a
 * script's writes apply only when that script succeeds, like Pi.
 */
export function stateBindings(session: unknown, success: { pending: Map<string, Json> }): BindingNamespace {
  const fail = (): never => {
    throw new Error('state is unavailable: this session does not expose event storage')
  }
  const view = session as { append?(type: string, data: unknown): void; snapshotEvents?(): readonly { type: string; data?: unknown }[] } | undefined
  const committed = view === undefined || typeof view.append !== 'function' ? undefined : readCommittedStore(view)
  return {
    global: 'state',
    functions: {
      async store(args: unknown) {
        const { key, value } = (args ?? {}) as { key?: unknown; value?: unknown }
        if (typeof key !== 'string' || key.length === 0) throw new Error('state.store requires a non-empty string key')
        const entry = (value ?? null) as Json
        const length = jsonLength(entry)
        if (length > STORE_VALUE_CAP) {
          throw new Error(`state.store: value is ${length} chars (cap ${STORE_VALUE_CAP}); keep large data in files, not the store`)
        }
        if (committed === undefined) fail()
        let total = 0
        for (const [k, v] of committed!) if (k !== key) total += jsonLength(v)
        for (const [k, v] of success.pending) if (k !== key) total += jsonLength(v)
        if (total + length > STORE_TOTAL_CAP) throw new Error(`state.store: store would pass ${STORE_TOTAL_CAP} chars total; prune old keys first`)
        success.pending.set(key, entry)
        return null
      },
      async load(args: unknown) {
        const { key } = (args ?? {}) as { key?: unknown }
        if (typeof key !== 'string') throw new Error('state.load requires a string key')
        if (committed === undefined) fail()
        if (success.pending.has(key)) return success.pending.get(key) as Json
        return committed!.get(key) ?? null
      },
    },
  }
}
