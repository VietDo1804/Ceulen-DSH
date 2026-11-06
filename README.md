# ceulen-dsh

Ceulen's toolkit for **DeepSeek Harness** (DSH): reviewer, memory, rules with behaviour guards, cron, GitHub, web extraction, A2A, UX audit, themes, structural search, an evidence-gated self-evolution loop, and a built-in upstream release watcher — installed as one DSH bundle.

Ceulen itself is a Pi extension bundle. DSH has a different plugin API, so this project is an independent port: UI-independent logic is vendored from Ceulen (MIT), and each feature gets a thin DSH adapter. The module-by-module status lives in `docs/parity.md` (kept with the source checkout, not published).

## Requirements

- DSH `0.2.1-rc.5` (the `dsh` CLI and `dsh-tui` 0.18.0 profile)
- Node.js `>=22.19` (tested on Node 24)
- Optional backends: `gh`, `sg`/`ast-grep`, `rtk`, Serena, Chrome/Chromium, a Munin server, a Brave Search key, an OpenAI-compatible router, A2A peers

## Install

From this checkout, install the bundle into the TUI profile and restart:

```sh
dsh plugin --profile tui add link:"$PWD"
```

`link:` keeps this checkout as the source of truth; rebuild with `npm run build` after changes and reload.

Installing on another machine, with no checkout: either install the published package with
`dsh plugin --profile tui add ceulen-dsh`, or build a frozen tarball and ship it —
see [release/README.md](release/README.md) for the one-command install (`dsh plugin
--profile tui add file:<tarball>` or an HTTPS URL, plus `--with-tui` on a fresh host). The plugin manager writes outside the workspace, so the install needs explicit approval.

Upgrade is the same command with the newer version (`add ceulen-dsh@<version>` for the
npm channel, a new tarball for the frozen one). A newer npm release is reported in the
session status line (`bundle <version> available`); `/ceulen upgrade` prints the exact
install + restart pair, and `/ceulen update` checks both upstream Ceulen and this bundle.

After restart:

```text
/ceulen
/ceulen-config   # full-screen settings panel
```

You should see the release line (`ceulen-dsh 0.2.2 (stable)`), the pinned
Ceulen version, and the mounted/native/planned modules.

This checkout is already linked into `~/.dsh/profiles/tui`. The bundle composes
31 rows. See `docs/live-verification.md` for the evidence.

### Release line

`package.json` carries this bundle's own version (`0.2.2`) plus
`release: { line: "stable", distTag: "stable" }`; the upstream Ceulen version it
tracks lives in `upstream.lock.json` (`0.23.0`). The bundle update check follows
the `stable` npm dist-tag, so `latest` staying on the old `0.23.0-dsh.x` line
never reads as an upgrade — and a missing tag reports `unknown` instead of
inventing one. `/ceulen doctor` prints the line and dist-tag it follows.

## What works today

