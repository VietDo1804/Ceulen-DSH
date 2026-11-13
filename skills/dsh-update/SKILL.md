---
name: dsh-update
description: Check and update DeepSeek Harness end to end — the global dsh core, each profile's dsh-tui, and the ceulen-dsh bundle — while keeping the exact engines/peer gates satisfied. Use when the user says "update dsh", "check dsh version", "keep dsh on latest", "is dsh current", "new dsh release", or asks to upgrade core, TUI, or the Ceulen bundle.
---

# DSH update

## Invocation contract

`/dsh-update` means execute the complete update and verification below, not
just print instructions. Discover current versions every time; historical
versions and memory are leads, not targets. Proceed with compatible updates,
minimal compatibility fixes, tests and independent review without routine
confirmation, within the session's approval policy. Do not promise zero bugs:
report exactly what passed and what still needs a restart or live credentials.
Do not reinstall layers already current or switch release channels implicitly.

DSH is three independently versioned layers. Updating one without the others
either gets refused at startup or leaves the profile on stale code.

| Layer | Installed where | Version source |
|---|---|---|
| `@deepseek-ai/dsh` (core + base/app bundles) | global npm (`nvm` prefix) | `dsh -V` |
| `@deepseek-harness-tui/dsh-tui` | per profile: `$DSH_HOME/profiles/<p>/node_modules/...` | profile `package.json` dep + installed `package.json` |
| `ceulen-dsh` | profile dependency: `link:<checkout>` in dev, `ceulen-dsh` from npm for a release install | `package.json` version; `/ceulen upgrade` compares it with npm `latest` |

`$DSH_HOME` defaults to `~/.dsh`. Profiles (`tui`, `web`, `acp`, …) share the
global core but pin their own TUI/plugin versions.

## 1. Check before changing anything (read-only)

Resolve the actual checkout and `${DSH_HOME:-$HOME/.dsh}` first. Inventory every
existing profile's dependencies, installed TUI version and Ceulen source
(`link:`, tarball, npm); do not assume only `tui` is used. Inspect git status
and the existing diff, record rollback versions, and preserve unrelated edits,
settings, credentials and sessions. Capture each used profile's config output
and exit code before updating, so existing warnings have a baseline.
Use the resolved home/profile in the examples below rather than hardcoded
`~/.dsh` if overridden. Search project memory for prior compatibility fixes.

```sh
dsh -V
node -p "require(process.env.HOME+'/.dsh/profiles/tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json').version"
node -p "require('./package.json').engines.dsh"

npm view @deepseek-ai/dsh dist-tags --json
npm view @deepseek-harness-tui/dsh-tui dist-tags --json
npm view ceulen-dsh dist-tags --json
npm view @deepseek-harness-tui/dsh-tui@<target-tui> peerDependencies.@deepseek-ai/dsh-agent
```

Report the three installed versions, the published `latest` (and `next`), and
whether the TUI peer range contains the target core. Do not change a package
before this report.

## 2. Decide

- Pick the channel from what is installed. Installed == `latest` → track
  `latest`. Installed is the `next` prerelease → track `next`, the channel this
  machine already opted into; that way "keep me current" moves rc.3 → rc.4
  instead of stalling on a stale `latest`. Switch channels only on explicit
  request, and never downgrade silently.
- A TUI release must list the target core in
  `peerDependencies.@deepseek-ai/dsh-agent`. Resolve a compatible core/TUI pair
  before mutation and update both in the same pass when needed. If no published
  TUI supports the proposed core, keep the current working pair and report the
  deferred core update; do not silently leave an unsupported TUI installed.
- `ceulen-dsh` must declare **exactly** the target core in `engines.dsh`
  (see gotchas). This is the gate that blocks startup after a core bump.
- For an npm-installed bundle the update is the same verb as the install:
  `dsh plugin --profile tui add ceulen-dsh@<version>`, then restart. For a
  `link:` checkout, fetch and fast-forward only if the tree is clean and the
  branch has a valid upstream; otherwise preserve the working tree and build
  locally, reporting the skipped pull. Never reset, stash or merge over local
  work automatically. `/ceulen upgrade`
  prints whichever command is right for the newer npm release; the session-start
  status line says `bundle <version> available` when one exists.
- npm `ceulen-dsh` may return E404 (verified 2026-11-13). That is not an
  installation failure for a linked checkout: keep and validate the local
  bundle. Do not replace it with a guessed package or version.

