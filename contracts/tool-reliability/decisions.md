# Decisions — tool-reliability

Coordinator's change log. Parties never edit this file.

## 2026-10-29 · v1 committed

- Contract drafted and committed (`7d42697`) before any party was spawned.
- **Scope corrected by the user mid-draft:** the upgrade must live entirely in
  `ceulen-dsh`; no DSH core change, no `node_modules` patch. Consequence:
  the plan's pre-dispatch mutation idea (`exec.arguments` / `exec.name`) is
  dropped — the execution object being mutable is an internal detail, not a
  supported surface. v1 is **annotation-only**.
- Amendment `adde31d`: the two parties share a text convention, not code.
  `repair` imports nothing from `src/core/toolguard.ts`, so neither party
  blocks the other and both can run their own tests green in parallel.
- Amendment `21ddacd`: rule 1 allowed the impossible (parties must write
  findings but may not touch `contracts/`); now each party may write exactly
  its own `findings-<party>.md`. Integration check no longer contains the
  non-command placeholder.
- Layer 2 folded into the existing `repair` module instead of a new
  `toolguard` module: one less cordis row, no new settings toggle, no
  smoke-count churn, and `apply_patch` (the tool half of that layer) already
  lives there.
- Delegated: `core` (worker) and `repair` (worker), spawned in one message.
  Coordinator keeps: contract, codemode guidance, plan-doc corrections,
  integration run, re-measurement.

## Coordinator work done while parties ran

- `docs/tool-reliability-plan.md` §4/§5/§6/§7 corrected to annotation scope;
  first-attempt target lowered 99.0% → 98.6% because native stale/read errors
  cannot be prevented from this repo.
- `src/modules/codemode/index.ts`: description now tells the model to retry a
  failed call shape inside `try/catch` (P4), so a wrong variant inside a script
  costs no extra model turn.

## 2026-10-29 · integration

- **Party `core` died mid-task** (subagent failure, last line "Writing
  src/core/toolguard.ts"). It had written a sound `toolguard.ts`; coordinator
  reviewed it, tightened the rename rule (target must declare `type` or `enum`,
  otherwise any value matches and the rename is a guess), then did the missing
  wiring + tests itself. Committed `f731c25`. Lesson: a dead worker can look
  productive by leaving good code — the report is the deliverable.
- **Party `repair` completed** and reported. Its log line omitted the "outcome"
  word the contract asked for; accepted — every logged line is an applied
  repair, so the word is noise. Contract §3 amended to `<tool> <repair-kind>`.
- Coordinator change to party code: `readLines` now reads through the mounted
  `fs` service (session sandbox applies) instead of raw `node:fs`; raw read is
  only the no-service fallback. A model-supplied path must not be able to echo
  content the sandbox would have refused.
- Verified in the harness source: `exec.arguments` exists on the execution
  object handed to `tools/execute` (deep-frozen JSON snapshot,
  `createExecution`). It is frozen — further confirmation that the dropped
  pre-dispatch mutation idea was never supported.
- Contract §6's walk is executed for real in `test/toolguard-compose.test.ts`:
  one failing `apply_patch` call carries core's `Call as: patch` **and** repair's
  `Current region:`, in that order, exactly once each. My earlier note that the
  ordering was "structural, not runtime-tested" was wrong — a ceulen tool *does*
  hit both layers (core inside `execute`, repair at `tools/execute`).
- Limitation, stated rather than hidden: no real-harness execution was possible
  from the repo — the middleware is exercised against `createFakeCtx` only. If
  the live hook ever omits `exec.arguments`, repairs no-op and return the
  original result, which is the intended safe failure mode.

## Retro: the one failing test during the core run

At the time I attributed the single `test/toolguard-middleware.test.ts` failure
to the running party's in-progress file. That claim was unevidenced when made.
What is checkable: `git diff f731c25..HEAD -- src/core/` is empty, so the core
code was identical on the red run and on the green run — the only variables
were the party's two files. What is not recoverable: that version of the test
was never committed, so the exact failing assertion cannot be replayed.
The compose test above is the check that would have caught it had my wrapper
been the cause.

## 2026-10-29 · reviewer triage (6 findings)

| # | Finding | Decision |
|---|---|---|
| 1 | MAJOR `candidatePaths` listed siblings outside the workspace via raw readdir | **Accepted.** Enumerates only when the resolved target is inside the session cwd (`insideCwd`); otherwise the repair is skipped. Test: "never lists siblings outside the workspace". |
| 2 | MAJOR `readLines` fell back to raw `readFile` with no fs service mounted | **Accepted.** Fallback deleted — no service, no repair. One existing test was relying on that unsandboxed path; it now mounts `diskFs()`, and a new test pins "stays silent when no fs service is mounted". |
| 3 | MINOR `contract.usage` appended `Call as:` without the marker check | **Accepted.** `withCallShape` now takes `schema \| string`, so there is one idempotent appender and no second format. |
| 4 | MINOR every `type:'string'` value trimmed, so `content`/`patch` lost whitespace | **Accepted.** Strings are data: never trimmed. Only literal number/boolean parses may fire. Test asserts byte-identical content. |
| 5 | MINOR marker check and content spread ran outside the try/catch | **Accepted.** Listener bails unless `Array.isArray(result.content)`, so a malformed result cannot make the annotation layer throw (rule 6). |
| 6 | MINOR `04552ab` carried a contract edit inside the repair party's commit | **Accepted as a process blemish.** The content was the coordinator's (log-format reconciliation) and correct, so the commit is not rewritten — rewriting history costs more than the ambiguity. Rule going forward: contract amendments get their own commit, never ride along with party work. |

Gate after fixes: `tsc --noEmit` clean, `vitest run` 30 files / 260 tests pass.
