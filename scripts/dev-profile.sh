#!/usr/bin/env bash
# Build a workspace-local DSH home, link this bundle into a test profile, and
# dump the composed configuration. Never touches ~/.dsh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_HOME="${DEV_HOME:-$ROOT/.devhome}"
PROFILE="${DSH_DEV_PROFILE:-ceulen-dev}"
WITH_TUI="${1:-}"

if [[ ! -f "$ROOT/lib/index.js" ]]; then
  (cd "$ROOT" && npm run build)
fi

PROFILE_DIR="$DEV_HOME/profiles/$PROFILE"
mkdir -p "$PROFILE_DIR/node_modules"

BUNDLES='"@deepseek-ai/dsh-base", "ceulen-dsh"'
if [[ "$WITH_TUI" == "--tui" ]]; then
  BUNDLES='"@deepseek-ai/dsh-base", "@deepseek-harness-tui/dsh-tui", "ceulen-dsh"'
  TUI_SRC="${DSH_TUI_PACKAGE:-$HOME/.dsh/profiles/tui/node_modules/@deepseek-harness-tui/dsh-tui}"
  if [[ ! -d "$TUI_SRC" ]]; then
    echo "dev-profile: TUI package not found at $TUI_SRC" >&2
    exit 1
  fi
  mkdir -p "$PROFILE_DIR/node_modules/@deepseek-harness-tui"
  ln -sfn "$TUI_SRC" "$PROFILE_DIR/node_modules/@deepseek-harness-tui/dsh-tui"
fi

cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": { "ceulen-dsh": "link:$ROOT" },
  "dsh": { "profile": { "bundles": [$BUNDLES] } }
}
EOF

ln -sfn "$ROOT" "$PROFILE_DIR/node_modules/ceulen-dsh"
[[ -f "$PROFILE_DIR/cordis.yml" ]] || printf '[]\n' > "$PROFILE_DIR/cordis.yml"

DSH_HOME="$DEV_HOME" dsh --profile "$PROFILE" --dump-config > "$DEV_HOME/dump.yml"
echo "dev-profile: composed $PROFILE -> $DEV_HOME/dump.yml"
grep -n -A12 'ceulen-dsh' "$DEV_HOME/dump.yml" | head -40