| Area | DSH surface |
|---|---|
| Status/config | `/ceulen`, `/ceulen modules`, `/ceulen tools` (schema budget), `/ceulen-config` (full-screen panel), `/ceulen config`, `/ceulen doctor` (services, compat flags, release line) |
| Upstream | `/ceulen update`, status line, `ceulen-sync` CLI, weekly CI check |
| Advisor | second-model review after settled work, one severity note, `/advisor`, `advisor` tool |
| Subagent roles | `delegate` starts a fresh-context child with a Ceulen role preset (planner, reviewer, scout, tester, worker); the role persona and provider/model route come from `subagent.roles`, `subagent.models`, and `subagent.thinking`; `/subagent` shows the routes. Native `subagent`, `subagent_fork`, and `workflow` remain |
| Memory | Munin is the primary store: `munin_search/get/store/...`, `/munin-status`, the Memory Protocol, and the first-turn brief (`munin.brief`, resolved in the background so it lands from the first re-composed prompt — usually turn 2). `munin.fallback.baseUrl` + `MUNIN_FALLBACK_API_KEY` make a dead cloud answer from the opimem bridge instead of erroring (transport failures only — a 401 still surfaces) |
| AgentMem | the same eleven tools under `agentmem_*` plus `/agentmem-status`: one opimem server on the LAN, by default the Pi replica that `munin.fallback` fails over to. Reads are ~50x faster than the cloud but can lag it by up to a week (the pull window is weekly; the UI's "Sync now" refreshes on demand), so its brief is off and the protocol says not to double-write through it |
| Rules | sticky `.dsh/RULES.md` + rulebook, `when-*` behaviour guards (`rules.guards`), read-only `AGENTS.md` / `.cursor/rules/*.mdc` / `.clinerules` sources, `rule_get`, `/rules` |
| GitHub | read-only `github` tool over the `gh` CLI |
| Ponytail | `/ponytail off|lite|full|ultra`, prompt discipline, skills |
| Skills | all 19 bundled skill packs registered (15 ported from Ceulen) |
| Evolve | `/evo` session postmortem → session ledger → Munin; `npm run evo` digests finished sessions for the daily `evo-daily` cron; `/evo-cycle` scans every session, rebuilds the report and spawns a worker on the model chosen in `/ceulen-config → Model → Evo` to fix, test, store Munin memory and notify; `evo_notice` shows a 💾 Self-improvement block; `/evo-status` groups proposals by destination; `/evo-probe` runs a proposal against recorded fixtures in base/candidate worktrees and writes a contrast record; `/evo-apply` refuses an unprobed proposal; `evo_pass` runs the improvement pass; see `docs/evo.md` |
| Cron | `cron` tool, `/cron`, persisted jobs fired into the live session |
| Classifier | `classify` typed decisions, bash audit, `/classifier` (audit + enforce) |
| Repair | `apply_patch`, `read_slice` |
| Themes | 104 Ceulen Pi themes converted to DSH runtime themes (`ceulen-<name>`) |
| Providers | `/router-status`, `/router-model`, `/zai`, `/provider-compat` with ready `llm-pi-ai` recipes; the DeepSeek recipe pins the three tool-loop compat flags and `/ceulen doctor` names a missing one |
| Web | `web_extract`, `web_map`, `web_status`; native `web_search`/`web_fetch` remain. Fetch and capture refuse non-public targets: fetch resolves DNS and re-checks every redirect hop, captures refuse link-local/metadata literals while loopback and LAN dev servers stay auditable |
| A2A | `a2a_peers`, `a2a_list`, `a2a_call`, `a2a_status` (outbound JSON-RPC) |
| UX | `/ux off|lite|strict`, `ux_audit` (static gates + 6-viewport runtime + two screenshots on image routes + motion checks and load frames) |
| Usage | `/usage` subscription windows and credits (OpenCode Go, Z.AI, Command Code, Codex, router) plus DSH token-meter totals |
| Steering | model-family prompt hints and `/steering` |
| Structural search | `ast_grep`, `ast_edit` when the `sg` binary is installed |
| Semantic find | `jfind`: behavior query -> lexical prior -> the agent model judges filenames, sketches, and passages |
| RTK | `rtk` tool and `/rtk`: rewrite one supported command, then run it with bash (explicit two-step) |
| NotebookLM | `notebooklm` CLI bridge when the `notebooklm` (notebooklm-py) binary is installed: one argument-vector tool with destructive / `--yes` / browser-login gates, redacted error text, and capped output |
| Codemode | `codemode` tool over the DSH PTC runtime: one JavaScript program calls every visible tool, only its result reaches the model; on by default in `/ceulen-config` → Tools |
| Browser capture | `web_screenshot`, `web_pdf`, `web_interact` via local headless Chrome/CDP |
| Tool budget | `/ceulen tools` (count, KB, top 5 by bytes, per-module split); `tools.cold` holds rarely used tools out of the prompt and `ceulen_tools` searches them by regex and dispatches by name (`/cold-tools`) |
| Serena | `/serena` status and the exact native `dsh-mcp-client` row (no bundled Python worker) |
| Context | `/context` dashboard: a Claude Code-style colored cell grid (⛁/⛶/⛝) beside the per-category token legend (system prompt / tools / messages / free / autocompact buffer), from `tokenMeter` + session projections; `scripts/tui-context-patch.mjs` redirects the TUI's built-in `/context` dump to it and preserves only SGR colors from the ANSI dashboard |
| Plan mode | the plan submitted through `exit_plan_mode` persists to `.dsh/plans/<timestamp>-<slug>.md` (same-title refinement overwrites); `/plan-approve [current\|new\|stay]` asks ceulen's three options — implement in this session · clear context and implement in a new session · continue planning. Per-phase routes: `plan.model` answers while plan mode is active, `plan.implement` once a plan was submitted, configured in `/ceulen-config → Tasks → Plan mode` (a `/model` switch during a phase wins). `scripts/tui-plan-patch.mjs` makes bare `/plan` toggle and puts the plan-mode name in the footer |
| Native DSH | todo, subagent/fork/workflow, attachments, permission/sandbox, shell jobs, grep/glob, notifications |

Not ported (documented gaps): Pi composer shapes, Pi entry renderers, inbound A2A server/mDNS, Gemini research / image generation / ChatGPT-web chat, usage subscription windows, per-role subagent sandbox/tool enforcement and timeouts, worktree sandbox. DSH also reserves the bare `/config` local command for its own “configuration source” output, so a plugin cannot replace it; the full-screen panel is `/ceulen-config` (and `/ceulen config`) in the TUI, and the `/config` registration covers compositions that do not ship that local command.

## Configuration

Settings live at `$DSH_HOME/ceulen/settings.json` (mode `0600`):

```json
{
  "schemaVersion": 1,
  "disabled": [],
  "upstream": { "enabled": true, "intervalHours": 24 },
  "advisor": { "provider": "zai", "model": "glm-5.3", "reasoningEffort": "max", "fallbacks": [], "watch": false, "minToolCalls": 1 },
  "classifier": { "provider": null, "model": null, "audit": true, "enforce": false, "fallbacks": [] },
  "tools": { "cold": ["a2a_call", "a2a_list", "a2a_peers", "a2a_status", "jfind", "munin_delete", "munin_share", "evo_pass", "web_interact", "web_map", "web_pdf", "web_screenshot"] },
  "munin": { "project": "", "baseUrl": "", "allowProjectConfig": false, "brief": { "enabled": false, "maxChars": 600, "recencyDays": 30 } },
  "agentmem": { "project": "", "baseUrl": "", "brief": { "enabled": false, "maxChars": 600, "recencyDays": 30 } },
  "cron": { "enabled": true, "tickMs": 30000 },
  "rules": { "projectFile": ".dsh/RULES.md", "userFile": "RULES.md", "maxBytes": 20000, "guards": "audit" },
  "ponytail": { "level": "full" },
  "ux": { "mode": "off" },
  "usage": { "enabled": true, "showStatus": true, "intervalMinutes": 5, "providers": [] },
  "codemode": { "enabled": true },
  "rtk": { "enabled": true },
  "evo": { "provider": null, "model": null, "reasoningEffort": null, "fallbacks": [], "probeBudget": { "maxRunsPerDay": 8 } },
  "subagent": { "roles": { "fast": ["*"], "coder": ["*"], "smart": ["zai/glm-5.3:max"] }, "models": {}, "thinking": {} },
  "a2a": { "peers": [] }
}
```

`subagent.roles` maps the `fast`/`coder`/`smart` aliases to ordered
`provider/model[:effort]` chains; `*` inherits the parent route.
`subagent.models` overrides one role (`"reviewer": "@smart:high"`) and
`subagent.thinking` overrides its effort. `/subagent` prints the effective
route for every role. A role's effort is applied when it resolves to an
explicit route; an inherited `*` route keeps the session's own effort.

Secrets belong in the environment or the DSH credential store, never in this file:

```sh
export MUNIN_API_KEY=... MUNIN_PROJECT=...
export ROUTER_BASE_URL=... ROUTER_API_KEY=...
export ZAI_ANTHROPIC_API_KEY=...
export GITHUB_TOKEN=...          # optional, for upstream release notes
```

### Config panel

`/ceulen-config` opens the full-screen settings panel for the whole bundle:
Appearance · Model · Memory · Context · Shell · Tasks · Providers · Tools ·
Plugins. It edits the file above directly — `↑/↓` moves, `←/→` or `Tab`
switches tabs, `Enter` edits a value, and `Esc` saves and closes. Text and
number rows edit inline; enums cycle; toggles flip. `/ceulen config` opens the
same panel, `/ceulen config <tab>` prints one tab, and `/ceulen config --raw`
prints the redacted JSON file.

Route rows (Advisor → Primary model, Classifier → Decision model, Subagents →
`<role>` model) open a filterable list of every model the registered providers
advertise: type to narrow, `↑/↓` to move, `Enter` to select. A typed
`provider/model[:effort]` is accepted when the catalog has no match, and
picking a model keeps the row's existing reasoning suffix. `-` clears the row:
the advisor and classifier fall back to the agent route, a subagent role falls
back to its default selector.

Subagents → `<role>` model and `<role>` reasoning (planner, reviewer, scout,
tester, worker) write `subagent.models.<role>` and `subagent.thinking.<role>`.
A role model accepts a `provider/model[:effort]` route, an `@fast`/`@coder`/
`@smart` alias, or `*` for the parent route; the placeholder shows the alias
the role ships with. `/subagent` prints the resulting route for every role.

Bare `/config` is a DSH local command (“show the dsh-tui configuration source”)
and local commands win name collisions, so the plugin spelling in the TUI is
`/ceulen-config`. The `/config` registry command still works where the harness
does not own that name (headless, web).

API-key rows (Munin, Brave, Z.AI) are editable here: the panel masks input and writes
through the DSH credential store (`$DSH_HOME/.credentials.yaml`, mode `0600`),
so no key ever lands in `settings.json` or the transcript. An environment
variable with the same name still wins; entering `-` clears the stored key.

### Codemode

The `codemode` tool lets the model write one JavaScript program instead of a
sequence of tool calls. The program runs on DSH's PTC runtime (the same
`ctx.ptcRuntime` that backs `run_code`) and every tool the calling agent can see
is bound as `tools.<name>(args)`. Only the program's return value and
`console.log` output reach the model, so fan-out and filtering stay out of the
transcript.

