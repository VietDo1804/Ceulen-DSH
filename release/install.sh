#!/usr/bin/env bash
# Install ceulen-dsh into a DSH profile from the tarball beside this script.
# Writes only through `dsh plugin` (i.e. into $DSH_HOME/profiles/<name>).
set -euo pipefail

profile=tui
with_tui=0
tarball=
dry_run=0
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Version pins live in package.json (`engines.dsh` and `dshTui`), never here.
# In the repo that is release/../package.json; a shipped release folder reads the
# package.json inside the tarball instead, so one artifact still pins itself.
repo_package=$script_dir/../package.json
dsh_pin=${dsh_pin:-}
tui_pin=${tui_pin:-}

usage() {
  cat <<EOF
usage: ./install.sh [--profile <name>] [--with-tui] [--tarball <path|url>] [--dry-run]

  --profile <name>   DSH profile to install into (default: tui)
  --with-tui         also add @deepseek-harness-tui/dsh-tui at the version pinned
                     in package.json (dshTui) when the profile has no TUI app
                     yet (safe to repeat)
  --tarball <spec>   local .tgz path or https URL (default: newest *.tgz here)
  --dry-run          print the command and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) profile=${2:?--profile needs a value}; shift 2 ;;
    --with-tui) with_tui=1; shift ;;
    --tarball) tarball=${2:?--tarball needs a value}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "install.sh: node not found (Node >=22.19 required)" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' || {
  echo "install.sh: Node >=22.19 required (found $(node -v))" >&2
  exit 1
}

read_pins='const read = t => { const p = JSON.parse(t); if (!p.engines?.dsh || !p.dshTui) { console.error("install.sh: package.json lacks engines.dsh or dshTui"); process.exit(1) } process.stdout.write(`${p.engines.dsh} ${p.dshTui}`) }; read(process.argv[1] === "-" ? require("node:fs").readFileSync(0, "utf8") : require("node:fs").readFileSync(process.argv[1], "utf8"))'

if [[ -z $tarball ]]; then
  # Newest first: `find -print -quit` is directory order, not modification time.
  tarball=$(ls -t "$script_dir"/ceulen-dsh-*.tgz 2>/dev/null | head -1)
  [[ -n $tarball ]] || { echo "install.sh: no ceulen-dsh-*.tgz in $script_dir (see release/build.sh)" >&2; exit 1; }
fi

# A shipped release folder can sit inside any project, so a neighbouring
# package.json only counts when it is this repo's.
is_repo_package='process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name === "ceulen-dsh" ? 0 : 1)'
if [[ -f $repo_package ]] && node -e "$is_repo_package" "$repo_package" 2>/dev/null; then
  pins=$(node -e "$read_pins" "$repo_package") || exit 1
else
  case "$tarball" in
    http://*|https://*) pins= ;;
    *)
      pins=$(tar -xzOf "$tarball" package/package.json 2>/dev/null | node -e "$read_pins" -) || {
        echo "install.sh: cannot read package/package.json from $tarball" >&2
        exit 1
      }
      ;;
  esac
fi
if ((with_tui)) && [[ -z $pins ]]; then
  echo "install.sh: --with-tui needs a local tarball (or a repo checkout) to read the dsh-tui pin from" >&2
  exit 1
fi
[[ -z $pins ]] || read -r dsh_pin tui_pin <<<"$pins"

case "$tarball" in
  http://*|https://*) spec=$tarball ;;
  file:*) spec=$tarball ;;
  *) spec="file:$(cd -- "$(dirname -- "$tarball")" && pwd)/$(basename -- "$tarball")" ;;
esac

command -v dsh >/dev/null 2>&1 || {
  echo "install.sh: dsh not found — install it with:" >&2
  echo "  npm install -g @deepseek-ai/dsh${dsh_pin:+@$dsh_pin}" >&2
  exit 1
}

specs=()
((with_tui)) && specs+=("@deepseek-harness-tui/dsh-tui@$tui_pin")
specs+=("$spec")

cmd=(dsh plugin --profile "$profile" add "${specs[@]}")
if ((dry_run)); then
  printf '%q ' "${cmd[@]}"; echo
  exit 0
fi

"${cmd[@]}"

dsh_home=${DSH_HOME:-$HOME/.dsh}
cat <<EOF

Installed into profile '$profile'. Restart it (plugin code does not hot-reload):
  dsh --profile $profile

Then, inside the session:
  /ceulen          bundle version and module status
  /ceulen-config   full-screen settings panel

Optional dsh-tui transcript row for reviewer notes (re-apply after every dsh-tui
upgrade; skip if you do not use the advisor):
  node "$dsh_home/profiles/$profile/node_modules/ceulen-dsh/scripts/tui-advisor-patch.mjs" apply
EOF
