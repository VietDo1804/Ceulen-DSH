# Security policy

## Supported versions

Only the latest published line is supported. `package.json` carries the bundle
version and `upstream.lock.json` the pinned Ceulen version; a report against an
older tarball is answered by asking you to reproduce on the current one.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Send a private report
to the maintainer of this checkout (or, once the repo has a remote, use the
host's private security advisory flow). Include:

- the bundle version (`/ceulen` prints it) and how it was installed (`link:`, a
  tarball, or npm);
- the DSH and dsh-tui versions (`/ceulen doctor` prints both);
- a minimal reproduction, and which boundary you believe is crossed.

Expect an acknowledgement within a week. Fixes for vendored files
(`src/vendor/**`) go upstream first per the policy in
`docs/improvement-plan.md`; a local patch is recorded in `vendor.manifest.json`
with `mode: patched` and a line in `docs/upstream-sync.md`.

## Boundaries this bundle treats as security-relevant

- `src/core/credentials.ts` reads `$DSH_HOME/.credentials.yaml`; values never
  reach logs or command output (see `test/credentials.test.ts`).
- `src/modules/web/url-guard.ts` refuses non-public URLs on every fetch hop,
  including hostnames that resolve to a private address.
- The browser capture tools keep `file://` inside the workspace. Chrome runs with
  a resolver rule (`CAPTURE_HOST_RULES_ARG` in `src/vendor/ceulen/web/chrome.ts`)
  that blocks cloud metadata, multicast and reserved addresses for every request
  it makes, including redirects, scripts and iframes. Not covered: a hostname
  that resolves to one of those addresses, traffic through a proxy, and loopback
  or LAN addresses, which stay reachable so local dev servers can be audited.
- `src/modules/classifier/index.ts` audits bash calls and, in enforce mode,
  denies irreversible or unparseable commands.
- `src/core/log.ts` redacts token-shaped strings and live secret env values.
- The installer (`release/install.sh`) writes only through `dsh plugin`.
