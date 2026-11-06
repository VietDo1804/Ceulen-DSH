---
name: contract-first
description: "Coordination protocol for running 2+ subagents in parallel without drift. Before spawning interdependent agents (backend+frontend, data+report, migration+app, tests+impl, docs+code, ...), write a CONTRACT first: goal, parties with disjoint write scopes, shared artifacts (schemas/types/formats/units/naming), rules, done criteria, integration check. Commit it, announce each party's resolved model route, spawn all parties in ONE message referencing it, coordinate all contract changes centrally, integrate at the end. Uses the ceulen subagent roles: planner drafts the contract, worker parties build in parallel, reviewer audits compliance, tester runs integration. Also covers swapping a party's model for one task (settings edit, mid-session). Use when a task needs several subagents whose outputs must fit together, when the user asks which model a role will use or wants a different model per party, or when the user says 'contract-first' / 'chạy song song' with agents."
whenToUse: Use BEFORE spawning 2+ interdependent subagents — to draft and commit the contract, run the parallel build, the coordinator loop on findings, and the final integration check.
---

# Contract-first parallel subagents

Parallel agents diverge exactly where the agreement is silent: field names, units,
formats, who owns which files, what "done" means. So the agreement is written and
committed **before** any spawn. The artifact type is per task — OpenAPI for API
features, JSON Schema for data, TS types for shared models, plain prose for small
jobs. The method is always the same.

Non-tech users never read raw artifacts: the main agent proposes the contract in
plain language, the user confirms, agents execute.

## Which subagent role plays which part

| Phase | Role | Why |
|---|---|---|
| 0–1 draft contract | `planner` (optional) | read-only design; returns the contract with file/symbol anchors and risks |
| recon before drafting | `scout` (optional) | compressed codebase context so the contract matches reality |
| 2 parallel build | `worker` × N | full tool access, isolated implementation per party |
| 3 compliance audit | `reviewer` (optional) | read-only diff review; JSON findings map to findings triage |
| 4 integration check | `tester` | runs checks without editing repo files; reports exact commands/outcomes |

The coordinator (main agent) is never a `delegate` — it owns the contract, the
decisions, and the deltas. Spawn parties with `delegate` (`role: worker`) or
native `subagent`; children do NOT see this conversation, so each party's task
text must carry its role, owned paths, and the Rules block verbatim — never rely
on inheritance.

Every party runs on a resolved model route. Announce the routes (Phase 1.5) and
pin them in contract.md §2 before the spawn, so the user can swap a party's model
for this task.

## File layout (per task)

```
contracts/<task>/
  contract.md         # THE agreement — ONLY the coordinator (main agent) edits
  findings-<party>.md # each party's ONLY channel for "the contract is wrong"
  decisions.md        # coordinator's change log (who asked what, what changed)
```

## contract.md template

```markdown
# Contract: <task>
Date: <date> · Coordinator: main agent · Status: draft|committed|v<n>

## 1. Goal
<One paragraph, business level. What exists when this is done.>

## 2. Parties
| Party (role) | Owns (write) | Reads | Route (model) | Notes |
|---|---|---|---|---|
| be (worker)  | server/**   | contracts/, shared types | <provider/model:effort from Phase 1.5> | |
| fe (worker)  | client/**   | contracts/, generated types | <provider/model:effort from Phase 1.5> | |

Write scopes are DISJOINT. The contracts/ dir is read-only for every party.

## 3. Shared artifacts
Each interface parties share — the exact places drift happens:
| Artifact | Path/format | Producer | Consumers | Conventions |
|---|---|---|---|---|
| API spec | contracts/x/openapi.yaml | coordinator | be, fe | error envelope {code,message,details}; money: integer minor units + currency field; dates ISO-8601 |
| Types | <gen path> | generated from spec | fe | regenerate after every spec change |

Add: field names, units/currency, date format, enum values, naming conventions,
error shape. Machine-checkable when applicable (lint the spec, compile the types).

## 4. Rules
1. No party edits contracts/** or generated artifacts. Ever.
2. A suspected contract bug: STOP the affected part, write findings-<party>.md,
   CONTINUE work that does not depend on it. Do not improvise around the contract.
3. Only the coordinator changes the contract; changes are broadcast to affected
   parties at once, so no party ever works from two versions.

## 5. Done criteria
- <party>: <checkable statement, e.g. "tests validate every response against the spec">
- <party>: <e.g. "builds against generated types with zero hand-written duplicates">

## 6. Integration check
<The one cross-party run that proves the fit: start real BE, point FE at it,
walk one happy path + one error path. For non-UI tasks: the equivalent pipeline run.>
```

## Playbook

