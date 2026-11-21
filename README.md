# ceulen-dsh

Ceulen's toolkit for **DeepSeek Harness** (DSH): reviewer, memory, rules with behaviour guards, cron, GitHub, web extraction, A2A, UX audit, themes, structural search, an evidence-gated self-evolution loop, and a built-in upstream release watcher — installed as one DSH bundle.

Ceulen itself is a Pi extension bundle. DSH has a different plugin API, so this project is an independent port: UI-independent logic is vendored from Ceulen (MIT), and each feature gets a thin DSH adapter. The module-by-module status lives in `docs/parity.md` (kept with the source checkout, not published).

## Native agent dashboard

`/dashboard` opens a read-only scene in the current TUI session; `Esc` returns
to chat. `Tab`/`Shift+Tab` selects tasks, agents or activity; arrows and page keys
navigate, `Enter` opens detail, and `Esc` returns to overview first.
`/dashboard status` prints a native projection summary without a scene host
(child run metrics require the live TUI channel). See [dashboard integration](docs/dashboard.md).
Opening the view never starts work, changes model, or changes approval policy.
Disable with `/plugin disable ceulen-dashboard` if needed. Herdr is optional.

## Orchestrator mode

`/orchestrator <task>` enables coordination for the current live lead session
and submits the task. The lead delegates execution through existing Ceulen
role/model routes, receives native child feedback, verifies it, and summarizes
the result. `/orchestrator` or `/orchestrator on` enables the mode for subsequent
chat messages; `/orchestrator status` checks it; `/orchestrator off` exits without
cancelling existing children. Restarting the session resets the mode. While the
mode is active, the native TUI footer shows `Orchestrator`; `off`, plugin reload
or session disposal clears it.

Use `/dashboard` to watch delegated work under **Agents** and **Activity**;
press `Esc` to return to chat and send another instruction. The **Tasks** panel
is the native Team board, not the lead's `todo_write` checklist; ordinary
delegation does not create Team tasks. `/subagent` shows the configured worker
routes. Orchestrator mode requires the subagent module/runtime, does not open a
second chat, and does not change the lead model, permissions, or approvals.

## Subagent progress

While children run, the `agentbar` module opens a **Subagents** side panel
beside the chat (about a third of the width, the dsh-tui `sidePanel.ratio`
default of 0.68), so you never scroll back to the delegate card:

```
 chat …                                        │ ◆ Subagents        2 running · 1 done
                                               │
                                               │ ⠼ scout · Survey auth code       41s
                                               │   muse-spark-1.3-contributor · xhigh
                                               │   Working…
                                               │   todo ━━━━━━━━──────────── 2/5
                                               │    ✓ Find the emitter
                                               │    ▸ Capture exact lines
                                               │    ○ Report back
                                               │   ctx 26k/1M · 3% · cache 47%
                                               │
                                               │ ✓ worker · Add login form      1m12s
                                               │ Ctrl+A dashboard
```

Each running child is a card: role and label, model and effort, a moving
`Working…`, its `todo_write` list, its context against the model window, and
the share of prompt tokens served from cache. Tool names are left out (under
the `ptc` preset every call is `run_code`). Finished children shrink to one
line. When the panel is short, cards shrink (only the active todo, then no
model line) so every running child stays in view; the rest scroll with the
wheel, or ↑/↓ once the panel has focus (`Ctrl+B`; `Esc` returns to the chat).
The panel opens when a batch starts and closes 60 s after the last child
ends, unless you focused it or opened it yourself. Typing is never
interrupted: auto-open needs `node scripts/tui-panel-patch.mjs apply`, which
adds an open that leaves focus in the prompt. Without that patch the panel
stays on `Ctrl+B`. `/ceulen doctor` shows `panel-reveal applied|stock`, and
`/dsh-update` re-applies the patch after a dsh-tui update.
`/agentbar auto off` keeps it manual (saved as `agentbar.autoOpen`, applied
from the next batch); `/agentbar auto on` turns it back on.

The split needs fullscreen mode and at least 93 columns. Elsewhere (inline
mode, a narrow terminal, a closed panel) the same data shows as up to three
rows above the prompt:

```
◆ Subagents  2 running · 1 done                         Ctrl+B panel · /agentbar
  ⠹ scout · Survey auth code   ⏵ Narrowing the search…   todo 2/5 · 7 steps · ctx 22k · 1m12s
  ⠼ worker · Add login form    Writing the form component…   4 steps · ctx 31k · 48s
```

