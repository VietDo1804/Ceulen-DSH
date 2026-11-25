# ceulen-dsh

**The Ceulen toolkit for DeepSeek Harness (DSH), installed as one plugin bundle.**

ceulen-dsh adds the parts of a coding agent that DSH leaves to plugins: a team
mode where one model leads and others build, a second-model reviewer, guards
for destructive commands, long-term memory, web and browser tools, a settings
panel, themes, and model-specific tuning. Every feature is a module you can
turn off.

Ceulen itself is a bundle for the Pi agent. DSH has a different plugin API, so
this is an independent port: logic that does not depend on the UI is vendored
from Ceulen (MIT), and each feature gets a thin DSH adapter.

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Install](#install)
- [Working with a team of agents](#working-with-a-team-of-agents)
- [Feature reference](#feature-reference)
- [Configuration](#configuration)
- [Guides](#guides)
- [Optional TUI patches](#optional-tui-patches)
- [Known gaps](#known-gaps)
- [Credential safety](#credential-safety)
- [Upstream releases](#upstream-releases)
- [Development](#development)
- [Special thanks](#special-thanks)
- [License](#license)

## Highlights

| You want to | Use |
|---|---|
| Have one model plan and review while cheaper models build in parallel | `/orchestrator` and the `delegate` tool |
| See what every child agent is doing without scrolling | the Team and Subagents side panels, `/dashboard` |
| Get a second opinion on finished work | `/advisor` |
| Stop an agent from deleting work you did not ask it to delete | `/classifier` and rule guards |
| Run many tool calls in one step and keep the noise out of the context | the `codemode` tool |
| Read, capture and click through web pages | `web_extract`, `web_screenshot`, `web_interact` |
| Keep project knowledge between sessions | [Munin long-term memory](#long-term-memory-munin) and the `munin_*` tools |
| Change settings without editing JSON | `/ceulen-config` |
| Check that everything is wired correctly | `/ceulen doctor` |

## Requirements

- DSH `0.2.2-rc.5` (the `dsh` CLI and `dsh-tui` 0.20.2 profile)
- Node.js `>=24.9.0` for a fresh installation (required by the pinned DSH CLI; the bundle itself supports `>=22.19`)
- On Windows, run the commands below in WSL.

Optional backends, each needed only for its own feature: `gh`, `sg`/`ast-grep`,
`rtk`, Serena, Chrome or Chromium, a Munin server, a Brave Search key, an
OpenAI-compatible router, A2A peers.

ceulen-dsh ships no API key and no subscription. You add your own model
provider with `/provider`.

## Install

`ceulen-dsh` is on [npm](https://www.npmjs.com/package/ceulen-dsh). The
package is already compiled and has no runtime dependencies.

### Install from npm

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.5
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.20.2 ceulen-dsh
dsh --profile tui
```

DSH has no `tui` template, so the second command installs two things into the
`tui` profile: the TUI app and this bundle. A plugin is installed with
`dsh plugin`, which runs the package manager inside the profile and mounts
the bundle there; a plain `npm install ceulen-dsh` only downloads it.

To pin a release, name it: `ceulen-dsh@0.2.13`.

### Install a release tarball

For a machine without registry access, download `ceulen-dsh-<version>.tgz`
from the [Releases](https://github.com/VietDo1804/Ceulen-DSH/releases) page,
then:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.5
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.20.2 file:/absolute/path/to/ceulen-dsh-0.2.13.tgz
dsh --profile tui
```

An HTTPS tarball URL works in place of `file:...`. Do not install from a Git
URL: the compiled `lib/` directory is not committed. Checksums and installer
options are in [release/README.md](release/README.md).

### Build from source

```sh
git clone https://github.com/VietDo1804/Ceulen-DSH.git
cd Ceulen-DSH
npm ci --include=dev
./release/build.sh

# Install BOTH the TUI app and this bundle into a new profile.
./release/install.sh --profile tui --with-tui --tarball "$PWD/release/ceulen-dsh-0.2.13.tgz"
dsh --profile tui
```

The installer creates the profile under `${DSH_HOME:-$HOME/.dsh}/profiles/tui`
and does not replace an existing profile's settings. To share the build, send
`release/ceulen-dsh-0.2.13.tgz`; the other machine needs no clone and no build.

### Develop from a checkout

After `npm ci --include=dev` and `npm run build`, link the checkout instead of
installing a tarball:

```sh
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.20.2 link:"$PWD"
dsh --profile tui
```

Rebuild with `npm run build` after a change and restart DSH. Plugin code does
not hot-reload.

### First run

1. Follow the TUI's first-run setup, or run `/setup`.
2. Add a provider and key with `/provider`, then pick a model with `/model`.
3. Check the installation:

```text
/ceulen          # version, release line, module status
/ceulen-config   # full-screen settings panel
/ceulen doctor   # compatibility and optional-backend diagnostics
```

`/ceulen` shows the release line (`ceulen-dsh 0.2.13 (stable)`), the pinned
Ceulen version, and which modules are mounted. The bundle composes 34 rows.

To upgrade, run `dsh plugin --profile tui add ceulen-dsh@latest` (or install a
newer tarball into the same profile) and restart. Your settings are kept.
`/ceulen update` tells you when a newer release is out.

### Release line

`package.json` carries this bundle's own version (`0.2.13`) plus
`release: { line: "stable", distTag: "stable" }`. The upstream Ceulen version it
tracks lives in `upstream.lock.json` (`0.31.0`). The update check follows the
`stable` npm dist-tag only, and reports `unknown` when that tag is missing
rather than offering another line as an upgrade. A cached result is compared
with the version installed now, so an upgrade clears the "bundle … available"
line at once instead of when the cache expires. `/ceulen doctor` prints the
line and dist-tag.

## Working with a team of agents

### Orchestrator mode

`/orchestrator <task>` turns the current session into a **team lead**. The lead
plans, hands out the work, reads every result and corrects it. It does not
build the result itself.

| Command | Effect |
|---|---|
| `/orchestrator <task>` | turn the mode on and submit the task |
| `/orchestrator` or `/orchestrator on` | turn the mode on for the following messages |
| `/orchestrator status` | the team, the plan and whether you approved it, the contract, the counters |
| `/orchestrator approve` | approve the current plan where there is no review card (headless) |
| `/orchestrator off` | leave the mode; running children are not cancelled |

How a run goes:

1. **Orient.** The lead reads what it needs. A choice only you can make, or a
   request it can read two ways, becomes a question to you. It does not guess.
2. **Plan.** It writes `.dsh/plans/<date>-<task>.md` (for example
   `2026-11-23-login-form.md`) with `Goal`, `Scope` (and what is out of
   scope), `Tasks` (`T1`, `T2`, … with owner, write scope, check and wave),
   `Acceptance` and `Assumptions`. It submits the plan by mirroring the tasks
   on its board.
3. **The advisor reads it.** When an advisor route is set, a second model
   checks the plan against what you asked. Its points go back to the lead
   once; the lead fixes the plan or answers them.
4. **You approve.** The whole plan appears on the plan review card, with what
   the advisor still holds open at the top. Choose **Approve**, or **Keep
   planning** with feedback that goes back to the lead.
5. **Contract.** When tasks must fit together, the lead pins the interfaces in
   `contracts/<task>/contract.md` (the `contract-first` skill).
6. **Dispatch.** It briefs the children and sends each wave in parallel.
7. **Checkpoint.** When a wave settles, it reads every report, then accepts,
   corrects or takes over.
8. **Report.** It tells you what was built and how it was checked.

Eight parts of this are enforced by the harness, not left to the prompt:

- **Plan.** Nothing is built before you approve. The review starts when the
  lead mirrors the plan on its board (`todo_write`), before it has written a
  brief, so a plan you send back costs it one small call; a contract write or
  a dispatch on an unapproved plan starts the same review. A `worker` or
  `tester` brief must name its plan task (`Plan: T2`); a task the plan does
  not list is refused. An edited plan comes back to you as a **Plan change**
  before the next board update, dispatch or message to a child, so work
  outside the approved scope cannot start without you. Scouts, planners and
  reviewers only read and may run earlier. The board that submits a first
  plan must show its worker and tester tasks as pending: one that marks them
  started is refused before you are asked.
- **Plan file name.** A new plan file starts with the day it was written, like
  the plans `/plan` saves, so the folder shows when each plan is from. The
  prompt gives the lead today's date; a new file without one is refused with
  the name to use. A plan file that already exists keeps its name.
- **Plan review by the advisor.** Before your card opens, the advisor reads the
  plan with your own messages and the lead's steps beside it. Points from the
  first reading are returned to the lead, and nothing is shown to you yet. The
  second reading only reports: the card's question line says what the advisor
  found, open points are listed above the plan, and **Keep planning** with no
  note sends them back to the lead. A later change to
  the plan is read once, against the plan you approved. If the advisor cannot
  answer, the card says so and you still get the plan. Turn it off with
  `advisor.planReview` (Config panel → Advisor → Review plans); it works with
  the turn watcher off and follows `advisor.skipModels`.
- **Brief.** `delegate` refuses a task without `Goal:`, `Scope:` and
  `Acceptance:` lines. It appends the handoff rules and the report every child
  ends with (`STATUS`, `CHANGED`, `CHECKS`, `DEVIATIONS`, `BLOCKERS`).
- **Checkpoint.** When every child of a wave has settled, the lead gets one
  notice with the roster and the review steps. After a wave of scouts the
  steps ask for a spot-check of the anchors the plan rests on and a follow-up
  question to the scout, not a second read of the files: the lead asks a scout
  for quoted lines with `path:line`, so its report is enough to plan from.
- **Dropped connection.** A child whose reply was cut by the provider
  connection (`WebSocket error`, `fetch failed` and the like) is not settled as
  failed: it is resumed once with its context intact, and the lead is told to
  wait for it. A second failure, a usage limit or any other error goes to the
  lead at the checkpoint as before.
- **Garbled message.** A message between the lead and a child that contains
  terminal control characters is refused at the sender, who is asked to write
  it again as plain text. The other side never receives half a report.
- **Takeover.** The lead's own edit outside `contracts/`, `.dsh/plans/` and
  `.scratch/` is refused once. Sending the same edit again declares a takeover,
  which is counted in `status`. Bash is not gated.
- **Contract.** A child cannot edit inside the lead's contract directory. A
  child that disagrees reports it under `BLOCKERS`.

The mode is tuned for `gpt-6.2-astra` and `gpt-6.2-sol` as lead and says so on
any other model; the rules are the same for every lead. It does not change the
lead's model, permissions or approvals. While it is on, the footer shows
`Orchestrator`. Restarting the session turns it off.

#### Team panel

While the mode is on, a **Team** side panel opens beside the chat and shows how
the lead runs the team:

```
 chat …                              │ ◆ Team · glm-5.3 lead                   wave 2
                                     │
                                     │   Plan ✓  Contract ✓  ▸ Dispatch  Review  Report
                                     │   plan     Add tax and loyalty     approved
                                     │   contract contracts/tax-loyalty-receipt
                                     │   board    ━━━━━━━───────────── 2/6
                                     │
                                     │ WAVE 1 · reviewed                        1m30s
                                     │ ✓ worker · T1 · Tax module            accepted
                                     │ ↻ worker · T2 · Loyalty module       corrected
                                     │
                                     │ WAVE 2 · running                           30s
                                     │ ⠧ worker · T3 · Receipt options            29s
                                     │     Goal    Integrate tax + loyalty into the receipt
                                     │     Scope   src/receipt.js, test/receipt.test.js
                                     │     Accept  npm test green; pinned 6-line example
                                     │     todo ━━━━━━━───────────── 1/3
                                     │
                                     │ NEXT
                                     │ ○ [reviewer] independent review
                                     │
                                     │ 1 checkpoint · 1 correction · 0 takeovers
```

- The rail is the lead's loop. A step it skipped shows `–`.
- The `plan` row says `draft`, `needs you` while the review card is open, or
  `approved`.
- A wave is everyone dispatched between two checkpoints. A running child shows
  its brief (or the correction it is fixing), its todo, model and context.
- After the checkpoint each child shows the lead's decision: `accepted`,
  `corrected`, `lead took over`, or what stands in the way (`blocked` with the
  child's blocker, `partial`, `failed`, `cancelled`).
- `NEXT` lists what the lead's board still has pending.
- Each new plan file starts a new round. Waves of earlier plans fold into one
  `▸ 13 earlier waves · 4 plans · 3 corrected` row; click it, or press Enter
  while the panel has focus, to show them all again. A wave still running or
  waiting for review always shows. The team map counts only the current plan.

When the panel has room left under those rows, it draws the **team map**: the
lead, the plan's task list, and one box per role.

```
        ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
        ╎             glm-5.3 · team lead              ╎
        ╎   splits the work · never writes the code    ╎
        ╎               effort ▮▮▮▮▮ max               ╎
        ╎              [ wave 2 running ]              ╎
        └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
                               ◆
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ PLAN TASKS  [ 1/4 ]                                  tasks 4 │
│ T1 Tax module              worker    ━━━━━━━━━━━━ done       │
│ T2 Loyalty module          worker    ─────━━━──── ⠧ fixing   │
│ T3 Receipt options         worker    ━━━━──────── ⠙ running  │
│ T4 Independent review      reviewer  ──────────── wave 3     │
│ the lead assigns · each wave is reviewed before the next     │
└──────────────────────────────────────────────────────────────┘
                               ◆
                               ▼
  » team · 3 subagents · own context each · fixes by message «
                  ▼                        ▼
       ┌──────────────────────┐ ┌──────────────────────┐
       │        worker        │ │       reviewer       │
       │ deepseek-v4.1-flash  │ │    glm-5.3-flash     │
       │   [ ⠸ 2 running ]    │ │     [ waiting ]      │
       │ ━━━━━━━───────────── │ │ ──────────────────── │
       │    1/3 tasks done    │ │    0/1 tasks done    │
       │    ↻ 1 correction    │ │   ✓ no corrections   │
       └──────────────────────┘ └──────────────────────┘
```

- A task row shows its owner, a bar and where it stands: `wave N` before its
  turn, `running` (the bar follows the child's todo list, or sweeps when there
  is none), `in review`, `done` once the lead accepted it, or `fix sent`,
  `fixing`, `blocked`, `partial`, `failed`, `cancelled`, `taken over`. The
  owner and wave come from the plan's task table, the title from the board.
- A role box shows the route that role runs on, how many of its tasks are
  done, and how many corrections the lead had to send.
- The map only uses free space. On a short panel it drops the lead box, then
  the role boxes; when the task list does not fit either, it is left out. It
  needs a panel at least 42 columns wide.
- While the map shows, `NEXT` is left out: the task list has the same tasks
  as `wave N`.

The panel never takes keyboard focus, is not reopened once you close it, and is
removed when the mode is turned off.

### Delegation and roles

The `delegate` tool starts a child agent with a fresh context and one of five
roles: `planner`, `reviewer`, `scout`, `tester`, `worker`. Each role has its own
persona and model route, so a strong model can lead while cheaper models do the
bulk of the work. `/subagent` shows the route of every role; see
[Subagent routes](#subagent-routes) to change them. DSH's native `subagent`,
`subagent_fork` and `workflow` tools remain available.

A child is a session of its own: it sees only its brief, never asks you for
approval (what would need it is refused) and cannot delegate further. It keeps
its parent's sandbox, with one exception: the `reviewer` and the `scout` are
held read-only by the harness. Their session is put in the read-only sandbox
before their first tool runs, `edit`, `write` and `apply_patch` are refused,
and so is a request for wider access. A check that writes files belongs to a
`tester`. The `planner` is read-only by its persona only.

### Subagents panel

Outside orchestrator mode, a **Subagents** panel opens while children run:

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

Each running child is a card with its role, model and effort, todo list,
context use and cache hit rate. Finished children shrink to one line. The panel
opens when a batch starts and closes 60 seconds after the last child ends,
unless you focused it or opened it yourself (`Ctrl+B`; `Esc` returns to the
chat).

Both panels need fullscreen mode and at least 93 columns. Elsewhere, the same
data shows as up to three rows above the prompt:

```
◆ Subagents  2 running · 1 done                         Ctrl+B panel · /agentbar
  ⠹ scout · Survey auth code   ⏵ Narrowing the search…   todo 2/5 · 7 steps · ctx 22k · 1m12s
  ⠼ worker · Add login form    Writing the form component…   4 steps · ctx 31k · 48s
```

| Command | Effect |
|---|---|
| `/agentbar` | print every child of the session |
| `/agentbar auto off` / `on` | keep the panels manual, or open them automatically again |
| `/ceulen module off agentbar` | remove the panels and the band |

Opening a panel automatically without interrupting your typing needs the
[panel patch](#optional-tui-patches). Without it the panels stay on `Ctrl+B`.

### Dashboard

`/dashboard` (or `Ctrl+A`) opens a read-only view of tasks, agents and activity
in the current session. `Tab` and `Shift+Tab` switch between the three lists,
arrows navigate, `Enter` opens detail, and `Esc` goes back. Opening it never
starts work and never changes the model or the approval policy.
`/dashboard status` prints a summary without the full-screen view.

## Feature reference

Every area below is a module. `/ceulen modules` lists them, and
`/ceulen module off <name>` turns one off.

### Agents and review

| Area | What it gives you |
|---|---|
| Orchestrator | `/orchestrator`: the team-lead mode described above |
| Subagent roles | `delegate` with five role presets; `/subagent` shows the routes. On DeepSeek flash leads, at most one notice per turn asks whether a `scout` or a `reviewer` would pay off (`subagent.nudge`) |
| Agent bar | the Team and Subagents side panels, the progress band, `/agentbar` |
| Dashboard | `/dashboard`: tasks, agents and activity |
| Advisor | a second model reviews settled work and leaves one note with a severity; `/advisor`, `advisor` tool |
| Plan mode | submitted plans are saved to `.dsh/plans/`; `/plan-approve`; separate model routes for planning and for implementing |
| Goal recovery | an active goal is resumed automatically after a provider error or `Esc` |
| Cron | `cron` tool and `/cron`: persisted jobs that fire into the live session |

### Safety and rules

| Area | What it gives you |
|---|---|
| Classifier | `/classifier`: audits bash commands and can gate destructive ones against what you actually asked for; `classify` tool for typed decisions |
| Rules | sticky rules in `.dsh/RULES.md`, a rulebook served by `rule_get`, and `when-*` guards checked before every tool call; `/rules` |
| Ponytail | `/ponytail off\|lite\|full\|ultra`: prompt discipline against over-engineering, with review and audit skills |
| Web guard | fetch and capture refuse non-public targets; loopback and LAN dev servers stay reachable for audits |

### Tools

| Area | What it gives you |
|---|---|
| Codemode | `codemode`: one JavaScript program calls every visible tool, and only its result reaches the model |
| Repair | `apply_patch`, `read_slice` |
| Web | `web_extract`, `web_map`, `web_status`, a Brave search provider and a fetch fallback; native `web_search` and `web_fetch` remain |
| Browser capture | `web_screenshot`, `web_pdf`, `web_interact` through local headless Chrome |
| Structural search | `ast_grep`, `ast_edit` when the `sg` binary is installed |
| Semantic find | `jfind`: describe a behaviour, and the model judges candidate files and passages |
| GitHub | read-only `github` tool over the `gh` CLI |
| RTK | `rtk` tool and `/rtk`: rewrite a supported command, then run it with bash |
| NotebookLM | `notebooklm` CLI bridge with gates for destructive and login actions |
| A2A | `a2a_peers`, `a2a_list`, `a2a_call`, `a2a_status`: outbound calls to other agents |
| Serena | `/serena`: status and the exact MCP row to add (it follows the installed serena-agent version); `/serena cold` keeps the navigation tools in the list and holds the rest |
| Tool budget | `/ceulen tools` shows what the tool schemas cost; `tools.cold` holds rarely used tools out of the prompt and `ceulen_tools` finds and calls them on demand |

### Memory, models and interface

| Area | What it gives you |
|---|---|
| Memory | [Munin long-term memory](#long-term-memory-munin): `munin_search`, `munin_get`, `munin_store` and eight more tools, a Memory Protocol in the prompt, `/munin-status`, an optional failover server |
| Steering | model-family prompt hints and `/steering`; extra tool habits for DeepSeek flash routes only |
| Providers | `/router-status`, `/router-model`, `/zai`, `/provider-compat` with ready provider recipes |
| Usage | `/usage`: subscription windows and credits for OpenCode Go, Z.AI, Command Code, Codex and a generic router, plus a footer segment |
| Context | `/context`: a colored grid of what fills the context window, by category |
| UX | `/ux off\|lite\|strict\|auto` design guidance and `ux_audit` (static checks, six viewports, screenshots, motion checks) |
| Themes | 104 Ceulen Pi themes converted to DSH themes (`ceulen-<name>`), plus the `skins` and `thread` UI styles |
| Skills | all 20 bundled skill packs registered (15 ported from Ceulen) |
| Config | `/ceulen-config`: full-screen settings panel |
| Status | `/ceulen`, `/ceulen modules`, `/ceulen tools`, `/ceulen doctor`, `/ceulen update` |
| Evolve | a weekly audit of past sessions that groups recurring tool errors into a report; `/evo`, `/evo-status` |
| Herdr | optional: a `herdr` skill and a `delegate` runner that puts a child in its own terminal pane |

DSH's own features stay as they are: todo, native subagents and workflows,
attachments, permissions and sandbox, shell jobs, grep and glob, notifications.

## Configuration

Settings live at `$DSH_HOME/ceulen/settings.json` (mode `0600`). The main keys
and their defaults:

```json
{
  "schemaVersion": 1,
  "disabled": [],
  "upstream": { "enabled": true, "intervalHours": 24 },
  "advisor": { "provider": "zai", "model": "glm-5.3", "reasoningEffort": "max", "fallbacks": [], "skipModels": ["gpt-6-astra"], "watch": false, "minToolCalls": 1, "planReview": true },
  "classifier": { "provider": null, "model": null, "audit": true, "enforce": false, "fallbacks": [] },
  "tools": { "cold": ["a2a_call", "a2a_list", "a2a_peers", "a2a_status", "jfind", "munin_delete", "munin_share", "web_interact", "web_map", "web_pdf", "web_screenshot"] },
  "munin": { "project": "", "baseUrl": "", "allowProjectConfig": false, "brief": { "enabled": false, "maxChars": 600, "recencyDays": 30 } },
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

### Config panel

`/ceulen-config` edits that file in a full-screen panel with nine tabs:
Appearance, Model, Memory, Context, Shell, Tasks, Providers, Tools, Plugins.

| Key | Action |
|---|---|
| `↑` / `↓` | move between rows |
| `←` / `→` or `Tab` | switch tabs |
| `Enter` | edit a value (text and numbers edit inline, enums cycle, toggles flip) |
| `Esc` | save and close |

- Model rows open a filterable list of every model your providers advertise.
  A typed `provider/model[:effort]` is accepted when the list has no match, and
  `-` clears the row.
- API-key rows (Munin, Brave, Z.AI) mask the input and write to the DSH
  credential store, so a key never lands in `settings.json` or the transcript.
- `/ceulen config <tab>` prints one tab; `/ceulen config --raw` prints the
  redacted file.

In the TUI the command is `/ceulen-config` because DSH keeps bare `/config`
for itself.

### Subagent routes

| Setting | Meaning |
|---|---|
| `subagent.roles` | maps the `fast`, `coder` and `smart` aliases to ordered `provider/model[:effort]` chains; `*` inherits the parent's route |
| `subagent.models` | overrides one role, for example `"reviewer": "@smart:high"` |
| `subagent.thinking` | overrides one role's reasoning effort |
| `subagent.presets` | picks a DSH preset per role, for example `{"scout": "ptc", "worker": "standard"}` |

`/subagent` prints the effective route of every role. Settings are read again
for each `delegate` call, so a change applies to the next child. A role's
effort applies when the role resolves to an explicit route; an inherited `*`
route keeps the session's own effort.

### Secrets

Secrets belong in the environment or the DSH credential store, never in the
settings file:

```sh
export MUNIN_API_KEY=... MUNIN_PROJECT=...
export ROUTER_BASE_URL=... ROUTER_API_KEY=...
export ZAI_ANTHROPIC_API_KEY=...
export GITHUB_TOKEN=...          # optional, for upstream release notes
```

An environment variable wins over the stored value of the same name.

## Guides

### Codemode

`codemode` lets the model write one JavaScript program instead of a chain of
tool calls. Every tool the agent can see is bound as `tools.<name>(args)`, and
only the program's return value and `console.log` output reach the model.

```js
const results = await Promise.allSettled([
  tools.bash({ command: 'git status --short', description: 'Show status' }),
  tools.bash({ command: 'git diff --stat', description: 'Show diff stat' }),
]);
return results.map(result => result.status === 'fulfilled' ? result.value : String(result.reason));
```

- `code` is the body of an async function: top-level `await` and `return` work.
- Tool names are exact. Use `tools['mcp__server__tool']` for names that are not
  identifiers. A typo such as `tools.Bash` gets a "did you mean" hint.
- A failed, blocked or denied call rejects. Nested calls go through the full
  tool pipeline, so approvals, guards and sandbox policy still apply.
- Calls resolve to structured values (bash output is `r.stdout.text`; `read`
  returns `{ lines: [{ number, text }] }`).
- Output past about 6k characters is truncated in the middle and the full text
  is written to `$DSH_HOME/ceulen/spill/` (kept 48 hours; not `/tmp`, which a
  sandboxed shell cannot see: see "Where large tool results go"). The notice says which parts were cut and prints
  the command that reads one part back (`scripts/spill-page.mjs`), sized to
  fit the same budget.
- A first line `// @options: {"timeout_ms": 60000, "max_output_chars": 4000}`
  changes the deadline (default 120 s, max 600 s) and the output budget.
- `state.store({ key, value })` and `state.load({ key })` keep small JSON
  values in memory for the life of the session.

It is on by default. Turn it off in `/ceulen-config` → Tools → Codemode and
restart DSH. Scripts run in a Node subprocess with the same trust as bash; it
is not a security sandbox.

### Advisor

A second model reviews the work after a turn settles and leaves one note with
a severity. `blocker` and `concern` notes wake a follow-up turn; `nit` notes
wait. It is off by default, so no model is called until you turn it on:

```text
/advisor model zai/glm-5.3:high, opencode-go/deepseek-v4-pro
/advisor on
/advisor status
```

- The route is a chain: the second entry is the fallback. The `:high` suffix is
  the reviewer's reasoning effort.
- The review sees your latest request and the diff of the files the turn
  touched, so it judges the actual request and the actual edit.
- `advisor.skipModels` lists main models that should not be reviewed
  (`gpt-6-astra` by default).
- In [orchestrator mode](#orchestrator-mode) the advisor reads the lead's plan
  before you approve it (`advisor.planReview`, on by default), and the turn
  watcher waits while the lead's children are running: it reviews the turn
  that reports.
- `Esc` cancels a running review.

### Classifier and the destructive-command gate

`/classifier` audits every bash command. With enforcement on, a destructive
command is judged against your latest request and your latest answer to a
question. Tool output never counts. A target you named passes; a general goal
does not authorize deleting anything else. Whole-tree git discards
(`git checkout -- .`, `git restore .`, `switch -f`) are gated like
`reset --hard`.

Set the decision model with `/classifier model <route>[,<fallback>]`. A
`typesafe/jev-*` route on OpenRouter is used for decisions only and needs
`OPENROUTER_API_KEY`.

### Steering for DeepSeek flash routes

For routes listed in `steering.models` (default `deepseek-v4.1-flash` and
`deepseek-flash`), and for no other model:

- a playbook in the prompt shows an efficient way to work: one opening
  codemode batch of searches and reads, a need → tool map, and delegating only
  when it pays;
- a bash call that only greps, cats or finds files is not run. The reply names
  the equivalent `grep`, `read` or `glob` call. Sending the same command again
  runs it, and so does a command you typed out yourself in your message.
  `steering.bashLookups: "off"` disables this;
- a bash call that only takes headless-Chrome screenshots is redirected to
  `web_screenshot` the same way;
- `web_interact` gains named browser sessions, a `hover` step, `text=Label`
  selectors and `screenshot: false`.

Every other route keeps the untuned tools, and a `/model` switch swaps the two
sets before the next step.

`steering.cold` (tool names, such as MCP tools a route never uses) is held
behind `ceulen_tools` on those routes, and also on the routes in
`steering.coldModels`, which get that hold and nothing else of the steering.
For a lead on a 272k window such as `gpt-6.2-astra`, holding the 27
openmotion/renesas MCP tools cut the first request from 33k to 18k tokens.
A child on a route outside both lists still gets those tools.

An agent that holds such tools gets a short `Held tools` note in its prompt:
the held names grouped by MCP server, and the way in (`ceulen_tools` search,
then call; `tools['<full name>']` inside codemode). A call to a held tool by
the short name an MCP server's instructions use (`openmotion_get_project`)
is answered with the full name and the `ceulen_tools` call to make.

### Plan mode

- A plan submitted through `exit_plan_mode` is saved to
  `.dsh/plans/<timestamp>-<slug>.md`.
- `/plan-approve [current|new|stay]` offers three paths: implement in this
  session, implement in a new session with a clean context, or keep planning.
- `/ceulen-config` → Tasks → Plan mode sets separate models, efforts and
  fallbacks for planning and for implementing. When a provider keeps failing,
  the next untried fallback continues in a new turn of the same session.

### Goal recovery

DSH stops a goal for good when a turn dies from a provider error or `Esc`. The
`goal-retry` module resumes the same goal after 5, 10, 20, 40 and 60 seconds,
at most five times per failure streak. A completed turn resets the streak.
`/goal pause|edit|complete|block|clear` is never undone. After five failed
recoveries the goal is blocked as `recovery-exhausted`, and `/goal resume`
starts a fresh budget. `/ceulen module off goal-retry` restores the stock
behaviour.

### Usage

`/usage` shows the active provider's 5-hour, weekly and monthly windows plus
credits. `/usage --all` checks every configured provider and `/usage refresh`
forces a fetch. The footer segment (`Go · 5h 86% · W 88% · M 94%`) appears only
while the session runs on a subscription route.

Credentials resolve from the environment first, then the DSH credential store:

```text
OPENCODE_GO_API_KEY   ZAI_ANTHROPIC_API_KEY / ZAI_API_KEY
COMMAND_CODE_API_KEY  OPENAI_CODEX_ACCESS_TOKEN + OPENAI_CODEX_ACCOUNT_ID
ROUTER_BASE_URL + ROUTER_API_KEY
```

The refresh interval is five minutes (`usage.intervalMinutes`). A failed fetch
stays quiet and never blocks a turn.

### Long-term memory (Munin)

An agent forgets what it learned when its session ends. [Munin](https://www.kalera.app)
is a long-term memory service for AI agents: what one session learns about
your project is stored there, and later sessions search it before they act.
Munin has [adapters](https://github.com/kalera-labs/munin-for-agents) for
Claude Code, Cursor, Gemini CLI and other tools, so a project's memory can be
shared with them.

**Set it up.** You need a Munin project and an API key:

```sh
export MUNIN_API_KEY=... MUNIN_PROJECT=my-project
export MUNIN_BASE_URL=https://munin.kalera.ai   # optional: this is the default
```

The key can also be stored from `/ceulen-config` → Memory → Munin, which
writes it to the DSH credential store. `/munin-status` shows where each value
comes from, without printing the key.

**What the agent does with it.** Once Munin is configured, the prompt carries
a Memory Protocol:

- Before non-trivial work, and before a change to architecture, dependencies,
  setup or a subsystem that was fixed before, the agent searches memory. For
  a bug it searches the exact error first.
- A search result is a lead, not a fact: the agent reads the memory and
  checks it against the repository.
- It stores only verified knowledge that a later session can use: decisions
  with their reason, root causes of recurring bugs, stable setup facts,
  conventions and constraints. Progress notes, logs, guesses and secrets are
  not stored.
- One concept goes into one memory, under a stable key, with at least one
  `type:` tag (`decision`, `bug-fix`, `fact`, `dependency`) and one
  `domain:` tag. A store without both tags is refused.
- New knowledge is stored once, at the end of the session.

**Tools.**

| Tool | What it does |
|---|---|
| `munin_search` | searches memory, with filters for tags and dates |
| `munin_get` | reads one memory in full |
| `munin_store` | stores or updates one memory |
| `munin_list`, `munin_recent` | lists memories; shows the latest changes |
| `munin_versions`, `munin_diff`, `munin_rollback` | a key's history, the difference between two versions, and a restore of an older one |
| `munin_delete` | deletes one memory |
| `munin_share` | shares memories with another project |
| `munin_capabilities` | shows what the server supports |

`munin_delete`, `munin_rollback` and `munin_share` run only with
`confirm: true`, which the agent is told to pass only after you asked. By
default only `munin_search`, `munin_get` and `munin_store` have their schemas
in the prompt; the other eight are held behind `ceulen_tools` (`tools.cold`).

**Options.**

- **Failover.** Set `munin.fallback.baseUrl` and `MUNIN_FALLBACK_API_KEY` to a
  second server that speaks the same protocol. It answers when the primary is
  unreachable. An authentication error still surfaces as an error.
- **Maintenance.** While the server is in a write freeze (`503
  MAINTENANCE_READ_ONLY`), a write waits and retries twice, then fails with a
  message that it was not saved. It is not sent to the failover server, and
  nothing is queued on disk. Reads keep working. The bundled client speaks
  Munin SDK 1.6.0.
- **Brief.** `munin.brief` adds a short summary of recent memories to the
  prompt. It is off by default and usually arrives from the second turn.
- A project-level `.dsh/ceulen.json` is read only when
  `munin.allowProjectConfig` is `true`, so a checkout cannot redirect your key.

### Web search and fetch

The web module registers two providers for DSH's native web tools:

- `brave`: `web_search` on the Brave Search API (`BRAVE_API_KEY`, or the key
  row in `/ceulen-config` → Tools → Web).
- `deepseek-fetch-fallback`: `web_fetch` asks the DeepSeek Fetch API for the
  page as Markdown and, on any failure, fetches it over plain HTTP with the
  public-URL guard. Without `DEEPSEEK_API_KEY` only the local path is used.

They become active when the profile pins them:

```yaml
- id: web
  config:
    searchProvider: brave
    fetchProvider: deepseek-fetch-fallback
```

Without a pin, the web service uses the single usable provider and reports
`WEB_PROVIDER_AMBIGUOUS` when there is more than one.

### Rules and guards

Create `.dsh/RULES.md` in the project, `$DSH_HOME/ceulen/RULES.md` for every
project, or both:

```md
## never-push
Never push unless the user explicitly asks.

## api-style
description: How to write HTTP handlers.
Use the shared json() helper.
```

A section without a `description:` line is always in the prompt. A section with
one is a rulebook entry that the model fetches with `rule_get` when it applies.

Add three `when-*` lines and the section becomes a **guard**: a check before
every tool call that costs no prompt space.

```md
## Guard: no force push
description: Force-pushing rewrites shared history.
when-tool: bash
when-match: git\s+push\b.*--force
when-action: deny
Never force-push a shared branch.
```

| Line | Meaning |
|---|---|
| `when-tool` | a tool name, or `*` |
| `when-match` | a JavaScript regex tested against the command (`bash`), the path (`edit`, `write`, `apply_patch`) or the JSON arguments (other tools) |
| `when-action` | `audit` (default) or `deny` |

`rules.guards` sets the mode: `audit` logs matches, `enforce` denies the rules
that chose `deny`, `off` disables the check. `/rules status` lists every guard.

Existing conventions are read too, in this order: the nearest `.dsh/RULES.md`,
`AGENTS.md`, `.cursor/rules/*.mdc`, `.clinerules`, then
`$DSH_HOME/ceulen/RULES.md`. The foreign files are read only at the workspace
root and are never written.

### Herdr (optional)

[Herdr](https://herdr.dev) is a terminal multiplexer for coding agents. Nothing
here needs it, and outside a Herdr pane every Herdr feature stays off.

- The `herdr` skill teaches the agent to drive panes. Refresh it after a Herdr
  update with `node scripts/herdr-skill-sync.mjs`.
- `delegate` accepts `runner: "herdr"` inside a Herdr pane. The child runs
  headless in a pane split beside the caller, and the call returns its final
  text. The pane closes on success and stays open on failure.

## Optional TUI patches

Some behaviour lives in the TUI app itself and cannot be reached by a plugin.
These scripts edit the **installed** `dsh-tui` copy. Each supports `apply`,
`check` and `revert`:

```sh
node scripts/tui-<name>-patch.mjs apply
```

| Patch | What it changes |
|---|---|
| `advisor` | shows advisor notes as a block in the transcript instead of a 15-second status line |
| `context` | makes `/context` open the token dashboard |
| `toolname` | renders acronym tool names correctly (`fff` instead of `Fff_grep`) |
| `plan` | bare `/plan` toggles, "implement in a new session" opens a real new session, the footer names plan mode, and the plan-review and question cards fit the screen (with a todo band up, Keep planning, the answer row and the key hint stay visible, and a short plan leaves no blank block) |
| `effort` | remembers the reasoning effort per model instead of one level for all |
| `style` | adds the `skins` and `thread` UI styles (`/theme style …`) |
| `usage` | keeps every usage window visible in the footer |
| `panel` | lets side panels open without taking keyboard focus |

A `dsh-tui` upgrade reverts all of them without notice, so apply them again
after every upgrade. `/ceulen doctor` reports the state of the UI patches, and
each script's `check` exits non-zero when its patch is missing.

`check` proves the edits are in place, not that the result looks right. For
the question cards, a headless render checks the layout itself:

```sh
node scripts/tui-question-fit-smoke.mjs   # 0 fits, 1 a card overflows, 2 cannot run
```

It draws both cards under a todo band in a virtual terminal and fails when a
button, the answer row or the key hint falls off screen. The `dsh-update` skill
runs it after every patch pass. For the
separate `dsh-fff` plugin, `scripts/fff-search-patch.mjs` adds ignore-aware
filename indexing with ripgrep.

## Known gaps

Not ported from Ceulen: Pi composer shapes and entry renderers, the inbound A2A
server and mDNS, Gemini research, image generation, ChatGPT-web chat, per-role
subagent sandboxes and timeouts, and the worktree sandbox. Codemode has no
`models` namespace; scripts call the `classify` tool instead.

## Credential safety

- Keep API keys and login state in your own DSH credential store, never in this
  repository or in a tarball you share.
- `.gitignore` excludes local `.env` files, credential files and login
  directories. Ignoring a file does not remove it from Git if it was already
  tracked.
- The `secrets` GitHub Actions workflow scans the Git history with Gitleaks on
  every push and pull request. Keep GitHub's own secret scanning and push
  protection enabled as well.
- Run the same scan locally before you push:

```sh
gitleaks git . --redact --log-opts="--all"
```

A history scan does not cover uncommitted or ignored files. Share only the
built tarball, never your workspace or `~/.dsh`. If a real secret was
committed, revoke it at once; adding it to `.gitignore` is not enough.

## Upstream releases

`/ceulen update` checks npm and the GitHub release notes. When Ceulen publishes
a new version:

```sh
node scripts/ceulen-sync.mjs report --version <new>
node scripts/ceulen-sync.mjs apply-vendor
node scripts/ceulen-sync.mjs parity
npm run check
node scripts/ceulen-sync.mjs bump --version <new>
```

`apply-vendor` upgrades only the files whose local hash still matches the lock.
Files marked `patched` are never overwritten; they become a manual-merge
report. Nothing from upstream is executed.

## Where large tool results go

DSH cuts a tool result that is too large for the prompt and stores the full
text in a file named in the result (`spill-local`). Its default place is a
fresh directory under the OS temp directory. In the workspace-write sandbox
the shell gets a private, empty `/tmp`, so `bash` cannot open that file: the
`read` and `grep` tools still can, but a model that reaches for `grep -o` or
`sed` on a one-line JSON result is told the file does not exist.

The bundle therefore sets the spill root to `$DSH_HOME/spill`, which every
sandbox mode can read, and removes files older than seven days at startup.
For the stock behaviour, add this to your profile's `cordis.patch.yml`:

```yaml
- id: spill-local
  config: {}
```

## Development

```sh
npm ci --include=dev
npm run build
node scripts/check-bundle.mjs
node scripts/check-pack.mjs
node scripts/ceulen-sync.mjs parity --check
```

CI runs the lint, build, strict typecheck, bundle, pack and parity checks on
Node 22.19 and 24. The Vitest suite is kept out of the public repository and
runs from the full development checkout.

`./scripts/dev-profile.sh` creates a workspace-local `DSH_HOME` and prints the
composed profile without touching `~/.dsh`.

Two checks run by hand, because they need the network or a model:

```sh
node scripts/smoke-install.mjs <version>   # after a publish: install it and check the payload
node scripts/steer-fixtures.mjs            # after a steering change: six cold tasks on the model
```

`smoke-install` installs the published package into a throwaway directory and
fails unless the version, the required files and the skill packs are there and
nothing private is (`docs/`, `test/`, `src/`, the personal agent-mode plugin,
a path under your home directory). `--tarball <file>` checks a local tarball
the same way before the publish.

`steer-fixtures` runs six one-shot tasks with steering on, off and unloaded,
each under its own `DSH_HOME`, and exits non-zero when steering on scores below
the best loadout without it. It spends about 18 short model calls.

`npm run bench:search -- --max 8` compares Brave with DeepSeek's own search on
the same queries. Brave needs `BRAVE_API_KEY`; the DeepSeek side needs
`DEEPSEEK_API_KEY` or a signed-in account.

## Special thanks

Special thanks to my big brother, [Ceulen](https://github.com/ceulen-dev/ceulen).
ceulen-dsh follows its design, and the logic vendored from it (MIT) is the base
this port is built on.

## License

MIT. Ported Ceulen files keep their MIT headers; see [NOTICE](NOTICE).
