---
name: contract-first
description: "Coordination protocol for 2+ subagents whose outputs must fit together (backend+frontend, data+report, migration+app, tests+impl, docs+code). Before dispatching, write a contract: goal, parties with disjoint write scopes and waves, shared interfaces with a pinned example, rules, done criteria, one integration check. Then brief every party from it, handle contract problems centrally, and integrate. Fits orchestrator mode and plain delegation. Use when a task needs several subagents working in parallel, or when the user says 'contract-first' / 'chạy song song'."
whenToUse: Use BEFORE dispatching 2+ interdependent subagents — to write the contract, brief the parties, handle contract problems, and run the integration check.
---

# Contract-first parallel subagents

Parallel agents diverge exactly where the agreement is silent: field names,
units, formats, who owns which file, what "done" means. So the agreement is
written **before** anyone is dispatched. The artifact fits the task: OpenAPI for
an API, JSON Schema for data, TS types for shared models, plain prose for a small
job. The method is the same every time.

One party, or parts that do not touch each other: no contract, plain delegation.
The method pays off at two or more parties that must fit.

In orchestrator mode the plan comes first: the user approves `.dsh/plans/<date>-<task>.md`
before any contract is written, and the contract only pins how that plan's tasks
fit together. A party is a plan task (`T1`, `T2`, …); the contract adds no work
the plan does not list.

## Who does what

| Part | Who | Notes |
|---|---|---|
| Owns the contract, decides, sends changes | coordinator (the main agent) | never delegated |
| Recon before drafting | `scout` (optional) | when the area is unfamiliar |
| Drafts a consequential contract | `planner` (optional) | the coordinator still finalizes it |
| Builds one party's part | `worker` × N | isolated, disjoint write scopes |
| Audits the combined diff | `reviewer` (optional) | for risky or behaviour-changing work |
| Runs a long integration check | `tester` | reports commands and outcomes |

A child starts with a fresh context and sees only its brief. Everything a party
needs is in the brief or in the contract file the brief points to.

## Files

```
contracts/<task>/
  contract.md    # the agreement; only the coordinator edits it
  decisions.md   # the coordinator's change log, once there is a change to log
```

A party never writes in this directory. A party that finds a problem with the
contract reports it in its result (Rules, below); the coordinator decides.

## contract.md template

Keep it as heavy as the task: a two-module job needs a page, not a spec.

```markdown
# Contract: <task>
Date: <date> · Coordinator: main agent · Status: draft | agreed | v<n>

## 1. Goal
<One paragraph, business level: what exists when this is done.>

## 2. Parties
| Party (role) | Owns (write) | Reads | Wave | Route |
|---|---|---|---|---|
| be (worker) | server/** | this contract, shared types | 1 | <provider/model:effort> |
| fe (worker) | client/** | this contract, generated types | 1 | <provider/model:effort> |
| glue (worker) | app/routes.ts | this contract, server/**, client/** | 2 | <provider/model:effort> |

Write scopes are DISJOINT. A party in a later wave may read what an earlier wave built.
Nobody's: package.json, lockfiles, README.md, shared config, every file not listed
above. A party that needs one of them changed says so in its result.

## 3. Shared interfaces
The exact places drift happens: signatures, field names, units, currency, date
format, enum values, error shape, naming.
| Interface | Where | Producer | Consumers | Conventions |
|---|---|---|---|---|
| API spec | contracts/<task>/openapi.yaml | coordinator | be, fe | errors {code,message,details}; money in integer minor units |

Pinned example — one concrete input with its exact output, worked by hand:
<input> → <output>
Every party tests against it, and it is the integration check's expected result.

## 4. Rules
1. Write only what you own. Never write in contracts/ or in a file that is nobody's.
2. If the contract looks wrong, silent or contradictory: do not improvise around
   it. Finish what does not depend on it and report the problem in your result.
3. Only the coordinator changes the contract, and tells every affected party.

## 5. Done criteria
- <party>: <a checkable statement, e.g. "tests cover the pinned example and the unknown-code error">

## 6. Integration check
<The one cross-party run that proves the fit: a command and its expected output
(the pinned example), or the happy path plus one error path walked end to end.>
```

## Playbook

### 1. Agree the contract
Draft `contract.md` from the request and check it at business level, where a
change is cheapest:
- Does every stated flow have an owner and the data it needs?
- What happens on wrong input, empty data, permission denied?
- Are units, currency, naming and date format pinned?
- Is every file some party will need to touch owned by exactly one party?

