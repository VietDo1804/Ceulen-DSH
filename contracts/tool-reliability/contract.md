# Contract: tool-call reliability (contract layer + error annotation)

Date: 2026-10-29 · Coordinator: main agent · Status: implemented (v1)

## 1. Goal

Tool calls that the model gets wrong stop costing a retry round-trip. Two
independent layers, both inside `ceulen-dsh`:

1. **Contract layer** — every tool built with `ceulenTool` normalizes what the
   model actually sends and, when it still cannot run, returns an error that
   names the exact accepted call shape.
2. **Annotation layer** — one `ctx.on('tools/execute')` listener in the
   `repair` module appends the missing context (candidate paths, current file
   region, accepted arguments) to failures from *any* tool, native included.

Baseline being improved (`docs/tool-reliability-plan.md` §1): 8,259 calls,
154 errors (1.86%), 65% recover on retry, 54 wasted turns.

**Hard scope rule: this work lives entirely in `ceulen-dsh`. No change to
DSH core, no `node_modules` patch, no upstream PR is a dependency of any task
here.** The bundle registers listeners on the plugin hook API it already uses
(`tools/pre-execute` in classifier, `tools/result` in munin).

## 2. Parties

| Party (role) | Owns (write) | Reads | Notes |
|---|---|---|---|
| core (worker) | `src/core/toolguard.ts` (new), `src/core/tools.ts`, `test/toolguard.test.ts` | plan doc, existing tool modules | the shared helpers both layers call |
| repair (worker) | `src/modules/repair/index.ts`, `test/toolguard-middleware.test.ts` (new), `test/fake-ctx.ts` | plan doc, harness hook shape | annotation listener + `apply_patch` repair |
| coordinator | `contracts/tool-reliability/**`, `docs/tool-reliability-plan.md`, `src/modules/codemode/index.ts`, integration run | everything | never edits party files |

Write scopes are DISJOINT. `contracts/` is read-only for every party.
`src/core/toolguard.ts` is authored by `core`; `repair` codes against the
signatures pinned in §3 and does not create or edit it.

## 3. Shared artifacts

| Artifact | Path / format | Producer | Consumers | Conventions |
|---|---|---|---|---|
| Helper API | `src/core/toolguard.ts` | core | core | **exact signatures pinned below** |
| Error text | `Error: <original>\n\n<block>` | core, repair | model | blocks marked `Call as:`, `Candidates:`, `Current region:` — append only when the marker is absent |
| Ordering | core runs inside `execute`; repair runs at `tools/execute` | — | — | core's text is already in the message when repair sees it; repair appends after, never rewrites |
| Log | `logLine('toolguard', …)`, one line per repair | repair | coordinator | `<tool> <repair-kind>`; every logged line is an applied repair, so an outcome word is noise; never the full error text |

Pinned helper API — `core` must export exactly these:

```ts
/** One-line call shape derived from a JSON object schema: "path | css | pairs". */
export function synthesizeUsage(schema: Record<string, unknown>): string

/** Append "Call as: <shape>" to a message; no-op when already present. */
export function withCallShape(message: string, schema: Record<string, unknown>): string

/** Coerce literal strings and single values; never invents a missing required key. */
export function coerceBySchema(raw: unknown, schema: Record<string, unknown>): Record<string, unknown>
```

`ceulenTool` gains one optional field, `contract?: { usage?: string; normalize?(args): args }`,
and wraps `execute` once: `coerceBySchema` → `contract.normalize` → run → on throw
rethrow `${message}\n\nCall as: ${contract.usage ?? synthesizeUsage(parameters)}`.

Repair listener shape (pinned so the coordinator can review it):

```ts
ctx.on('tools/execute', async (exec, next) => {
  const result = await next()
  if (!result.isError) return result
  const extra = remediation(exec, result)   // undefined => return result untouched
  return extra === undefined ? result : { ...result, content: [...result.content, { type: 'text', text: extra }] }
})
```

Repairs allowed in this version, all read-only against the filesystem:

| Trigger | Appended block |
|---|---|
| `read`/`edit`/`write` "not found" | `Candidates: <≤3 nearest paths>` |
| `edit`/`write` "changed since it was read" / "has not been read" | `Current region: <lines around the model's old_string>` |
| `apply_patch` "hunk does not match" | `Current region:` around the first context line |
| unknown tool name | `Call as:` + the closest registered tool name |

## 4. Rules