It is on by default. Turn it off in `/ceulen-config` → Tools → Codemode, then
restart DSH (`/reload` does not reload plugin code). The panel also reports
whether the `ptcRuntime` service is mounted.

```js
const results = await Promise.allSettled([
  tools.bash({ command: 'git status --short', description: 'Show status' }),
  tools.bash({ command: 'git diff --stat', description: 'Show diff stat' }),
]);
return results.map(result => result.status === 'fulfilled' ? result.value : String(result.reason));
```

The contract: `code` is the body of an async function (top-level `await` and
`return` work), tool names are exact (`tools['mcp__server__tool']` for names
that are not identifiers), and a failed/blocked/denied call rejects. Nested
calls run through the full tool pipeline, so approvals, guards and sandbox
policy still apply. `bash` keeps its DSH arguments and requires `description`
plus `command`.

Distilled by design: calls resolve to their structured value (for example
`bash` → an object whose `stdout` holds the output text), and a return plus
console block past ~6k characters is middle-truncated with the full text
spilled to a file path named in the result — an unfiltered dump can never blow
up the context. A first line `// @options: {"timeout_ms": 60000,
"max_output_chars": 4000}` overrides the per-call deadline (default 120s, max
600s) and the budget (200–50 000 chars). `state.store({ key, value })` /
`state.load({ key })` keep small JSON values across calls (~256k per value,
~1M total) as `codemode-store` session events — writes commit only when the
script succeeds, and a typo like `tools.Bash` gets a "did you mean
'tools.bash'?" hint in the error.

