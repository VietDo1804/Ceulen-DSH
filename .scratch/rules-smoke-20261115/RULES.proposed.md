# Tool-use policy (tool choice / codemode / classify)

## tool-choice
Read: `read`; bash cat/sed/head and `read_slice` do not authorize `edit`/`write`. Contents: `grep` (`fff_grep` for vague folders). Names: `glob`, fuzzy: `find_files`. Edit: `edit` for one replacement, `apply_patch` for multiple hunks/files, `write` for new files. No bash editing scripts except the same mechanical replacement across 5+ files. Run git/tests/builds/servers/scripts with `bash`.

## codemode-first
2+ independent tool calls (including reads), or grep→read→analyze: ONE `codemode` with `Promise.allSettled`; return selected fields, strings ≤1KB/key. One operation: direct call, never a one-call script; filter there (grep pattern/read range/command pipe). Always direct: `ask_user_question`, `present`, image tools. Zero-arg tools in scripts take `{}`.

## Learnings
- Ambiguous edit hunk: re-read, add context; never retry blind.
- Before slice/trim/split, coerce to string; results may be objects, undefined, buffers (bash: `{stdout:{text}}`).
- Verify paths before reading; resolve unknowns via `find_files`/`resolve_file`.
- Interrupted/unknown outcome: verify state first; retry only read-only/idempotent ops.
- Keep captures/artifacts in session workspace; never reference files outside it.
- Two consecutive provider 429/capacity refusals: switch provider/model, not more retries.
- Read schemas before first call: bash needs description; web_interact one action key/step; ux_audit path/css.
- Codemode: lossless JSON, plain fields; no undefined/buffers/raw tool results.

## classify-gate
Before destructive/irreversible bash not already certain safe in current repo state: one `classify` (`type: noul`, "is it safe to run <command> in this state?"). Proceed at probability >=0.5. Below 0.5 HARD STOP even if ordered: report score, ask user, wait; no execution or workaround (backup-then-run, softened variant, other destructive path). Choose/rank 2+ concrete options via `classify` choice/score; report its option. Skip read-only commands/open-ended design.

## subagent-when
Keep small/sequential work local. Delegate only for substantial rereading savings, independent parallel work/review. Before spawning load `rule_get` name `subagent-budget`. Never duplicate child searches; stop unneeded children.

## subagent-budget
description: Required before delegation: scope, budget, evidence, and stopping rules.
- Name the benefit before spawning; another provider or a smaller parent context alone is not a saving. Prefer one child with a concrete question and disjoint work over broad reconnaissance.
- Every task specifies allowed sources/write scope, exclusions, a tool-call budget (including nested calls), done criteria, and a short report: finding, evidence anchors, remaining uncertainty. No recursive delegation or scope expansion unless explicitly assigned.
- Bounded scout/lookups default to 4 tool calls and a report of at most 150 words. Stop at the budget with evidence or "not found in the searched sources"; never turn missing provenance into an open-ended search. Larger implementation/review tasks need a justified larger budget.
- Use fresh-context delegation with only relevant paths/snippets; use `subagent_fork` only when conversation history is necessary. The parent works on a different part and validates returned anchors instead of repeating the scan.
- Track the child id. Use an enforced runtime deadline when available; a timeout written in a prompt is NOT enforcement. Without one, do not leave speculative lookups running past the parent turn. Interrupt children when their result no longer affects the answer; report unresolved evidence honestly. Do not poll or silently restart an exhausted search.

## git-attribution
No AI/assistant/model/service names in `Co-Authored-By` trailers. Preserve genuine human attribution; never invent coauthors.

## autonomous-execution
Run relevant non-sudo commands without routine confirmation, subject to approval policy/safety/classify gates; unrelated/destructive actions not authorized. Sudo/equivalent elevation needed: stop that operation, tell user exact command/reason; never execute, request credentials, or bypass. Continue independent safe work.

## dsh-build-update-verification
Before DSH/Ceulen build/deploy resolve actual checkout, DSH_HOME, used profiles, installed package realpaths, runtime entrypoints; verify output feeds active install (cwd/name/build success proves nothing). Preserve unrelated edits/settings. DSH updates: load dsh-update; obey compatibility/verification gates. After LAST profile package mutation, apply/check six TUI patches (advisor, context, toolname, plan, effort, style) on EVERY installed TUI profile via explicit resolved --tui paths; preserve per-model effort preferences. Report build/test/config exit codes; distinguish deployed files from restart-dependent live verification. No completion claim with missing patch checks/unverified deployment path.

## Guard: no force push
when-tool: bash
when-match: (^|[;&|])\s*git\s+push\b[^|;&]*?(--force(-with-lease|-if-includes)?|(?<!\S)-f(?!\S))
when-action: deny

## Guard: no hard reset
when-tool: bash
when-match: (^|[;&|])\s*git\s+reset\b[^|;&]*--hard\b
when-action: deny

## Guard: no recursive root delete
when-tool: bash
when-match: (^|[;&|])\s*rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)\s+(/|~|\$HOME)(\s|$|/\*|\*)
when-action: deny