After the batch, one summary row stays for 60 s. `/agentbar` prints every
child of the session; the native dashboard (`Ctrl+A`) remains the detail view.
Both views cover every in-process child session (`delegate` and the native
subagent tools). Herdr-runner children already have their own pane, so they are
left out. `/ceulen module off agentbar` removes the panel and the band.

## Requirements

- DSH `0.2.2-rc.1` (the `dsh` CLI and `dsh-tui` 0.20.2 profile)
- Node.js `>=24.9.0` for a fresh installation (required by the pinned DSH CLI; the bundle itself supports `>=22.19`)
- Optional backends: `gh`, `sg`/`ast-grep`, `rtk`, Serena, Chrome/Chromium, a Munin server, a Brave Search key, an OpenAI-compatible router, A2A peers

## Install

### Fresh DeepSeek Harness installation

Use Node.js **24.9 or newer** (Node 24 LTS recommended), npm, and Git.
On Windows, run these Bash commands in WSL. No existing DSH profile is needed.

`ceulen-dsh` is **not published to npm yet**: `dsh plugin add ceulen-dsh`
currently returns 404. Build a tarball from this repository instead:

```sh
node --version
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
dsh --version

git clone https://github.com/VietDo1804/Ceulen-DSH.git
cd Ceulen-DSH
npm ci --include=dev
./release/build.sh

# Install BOTH the TUI app and this bundle into a new profile.
./release/install.sh --profile tui --with-tui --tarball "$PWD/release/ceulen-dsh-0.2.7.tgz"
dsh --profile tui
```

DSH does not ship a `tui` template: installing only Ceulen-DSH does **not**
install the TUI app. `--with-tui` adds the pinned TUI as well. The installer
creates the profile under `${DSH_HOME:-$HOME/.dsh}/profiles/tui`; it does not
replace an existing profile's settings. Restart an already-running session
after installation.

Follow the TUI's first-run setup, or run `/setup` again. Use `/provider` to add
your model provider/API key and `/model` to select a model before sending
prompts. Ceulen-DSH does not include an API key or subscription. Optional
backends below are needed only for their respective features, not to install
the bundle.

### Install on a friend's machine without building

Send `release/ceulen-dsh-0.2.7.tgz` to your friend after building it. With Node
24.9+ and the pinned DSH CLI installed, they can run (replace the tarball path):

```sh
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.20.2 file:/absolute/path/to/ceulen-dsh-0.2.7.tgz
dsh --profile tui
```

The tarball includes compiled code; no clone or build is needed on their
machine. An HTTPS tarball URL works in place of `file:...`. Do not install
directly from a Git URL: compiled `lib/` is not committed. See
[release/README.md](release/README.md) for checksums and installer options.

### Develop from a checkout

After `npm ci --include=dev` and `npm run build`, link this checkout instead:

```sh
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.20.2 link:"$PWD"
dsh --profile tui
```

`link:` keeps this checkout as the source of truth; rebuild with `npm run build`
after changes and restart DSH. To upgrade a tarball installation, install a
newly built tarball into the same profile and restart. npm-based update notices
and `/ceulen upgrade` cannot supply a release until the package is published.

After restart:

```text
/ceulen
/ceulen-config   # full-screen settings panel
/ceulen doctor  # compatibility and optional-backend diagnostics
```

You should see the release line (`ceulen-dsh 0.2.7 (stable)`), the pinned
Ceulen version, and the mounted/native/planned modules.

Installation is per machine and profile, not inherited from this checkout. The bundle composes
35 rows. See `docs/live-verification.md` and `docs/dashboard.md` for the evidence.

### Release line

`package.json` carries this bundle's own version (`0.2.7`) plus
`release: { line: "stable", distTag: "stable" }`; the upstream Ceulen version it
tracks lives in `upstream.lock.json` (`0.23.0`). The bundle update check follows
the `stable` npm dist-tag, so `latest` staying on the old `0.23.0-dsh.x` line
never reads as an upgrade — and a missing tag reports `unknown` instead of
inventing one. `/ceulen doctor` prints the line and dist-tag it follows.

## Credential safety

Keep API keys and login state in your own DSH credential store, never in this
repository or a shared tarball. `.gitignore` excludes local `.env` files,
credential files, and Codex/Claude login directories. Example environment files
may be committed, but must contain placeholders only. Ignoring a file does not
remove it from Git if it was already tracked.

