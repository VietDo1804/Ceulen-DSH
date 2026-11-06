---
name: evo
description: "End-of-session self-evolution postmortem for DSH. Distills what the session actually did (done / errors / friction / improvement candidates) into one ledger line and stores only durable verified lessons in Munin. Use when the user says 'evo', 'postmortem', 'session review', 'learn from this session', or asks what we improved today."
whenToUse: Run at session end or after a substantial task completes. One pass over the conversation already in context. Not for mid-task reflection.
---

# evo — self-evolution postmortem

Loop: **DISTILL → VERIFY → STORE**. Promotion into rules or skills is NOT part
of evo — the weekly consolidator owns that and requires repeated evidence.
An explicit user request overrides this.

## 1. Distill this conversation

- **done** — 1-3 concrete outcomes.
- **errors** — `{error, root_cause, fix}` for failures actually hit (tool
  errors, build/test failures, fixes that landed in the wrong place). Not
  hypotheticals.
- **friction** — anything that cost retries or time: sandbox denials, gates
  that fired, surprising tool-result shapes, missing paths.
- **improvements** — 0-3 concrete next steps: missing rule, missing skill,
  automation script, stale memory to update.

## 2. Append to the ledger

One compact JSON line per session in
`${DSH_HOME:-~/.dsh}/ceulen/self-evo/ledger.jsonl` (create the directory if
missing):

```json
{"ts":"ISO-8601","session_id":"<uuid if known>","ws":"<workspace>","done":[],"errors":[],"friction":[],"improvements":[],"stored":[]}
```

Append, never rewrite. The ledger is the raw evidence the weekly pass reads.

## 3. Store only durable, verified knowledge

Before storing: `munin_search` for a near-duplicate. Found it → skip, or
upsert the same key deliberately.

Store once with `munin_store` (the primary memory). Do not second-copy it with
`agentmem_store`: that is the Pi replica, refreshed from the cloud, so the
duplicate can diverge.

Store: recurring bug root causes (`type:bug-fix`), stable setup facts
(`type:fact`), decisions with rationale (`type:decision`), dependency
choices (`type:dependency`) — always with one `domain:` tag.

Never store: transient progress, TODOs, raw logs, unverified hypotheses,
session summaries, secrets (redact tokens, keys, hosts, IPs).

## 4. Report

At most three lines: distilled / stored (keys, or "nothing durable") /
skipped and why.

## Daily pass (cron `evo-daily`)

When the prompt starts with `[cron evo-daily]` or the user asks for the daily
pass:

1. Distil new sessions (no model involved, deterministic):

   ```sh
   node "$(dirname "$(readlink -f "$DSH_HOME/profiles/${DSH_PROFILE:-tui}/node_modules/ceulen-dsh)")/scripts/evo-distill.mjs"
   ```

   Each finished session becomes one digest in
   `$DSH_HOME/ceulen/self-evo/queue/`. Already-processed sessions are skipped
   via `state.json`; the pass's own sessions are skipped by prompt prefix.
2. Drain the queue: for every `queue/*.md` digest, write one ledger line
   (step 2 shape), store only durable lessons (step 3), then move the digest
   to `queue/done/`. Do not re-derive what the digest already states.
3. Report: sessions distilled, ledger lines, memories stored, and anything
   that recurs across sessions — recurrence is the Phase 2 promotion signal,
   so name it even when you do not promote it.

## Weekly promotion pass (`evo-promote`)

The distiller and report are deterministic; this pass is not. A signature
qualifies for promotion only at **>= 5 occurrences** in the packet.

1. `node "<ceulen-dsh>/scripts/evo-report.mjs" --promote` — writes
   `reports/promotion-<date>.md` and prints it. Then call `evo_pass` to have
   the configured Evo model (`/ceulen-config → Model → Evo`) draft the rule
   lines into `reports/proposal-<date>.md`; review that draft, do not trust
   it blindly.
2. For each candidate choose exactly one: a scoped line in the
   `## Learnings (auto, evo)` section of `$DSH_HOME/ceulen/RULES.md`, a
   skill, or a script fix. State the result, not the symptom, and keep the
   section under ~15 lines — delete lines the new evidence supersedes.
3. Drop candidates that are incident-specific (one provider outage, one
   broken checkout) instead of promoting them.
4. Call `evo_notice` ONCE with a one-line summary of what actually changed
   and the counts as detail. It writes the changelog entry and renders the
   `💾 Self-improvement` notice in the session (or replays it at the next
   idle if nothing is live). No change → no call.
5. Report: promoted / rewritten / dropped, one line each with the count that
   justified it.

Never promote below the threshold because the packet "looks convincing" —
the count is the gate.

