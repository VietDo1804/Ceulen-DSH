#!/usr/bin/env node
/**
 * dsh-tui plan-mode polish for the installed profile tree.
 *
 * Target: dsh-tui 0.20.2 (anchors unchanged since 0.18.0). Five behaviors the stock TUI cannot express, each
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
 *  5. The plan-review card fits the screen. Stock sized the plan body as the
 *     terminal height minus a fixed twelve rows, so with the goal/todo band
 *     up (any later plan, e.g. an /orchestrator "Plan change") the stack ran
 *     past the screen: "Keep planning", the feedback row and the hint were
 *     cut off, and a short plan left a blank block. The card now measures
 *     its plan and its place on screen after layout and trims the body.
 *     The ask_user_question card had the same fixed budget for its option
 *     list; it measures the same way and windows the list instead.
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
const LAUNCHPAD = 'lib/types/screens/Launchpad.js'
const ASK_QUESTION = 'lib/types/components/questions/AskUserQuestionPanel.js'

/**
 * Shared by both question cards: after layout, how many rows of the card's
 * stack (the card plus what follows it in each enclosing column, such as the
 * usage band) fall outside the screen. Expects `panel` and `terminalRows`;
 * defines `over`.
 */
const FIT_WALK = `        // Absolute top of the card (same walk as useTerminalViewport) plus
        // what follows it in each enclosing column (the usage band).
        let top = 0;
        let below = 0;
        let root = panel.yogaNode;
        for (let node = panel; node; node = node.parentNode) {
            const parent = node.parentNode;
            if (node.yogaNode) {
                top += node.yogaNode.getComputedTop();
                root = node.yogaNode;
                if (parent?.yogaNode && parent.style?.flexDirection === 'column') {
                    const end = node.yogaNode.getComputedTop() + node.yogaNode.getComputedHeight();
                    let last = end;
                    for (const sibling of parent.childNodes.slice(parent.childNodes.indexOf(node) + 1)) {
                        if (!sibling.yogaNode || sibling.style?.position === 'absolute')
                            continue;
                        last = Math.max(last, sibling.yogaNode.getComputedTop() + sibling.yogaNode.getComputedHeight());
                    }
                    below += last - end;
                }
            }
            if (parent?.scrollTop)
                top -= parent.scrollTop;
        }
        const screen = root.getComputedHeight();
        const viewTop = screen > terminalRows ? screen - terminalRows + 1 : 0;
        const bottom = top + panel.yogaNode.getComputedHeight() + below;
        const over = Math.max(0, bottom - (viewTop + terminalRows), viewTop - top);
`

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
    file: PLAN_REVIEW,
    label: 'plan card fit: terminal width',
    stock: '    const { rows: terminalRows } = useTerminalSize();',
    patched: '    const { rows: terminalRows, columns: terminalColumns } = useTerminalSize();',
  },
  {
    file: PLAN_REVIEW,
    label: 'plan card fit: measure',
    stock: `    const detailMax = Math.max(0, terminalRows - reservedRows);
    const detailScrollRef = React.useRef(null);`,
    patched: `    const detailMax = Math.max(0, terminalRows - reservedRows);
    const detailScrollRef = React.useRef(null);
    // ceulen-plan: fit the card to the screen it is given. The twelve rows
    // above are a guess: Chat stacks the goal/todo band, the spinner and
    // plugin status views over the card in the same unshrinkable column, so
    // a second plan (board already up) pushed "Keep planning", the feedback
    // row and the hint off the bottom. And the body kept its whole budget
    // even for a short plan, leaving a blank block. After each layout the
    // card measures its plan (body = content height, at most the budget)
    // and where its stack really ends on screen; any rows past the screen
    // come off the body. The limit only shrinks for a given terminal size,
    // so the measuring settles in a frame or two and cannot oscillate.
    const panelRef = React.useRef(null);
    const detailContentRef = React.useRef(null);
    const [fit, setFit] = React.useState(null);
    const fitNow = fit !== null && fit.rows === terminalRows && fit.columns === terminalColumns && fit.detail === question.detail ? fit : null;
    const detailRows = Math.max(0, Math.min(detailMax, fitNow?.content ?? detailMax, fitNow?.limit ?? detailMax));
    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel?.yogaNode)
            return;
        // The plan's own height: ScrollBox's inner box grows to the
        // viewport, so the markdown sits in a box of its natural height.
        const body = question.detail !== undefined && detailRows > 0 ? detailContentRef.current : null;
        // A body not laid out yet reads 0: keep the last reading, or the
        // card would drop its plan and never measure it again.
        const measured = body?.yogaNode?.getComputedHeight() ?? 0;
        const content = measured > 0 ? measured : fitNow?.content;
${FIT_WALK}        const rendered = body === null ? 0 : detailRows;
        const limit = over > 0 ? Math.min(fitNow?.limit ?? Infinity, Math.max(0, rendered - over)) : fitNow?.limit;
        if (fitNow === null || content !== fitNow.content || limit !== fitNow.limit) {
            setFit({ rows: terminalRows, columns: terminalColumns, detail: question.detail, content, limit });
        }
    });`,
  },
  {
    file: PLAN_REVIEW,
    label: 'plan card fit: body height',
    stock: 'question.detail !== undefined && detailMax > 0 && (_jsx(Box, { flexDirection: "column", marginTop: 1, height: detailMax, flexShrink: 0, children: _jsx(ScrollBox, { ref: detailScrollRef, flexDirection: "column", flexGrow: 1, height: detailMax, children: _jsx(Markdown, { children: question.detail }) }) }))',
    patched: 'question.detail !== undefined && detailRows > 0 && (_jsx(Box, { flexDirection: "column", marginTop: 1, height: detailRows, flexShrink: 0, children: _jsx(ScrollBox, { ref: detailScrollRef, flexDirection: "column", flexGrow: 1, height: detailRows, children: _jsx(Box, { ref: detailContentRef, flexDirection: "column", flexShrink: 0, children: _jsx(Markdown, { children: question.detail }) }) }) }))',
  },
  {
    file: PLAN_REVIEW,
    label: 'plan card fit: panel ref',
    stock: 'return (_jsxs(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Divider, { color: "permission"',
    patched: 'return (_jsxs(Box, { ref: panelRef, flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Divider, { color: "permission"',
  },
  {
    file: ASK_QUESTION,
    label: 'question card fit: measure',
    stock: '    const optionBudget = Math.max(terminalRows - reservedRows, 2);',
    patched: `    // ceulen-plan: fit the question card to the screen it is given. The
    // twelve rows above are a guess: Chat stacks the goal/todo band, the
    // spinner and plugin status views over the card in the same unshrinkable
    // column, so a long option list asked while a board is up pushed the
    // answer row, the key hint and the usage band off the bottom. After each
    // layout the card measures where its stack really ends on screen and
    // takes the rows past it off the option budget (the list then windows).
    // The limit only shrinks for a given terminal size and question, so the
    // measuring settles in a frame or two and cannot oscillate.
    const panelRef = React.useRef(null);
    const [fit, setFit] = React.useState(null);
    const fitNow = fit !== null && fit.rows === terminalRows && fit.columns === terminalColumns && fit.id === question.id && fit.question === question.question ? fit : null;
    const optionBudget = Math.max(Math.min(terminalRows - reservedRows, fitNow?.limit ?? Infinity), 2);
    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel?.yogaNode)
            return;
${FIT_WALK}        const rendered = windowedOptions ? optionBudget : wrappedOptionRows;
        const limit = over > 0 ? Math.max(2, Math.min(fitNow?.limit ?? Infinity, rendered - over)) : fitNow?.limit;
        if (fitNow === null || limit !== fitNow.limit) {
            setFit({ rows: terminalRows, columns: terminalColumns, id: question.id, question: question.question, limit });
        }
    });`,
  },
  {
    file: ASK_QUESTION,
    label: 'question card fit: panel ref',
    stock: '    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Box, { flexDirection: "column", onClick: onToggleFold',
    patched: '    return (_jsxs(Box, { ref: panelRef, flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Box, { flexDirection: "column", onClick: onToggleFold',
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

// ponytail: reuse the existing footer name and launchpad row; no new picker or preference.
commandEdge.push(
  {
    file: 'lib/types/sessionModes.js',
    label: 'explicit PLAN MODE label',
    stock: "    if (spec.id === 'plan')\n        return t('mode-plan');",
    patched: "    if (spec.id === 'plan')\n        return 'PLAN MODE';",
  },
  {
    file: CHAT,
    label: 'launchpad live plan state',
    stock: 'effort: channel.reasoningEffort, preset: channel.agentPreset === undefined',
    patched: 'effort: channel.reasoningEffort, planActive: channel.mode.plan === true, preset: channel.agentPreset === undefined',
  },
  {
    file: LAUNCHPAD,
    label: 'launchpad plan state input',
    stock: 'onParamPick, model, effort, preset, permission, commands,',
    patched: 'onParamPick, model, effort, planActive = false, preset, permission, commands,',
  },
  {
    file: LAUNCHPAD,
    label: 'launchpad plan badge width',
    stock: 'const paramBudget = Math.max(24, Math.min(columns - 4, 72)) - 2;',
    patched: 'const paramBudget = Math.max(24, Math.min(columns - 4, 72)) - 2 - (planActive ? 12 : 0);',
  },
  {
    file: LAUNCHPAD,
    label: 'launchpad retains permission beside plan badge',
    stock: "if (preset !== undefined && preset !== '') {",
    patched: "if (!planActive && preset !== undefined && preset !== '') {",
  },
  {
    file: LAUNCHPAD,
    label: 'launchpad plan badge survives narrow widths',
    stock: 'const hasParams = fittedParams.length > 0;',
    patched: 'const hasParams = planActive || fittedParams.length > 0;',
  },
  {
    file: LAUNCHPAD,
    label: 'launchpad PLAN MODE badge',
    stock: 'hasParams && (_jsx(Box, { paddingLeft: 2, height: 1, flexDirection: "row", children: fittedParams.map((part, index)',
    patched: 'hasParams && (_jsxs(Box, { paddingLeft: 2, height: 1, flexDirection: "row", children: [planActive && _jsx(Text, { color: "planMode", bold: true, children: "PLAN MODE" + PARAM_SEPARATOR }), ...fittedParams.map((part, index)',
  },
  {
    file: LAUNCHPAD,
    label: 'launchpad badge row closure',
    stock: '} }))] }, part.segment))) })), overlayPanel !== undefined',
    patched: '} }))] }, part.segment)))] })), overlayPanel !== undefined',
  },
)

const args = process.argv.slice(2)
const action = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--tui') ?? 'check'
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
