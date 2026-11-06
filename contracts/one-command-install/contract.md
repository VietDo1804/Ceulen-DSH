# Contract: one-command install bundle

Date: 2026-10-28 · Coordinator: main agent · Status: committed (v1)

## 1. Goal

A user who has DSH (`0.2.1-rc.5`) and Node `>=22.19` installs `ceulen-dsh` into a
DSH profile with one command, from a self-contained tarball — no git checkout, no
`npm install`, no build step. The bundle composes on the next profile restart.

## 2. Parties

| Party (role) | Owns (write) | Reads | Notes |
|---|---|---|---|
| coordinator | `release/**`, `contracts/one-command-install/**`, `package.json` `files` | src, scripts, profile state | single party — no parallel spawn |

One party, so there is no disjoint-scope problem; this contract is the review
artifact, not a coordination harness.

## 3. Shared artifacts

| Artifact | Path | Producer | Consumers | Conventions |
|---|---|---|---|---|
| Tarball | `release/ceulen-dsh-<version>.tgz` | `release/build.sh` (`npm pack`) | installers | must contain `lib/`, `skills/`, `scripts/`, `cordis.patch.yml`, `parity.json`, LICENSE/NOTICE; zero runtime deps |
| Checksums | `release/SHA256SUMS` | `release/build.sh` | users | out-of-band verification, `sha256sum -c` |
| Installer | `release/install.sh` | coordinator | users | writes only through `dsh plugin`; `--dry-run` touches nothing |
| Install doc | `release/README.md` | coordinator | users | one command first, verification second, uninstall last |

## 4. Rules

1. The tarball is built from a clean `npm run build`; `lib/` is gitignored, so a
   git URL is **not** a supported install spec on its own.
2. No runtime `dependencies` — every import is `node:*`. A new runtime dep is a
   contract change (it would make the one command network-bound beyond npm's
   registry and break offline tarball installs).
3. `install.sh` never writes outside `$DSH_HOME` directly; profile mutation is
   `dsh plugin --profile <name> add <spec>` only.
4. Version gates are hard: Node `>=22.19`, DSH `0.2.1-rc.5`, optional TUI
   `@deepseek-harness-tui/dsh-tui@0.18.0`. Both pins live in `package.json`
   (`engines.dsh`, `dshTui`); `install.sh` reads them from there.
5. Contract changes go through `decisions.md`; findings that contradict this
   contract stop the affected part.

## 5. Done criteria

- coordinator: `release/build.sh` produces a tarball + `SHA256SUMS` from a clean build.
- coordinator: clean-room `DSH_HOME=$(mktemp -d) release/install.sh --profile tui --with-tui`
  exits 0 and `dsh --profile tui --dump-config` composes 27 `ceulen-dsh/modules/*`
  rows plus the TUI app row.
- coordinator: `release/install.sh --dry-run` prints the exact `dsh plugin` command
  and changes nothing.
- coordinator: `release/README.md` installs, verifies, upgrades, and uninstalls
  without referencing this machine's absolute paths.

## 6. Integration check

The clean-room run in §5 (fresh `DSH_HOME`, tarball only, no workspace), plus
`node -e "import('<profile>/node_modules/ceulen-dsh/lib/index.js')"` importing
cleanly outside the repo. TUI boot is not headless-testable; `--dump-config` is
the composed-tree proxy and the user's first `/ceulen` is the live confirmation.
