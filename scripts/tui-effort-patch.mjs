#!/usr/bin/env node
/**
 * Target: dsh-tui 0.19.0.
 *
 * dsh-tui keeps ONE reasoning-effort preference (the /settings `effortDefault`,
 * else `~/.dsh-tui/effort.json`) and re-applies it on every /model switch, so a
 * `max` default puts every model on max. Pi remembers the level per model; this
 * patch does the same:
 *
 *   - `~/.dsh-tui/effort-by-model.json` holds `{ "provider/model": "level" }`.
 *   - `/effort <level>` records the level for the current model only. It no
 *     longer moves the global default (stock rewrote effort.json and the live
 *     preference, so one model's level leaked onto every model without an
 *     entry). The global default is the /settings "default reasoning effort".
 *   - A model switch, a fresh session or a /settings default change applies the
 *     model's own entry first; models with no entry fall back to the global
 *     default. A level the model does not offer still steps down to the nearest
 *     lower one, as stock does.
 *   - A resumed session keeps the level it ran on (stock behaviour, untouched).
 *
 * Usage: node scripts/tui-effort-patch.mjs [apply|revert|check] [--tui <dir>]
 * Re-run `apply` after a dsh-tui update; `check` exits 1 when not applied.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PREFS = 'lib/types/effortPrefs.js'
const ACTIONS = 'lib/types/dsh-adapter/channel/model-actions.js'

const LADDER = `export const STANDARD_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];`
const ROUTE_PREFS = `/** ceulen-effort: per-model reasoning effort (\`effort-by-model.json\`,
 *  \`{ "provider/model": "level" }\`). /effort records the level for the current
 *  route; a model switch applies the route's entry before the global default. */
