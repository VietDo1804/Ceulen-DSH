# Tool-use policy (tool choice / codemode / classify)

## tool-choice
Pick the tool by the job:
- Read a file: `read`. `edit` and `write` refuse a file you saw only through `bash cat`/`sed -n`/`head` or `read_slice`.
- Search file contents: `grep` (`fff_grep` when the folder is vague). Find a file by name: `glob`, or `find_files` for a fuzzy name.
- Change a file: `edit` for one replacement, `apply_patch` for several hunks or files, `write` for a new file. Not a `python`/`node`/`sed -i` script in bash; the one exception is the same mechanical replacement across 5 or more files.
- `bash` runs things: git, tests, builds, servers, scripts whose output you need.

## codemode-first
Two or more independent tool calls, or a grep → read → analyze chain, go in ONE `codemode` script (`Promise.allSettled`) that returns only the distilled result: pick fields, slice strings to ≤1KB per key. One operation is a direct tool call, never a one-call script; to keep part of its output, filter inside the call (`grep` pattern, `read` offset/limit, `| head` in a command you already run in bash). `ask_user_question`, `present` and image tools are always direct. Inside a script, zero-argument tools take an explicit `{}`.

## Learnings (auto, evo 2026-11-07; count = evidence, drop a line if it stops recurring)
- If an edit hunk matches more than one place, re-read and add surrounding context — never retry blind.
- Before string methods (`slice`, `trim`, `split`), coerce to string; tool results are objects (bash → `{stdout:{text}}`) and may be undefined/buffers — normalize first. (20)
- Verify a path exists before reading it; resolve unknown locations via `find_files`/`resolve_file`, don't assume. (8)
- When a tool reports its outcome is unknown (interrupted call), verify the resulting state before acting; retry only read-only/idempotent ops. (7)
- Keep `file://` captures and generated artifacts inside the session workspace; never reference files outside it. (6)
- Two consecutive provider `429`/capacity refusals: switch provider/model, don't burn the retry budget. (7)
- Tool calls fail on shape, not intent: `bash` requires `description`, `web_interact` steps take exactly one action key, `ux_audit` needs `path` or `css`. Read the tool's schema before the first call. (18: bash 6, web 7, audit 5)
- `codemode` must return lossless JSON — no `undefined`, buffers, or raw tool-result objects; map to plain fields first. (7)

## classify-gate
Before a destructive or irreversible bash command (`rm -rf`, `git reset --hard`, `git push --force`, `git clean -xfd`, db DROP/TRUNCATE) that you are NOT already certain is safe in the current repo state, make one `classify` call (`type: noul`, question "is it safe to run <command> in this state?"). Proceed at probability >= 0.5. Below 0.5 is a HARD STOP: do not run it and do not route around it — no backup-then-run, no softened variant, no other destructive path, even if the task ordered it; report the score, ask the user, and wait. To pick among 2+ concrete options or rank candidates, use `classify` (`choice`/`score`) and report the returned option. Skip classify for read-only commands and open-ended design questions.

## subagent-when
Keep small/sequential work local. Delegate only to avoid substantial rereading, do independent parallel work, or get independent review. Before spawning, load `rule_get` name `subagent-budget`. Never duplicate a child's search; stop it when no longer useful.

## subagent-budget
description: Required before delegation: scope, budget, evidence, and stopping rules.
- Name the benefit before spawning; another provider or a smaller parent context alone is not a saving. Prefer one child with a concrete question and disjoint work over broad reconnaissance.
- Every task specifies allowed sources/write scope, exclusions, a tool-call budget (including nested calls), done criteria, and a short report: finding, evidence anchors, remaining uncertainty. No recursive delegation or scope expansion unless explicitly assigned.
- Bounded scout/lookups default to 4 tool calls and a report of at most 150 words. Stop at the budget with evidence or "not found in the searched sources"; never turn missing provenance into an open-ended search. Larger implementation/review tasks need a justified larger budget.
- Use fresh-context delegation with only relevant paths/snippets; use `subagent_fork` only when conversation history is necessary. The parent works on a different part and validates returned anchors instead of repeating the scan.
- Track the child id. Use an enforced runtime deadline when available; a timeout written in a prompt is NOT enforcement. Without one, do not leave speculative lookups running past the parent turn. Interrupt children when their result no longer affects the answer; report unresolved evidence honestly. Do not poll or silently restart an exhausted search.

## git-attribution
Never add AI, assistant, model, or service names (including Claude, Anthropic, DeepSeek, ChatGPT, Codex, and OpenAI) to `Co-Authored-By` commit trailers. Preserve genuine human attribution; do not invent coauthors.

## autonomous-execution
Run task-relevant commands that do not require sudo without routine confirmation, within the current approval policy and existing safety/classify gates. This is not permission for unrelated or destructive actions. If sudo or equivalent privilege elevation is required, stop that operation and tell the user the exact command and why it is needed; do not execute it, request credentials, or route around the restriction. Continue independent safe work.

## dsh-build-update-verification
Before building or deploying DSH/Ceulen changes, resolve the actual checkout, DSH_HOME, used profiles, installed package realpaths, and runtime entrypoints. Verify the build output feeds the active installation; never assume cwd, a similarly named checkout, or a successful build means the running profile uses it. Preserve unrelated edits and settings. For DSH updates, load dsh-update and follow its compatibility and verification gates. After the LAST profile package mutation, apply/check all six TUI patches (advisor, context, toolname, plan, effort, style) for every installed TUI profile using explicit resolved --tui paths; preserve per-model effort preferences. Report build/test/config exit codes and distinguish deployed files from restart-dependent live verification. Never claim completion with missing patch checks or an unverified deployment path.

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