While it runs, the card shows the script under a `Codemode` header (the body
folds past three lines; click or `Ctrl+O` expands). Once it settles, the header
becomes `Codemode (<description>)` and the body lists each nested call
(`▸ bash · git status --short · 0.1s`) above the script output; a failed script
adds ` · failed` and a red `exit code 1` line. The call list is persisted with
the result, so a resumed transcript renders the same block.

Not ported: the `models` namespace (scripts can call the `classify` tool
instead), `text()`/`image()` (redundant with `return` here), and
`searchTools`/`ALL_TOOLS` (every visible tool is bound by exact name). The
runtime is a Node subprocess, not QuickJS: treat scripts as bash-level trust,
not a security sandbox. See `docs/codemode-plan.md` for
the research and the parity matrix.

### Advisor

The reviewer is off by default to avoid surprise model calls. Enable it with a chain:

```text
/advisor model zai/glm-5.3:high, opencode-go/deepseek-v4-pro
/advisor on
/advisor status
```

The `:high` suffix persists as the advisor's reasoning effort; the Model tab in
`/ceulen-config` exposes the same route and a Reasoning row. The shipped default
is `zai/glm-5.3:max` (Z.AI GLM-5.3 at max thinking); clear the route row to fall
back to the parent agent's route. Notes are delivered as logged user context; `blocker`/`concern` notes wake a follow-up turn, `nit` notes are deferred.