const ROUTE_EFFORT_FILE = 'effort-by-model.json';
function readRouteEffortMap(dir) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, ROUTE_EFFORT_FILE), 'utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
export function readRouteEffortPref(provider, model, dir = PREFS_DIR) {
    const effort = readRouteEffortMap(dir)[\`\${provider}/\${model}\`];
    return typeof effort === 'string' && effort !== '' ? effort : undefined;
}
export function writeRouteEffortPref(provider, model, effort, dir = PREFS_DIR) {
    try {
        const map = readRouteEffortMap(dir);
        map[\`\${provider}/\${model}\`] = effort;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ROUTE_EFFORT_FILE), JSON.stringify(map, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
${LADDER}`

const IMPORT = `import { nearestLowerEffort, readEffortPref, resolveEffortDefault, writeEffortPref, STANDARD_EFFORT_LADDER } from '../../effortPrefs.js';`
const IMPORT_PATCHED = `import { nearestLowerEffort, readEffortPref, readRouteEffortPref, resolveEffortDefault, writeEffortPref, writeRouteEffortPref, STANDARD_EFFORT_LADDER } from '../../effortPrefs.js';`

// /effort records the level for this route only. Stock also moves the global
// preference (and effort.json), which leaked one model's level onto every model
// with no entry of its own; the global default stays the /settings level.
const RECORD = `        preferredEffort = effort.id;
        state.reasoningEffort = effort.id;
        writeEffortPref(effort.id);`
const RECORD_PATCHED = `        state.reasoningEffort = effort.id;
        writeRouteEffortPref(capture.provider, capture.model, effort.id); // ceulen-effort: per model, global default untouched`

// /model picker preview (listEfforts with a route): stock shows the route's own
// default ("Default"), while Enter applies the per-model entry or the global
// default. Preview the level a switch will actually apply.
const PREVIEW = `                efforts: tiersOf(info.reasoning),
                defaultEffort: typeof info.reasoning === 'object' && info.reasoning !== null ? info.reasoning.defaultEffort : undefined,`
const PREVIEW_PATCHED = `                efforts: tiersOf(info.reasoning),
                defaultEffort: nearestLowerEffort(readRouteEffortPref(route.provider, route.model) ?? preferredEffort ?? '', tiersOf(info.reasoning).map(effort => effort.id)) ?? // ceulen-effort
                    (typeof info.reasoning === 'object' && info.reasoning !== null ? info.reasoning.defaultEffort : undefined),`

// applyPreferredEffort: the block between these anchors reads the global
// preference; the patch reads the route's own entry first.
const BLOCK_START = `        if (preferredEffort === undefined)
            return;`
const BLOCK_END = `        if (applied === preferredEffort)
            lastEffortFallbackNotice = undefined;`
const TARGET_LINE = `        const targetEffort = readRouteEffortPref(capture.provider, capture.model) ?? preferredEffort; // ceulen-effort
`

const args = process.argv.slice(2)
const action = args.find(arg => !arg.startsWith('--')) ?? 'check'
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

if (!existsSync(join(root, ACTIONS)) || !existsSync(join(root, PREFS))) {
  console.error(`dsh-tui not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

const toTarget = block => block.replaceAll('preferredEffort', 'targetEffort')

/** Swap the applyPreferredEffort block; returns undefined when anchors do not match. */
function swapBlock(source, apply) {
  const start = apply ? BLOCK_START : TARGET_LINE + toTarget(BLOCK_START)
  const end = apply ? BLOCK_END : toTarget(BLOCK_END)
  if (count(source, start) !== 1 || count(source, end) !== 1) return undefined
  const from = source.indexOf(start)
  const to = source.indexOf(end) + end.length
  if (to <= from) return undefined
  const block = source.slice(from, to)
  const next = apply
    ? TARGET_LINE + toTarget(block)
    : block.slice(TARGET_LINE.length).replaceAll('targetEffort', 'preferredEffort')
  return source.slice(0, from) + next + source.slice(to)
}

const prefs = readFileSync(join(root, PREFS), 'utf8')
const actions = readFileSync(join(root, ACTIONS), 'utf8')

const applied = count(prefs, ROUTE_PREFS) === 1 &&
  count(actions, IMPORT_PATCHED) === 1 &&
  count(actions, RECORD_PATCHED) === 1 &&
  count(actions, PREVIEW_PATCHED) === 1 &&
  count(actions, TARGET_LINE) === 1

if (action === 'check') {
  console.log(`dsh-tui ${version} at ${root}: ${applied ? 'per-model effort patch applied' : 'per-model effort patch NOT applied'}`)
  process.exit(applied ? 0 : 1)
}

if (action !== 'apply' && action !== 'revert') {
  console.error('usage: node scripts/tui-effort-patch.mjs [apply|revert|check] [--tui <dir>]')
  process.exit(2)
}
if (action === 'apply' && applied) {
  console.log(`per-model effort patch already applied on dsh-tui ${version}.`)
  process.exit(0)
}

const apply = action === 'apply'
const fail = file => {
  console.error(`${action} failed: ${file} does not match dsh-tui ${version}. Re-check the package version.`)
  process.exit(1)
}

const swaps = [
  [prefs, LADDER, ROUTE_PREFS, PREFS],
  [actions, IMPORT, IMPORT_PATCHED, ACTIONS],
  [actions, RECORD, RECORD_PATCHED, ACTIONS],
  [actions, PREVIEW, PREVIEW_PATCHED, ACTIONS],
]
// Validate everything before writing anything, so a mismatch leaves no half patch.
for (const [source, from, to, file] of swaps) {
  if (count(source, apply ? from : to) !== 1) fail(file)
}
let nextActions = actions
for (const [, from, to] of swaps.slice(1)) {
  nextActions = apply ? nextActions.replace(from, to) : nextActions.replace(to, from)
}
nextActions = swapBlock(nextActions, apply)
if (nextActions === undefined) fail(ACTIONS)
const nextPrefs = apply ? prefs.replace(LADDER, ROUTE_PREFS) : prefs.replace(ROUTE_PREFS, LADDER)

writeFileSync(join(root, PREFS), nextPrefs)
writeFileSync(join(root, ACTIONS), nextActions)
console.log(`${apply ? 'applied' : 'reverted'} the per-model effort patch on dsh-tui ${version}. Restart the TUI.`)