## 3. Update the core

```sh
npm i -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  @deepseek-ai/dsh@<version>
dsh -V
```

Plain `npm i -g` is wrong here: npm 12 blocks install-time scripts, and
`node-pty`/`koffi` need theirs or the TUI terminal breaks. Watch for
`Ignored build scripts` in the output. No sudo under nvm. Profiles, settings,
credentials, and sessions survive a core update.

If a bundle is now denied, the startup error names it — fix `engines.dsh`
(next step), do not use `dsh plugin allow-version` except as a stopgap.

## 4. Update the TUI and its patches

```sh
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@^<minor>
node -p "require(process.env.HOME+'/.dsh/profiles/tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json').version"

# ALL SIX patches: each edits a file inside the installed dsh-tui package, so
# an add/remove/reinstall wipes every one of them.
for p in advisor context toolname plan effort style; do node scripts/tui-$p-patch.mjs apply || exit 1; done
for p in advisor context toolname plan effort style; do node scripts/tui-$p-patch.mjs check || exit 1; done
```

Repeat for every profile with an installed TUI, passing `--tui <resolved-dir>`
to every patch script. Finish all profile package changes before applying
patches: another add/remove can rewrite the dependency tree again.

If a patch refuses a new version or moved anchor, inspect its source, callers,
tests and installed upstream files. Adapt the smallest compatible change;
never bypass a gate blindly or broaden it to untested future versions. Keep
anchor uniqueness and all-or-nothing writes. A version-only gate extension is
valid only after confirming unchanged anchors and passing patch tests.
For example, 0.20.0 required extending the style patch's exact 0.19.0 gate;
the other five patches already worked. Test check/apply/idempotence/revert,
byte-identical restoration, all-six coexistence, changed-JS syntax and refusal
without writes. Negative fixtures must assign an unsupported JSON version,
not replace a literal old version that becomes a no-op after an upgrade.

- `dsh plugin update` respects the profile's existing `^range` and will not
  cross a minor. `add` with the new spec is what moves it.
- Six patches ride the installed dsh-tui tree, and a missed one breaks silently:
  `advisor` (reviewer notes in the transcript), `context` (`/context` opens the
  dashboard instead of the loaded-context text dump), `toolname` (grep tool
  renders as `fff`, not `Fff_grep`), `plan` (bare `/plan` toggles and the footer
  names plan mode), `effort` (per-model reasoning effort). `apply` fails loudly when an anchor moves; `check` exits 1
  when not applied.
- `style` adds live `/theme style dsh|pi|omp` layout selection without changing
  the color theme; `ui-style.json` shares the effort preference directory.
- dsh-tui 0.19.0 dropped the context patch with no warning (2026-11-06):
  `/context` still answered, it just dumped the stock report again. That is why
  the loop now covers all six, not the two this section used to list.
- `/ceulen doctor` prints all six states (`advisor-block`, `context-redirect`,
  `tool-names`, `plan-mode`, `effort-per-model`, `ui-style`); a `stock (…)` segment names the script to run.
- The usage footer needs no patch on **dsh-tui >= 0.17.0** (native
  `tuiStatus.setField`). The 0.16.1 footer patch was deleted (plan 5.5), and the
  usage module prefers `setField`.
- Re-apply all six after every `dsh plugin add/remove`/`update` — pnpm rewrites
  the package tree and the patch files live inside it.

## 5. Sync ceulen-dsh

```sh
# package.json + package-lock.json: "engines": { "dsh": "<new core>" }
# package.json dshTui: installed target TUI
# Sync README requirements AND installation examples, release/README.md,
# and docs/live-verification.md's dated header/evidence if that file exists.
npm run check
# Save full config output to a workspace log, preserving the real exit code.
dsh --profile tui --dump-config
```

Finish edits before starting the final check; an in-flight Vitest run can
retain the old fixture. On failure, inspect and fix the cause, then rerun
against the settled files. Do not count stale test output as current evidence.
`npm run check` must pass all its gates (lint, build, strict/test typechecks,
coverage tests, bundle, pack and parity), not just a focused patch test.
Keep logs/artifacts in the session workspace, collect all background jobs,
and inspect every exit code. Do not declare success if a required gate fails.

