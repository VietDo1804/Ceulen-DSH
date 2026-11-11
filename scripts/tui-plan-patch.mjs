#!/usr/bin/env node
/**
 * dsh-tui plan-mode polish for the installed profile tree.
 *
 * Target: dsh-tui 0.19.0 (anchors unchanged since 0.18.0). Four behaviors the stock TUI cannot express, each
 * anchored on the exact 0.18.0 source text (a dsh-tui update reverts them
 * silently — re-run `apply` and check `/ceulen doctor`):
 *
 *  1. Bare `/plan` toggles. Stock opens an on/off picker whose cursor sits on
 *     the CURRENT state, so a bare Enter confirmed Off. Now bare `/plan`
 *     enters; `/plan` again leaves. `/plan on|off|message` still passes
 *     through to the registry command.
 *  2. `/plan-approve`'s "Clear context and implement in new session" starts a
 *     real fresh session: the client answers the asker "continue planning" to
 *     settle it, opens `/new`, and seeds the new session with the execution
 *     handoff carried on the question intent. Web/plain clients keep the
 *     compaction fallback in the harness command.
 *  3. The footer names plan mode while it is active. A bare `/plan` (unlike
 *     Shift+Tab) writes no sandbox/approval atoms, so no configured mode
 *     matched and the segment fell back to the base mode. The plan identity is
 *     overlaid on the derived mode; the real sandbox/approval atoms stay for
 *     the safety readout.
 *  4. Esc keeps typed text. On a question (first question, no "back") or on
 *     the plan-review card, Esc used to cancel and drop what the user typed;
 *     the model then heard only "the user cancelled". With text typed, Esc now
 *     submits it like Enter. Empty Esc and Ctrl+C still cancel.
 *
 * Usage: node scripts/tui-plan-patch.mjs [apply|revert|check] [--tui <dir>]
 * Restart the TUI after apply/revert.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHAT = 'lib/types/screens/Chat.js'
const MODE = 'lib/types/dsh-adapter/channel/mode-actions.js'
const PERMISSION_MODE = 'lib/types/dsh-adapter/channel/mode-permission-actions.js'
const PLAN_REVIEW = 'lib/types/components/questions/PlanReviewPanel.js'

const commandEdge = [
  {
    file: CHAT,
    label: 'bare /plan toggles',
    stock: `                if (mounted && parts.length === 0) {
                    setHelpOpen(false);
                    dispatchOverlay({
                        type: 'open',
                        overlay: { kind: 'plan', index: channel.mode.plan === true ? 0 : 1 },
                    });
                    return true;
                }`,
    patched: `                if (mounted && parts.length === 0) {
                    setHelpOpen(false);
                    // ceulen-plan: bare \`/plan\` toggles plan mode. The stock
                    // on/off picker preselected the CURRENT state, so a bare
                    // Enter silently confirmed Off; the registry command stays
                    // the only writer (\`/plan\` = enter, \`/plan off\` = leave).
                    // The invoker builds the line as \`/\${name}\${rawInput}\`, so
                    // the argument carries its own leading space.
                    return runExternalCommand('plan', channel.mode.plan === true ? ' off' : '', images);
                }`,
  },
  {
    file: CHAT,
    label: 'new-session approval option',
    stock: `            if (!questionStore.stillCurrent(questionSnapshot.key))
                return;
            questionStore.answerCurrent(selection);`,
    patched: `            if (!questionStore.stillCurrent(questionSnapshot.key))
                return;
            // ceulen-plan: the approval question's fresh-session choice is the
            // CLIENT's to perform — this surface owns \`/new\`. Answer the asker
            // "continue planning" (settles it quietly; the abandoned session is
            // never seen again), then open a fresh session seeded with the
            // execution handoff the intent carries.
            const approveIntent = questionSnapshot.question.intent;
            if (approveIntent?.kind === 'plan-approve'
                && typeof approveIntent.prompt === 'string'
                && selection.selected?.includes(approveIntent.fresh)) {
                questionStore.answerCurrent({ selected: [approveIntent.stay], custom: '' });
                void channel.newSession().then(ok => {
                    if (ok)
                        channel.submit(approveIntent.prompt);
                });
                return;
            }
            questionStore.answerCurrent(selection);`,
  },
  {
    file: CHAT,
    label: 'Esc keeps a typed answer',
    stock: `            if (live !== null && questionStore.stillCurrent(questionSnapshot.key)) {
                questionStore.cancelCurrent();
            }
        }, onBack: questionSnapshot.canGoBack`,
    patched: `            if (live !== null && questionStore.stillCurrent(questionSnapshot.key)) {
                // ceulen-plan: Esc after typing a custom answer used to cancel
                // the whole ask, so the model only saw "the user cancelled
                // ask_user_question" and the typed text was lost. Typed text
                // is an answer: submit it like Enter. Esc with nothing typed
                // (and Ctrl+C always) still cancels.
                if (typeof draft?.custom === 'string' && draft.custom.trim() !== '') {
                    questionStore.answerCurrent({ selected: draft.selected ?? [], custom: draft.custom.trim() });
                    return;
                }
                questionStore.cancelCurrent();
            }
        }, onBack: questionSnapshot.canGoBack`,
  },
  {
    file: PLAN_REVIEW,
    label: 'Esc keeps typed plan feedback',
    stock: `        if (key.escape || (key.ctrl && input === 'c')) {
            onCancel();
            return;
        }`,
    patched: `        if (key.escape || (key.ctrl && input === 'c')) {
            // ceulen-plan: Esc with feedback typed sends it as keep-planning
            // feedback; dismissing used to drop the text. Empty Esc and
            // Ctrl+C still dismiss.
            if (key.escape && textRef.current.trim() !== '') {
                submitFeedback();
                return;
            }
            onCancel();
            return;
        }`,
  },
  {
    file: MODE,
    label: 'footer plan indicator (base)',
    stock: `    const refreshMode = () => {
        state.modeIndex = deriveModeIndex(snapshotLiveSessionEvents(binding.agent.session));
        state.mode = sessionModes[state.modeIndex];
    };`,
    patched: `    const refreshMode = () => {
        const events = snapshotLiveSessionEvents(binding.agent.session);
        state.modeIndex = deriveModeIndex(events);
        const base = sessionModes[state.modeIndex];
        // ceulen-plan: bare \`/plan\` enters plan mode WITHOUT the cycle's
        // sandbox/approval atoms, so no configured mode matches and the footer
        // fell back to the base mode. Overlay the plan identity for the label
        // and colour; the observed atoms stay so the safety readout is true.
        const sandbox = foldSandboxMode(events);
        const approval = foldApprovalPolicy(events);
        state.mode = foldPlanActive(events) && base?.plan !== true
            ? {
                ...base,
                id: 'plan',
                label: undefined,
                plan: true,
                ...(sandbox === undefined ? {} : { sandbox }),
                ...(approval === undefined ? {} : { approval }),
            }
            : base;
    };`,
  },
  {
    file: PERMISSION_MODE,
    label: 'footer plan indicator (permission-aware)',
    stock: `    const refreshMode = () => {
        roster.rebuild(binding.agent);
        const index = derivePermissionModeIndex(sessionModes, snapshotLiveSessionEvents(binding.agent.session));
        state.modeIndex = index;
        state.mode = sessionModes[index];
    };`,
    patched: `    const refreshMode = () => {
        roster.rebuild(binding.agent);
        const events = snapshotLiveSessionEvents(binding.agent.session);
        const index = derivePermissionModeIndex(sessionModes, events);
        state.modeIndex = index;
        const base = sessionModes[index];
        // ceulen-plan: a bare \`/plan\` writes no sandbox/approval atoms, and a
        // durable permission identity outranks the atom match, so the footer
        // kept naming the permission preset ("Full access") while planning.
        // Overlay the plan identity for the label and colour; the observed
        // atoms stay so the safety readout is true.
        const sandbox = foldSandboxMode(events);
        const approval = foldApprovalPolicy(events);
        state.mode = foldPlanActive(events) && base?.plan !== true
            ? {
                ...base,
                id: 'plan',
                label: undefined,
                plan: true,
                ...(sandbox === undefined ? {} : { sandbox }),
                ...(approval === undefined ? {} : { approval }),
            }
            : base;
    };`,
  },
]

const args = process.argv.slice(2)
const action = args.find(arg => !arg.startsWith('--')) ?? 'check'
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

if (!existsSync(join(root, CHAT))) {
  console.error(`dsh-tui not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

const files = new Map()
const read = file => {
  if (!files.has(file)) files.set(file, readFileSync(join(root, file), 'utf8'))
  return files.get(file)
}
const isApplied = edge => count(read(edge.file), edge.patched) === 1
const isStock = edge => count(read(edge.file), edge.stock) === 1

if (action === 'check') {
  const pending = commandEdge.filter(edge => !isApplied(edge))
  console.log(`dsh-tui ${version} at ${root}: ${pending.length === 0 ? 'plan patch applied' : `plan patch NOT applied (${pending.map(edge => edge.label).join(', ')})`}`)
  process.exit(pending.length === 0 ? 0 : 1)
}

if (action !== 'apply' && action !== 'revert') {
  console.error('usage: node scripts/tui-plan-patch.mjs [apply|revert|check] [--tui <dir>]')
  process.exit(2)
}

if (action === 'apply') {
  const stuck = commandEdge.filter(edge => !isApplied(edge) && !isStock(edge))
  if (stuck.length > 0) {
    console.error(`apply failed: ${stuck.map(edge => `${edge.file} (${edge.label})`).join(', ')} does not match dsh-tui ${version}. Re-check the package version.`)
    process.exit(1)
  }
  let written = 0
  for (const edge of commandEdge) {
    if (isApplied(edge)) continue
    files.set(edge.file, read(edge.file).replace(edge.stock, edge.patched))
    written += 1
  }
  for (const [file, text] of files) writeFileSync(join(root, file), text)
  console.log(written === 0
    ? `dsh-tui ${version}: plan patch already applied.`
    : `applied the plan patch on dsh-tui ${version} (${written} edit${written === 1 ? '' : 's'}). Restart the TUI.`)
  process.exit(0)
}

const missing = commandEdge.filter(edge => !isApplied(edge))
if (missing.length > 0) {
  console.error(`revert failed: ${missing.map(edge => `${edge.file} (${edge.label})`).join(', ')} is not patched for dsh-tui ${version}.`)
  process.exit(1)
}
for (const edge of commandEdge) files.set(edge.file, read(edge.file).replace(edge.patched, edge.stock))
for (const [file, text] of files) writeFileSync(join(root, file), text)
console.log(`reverted the plan patch on dsh-tui ${version}. Restart the TUI.`)
