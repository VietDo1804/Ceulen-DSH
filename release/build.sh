#!/usr/bin/env bash
# Build the installable tarball + checksums into release/.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# Single source for both pins: package.json (engines.dsh and dshTui).
node -e 'const p = require("./package.json"); console.log(`pins: dsh ${p.engines.dsh} · dsh-tui ${p.dshTui}`)'

npm run build
node scripts/check-bundle.mjs
npm pack --pack-destination release
node scripts/check-pack.mjs
(cd release && sha256sum ceulen-dsh-*.tgz > SHA256SUMS)
ls -lh release/ceulen-dsh-*.tgz release/SHA256SUMS