`--dump-config` must compose without new errors. `patch: entry "tool-ralph" not
found` and `tool-subagent-list-agents` are known upstream warnings; compare
against the captured baseline rather than suppressing new warnings. If a row the profile
patch targets disappears upstream, fix `cordis.patch.yml` here instead of
leaving a silent no-op.

If the TUI's footer seam changed (native field vs patch), update the
`usage` module's `statusService`/`setStatus`, `tuiFooterState()` in the status
module, the tests, and the README/parity rows together.

Verify native imports of `node-pty` and `koffi` resolved from the **global core
package**, not from this checkout or the profile TUI (they may not be hoisted
there). Smoke-test config composition for every used Ceulen profile, plus
`dsh --profile web --help` when web is installed. Inspect the actual web rows;
do not assume a trimmed or full bundle. Missing/unused profiles need no setup.
Run one read-only independent review of the compatibility delta, distinguishing
pre-existing user edits; fix blockers and rerun affected checks before reporting.

## 6. Restart and verify

```sh
pgrep -af 'dsh tui'
```

A running TUI keeps the old modules in memory and holds the session; a stale
one can make new runs hang. The agent cannot restart the TUI it is running in.

An optional isolated PTY smoke may confirm the new TUI renders and exits
without a runtime exception. Track and stop only the probe you started. Do not
use `dsh --profile tui --help` as a help check: on 0.20.0 it starts the app and
can hang. Immediate Ctrl+C before startup proves nothing; require rendered
version/prompt evidence. Typed slash-command text is not proof of execution:
doctor must return diagnostics, context must return the dashboard. Do not
reuse the user's active session concurrently or spend subscription calls
without need. If live checks cannot run safely, leave them explicitly pending.

Tell the user to exit (Ctrl+C twice) and resume:

```sh
dsh tui --resume "$DSH_SESSION_ID"
```

Other profiles: restart `dsh web` (it prints a fresh token per start) and any
ACP/headless workers. Do not kill unrelated processes or the active agent's
TUI; report required restarts. Respect disabled approval prompts.

Verify after restart:

- `/ceulen doctor` → `tui footer: tui:<version> footer-native` (or
  `footer-applied` on 0.16.x) and all six patches `applied`; a `stock (…)`
  segment means that patch is missing — run its script and restart again.
- `/context` renders the colour dashboard (that is `context-redirect applied`
  proving itself).
- One turn on a subscription route → the usage segment appears in the footer.
- `dsh --profile web --help` exits 0; `dsh --profile acp --dump-config` still
  composes if that profile is used.

## Rollback

Keep the previous versions in the report. To return:

```sh
npm i -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  @deepseek-ai/dsh@<old-core>
# restore engines.dsh + README pins, then:
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@<exact-old-tui>
for p in advisor context toolname plan effort style; do node scripts/tui-$p-patch.mjs apply || exit 1; done
for p in advisor context toolname plan effort style; do node scripts/tui-$p-patch.mjs check || exit 1; done
```

Restore only update-owned compatibility hunks (including `dshTui` and release
docs), not the whole mixed working tree. Rebuild and recheck used profiles.
Preserve rollback support in adapted patch scripts where verified possible.

## Gotchas

- **Exact engines gate**: `engines.dsh` is an exact version, not a range. A
  mismatch denies the plugin at startup ("profile startup denies it until you
  grant an exemption"). Bump the bundle; `dsh plugin allow-version` is only a
  temporary escape hatch.
- **`--allow-scripts` list**: if a new core adds a native dependency, npm prints
  `Ignored build scripts`; add that package to the list and reinstall.
- **`--from-default-profile` resets the profile** to the shipped template and
  drops `ceulen-dsh` plus the custom patch. Never use it to "refresh".
- **Profiles differ**: discover mounted rows from each actual profile; web may
  mount a trimmed or full bundle. Run checks for the rows actually mounted.
- **Version drift is expected**: prereleases move fast; pin the exact version
  you installed in the report so the next run can roll back.

## Report

End with a compact before/after table (core, TUI, engines, tests), what was
skipped and why, independent review verdict, the restart command with the
actual session id when available, and exact rollback versions. Separate
automated checks passed from post-restart live checks pending. Store only new
verified durable compatibility lessons in project memory. A single
`/dsh-update` should complete everything safely executable in-session and
leave only concrete restart/live-check actions, not a generic update checklist.