### Usage

`/usage` shows the active provider's 5-hour, weekly, and monthly windows plus
monthly credits. The compact segment (`Go · 5h 86% · W 88% · M 94%`) is
model-gated: it appears only while the session runs on a subscription route,
clears the moment `/model` switches to another provider, and repaints when the
route comes back. `/usage --all` checks every configured provider; `/usage
refresh` forces a fetch. Supported: OpenCode Go, Z.AI (international and CN),
Command Code, Codex (OAuth access token), and a generic router `/usage` JSON
endpoint.

Credentials resolve from the environment first, then the DSH credential store
`$DSH_HOME/.credentials.yaml` under `refs:`:

```text
OPENCODE_GO_API_KEY   ZAI_ANTHROPIC_API_KEY / ZAI_API_KEY
COMMAND_CODE_API_KEY  OPENAI_CODEX_ACCESS_TOKEN + OPENAI_CODEX_ACCOUNT_ID
ROUTER_BASE_URL + ROUTER_API_KEY
```

Refresh defaults to every 5 minutes; `usage.intervalMinutes` and
`usage.showStatus` are in the settings file. Failures stay quiet (the segment
clears or shows `unavailable`) and never block a turn.

dsh-tui 0.17.0+ has a native footer slot (`ctx.tuiStatus.setField`, shipped in
the installed 0.18.0), so the `ceulen:usage` segment joins the head of the
footer's right group beside the model/effort/mode/cwd fields
(`Go · 5h 86% · W 88% · M 94%`) with no patch. The 0.16.1 footer patch was
deleted for this reason (plan 5.5); `/ceulen doctor` still prints
`tui footer: tui:<version> footer-native|stock · advisor-block applied|stock …`
and names the script to run for every patch that is missing, so a dsh-tui
upgrade's silent revert is visible instead of silent.

Advisor notes have the same gap: dsh-tui drops every user message whose
`source.kind` is not `user`, so a `ceulen-advisor` note reached no transcript
and only the 15 s status line showed it. `node scripts/tui-advisor-patch.mjs`
keeps the note's own source and renders it as a rounded block row
(`check` and `revert` included, same version guard).