1. No party edits `contracts/**` except its own `findings-<party>.md`, and no party edits the other party's files.
   `repair` imports nothing from `src/core/toolguard.ts` in v1 — the two layers
   share a text convention, not code, so neither party blocks the other. When an
   unknown tool has no schema, `Call as:` names the closest *registered tool*;
   that is the only place both layers write the same marker, and the messages
   never collide (a call cannot be both a ceulen tool and an unknown one).
2. A suspected contract bug: STOP the affected part, write
   `findings-<party>.md`, continue work that does not depend on it. Never
   improvise a new helper or a second usage format.
3. Only the coordinator changes the contract; changes are broadcast to both
   parties at once.
4. **No harness modifications of any kind.** No new dependency, no
   `@deepseek-ai/*` import, no write to `node_modules`, no reliance on mutating
   `exec` (arguments, name, signal). Only `next()` and a returned result.
5. An error must stay an error. Neither layer may convert a failure into a
   success result, and neither may return remediation for a success.
6. Remediation is best-effort: any throw inside the repair path returns the
   original result untouched. A repair must never be the reason a call fails.
7. Every appended block is capped (≤ 12 lines) so one bad file cannot flood the
   context; use `clampText` from `src/core/tools.ts`.

## 5. Done criteria

- **core**: `coerceBySchema` turns `"5"` into `5` for `integer`, `"true"` into
  `true`, a single value into an array when the item schema matches, and leaves
  every other value untouched; rename rule moves exactly one stray key when
  exactly one required key is missing and the value validates; `withCallShape`
  is idempotent; `test/toolguard.test.ts` covers all four.
- **core**: every existing test still passes, `tsc --noEmit` clean; no module
  file changed.
- **repair**: a failing `read` for a missing path returns a result whose text
  contains `Candidates:` with at least one real sibling; an unknown-tool error
  names a registered tool; repairs append, never replace; a throwing repair
  returns the original result; the listener is registered only when the module
  is enabled.
- **repair**: `test/toolguard-middleware.test.ts` exercises all four repairs
  through a fake ctx, plus one case asserting success results are untouched.

## 6. Integration check

Coordinator runs, once, for real:

```
npx tsc --noEmit && npx vitest run
```

Plus one behavioural walk through `createFakeCtx()`: call a ceulen tool with a
deliberately wrong-shaped argument and confirm the returned text carries both
the core `Call as:` block and, after a native-tool failure, the repair
`Candidates:` block — in that order, exactly once each.

## 7. Deviation from `docs/tool-reliability-plan.md`

The plan's P2 ("mutate `exec.arguments` / `exec.name`") is **out of scope**: it
depends on the harness execution object being mutable, which is not a supported
surface. v1 is annotation-only, so pre-dispatch path repair (`ls` → `bash`
rewrite) is replaced by an annotated error. Target for `retry-ok` (≥90%) is
unchanged because it was always annotation's job; the error *count* improves
less than the plan's table implied — the plan doc is corrected after merge.

## 8. Amendment 2026-11-09 (coordinator): what the session logs changed

Measured on 110 `deepseek-v4.1-flash` sessions (1–9 Nov 2026). Three parts of
§3 misled the model and are replaced. The helper signatures in §3 gain an
optional trailing `name`; nothing else in the pinned API moves.

| Was | Now | Why |
|---|---|---|
| `Call as: path \| [limit]` on **every** throw of a ceulen tool | `Call as: read_slice({ path, start? })`, appended only when the failure is about the shape: the arguments do not fit the schema's top level (`shapeProblem`), or the body died on a `TypeError` | `Call as: patch` under "hunk is ambiguous" read as "call the tool named patch"; a pipe list read as alternatives |
| body runs with a required key missing | `missing required argument "url"` + `Call as:` before the body runs | a cold dispatch skips the registry's schema check, so the body crashed with `Cannot read properties of undefined` |
| unknown tool → `Call as: <closest name>` | `Closest tool: <name> — no tool is named "<wanted>". Use <name> only if that is the tool you meant.`; a cold name gets the `ceulen_tools` call instead | the nearest name is a guess (`codemap` is not `codemode`), and the marker no longer has two meanings |

`apply_patch` (repair) now also: reports the line numbers of an ambiguous hunk
with the two lines above each match, honours the text after `@@` as a search
start, numbers the failing hunk, and ends every preflight failure with
"No file was changed". Blocks stay capped (§4.7): the match preview shows at
most four matches of three lines each.

