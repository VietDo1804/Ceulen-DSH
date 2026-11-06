# ceulen-dsh — install bundle

A frozen, self-contained build of this checkout for another machine. No clone, no
`npm install`, no build step on the target: `lib/` is already compiled in the
tarball, and the package has **zero runtime dependencies** (every import is
`node:*`).

## One command

Already have this repo on the target? Install straight from the tarball:

```sh
dsh plugin --profile tui add file:/path/to/ceulen-dsh-<version>.tgz
```

Tarball reachable over HTTP(S) (object storage, a release asset, an internal
server)? Same command with the URL:

```sh
dsh plugin --profile tui add https://example.com/ceulen-dsh-<version>.tgz
```

Then restart the profile — plugin code does not hot-reload:

```sh
dsh --profile tui
```

Inside the session: `/ceulen` (bundle version + module status) and
`/ceulen-config` (settings). Both should list the mounted rows.

### Fresh machine

`dsh` ships templates for `web`, `headless`, `acp`, and `sdk-minimal` — **not**
`tui`. A profile named `tui` created by `dsh plugin add` therefore gets the base
harness plus this bundle, but no TUI app. If the target has no TUI yet, use the
wrapper, which adds `@deepseek-harness-tui/dsh-tui@0.18.0` in the same command:

```sh
./install.sh --profile tui --with-tui
```

It refuses to run without `dsh` and Node `>=22.19`, and `--dry-run` prints the
exact `dsh plugin` invocation without touching anything.

## Requirements

| Requirement | Version | Why |
|---|---|---|
| Node.js | `>=22.19` (tested on 24) | `engines`, and dsh-tui's own `^22.19 \|\| >=24` |
| DSH CLI | `0.2.1-rc.5` | `engines.dsh` (single source in `package.json`); pin it: `npm install -g @deepseek-ai/dsh@0.2.1-rc.5` |
| Profile | any; `tui` is the supported one | bundle rows mount into the base composition |

Optional backends stay fail-open — install them only for the features you use:
`gh` (GitHub tools), `sg`/ast-grep (structural search), `rtk` (command rewriting),
Serena (MCP), Chrome/Chromium (screenshot/PDF/interact), a Munin server, a Brave
Search key, an OpenAI-compatible router, A2A peers.

## Verify the download

```sh
cd release && sha256sum -c SHA256SUMS
```

## What is inside

`lib/` (compiled modules + 104 themes + vendored Ceulen files), `skills/`
(19 skill packs), `scripts/` (TUI patches, sync/parity tooling),
`cordis.patch.yml` (31 composed rows), `parity.json`, `docs/`, `README.md`,
LICENSE/NOTICE. `devDependencies` are not needed at runtime and are not
installed. `node scripts/check-pack.mjs` asserts that the tarball holds these.

## Upgrade

```sh
dsh plugin --profile tui add file:/path/to/ceulen-dsh-<next>.tgz
dsh --profile tui
```

pnpm replaces the dependency, the plugin manager keeps the bundle registered,
and the profile keeps your settings (`$DSH_HOME/ceulen/settings.json`).

## Optional TUI patches

Only needed for the reviewer transcript row; they edit the *installed* dsh-tui
copy and are reverted by every dsh-tui upgrade. Re-apply after upgrading:

```sh
node ~/.dsh/profiles/tui/node_modules/ceulen-dsh/scripts/tui-advisor-patch.mjs apply
# --tui <dir> if DSH_HOME is not ~/.dsh (the script ignores DSH_HOME)
```

`/ceulen doctor` reports `tui footer: … · advisor-block applied|stock …`, and each
script's `check` exits non-zero when its patch is missing. The footer patch was
deleted — dsh-tui 0.17.0+ renders plugin footer fields natively. Patches target
dsh-tui 0.18.0; re-apply after every upgrade.

## Uninstall

```sh
dsh plugin --profile tui remove ceulen-dsh
```

Settings and logs stay in `$DSH_HOME/ceulen/`; delete that directory to remove
them too.

## Cutting a new release

```sh
./release/build.sh   # npm run build + check-bundle + npm pack + SHA256SUMS
```

Tarballs are build output and are not committed (`release/.gitignore`); ship the
folder or upload the `.tgz` where the target can reach it.

## Update notice

At session start the bundle checks `https://registry.npmjs.org/ceulen-dsh/latest`
(24 h cache, `upstream.enabled` gates the network call) and adds
`bundle <version> available` to the status line when a newer release exists.
`/ceulen upgrade` prints the exact pair:

```sh
dsh plugin --profile <profile> add ceulen-dsh@<version>
dsh --profile <profile>          # restart — plugin code is not hot-reloaded
```

`/ceulen update` reports both upstream Ceulen and this bundle; `/ceulen status`
shows the npm check result even when it is current.

## Publishing to npm

The package declares `publishConfig { access: public, tag: latest }`, so a
prerelease version becomes the default `latest` and `add ceulen-dsh` resolves it.

```sh
npm login            # this machine's token is currently rejected (401)
cd .. && npm publish # from the repo root, after ./release/build.sh
```

## Publishing options

| Channel | Command for the user | Status |
|---|---|---|
| Local tarball | `dsh plugin add file:…` | works today, verified clean-room |
| HTTPS tarball | `dsh plugin add https://…` | works today, verified against a local HTTP server |
| npm registry | `dsh plugin add ceulen-dsh` | not published yet; `/ceulen upgrade` and the startup check already target it |
| git URL | `dsh plugin add git+https://…` | **not supported**: `lib/` is gitignored and pnpm does not rebuild it on install |