### Phase 0 — Agree the contract (coordinator + user)
Draft `contract.md` from the request. Check it at business level — this is the
cheapest place to change anything:
- Is the data sufficient for every stated flow?
- Does every flow have an owner party and the artifacts it needs?
- What happens on wrong input, empty data, permission denied?
- Units, currency, naming, date format pinned?
Non-tech user: propose answers in plain language, get confirmation, never show YAML.
Optional: `delegate` a `scout` for codebase recon, or a `planner` to draft the
contract for a consequential task — the coordinator still owns and finalizes it.

### Phase 1 — Commit the contract
Finalize artifacts. Validate what is machine-checkable
(`npx @redocly/cli lint` for OpenAPI; `npx openapi-typescript` for types — if npx
is unavailable, hand-write and mark weaker). `git add contracts/ && git commit` —
the contract commit must precede any implementation commit (tamper-evidence).

### Phase 1.5 — Announce the routes before the spawn (do not skip)
Each party's model is resolved from the Ceulen settings document
(`~/.dsh/ceulen/settings.json` → `subagent.models`, `subagent.thinking`,
`subagent.roles` chains). Print it in the message right before spawning, so the
user can move a party to a cheaper or stronger model for THIS task:

```
routes for this task
  planner   opencode-go/glm-5.3-flash:max
  worker    opencode-go/deepseek-v4.1-flash:max      x2 (be, fe)
  reviewer  zai/glm-5.3:max
  tester    opencode-go/deepseek-v4.1-flash:max
```

Quote `/subagent` (all roles) or `/subagent <role>` (selector → chain → route →
thinking). Never guess a route. Do not spawn while a role shows `?`,
`parent route`, or `unresolved:` unless that is genuinely what you want.

**Mid-session override** — the only per-task knob, because `delegate` takes no model
argument: never smuggle a route into a party's task text and expect it to take
effect. `delegate` re-reads the settings document on every call, so an edit applies
to the next spawn with no restart:

1. `cp ~/.dsh/ceulen/settings.json ~/.dsh/ceulen/settings.json.bak-<task>`
2. set `subagent.models.<role>` to `provider/model` (a `:effort` suffix beats
   `subagent.thinking`; `*` inherits this session's route)
3. run `/subagent <role>` again to confirm — malformed JSON silently falls back to
   defaults, so a vanished override means the edit broke the file
4. after the task: restore the backup, or keep the change on purpose — say which

A route change only affects the NEXT spawn; once parties are running it cannot
retro-fit them. Log any override in decisions.md (role, old → new, backup path,
who asked), and copy the resulting routes into contract.md §2.

### Phase 2 — Spawn in parallel
ONE message, N `delegate`/`subagent` calls (concurrent), role `worker` per party.
Each prompt: party role, owned paths, contract path, and the Rules block verbatim.
Optional unblocking aids: `npx @stoplight/prism-cli mock` serves an OpenAPI spec
directly; fixtures for a JSON Schema. A party must never wait on another party's
runtime to start.

### Phase 3 — Coordinator loop
When parties return:
1. `git diff --name-only contracts/` — a hit means a party broke Rule 1: revert
   the touch, log it, treat its findings with suspicion.
2. Read each findings file. Decide: accept (edit contract, regenerate artifacts,
   log to decisions.md, commit) or reject (tell the party why).
3. `send_message` only the affected party with the delta — never a full re-run.
   A change touching several parties is sent to all of them in one message each.
Optional: `delegate` a `reviewer` over the combined diff to audit contract
compliance before triage — its JSON findings feed the same triage.

### Phase 4 — Integrate
`delegate` a `tester` to run the contract's integration check (UI tasks: browser
via `web_interact` — the tester reports, the coordinator judges). Mismatch → fix
the contract first, regenerate, re-verify. Then merge. Done = every done-criterion
checked + integration run executed.

## Edge cases

- **Conflicting findings** from two parties → coordinator picks one version, both follow.
- **Change invalidates finished work** → delta task to that party only.
- **1 party or trivial task** → no contract; plain delegation. The method pays off
  only at 2+ interdependent parties.
- **Silent/blocked party** → its findings file + status report surface the stall at
  the coordinator, not at merge time.
- **Tiny feature (1–2 endpoints)** → prose contract may replace OpenAPI; keep
  artifacts no heavier than the task.
- **Route is not what you expected** (`?`, `parent route`, `unresolved:`) → fix
  `~/.dsh/ceulen/settings.json` and re-read `/subagent` before spawning. A child on
  the wrong model is a silent quality regression, not a visible error.

## Self-check before claiming done

- [ ] Contract committed before any spawn (`git log` proves it)
- [ ] Routes printed from `/subagent` before the spawn; every override is in
      decisions.md (old → new, backup path, restored or kept)
- [ ] `git diff contracts/` clean after runs, or explained in decisions.md
- [ ] Every done-criterion checked; integration check executed once for real
- [ ] Findings files addressed (accepted or rejected with reason)