The `secrets` GitHub Actions workflow scans Git history with Gitleaks on pushes
and pull requests, redacts findings, and fails if a secret is detected. It needs
no API key. GitHub's billing lock must be resolved before this workflow can run.
Keep GitHub's native secret scanning and push protection enabled in repository
security settings too: push protection can reject supported secret types before
GitHub accepts the push, independently of Actions.
With Gitleaks 8.30.1 installed, run the same check locally before pushing:

```sh
gitleaks git . --redact --log-opts="--all"
```

History scanning does not cover uncommitted or ignored files. Share only the
built tarball, not your workspace, `~/.dsh`, or `~/.codex`. If a real secret was
committed, revoke/rotate it immediately; adding it to `.gitignore` is not enough.

## What works today

| Area | DSH surface |
|---|---|
| Status/config | `/ceulen`, `/ceulen modules`, `/ceulen tools` (schema budget), `/ceulen-config` (full-screen panel), `/ceulen config`, `/ceulen doctor` (services, compat flags, release line) |
| Upstream | `/ceulen update`, status line, `ceulen-sync` CLI, weekly CI check |
| Advisor | second-model review after settled work, one severity note, `/advisor`, `advisor` tool |
| Subagent roles | `delegate` starts a fresh-context child with a Ceulen role preset (planner, reviewer, scout, tester, worker); the role persona and provider/model route come from `subagent.roles`, `subagent.models`, and `subagent.thinking`; `/subagent` shows the routes. Native `subagent`, `subagent_fork`, and `workflow` remain; inside a Herdr pane `delegate` also takes `runner: "herdr"` (see Herdr below). Delegation nudges: on a lead whose route matches `subagent.nudge.models` (default `deepseek-v4.1-flash`, `deepseek-flash`), at most one notice per turn of each kind. Recon: after `discoveryAfter` (10) local reads/searches with no delegation once the lead context reaches `reconMinContext` (60k tokens), it asks whether a `scout` would pay. Review: once the turn has edited `reviewAfterFiles` (3) files, it asks for a `reviewer` only for new logic, behaviour/API changes or risky areas, and says mechanical edits may skip it. The thresholds were set by replaying past flash sessions against gpt-6.1-sol's rates. `[]` or 0 turns them off |
| Memory | Munin is the primary store: `munin_search/get/store/...`, `/munin-status`, the Memory Protocol, and the first-turn brief (`munin.brief`, resolved in the background so it lands from the first re-composed prompt — usually turn 2). `munin.fallback.baseUrl` + `MUNIN_FALLBACK_API_KEY` make a dead cloud answer from the opimem bridge instead of erroring (transport failures only — a 401 still surfaces) |
| AgentMem | the same eleven tools under `agentmem_*` plus `/agentmem-status`: one opimem server on the LAN, by default the Pi replica that `munin.fallback` fails over to. Reads are ~50x faster than the cloud but can lag it by up to a week (the pull window is weekly; the UI's "Sync now" refreshes on demand), so its brief is off and the protocol says not to double-write through it |
| Rules | sticky `.dsh/RULES.md` + rulebook, `when-*` behaviour guards (`rules.guards`), read-only `AGENTS.md` / `.cursor/rules/*.mdc` / `.clinerules` sources, `rule_get`, `/rules` |
| GitHub | read-only `github` tool over the `gh` CLI |
| Ponytail | `/ponytail off|lite|full|ultra`, prompt discipline, skills |
| Agent Mode | `/agent-mode` loads `~/vietdo_workspace/DHS/agent_mode/AGENTS.md`; run again to reload edits, `off` to remove the role, `status` to inspect it. Starts off after restart; permissions and Plan Mode are unchanged. Routes listed under `/ceulen-config` → Model → Agent Mode (empty by default) load the role automatically; an explicit on/off outranks the route default. Override the file with the plugin's `path` config. |
| Skills | all 20 bundled skill packs registered (15 ported from Ceulen) |
| Evolve | Weekly audit with no model: `scripts/evo-weekly.mjs` (systemd timer) scans every session, gathers recurring tool errors into fix groups and writes an HTML report plus `report-<date>.md`; the review is a session the user starts on a strong model (skill `evo`, "evo weekly review"): diagnose, fix in a worktree with a test, then `evo-report.mjs --fixed` so later reports compare before and after; `/evo-status` names the newest report; `evo_notice` shows a 💾 Self-improvement block; `/evo` session postmortem → ledger → Munin; see `docs/evo.md` |
| Cron | `cron` tool, `/cron`, persisted jobs fired into the live session |
| Classifier | `classify` typed decisions, bash audit, `/classifier` (audit + enforce). A `typesafe/jev-*` route (e.g. `/classifier model router/typesafe/jev-1.14,deepseek/deepseek-flash`) calls OpenRouter's System One endpoint with `OPENROUTER_API_KEY`; other routes use chat |
| Repair | `apply_patch`, `read_slice` |
| Themes | 104 Ceulen Pi themes converted to DSH runtime themes (`ceulen-<name>`) |
| Providers | `/router-status`, `/router-model`, `/zai`, `/provider-compat` with ready `llm-pi-ai` recipes; the DeepSeek recipe pins the three tool-loop compat flags and `/ceulen doctor` names a missing one |
| Web | `web_extract`, `web_map`, `web_status`; native `web_search`/`web_fetch` remain. Fetch and capture refuse non-public targets: fetch resolves DNS and re-checks every redirect hop, captures refuse link-local/metadata literals while loopback and LAN dev servers stay auditable |
| A2A | `a2a_peers`, `a2a_list`, `a2a_call`, `a2a_status` (outbound JSON-RPC) |
| UX | `/ux off|lite|strict|auto` (auto classifies each user request as off, keep, lite or strict and sends the level as runtime context), `ux_audit` (static gates + 6-viewport runtime + two screenshots on image routes + motion checks and load frames) |
| Usage | `/usage` subscription windows and credits (OpenCode Go, Z.AI, Command Code, Codex, router) plus DSH token-meter totals |
| Steering | model-family prompt hints and `/steering`. For routes in `steering.models` (default `deepseek-v4.1-flash`, `deepseek-flash`): the `ceulen:playbook` prompt section (leads only) shows how gpt-6.1-sol works here: one opening codemode batch of grep/glob/read, a need → tool map, and delegating only when it pays. A bash call that only greps/cats/`sed -n`/heads/finds files is not run; the reply names the exact `grep`/`read`/`glob` call (several lookups become one codemode batch, GNU grep BRE patterns are converted to ripgrep syntax), and sending the same command again unchanged runs it. This covers codemode's nested calls and children; a bash call that only takes headless-Chrome screenshots is redirected to `web_screenshot` the same way. `steering.bashLookups: "off"` disables the redirect. The same routes get tuned `codemode` and `web_interact` definitions (named browser sessions, hover, `text=` selectors, `screenshot:false`), registered in the agent's own scope so every other route keeps the untuned ones, and `steering.cold` holds tools out of their prompt only; a `/model` switch swaps both before the next step |
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

### Herdr (optional)

[Herdr](https://herdr.dev) is a terminal multiplexer for coding agents. Nothing here needs it; outside a Herdr pane (ACP/hermes delegation, the web profile, a plain terminal) every Herdr feature stays off.

- **Skill** `herdr`: `herdr --skill` verbatim plus a ceulen note and a DSH addendum (no `dsh` agent kind; drive a DSH TUI pane with `pane send-text` + `send-keys enter` and a settled `agent wait`; `/exit` quits; alternate-screen reads). Refresh after a Herdr update with `node scripts/herdr-skill-sync.mjs` (`--check` reports drift); `/ceulen doctor` shows client/server versions, the pane, and drift.
- **`delegate` runner `herdr`**: offered only when DSH runs in a Herdr pane. The child runs as `dsh --profile headless --json` in a pane split beside the caller (right first, then stacked below), driven by `scripts/herdr-child.mjs`, which prints progress and writes `result.json` under `$DSH_HOME/ceulen/herdr-runs/<id>/`. The call blocks and returns the child's final text, exit code and tool count; the pane closes on success and stays open on failure. The run overlay re-enables the credential store, copies the parent profile's `llm-pi-ai` row, and pins the role route; planner/reviewer/scout run `read-only`, tester/worker `workspace-write`, and plan mode forces `read-only`. Children carry `CEULEN_HERDR=off`, which keeps them (and any process given it) from driving Herdr. Routes must use a provider declared in the profile's `llm-pi-ai` row.

Not ported (documented gaps): Pi composer shapes, Pi entry renderers, inbound A2A server/mDNS, Gemini research / image generation / ChatGPT-web chat, usage subscription windows, per-role subagent sandbox/tool enforcement and timeouts, worktree sandbox. DSH also reserves the bare `/config` local command for its own “configuration source” output, so a plugin cannot replace it; the full-screen panel is `/ceulen-config` (and `/ceulen config`) in the TUI, and the `/config` registration covers compositions that do not ship that local command.

## Configuration

Settings live at `$DSH_HOME/ceulen/settings.json` (mode `0600`):

```json
{
  "schemaVersion": 1,
  "disabled": [],
  "upstream": { "enabled": true, "intervalHours": 24 },
  "advisor": { "provider": "zai", "model": "glm-5.3", "reasoningEffort": "max", "fallbacks": [], "skipModels": ["gpt-6-astra"], "watch": false, "minToolCalls": 1 },
  "classifier": { "provider": null, "model": null, "audit": true, "enforce": false, "fallbacks": [] },
  "tools": { "cold": ["a2a_call", "a2a_list", "a2a_peers", "a2a_status", "jfind", "munin_delete", "munin_share", "web_interact", "web_map", "web_pdf", "web_screenshot"] },
  "munin": { "project": "", "baseUrl": "", "allowProjectConfig": false, "brief": { "enabled": false, "maxChars": 600, "recencyDays": 30 } },
  "agentmem": { "project": "", "baseUrl": "", "brief": { "enabled": false, "maxChars": 600, "recencyDays": 30 } },
  "cron": { "enabled": true, "tickMs": 30000 },
  "rules": { "guards": "audit" },
  "ponytail": { "level": "full" },
  "ux": { "mode": "off" },
  "usage": { "enabled": true, "showStatus": true, "intervalMinutes": 5, "providers": [] },
  "codemode": { "enabled": true },
  "rtk": { "enabled": true },
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
`subagent.presets` independently selects a DSH preset per role, for example
`{"scout": "ptc", "worker": "standard", "planner": "standard", "reviewer": "standard"}`.
Omitted roles inherit the parent's composition. Settings are re-read for each
`delegate` spawn; existing children and native `subagent`/`subagent_fork` are unchanged.
`/subagent <role>` shows the configured preset. Reviewers load `ponytail-review`
for diffs or `ponytail-audit` for explicitly requested repo-wide audits, while
retaining correctness/security checks and the structured reply contract.

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
whether the `ptcRuntime` service is mounted. The chain-hint experiment lives
there too: after `codemode.chainHintAfter` (default 2, `0` = off) consecutive
steps that each make one read-only call, the next step gets a one-line nudge to
batch the following reads into one script or one parallel tool batch; the
nudge names the steps it is about.

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

Distilled by design: calls resolve to their structured value (bash output is
`r.stdout.text`, `read` returns `{ lines: [{ number, text }] }`), and a return plus
console block past ~6k characters is middle-truncated with the full text
spilled to a file path named in the result — an unfiltered dump can never blow
up the context. A first line `// @options: {"timeout_ms": 60000,
"max_output_chars": 4000}` overrides the per-call deadline (default 120s, max
600s) and the budget (200–50 000 chars). `state.store({ key, value })` /
`state.load({ key })` keep small JSON values across calls of one live session
(~256k per value, ~1M total) in memory, never in the session log: an event type
the resume reader does not know makes that whole session refuse to open. Writes
commit only when the script succeeds, and a typo like `tools.Bash` gets a "did
you mean 'tools.bash'?" hint in the error.

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

When the main model is Astra (`gpt-6-astra`), both automatic reviews and the
on-demand `advisor` tool skip reviewer calls by default. Other main models keep
their normal advisor behavior. Configure **Model → Advisor → Skip main models**
in `/ceulen-config` (`advisor.skipModels` in settings): comma-separated model ids
or exact `provider/model` routes; clear it or enter `-` to allow every model.
The exclusion follows the current model after a model switch.

A review pins the latest real user request above the turn transcript (harness
notices like `time-context` are never mistaken for it) and appends the
working-tree diff of the files this turn touched as evidence, so the reviewer
judges the actual request and the actual edit. Pressing `Esc` cancels a running
review.

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
the installed 0.20.2), so the `ceulen:usage` segment joins the head of the
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

For the separate `dsh-fff` 0.1.0 plugin, run
`node scripts/fff-search-patch.mjs apply` (`check`/`revert` supported; use
`--fff <package-dir>` for another profile). It uses ripgrep for ignore-aware
filename indexing, accepts exact directory/file search scopes before fuzzy
resolution, and reports unresolved scopes without pretending a search ran.
Restart DSH after applying; reapply after reinstalling FFF. Without ripgrep,
filename indexing retains the original walker and its hardcoded exclusions.
Run its regression checks with `node --test scripts/fff-search-patch.test.mjs`.
For routine code search, use scoped `grep`/`glob` first, FFF for vague filenames,
and `jfind` when the behavior cannot be expressed as a literal search.

Tool cards name an unmapped tool id by upper-casing its first letter, which
turns the acronym `fff_grep` into `Fff_grep`.
`node scripts/tui-toolname-patch.mjs` (`apply`/`check`/`revert`) adds the
alias table that renders it as the short id (`fff`) — add a row per acronym family,
not per tool.

dsh-tui keeps one reasoning effort for every model: the `/settings` default
reasoning effort (or the last `/effort`) is re-applied on each `/model`
switch, so a `max` default puts every model on max.
`node scripts/tui-effort-patch.mjs` (`apply`/`check`/`revert`) makes it
per model, as in Pi: `/effort <level>` (or ←/→ in the `/model` picker, which
now previews the level a switch will apply) records the level for the current
model in `~/.dsh-tui/effort-by-model.json` (`{ "provider/model": "level" }`, also
fine to edit by hand), a switch applies that model's entry, and a model with no
entry uses the `/settings` default. A level the model does not offer still
steps down to the nearest lower one; a resumed session keeps the level it ran
on. `/effort` no longer moves the global default. `/ceulen doctor` reports
`effort-per-model applied|stock`.

`/ceulen-config → Tasks → Plan mode` exposes separate model, reasoning, and ordered fallback controls for planning and implementation. Reasoning stays in the existing `provider/model:effort` route strings; each fallback has its own reasoning. `plan.fallbacks` and `plan.implementFallbacks` default to empty. After native recovery is exhausted for a provider failure, Ceulen waits for the failed turn to settle, selects the next untried fallback, and continues in a new turn of the same session. The original failed attempt remains visible. Cancellation, context/offload errors, and manual model overrides do not trigger fallback. A phase change restores that phase's primary model.

Plan mode has three TUI gaps the harness cannot reach.
`node scripts/tui-plan-patch.mjs` (`apply`/`check`/`revert`) makes bare
`/plan` toggle instead of opening the on/off picker that confirmed the state
already set, lets the "clear context and implement in new session" answer open
a real fresh session seeded with the plan handoff, and names `plan mode` in
the footer while it is active — a bare `/plan` writes no sandbox/approval
atoms, so the stock indicator fell back to the base mode (or kept the
permission preset's "Full access" label). `/ceulen doctor` reports
`plan-mode applied|stock`.

### Goal mode: automatic recovery

DSH's goal driver stops for good when a turn dies outside the model's control:
it disarms the goal on `agent/error` and pauses a cancelled goal round (Esc)
once the agent goes idle. The `goal-retry` module adds the missing recovery
over the public services — the harness stays untouched:

- the same active goal is re-armed after 5/10/20/40/60 s, at most 5 times per
  consecutive failure streak, and `agent/error` + `turn/end` for one turn count
  as a single failure;
- re-arming is `goals.resume()`: the driver's own `goal/changed` listener starts
  the next round in the same session, so no prompt is injected and the round
  budget, revision fence and checkpoint keep working;
- a completed turn resets the streak and cancels a pending retry;
  `/goal pause|edit|complete|block|clear` cancels it and is never undone;
- Esc is recovered by reading the harness's own pause (it lands right after the
  cancelled turn) instead of treating it as a human stop;
- after 5 recoveries the goal is blocked with `recovery-exhausted` and
  `/goal resume` restarts it with a fresh 5-attempt budget (only a human resume
  refreshes the streak; the module's own re-arm must not, or the cap never
  binds). `max-tokens`, a disposed session and an exhausted round budget still
  stop the goal.

`/ceulen module off goal-retry` restores stock behaviour.

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

The Vitest suite lives in `test/` and is kept out of the public repo; run it from
the full development checkout (CI checks the build, bundle, pack and parity).

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
