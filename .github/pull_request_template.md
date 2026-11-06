## What changed

<!-- One paragraph. Link the plan item (e.g. plan 0.4) when there is one. -->

## Checks

- [ ] `npm run check` is green (lint, build, strict and test typecheck, tests + coverage floor, bundle, pack, parity)
- [ ] `node scripts/ceulen-sync.mjs parity --check` is green (vendored hashes included)
- [ ] Vendored files under `src/vendor/**` are untouched, or the change is `mode: patched`
      with a line in `docs/upstream-sync.md`
- [ ] Behaviour change: ran the relevant checklist in `docs/live-verification.md`
- [ ] Docs updated when a user-visible surface changed (`README.md`, `docs/parity.md` via `npm run parity`)

## Notes for the reviewer

<!-- Known limits, follow-ups, things you deliberately did not do. -->
