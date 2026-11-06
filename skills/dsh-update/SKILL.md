---
name: dsh-update
description: Check and update DeepSeek Harness end to end — the global dsh core, each profile's dsh-tui, and the ceulen-dsh bundle — while keeping the exact engines/peer gates satisfied. Use when the user says "update dsh", "check dsh version", "keep dsh on latest", "is dsh current", "new dsh release", or asks to upgrade core, TUI, or the Ceulen bundle.
---

# DSH update

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
  `peerDependencies.@deepseek-ai/dsh-agent`; otherwise update core and TUI in
  the same pass and say so.
- `ceulen-dsh` must declare **exactly** the target core in `engines.dsh`
  (see gotchas). This is the gate that blocks startup after a core bump.
- For an npm-installed bundle the update is the same verb as the install:
  `dsh plugin --profile tui add ceulen-dsh@<version>`, then restart. For a
  `link:` checkout, pull, `npm run build`, and reload instead. `/ceulen upgrade`
  prints whichever command is right for the newer npm release; the session-start
  status line says `bundle <version> available` when one exists.
- Skip the TUI and keep the core move if no TUI release supports the new core
  yet; the engine gate only concerns bundles.

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

# ALL FOUR patches: each edits a file inside the installed dsh-tui package, so
# an add/remove/reinstall wipes every one of them.
for p in advisor context toolname plan; do node scripts/tui-$p-patch.mjs apply; done
for p in advisor context toolname plan; do node scripts/tui-$p-patch.mjs check; done
```

- `dsh plugin update` respects the profile's existing `^range` and will not
  cross a minor. `add` with the new spec is what moves it.
- Four patches ride the installed dsh-tui tree, and a missed one breaks silently:
  `advisor` (reviewer notes in the transcript), `context` (`/context` opens the
  dashboard instead of the loaded-context text dump), `toolname` (grep tool
  renders as `fff`, not `Fff_grep`), `plan` (bare `/plan` toggles and the footer
  names plan mode). `apply` fails loudly when an anchor moves; `check` exits 1
  when not applied.
- dsh-tui 0.19.0 dropped the context patch with no warning (2026-11-06):
  `/context` still answered, it just dumped the stock report again. That is why
  the loop covers four, not the two this section used to list.
- `/ceulen doctor` prints all four states (`advisor-block`, `context-redirect`,
  `tool-names`, `plan-mode`); a `stock (…)` segment names the script to run.
- The usage footer needs no patch on **dsh-tui >= 0.17.0** (native
  `tuiStatus.setField`). The 0.16.1 footer patch was deleted (plan 5.5), and the
  usage module prefers `setField`.
- Re-apply all four after every `dsh plugin add/remove`/`update` — pnpm rewrites
  the package tree and the patch files live inside it.

## 5. Sync ceulen-dsh

```sh
# package.json + package-lock.json: "engines": { "dsh": "<new core>" }
# README requirements line: DSH <core> / dsh-tui <tui>
npm run check        # tsc + tests + check-bundle
dsh --profile tui --dump-config 2>&1 | head -3
```

`--dump-config` must compose without new errors. `patch: entry "tool-ralph" not
found` is a known, pre-existing warning from the TUI layer. If a row the profile
patch targets disappears upstream, fix `cordis.patch.yml` here instead of
leaving a silent no-op.

If the TUI's footer seam changed (native field vs patch), update the
`usage` module's `statusService`/`setStatus`, `tuiFooterState()` in the status
module, the tests, and the README/parity rows together.

## 6. Restart and verify

```sh
pgrep -af 'dsh tui'
```

A running TUI keeps the old modules in memory and holds the session; a stale
one can make new runs hang. The agent cannot restart the TUI it is running in.

Tell the user to exit (Ctrl+C twice) and resume:

```sh
dsh tui --resume "$DSH_SESSION_ID"
```

Other profiles: restart `dsh web` (it prints a fresh token per start) and any
ACP/headless workers. Kill other TUI processes only with the user's approval.

Verify after restart:

- `/ceulen doctor` → `tui footer: tui:<version> footer-native` (or
  `footer-applied` on 0.16.x) and all four patches `applied`; a `stock (…)`
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
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@^<old-tui>
for p in advisor context toolname plan; do node scripts/tui-$p-patch.mjs apply; done
```

## Gotchas

- **Exact engines gate**: `engines.dsh` is an exact version, not a range. A
  mismatch denies the plugin at startup ("profile startup denies it until you
  grant an exemption"). Bump the bundle; `dsh plugin allow-version` is only a
  temporary escape hatch.
- **`--allow-scripts` list**: if a new core adds a native dependency, npm prints
  `Ignored build scripts`; add that package to the list and reinstall.
- **`--from-default-profile` resets the profile** to the shipped template and
  drops `ceulen-dsh` plus the custom patch. Never use it to "refresh".
- **Web profile is trimmed**: it mounts only `ceulen-web`, not the full bundle;
  run its patches/tests only where the rows are mounted.
- **Version drift is expected**: prereleases move fast; pin the exact version
  you installed in the report so the next run can roll back.

## Report

End with a compact before/after table (core, TUI, engines, tests), what was
skipped and why, the restart command, and the rollback versions.