Ask the user only when the contract has to settle a business decision the
request left open (which rounding, which error the customer sees). Put the
question in plain language with your recommendation, never raw YAML. Everything
else you decide yourself: say the choice in one line and go on. A decision that
changes what the approved plan says is not a contract detail: change the plan,
which goes back to the user.

Validate what is machine-checkable (`npx @redocly/cli lint` for OpenAPI,
`npx openapi-typescript` for types). When the contract is ready, set
`Status: agreed`.

### 2. Keep the contract from drifting
- **Orchestrator mode:** the harness refuses any child's edit inside the
  contract directory, so the agreed file stays as you wrote it. Do not commit
  it for protection.
- **Plain delegation:** nothing guards the file. Note
  `sha256sum contracts/<task>/contract.md` in `decisions.md` before dispatch and
  compare after the parties return.

Commit the contract only when the user asked for commits or the repo's workflow
expects them, and only with the git identity the repo already has. Never set or
invent a `user.name` / `user.email`: without an identity, do not commit.

### 3. Say the routes
Each role runs on a model route from the Ceulen settings. When you dispatch a
wave, say in one line which route each party runs on, and copy it into §2, so
the user can move a party to a cheaper or stronger model for the next dispatch.
- Orchestrator mode: the routes are listed in the mode prompt.
- Otherwise: read `subagent.models` and `subagent.thinking` in
  `~/.dsh/ceulen/settings.json`. `/subagent` shows the same table, but only the
  user can run it.

Never guess a route, and never put a model name in a brief expecting it to take
effect: `delegate` takes no model argument. To change a party's model for this
task, follow [references/routes.md](references/routes.md).

### 4. Brief and dispatch, one wave per step
Send every party of a wave in ONE step as parallel `delegate` calls. A party
must never wait on another party's running process: give it a mock
(`npx @stoplight/prism-cli mock` for OpenAPI) or fixtures instead.

The brief comes straight from the contract:

| Brief line | From |
|---|---|
| Plan | the plan task id this party carries out (orchestrator mode) |
| Goal | §1, narrowed to this party's part and wave |
| Context | the contract path ("read it first"), what earlier waves delivered |
| Scope | this party's "Owns", plus what is nobody's |
| Acceptance | this party's Done criteria and the pinned example |

- **Orchestrator mode:** those labelled lines are the brief the mode
  requires. The harness appends the handoff rules and the report format, so do
  not paste §4. Use `delegate` for every party: a child started with native
  `subagent` is not tracked, and its wave never reaches a checkpoint.
- **Plain delegation:** the child gets nothing but your text. Add the party's
  role and paste §4 verbatim.

### 5. Coordinate
When a wave returns:
1. Read every result for contract problems: the `BLOCKERS` and `DEVIATIONS`
   lines of the handoff report, or wherever the party described them.
2. Decide each one. Accept: edit the contract, raise `Status` to `v<n>`,
   regenerate derived artifacts, log it in `decisions.md` (who asked, what
   changed). Reject: tell the party why.
3. Send the change with `send_message` to every party it affects, as the delta
   only, never a full re-run. Two parties in conflict: pick one version, both
   follow.
4. Plain delegation: compare the contract's hash; a change you did not make
   means a party broke Rule 1, so restore the file and distrust that result.

### 6. Integrate
Run §6 once for real, against the parties' actual output:
- one short command (the test suite, the pinned example): run it yourself;
- a long run, a browser walk (`web_interact`), or anything that needs its own
  context: `delegate` a `tester`; it reports, you judge.

A mismatch is a contract problem first: fix the contract, tell the affected
party, verify again. A risky or behaviour-changing result also gets a
`reviewer` over the combined diff before you report.

## Edge cases

- **A change invalidates finished work:** a delta to that party only.
- **A party is silent or blocked:** its result says so; answer it before the next wave depends on it.
- **A file nobody owns must change:** the coordinator assigns it to one party in the next wave, or to a new one-file party.
- **A route shows `?` or an unresolved entry:** fix the settings before dispatching. A child on the wrong model is a silent quality drop, not a visible error.
- **Not a git repo, or no git identity:** nothing here needs git.

## Self-check before claiming done

- [ ] Contract agreed before the first dispatch; every later change is in `decisions.md`
- [ ] Every file a party wrote was in its own scope; the contract is as you left it
- [ ] Routes named at dispatch and copied into §2; any override restored or kept on purpose
- [ ] Every contract problem a party reported was accepted or rejected with a reason
- [ ] Every done criterion checked; the integration check ran once for real
