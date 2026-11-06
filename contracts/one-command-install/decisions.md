# Decisions — one-command install

## 2026-10-28 — tarball in `release/`, not npm publish

Evidence: `npm view ceulen-dsh` → 404 (unpublished); `git remote -v` → no remote,
so there is no GitHub release host yet. `npm pack` yields 310 files / 450 kB /
zero runtime deps (`src` imports only `node:*`), and a clean-room
`dsh plugin --profile tui add file:<tarball>` composed 27 rows. Therefore the
tarball is the artifact and the single command is `dsh plugin ... add <spec>`
(`file:` today, `https:` when a host exists). Publishing to npm was rejected for
now: it needs an account/token and a prerelease tag decision
(`0.23.0-dsh.5` would not answer `latest`).

## 2026-10-28 — `--with-tui` instead of a separate TUI install step

Evidence: DSH ships templates only for `web`, `headless`, `acp`, `sdk-minimal`;
`tui` is not a shipped template. A fresh profile created by
`dsh plugin --profile tui add ceulen-dsh` contains `@deepseek-ai/dsh-base` +
`ceulen-dsh` and no TUI app. pnpm accepts several specs in one `add`, and the
plugin manager registers every added bundle (verified: both appeared in
`dsh.profile.bundles`). So `--with-tui` prepends
`@deepseek-harness-tui/dsh-tui@0.17.0` to the same command.

## 2026-10-28 — rejected: `curl | sh` bootstrap

The tarball already installs with one `dsh plugin` command; a bootstrap script
would add a hosting requirement, a second trust step, and nothing the installer
does not already do. Revisit only when a public URL exists and version discovery
matters.

## 2026-10-28 — rejected for now: GitHub release workflow

No remote is configured, so `.github/workflows/release.yml` would be dead code.
Add it when the repo has a remote; the job is `npm ci`, `npm run build`,
`npm pack`, upload asset + `SHA256SUMS`.

## 2026-10-28 — bundle update channel: npm, notice at session start

User chose the npm registry as the version source (the package name is free).
Implementation: `checkBundleUpdate()` in `core/upstream.ts` fetches
`registry.npmjs.org/ceulen-dsh/latest`, cached 24 h under
`$DSH_HOME/cache/ceulen/bundle.json`, gated by `settings.upstream.enabled` and
`intervalHours`, fail-open (a cache hit survives a failed check). The status line
composes `bundle <version> available` next to the existing upstream line;
`/ceulen update` reports both; `/ceulen upgrade` prints the install + restart
pair. `package.json` declares `publishConfig { access: public, tag: latest }` so
the prerelease version resolves for `add ceulen-dsh` (verified with
`npm publish --dry-run`).

`/ceulen upgrade` prints rather than executes: pnpm would rewrite the profile's
`node_modules` while this process is executing from it, so the restart is
mandatory and on Windows the in-place replace would fail. Print-only is the
honest surface.

Blocking: `npm whoami` returns 401 with the token in `~/.npmrc`, so the publish
itself is pending `npm login` + `npm publish`. Until then the check fails open
and logs one line per refresh.

Also fixed: `test/plan.test.ts` compared two `Date.now()` stamps for equality and
flaked across a millisecond boundary; it now matches the filename shape.

## Open gaps (not contract changes)

- `package.json` `files` lists root `themes` (only `lib/themes` exists) — harmless,
  npm skips missing entries; tidy when touching packaging.
- Patch scripts default to `$HOME/.dsh/...` and ignore `DSH_HOME`; installers
  should pass `--tui <dir>` when `DSH_HOME` is non-default.
- `engines.dsh` is informational: pnpm does not enforce it, so the install doc
  pins the version instead. Registry `latest` and `engines.dsh` are now both
  `0.2.1-rc.5` (checked 2026-11-04).

## 2026-11-04 — version pins have one home, in `package.json`

The release docs had drifted: `release/install.sh` and `release/README.md` pinned
`dsh@0.2.1-rc.3` / `dsh-tui@0.17.0` while the working profile ran `dsh-tui
^0.18.0`, `engines.dsh` said `0.2.1-rc.5`, and npm `latest` is `0.2.1-rc.5`
(`npm view @deepseek-ai/dsh version`). The installer now reads both pins from
`package.json` (`engines.dsh` plus the new top-level `dshTui`), and
`scripts/check-bundle.mjs` fails when README.md, release/README.md or
`install.sh` disagree with it. `release/build.sh` prints the derived pair before
packing, so a stale pin shows up in the build log as well.

Same change closes the doc-count drift: rows (31), skill packs (19, of which 15
come from upstream Ceulen), themes (104), the upstream version and the bundle
version are checked against the repo instead of being retyped. The earlier
"18 Ceulen skills" figure was wrong twice over: upstream 0.23.0 ships 15 skill
packs and this repo adds 4 local ones.