Tool cards name an unmapped tool id by upper-casing its first letter, which
turns the acronym `fff_grep` into `Fff_grep`.
`node scripts/tui-toolname-patch.mjs` (`apply`/`check`/`revert`) adds the
alias table that renders it as the short id (`fff`) — add a row per acronym family,
not per tool.

Plan mode has three TUI gaps the harness cannot reach.
`node scripts/tui-plan-patch.mjs` (`apply`/`check`/`revert`) makes bare
`/plan` toggle instead of opening the on/off picker that confirmed the state
already set, lets the "clear context and implement in new session" answer open
a real fresh session seeded with the plan handoff, and names `plan mode` in
the footer while it is active — a bare `/plan` writes no sandbox/approval
atoms, so the stock indicator fell back to the base mode (or kept the
permission preset's "Full access" label). `/ceulen doctor` reports
`plan-mode applied|stock`.

### Memory: Munin cloud first, opimem bridge as failover

Munin (the cloud endpoint below) is the primary store. The opimem bridge on the
Pi is the failover endpoint: `munin.fallback.baseUrl` is tried when the cloud is
unreachable, with its own key from `MUNIN_FALLBACK_API_KEY` (a token is scoped to
one server, so it never inherits the primary's). The same Pi server is reachable
directly as `agentmem_*`; it is a pull of the cloud corpus, so it can lag by up
to an hour and is not a write target.

```sh
export MUNIN_API_KEY=... MUNIN_PROJECT=my-project
export MUNIN_BASE_URL=https://munin.kalera.ai   # optional
```

The API key also resolves from the DSH credential store, and
`/ceulen-config` → Memory → Munin → API key writes it there. `MUNIN_API_KEY`
in the environment wins over the stored value. Project and base URL live in
the Settings section as usual.

Munin registers **no prompt section** of its own: the Memory Protocol lives in
`ceulen-agentmem` and says to mirror each stored memory with `munin_store` at
session end. `munin_search`/`munin_get` are cold tools (`tools.cold`) used only
when the local store is down; `munin_store` stays warm for the one mirror call.
`munin.brief` still exists but is off by default — the AgentMem brief already
falls back to it.

Project-level `.dsh/ceulen.json` is only read when `munin.allowProjectConfig` is `true`; a checkout must not be able to redirect the API key.

### AgentMem

The failover endpoint for the same wire protocol: one local
[opimem](https://github.com/kalera/opimem) server, in the default setup the Pi
bridge that `munin.fallback.baseUrl` points at:

```sh
export AGENTMEM_BASE_URL=http://<pi-host>:8900
export AGENTMEM_PROJECT=proj_pi-agents
export AGENTMEM_API_KEY=...
```

`/ceulen-config` → Memory → **AgentMem** writes the project and base URL to
the settings section and the key to the DSH credential store. Resolution per
field is tool param > `AGENTMEM_*` env > credential store (key) > the
`agentmem` settings section. There is deliberately **no default endpoint**, no
project-level config file and **no write failover**: an unconfigured AgentMem
refuses to run rather than guess a server, and a write never lands in the
backup store by accident. Reads are the exception — `search`, `get`, `list`
and `recent` fail over to the configured Munin cloud after one bounded attempt,
and the result says it came from the backup (with the cloud as primary, that
path only matters on the day the Pi is the one that is down). The first-turn
brief takes the same path. `agentmem_share`
copies memories into other projects on the same opimem server (opimem
identifies a memory by its key, so `memory_ids` are keys); it is
capability-gated, so an older server without `share` answers with a clean
`FEATURE_DISABLED` instead of a fake success.

### Web search (Brave) and fetch fallback

The `ceulen-web` module registers `brave` as a native `ctx.web` search
provider, so `web_search` can run on the Brave Search API. The key resolves
from `BRAVE_API_KEY` or the DSH credential store (also editable in
`/ceulen-config` → Tools → Web). Restart DSH after installing this build so
the module registers the providers.

It also registers `deepseek-fetch-fallback`: `ctx.web.fetch` first asks the
DeepSeek Fetch API for page Markdown and, on any failure (401/429, timeout, a
page its extractor cannot read), re-fetches over plain HTTP with the public-URL
guard. Without `DEEPSEEK_API_KEY` it uses the local leg only.

The providers activate when the profile pins them:

```yaml
- id: web
  config:
    searchProvider: brave
    fetchProvider: deepseek-fetch-fallback
```

Without a pin, the web service uses the single usable provider and reports
`WEB_PROVIDER_AMBIGUOUS` if more than one is available. With no key set,
search falls back to the configured pin's error rather than silently using a
different backend.

### Rules

Create `.dsh/RULES.md` in the project and/or `$DSH_HOME/ceulen/RULES.md`:

```md
## never-push
Never push unless the user explicitly asks.

## api-style
description: How to write HTTP handlers.
Use the shared json() helper.
```

`## name` sections without a `description:` line are sticky; sections with one are rulebook entries served by `rule_get`.

Add a `when-*` directive trio to a section and it becomes a behaviour guard
instead of prompt text — checked before every tool call, so it costs no prompt
bytes:

```md
## Guard: no force push
description: Force-pushing rewrites shared history.
when-tool: bash
when-match: git\s+push\b.*--force
when-action: deny
Never force-push a shared branch.
```

`when-tool` is a tool name or `*`; `when-match` is a JS regex (no flags) tested
against the command for `bash`, the path for `edit`/`write`/`apply_patch`, and
the JSON arguments otherwise; `when-action` is `audit` (default) or `deny`.
`rules.guards` picks the mode: `audit` logs matches, `enforce` denies the rules
that opted into `deny` (the refusal names the rule, the matched text, the body
and the settings key), `off` disables the hook. `/rules status` lists every
guard and the mode.

Existing repo conventions are read too, in this precedence order: nearest
`.dsh/RULES.md`, then `AGENTS.md` (one sticky rule, capped at 4 KB), then
`.cursor/rules/*.mdc` (one rulebook entry per file, named after the file), then
`.clinerules` (one rulebook entry), then `$DSH_HOME/ceulen/RULES.md`. The
foreign sources are read-only and only at the workspace root — never above it,
never written to.

## Upstream releases

`/ceulen update` checks npm and the GitHub release notes. When Ceulen publishes a new version:

```sh
node scripts/ceulen-sync.mjs report --version <new>
node scripts/ceulen-sync.mjs apply-vendor
node scripts/ceulen-sync.mjs parity
npm run check
node scripts/ceulen-sync.mjs bump --version <new>
```

`apply-vendor` only upgrades files whose local hash still matches the lock. Files marked `patched` (DSH path/import changes) are never overwritten; they become a manual-merge report. Nothing from upstream is executed. Full runbook: `docs/upstream-sync.md`.

## Development

```sh
npm ci --include=dev
npm run build
npm test
node scripts/check-bundle.mjs
node scripts/ceulen-sync.mjs parity --check
```

The dev profile helper creates a workspace-local `DSH_HOME` and dumps the composed profile without touching `~/.dsh`:

```sh
./scripts/dev-profile.sh
```

### Search benchmark

Compare Brave against DeepSeek's official search (the backend `dsh web` ships
with) on the same queries:

```sh
npm run bench:search -- --max 8
npm run bench:search -- --queries "rust async runtime;postgres WAL" --brave-only
```

Brave needs `BRAVE_API_KEY`; the DeepSeek side needs `DEEPSEEK_API_KEY` or a
signed-in DeepSeek account, otherwise the row prints `unavailable` and the
rest of the matrix still runs.

## License

MIT. Ported Ceulen files retain their MIT headers; see [NOTICE](NOTICE).
