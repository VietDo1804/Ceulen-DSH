#!/usr/bin/env node
/** UI layouts for dsh-tui 0.19.0/0.20.0. Usage: apply|check|revert [--tui <dir>]. */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PREFS = 'lib/types/uiStyle.js'
const CHAT = 'lib/types/screens/Chat.js'
const BORDER = 'lib/types/components/EffortInputBorder.js'
const PROMPT = 'lib/types/components/PromptInput.js'
const FOOTER = 'lib/types/screens/StatusLine.js'
const TOOL = 'lib/types/components/messages/AssistantToolUseMessage.js'
const USER = 'lib/types/components/messages/UserPromptMessage.js'
const LOGO = 'lib/types/components/LogoV2.js'
const LIST = 'lib/types/components/MessageList.js'
const LAUNCH = 'lib/types/screens/Launchpad.js'
const COMPLETE = 'lib/types/dsh-adapter/channel/command-completions.js'
const COMMANDS = 'lib/types/commands.js'
const UI_STYLE = String.raw`/** ceulen-style: live layout preference; colors remain owned by the theme. */
import { useSyncExternalStore } from 'react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './utils/paths.js';
import { stringWidth } from './ink/stringWidth.js';
import { getTheme } from './theme.js';
export function piBackground(themeName) {
    const fill = getTheme(themeName).userMessageBackground;
    return typeof fill === 'string' && fill.trim() !== '' ? 'userMessageBackground' : 'toolCardBackgroundDim';
}
export const UI_STYLES = [
    { id: 'dsh', label: 'DSH', description: 'Stock dsh-tui layout.' },
    { id: 'pi', label: 'Pi', description: 'Flat prompts and shaded tool blocks, with a compact status bar.' },
    { id: 'omp', label: 'OMP', description: 'Rounded input with status borders and a two-column welcome card.' },
];
const valid = id => UI_STYLES.some(style => style.id === id);
const file = join(DATA_DIR, 'ui-style.json');
const listeners = new Set();
let style = 'dsh';
try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))?.style;
    if (valid(saved)) style = saved;
} catch { /* Missing or corrupt preferences use the stock layout. */ }
export function getUiStyle() {
    const env = process.env.DSH_TUI_STYLE;
    return valid(env) ? env : style;
}
export function setUiStyle(id) {
    if (!valid(id)) return false;
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify({ style: id }, null, 2) + '\n');
    } catch { return false; }
    style = id;
    for (const fn of listeners) fn();
    return true;
}
export function subscribeUiStyle(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
export function useUiStyle() {
    return useSyncExternalStore(subscribeUiStyle, getUiStyle, getUiStyle);
}
/** Segments are {id, text}; the separator occupies three terminal cells. */
export function fitSegments(segments, width) {
    let fitted = segments.filter(segment => segment.text);
    for (const id of ['cwd', 'branch', 'effort']) {
        if (stringWidth(fitted.map(segment => segment.text).join(' > ')) <= width) break;
        fitted = fitted.filter(segment => segment.id !== id);
    }
    return fitted;
}
`
const IMPORT = "import { readThemePref } from '../themePrefs.js';"
const THEME_PARTS = `                const parts = rawInput.trim().split(/\\s+/).filter(Boolean);
                if (parts[0] === 'status') {
                    setHelpOpen(false);
                    channel.pushLocal('/theme', [
                        t('theme-current', { name: themeName }),`
const STYLE_COMMAND = `                const parts = rawInput.trim().split(/\\s+/).filter(Boolean);
                // ceulen-style: layout selection never changes the color theme.
                if (parts[0] === 'style') {
                    setHelpOpen(false);
                    if (parts.length === 1) {
                        channel.pushLocal('/theme style', UI_STYLES.map(style =>
                            (style.id === uiStyle ? '* ' : '  ') + style.id + ' — ' + style.description));
                        return true;
                    }
                    const id = parts[1];
                    if (!UI_STYLES.some(style => style.id === id) || parts.length !== 2) {
                        channel.notify('Unknown UI style: ' + id + '. Use dsh, pi or omp.', { color: 'error' });
                        return true;
                    }
                    if (!setUiStyle(id)) {
                        channel.notify('Could not save UI style: ' + id + '.', { color: 'error' });
                        return true;
                    }
                    channel.notify('UI style: ' + id + (id === 'pi' && themeName !== 'ceulen-pi-mirage'
                        ? ' Tip: /theme ceulen-pi-mirage gives the Pi colors.' : ''), { color: 'success' });
                    return true;
                }
                if (parts[0] === 'status') {
                    setHelpOpen(false);
                    channel.pushLocal('/theme', [
                        'UI style: ' + uiStyle,
                        t('theme-current', { name: themeName }),`
const INPUT_HELPERS = String.raw`
// ceulen-style: reuse the real channel metrics and the stock ignition sweep.
function renderStyleStatus(style, { channel, columns, idleColor, sweepColors, themeName }) {
    const occupancy = channelContextOccupancy(channel);
    const context = occupancy?.contextWindow > 0
        ? (occupancy.usedTokens / occupancy.contextWindow * 100).toFixed(1) + '%──┃─' + formatTokens(occupancy.contextWindow) + '─'
        : '';
    const segments = fitSegments([
        { id: 'brand', text: 'dsh' },
        { id: 'model', text: (style === 'pi' ? '⬢ ' : '◉ ') + (channel.modelDisplay ?? channel.model ?? '') },
        { id: 'effort', text: channel.reasoningEffort ?? '' },
        { id: 'cwd', text: formatProject(displayWorkingDirectory(channel), homeDir()) },
        { id: 'branch', text: channel.gitBranch ? '⑂ ' + channel.gitBranch : '' },
    ], Math.max(0, columns - stringWidth(context) - (style === 'pi' ? 3 : 7)));
    const left = style === 'pi' ? ' ' : '╭── ';
    const right = style === 'pi' ? '' : '╮';
    const textWidth = stringWidth(segments.map(s => s.text).join(' > '));
    const ruleWidth = Math.max(0, columns - stringWidth(left + right + context) - textWidth - 1);
    return _jsx(Box, { width: '100%', flexShrink: 0, backgroundColor: style === 'pi' ? piBackground(themeName) : undefined,
        children: _jsxs(Text, { color: idleColor, wrap: 'truncate-end', children: [left,
            ...segments.flatMap((segment, index) => [index > 0 ? (segment.id === 'effort' ? ' · ' : ' > ') : '',
                _jsx(Text, { color: segment.id === 'brand' ? 'accent' : 'text', bold: segment.id === 'brand', children: segment.text }, segment.id)]),
            ' ', ...Array.from({ length: ruleWidth }, (_, index) => _jsx(Text, { color: sweepColors[textWidth + index] ?? idleColor, children: '─' }, index)), context, right] }) });
}
function renderStyleFooter(style, { channel, columns, styleFields = [], styleBackendMode, idleColor }) {
    const access = styleBackendMode?.name ?? (channel.mode.sandbox === 'danger-full-access' ? 'full access'
        : channel.mode.sandbox === 'read-only' ? 'read only' : 'workspace write');
    const parts = [access, channel.mode.plan === true ? 'plan' : '',
        ...styleFields.map(field => field.text),
        channel.goal ? 'goal ' + channel.goal.phase + ' ' + channel.goal.roundsStarted + '/' + channel.goal.maxGoalRounds : '',
        channel.sessionTitle ?? ''].filter(Boolean);
    const text = parts.join(' · ');
    const hint = '⇧⇥ effort';
    const prefix = style === 'pi' ? '   ' : '╰─ ';
    const suffix = style === 'omp' ? ' ─╯' : '';
    const spare = columns - stringWidth(prefix + text + suffix + hint) - 2;
    // ponytail: wrap safety/usage before decoration; hide the hint when space is tight.
    return _jsx(Box, { width: '100%', flexShrink: 0, children: _jsxs(Text, { color: 'subtle', children: [
        _jsx(Text, { color: idleColor, children: prefix }), text,
        style === 'omp' && spare >= 0 ? ' ' + '─'.repeat(spare) + ' ' + hint : '',
        _jsx(Text, { color: idleColor, children: suffix })] }) });
}
function renderStyleInputRow(style, children) {
    // The stock prompt row owns input, caret, vim state and handlers. Keep those nodes.
    const [, , vim, input] = children.props.children;
    return cloneElement(children, { children: [
        _jsx(Text, { color: 'subtle', children: style === 'pi' ? '╰─ ❯ ' : '│ ❯ ' }, 'style-prompt'),
        vim, input, style === 'omp' ? _jsx(Text, { color: 'promptBorder', children: '│' }, 'style-right') : null,
    ] });
}
function renderPiInput(options) {
    const tokens = options.channel.tokens;
    const total = tokens ? tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) : 0;
    const stats = tokens && Number.isFinite(tokens.input) && Number.isFinite(tokens.output)
        ? '↑' + formatTokens(tokens.input) + ' ↓' + formatTokens(tokens.output)
            + (Number.isFinite(tokens.cacheRead) ? ' R' + formatTokens(tokens.cacheRead) : '')
            + (total > 0 && Number.isFinite(tokens.cacheRead) ? ' CH' + (tokens.cacheRead / total * 100).toFixed(1) + '%' : '')
        : undefined;
    return _jsxs(Box, { flexDirection: 'column', width: '100%', flexShrink: 0, children: [
        stats === undefined ? null : _jsx(Text, { color: 'subtle', children: stats }),
        renderStyleStatus('pi', options), renderStyleInputRow('pi', options.children), renderStyleFooter('pi', options),
    ] });
}
function renderOmpInput(options) {
    return _jsxs(Box, { flexDirection: 'column', width: '100%', flexShrink: 0, children: [
        renderStyleStatus('omp', options), renderStyleInputRow('omp', options.children), renderStyleFooter('omp', options),
    ] });
}
`
const USER_HELPER = String.raw`
// ceulen-style: pi prompt; dsh/omp retain the original JSX below.
function renderPiUserPrompt({ text, columns, marginTopOnTurn, onClick, themeName }) {
    return _jsx(Box, { width: '100%', flexDirection: 'column', backgroundColor: piBackground(themeName),
        paddingX: 1, paddingY: 1, marginTop: marginTopOnTurn ? 1 : 0, onClick,
        children: wrapWidth(text, Math.max(1, columns - 2)).map((line, index) =>
            _jsx(Text, { color: 'text', bold: false, children: line || ' ' }, index)) });
}
`
// Derive the alternate card from the fixed, retained stock return. Every edit
// has one unique anchor; no tool-name/alias code is copied or changed.
function toolCardSwap(source) {
  const start = '    return (_jsx(Box, { ref: viewportRef,'
  const end = 'children: footnote })] }))] }) }));'
  if (count(source, start) !== 1 || count(source, end) !== 1) fail('Tool card return anchors must match exactly once. Nothing written.')
  const original = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)) + end.length)
  let pi = original
  const swap = (from, to) => {
    if (count(pi, from) !== 1) fail('Pi tool-card anchor must match exactly once: ' + from + '. Nothing written.')
    pi = pi.replace(from, to)
  }
  swap(start, '    return (_jsx(Box, { paddingX: 1, paddingY: 1, ref: viewportRef,')
  swap("backgroundColor: isSelected ? 'messageActionsBackground' : hoverTint ? 'toolCardBackground' : ordinaryBackground",
    "backgroundColor: isSelected || hoverTint ? 'toolCardBackground' : 'toolCardBackgroundDim'")
  swap('_jsx(ToolUseLoader, { shouldAnimate: isRunning, isUnresolved: isRunning, isError: isError, toolName: tool.name })', 'null')
  const headerStart = '_jsx(HeaderTitle, { name: name,'
  const headerEnd = 'headerTextBudget: headerTextBudget })'
  if (count(pi, headerStart) !== 1 || count(pi, headerEnd) !== 1) fail('Pi header anchors must match exactly once. Nothing written.')
  const header = pi.slice(pi.indexOf(headerStart), pi.indexOf(headerEnd) + headerEnd.length)
  swap(header, `_jsxs(Box, { flexDirection: 'column', flexGrow: 1, children: [
      _jsx(Text, { bold: true, color: isError ? 'error' : toolNameColor(tool.name, view?.category ?? tool.callView?.category), children: name }),
      displayArgs !== '' && _jsx(Text, { color: 'text', children: displayArgs })] })`)
  swap('!isRunning && (_jsx(Box, { flexWrap: "nowrap", children: _jsx(Text, { dimColor: !hovered, children: elapsedText }) }))', 'false')
  for (const prefix of [
    "useSplitDiff && view?.card === 'diff' ? (",
    'shownLines.map((line, index) => (',
    'sendMessage !== undefined && sendMessageState !== undefined && (',
    'disclosure.map((line, index) => (',
    'useSplitDiff && footnote !== undefined && (',
  ]) {
    const from = prefix + '_jsxs(Box, { flexDirection: "row", children: [_jsx(Box, { width: 3,'
    // Width zero alone wraps the three gutter characters into four layout rows.
    swap(from, from.replace('width: 3,', 'width: 0, display: "none",'))
  }
  swap(end, `children: footnote })] })), _jsx(Text, { color: 'subtle', dimColor: true,
      children: isRunning ? 'running…' : elapsedMs === undefined ? '' : 'Took ' + formatDuration(elapsedMs) })] }) }));`)
  const branch = `    // ceulen-style: pi-tool begin\n    function renderPiToolCard() {\n${pi}\n    }\n    if (uiStyle === 'pi') return renderPiToolCard();\n    // ceulen-style: pi-tool end\n${original}`
  return [TOOL, original, branch]
}
const LOGO_HELPERS = String.raw`
// ceulen-style: layout-only banners; all ink is owned by the active theme.
function renderPiLogo({ model, cwd }) {
    return _jsxs(Box, { width: '100%', flexDirection: 'column', marginTop: 1, children: [
        _jsx(Text, { color: 'accent', bold: true, children: '⬢ dsh-tui v' + VERSION }),
        _jsx(Text, { color: 'subtle', wrap: 'truncate-end', children:
            'esc interrupt · ctrl+c clear · /exit quit · / commands · ! bash'
            + ([model, cwd].filter(Boolean).length ? ' · ' + [model, cwd].filter(Boolean).join(' · ') : '') }),
    ] });
}
function renderOmpLogo({ model, provider, columns }) {
    const title = '─── dsh-tui v' + VERSION + ' ';
    const left = Math.max(stringWidth(title), Math.floor((columns - 3) / 2));
    const right = Math.max(0, columns - left - 3);
    return _jsxs(Box, { width: '100%', flexDirection: 'column', marginTop: 1, children: [
        _jsx(Text, { color: 'promptBorder', wrap: 'truncate-end', children:
            '╭' + title + '─'.repeat(Math.max(0, left - stringWidth(title))) + '┬' + '─'.repeat(right) + '╮' }),
        _jsxs(Box, { width: '100%', flexDirection: 'row', borderStyle: 'single', borderColor: 'promptBorder', borderTop: false, borderBottom: false, children: [
            _jsxs(Box, { width: left, paddingX: 1, flexDirection: 'column', children: [
                _jsx(Text, { bold: true, color: 'text', children: 'Welcome back!' }),
                _jsx(Text, { color: 'text', children: model }),
                provider ? _jsx(Text, { color: 'subtle', children: provider }) : null,
            ] }),
            _jsxs(Box, { flexGrow: 1, paddingX: 1, flexDirection: 'column', borderStyle: 'single', borderColor: 'promptBorder', borderTop: false, borderBottom: false, borderRight: false, children: [
                _jsx(Text, { bold: true, color: 'text', children: 'Tips' }),
                _jsx(Text, { color: 'subtle', children: '/ for commands · ! bash' }),
                _jsx(Text, { color: 'subtle', children: 'esc interrupt · ctrl+c clear' }),
                _jsx(Text, { color: 'subtle', children: '/exit quit' }),
            ] }),
        ] }),
        _jsx(Text, { color: 'promptBorder', wrap: 'truncate-end', children: '╰' + '─'.repeat(left) + '┴' + '─'.repeat(right) + '╯' }),
    ] });
}
`
const LAUNCH_LOGO = '_jsx(LogoV2, { fontId: font.id, egg: dailyEgg, whale: layout.showWhale && whale, whaleIdle: whaleIdle, whaleGirl: layout.showWhale && whaleGirl, brand: brand, companionSkin: companionSkin, mascotBox: mascotBox, starred: starred, onStarClick: onStarClick, skipIntro: true, align: "center", chrome: "minimal", arrangement: "column" })'
const swaps = [
  [CHAT, IMPORT, IMPORT + "\nimport { UI_STYLES, setUiStyle, useUiStyle } from '../uiStyle.js'; // ceulen-style"],
  [CHAT, '    const [themeName, setTheme] = useTheme();', '    const [themeName, setTheme] = useTheme();\n    const uiStyle = useUiStyle(); // ceulen-style'],
  [CHAT, THEME_PARTS, STYLE_COMMAND],
  [CHAT, '_jsx(PromptInput, { channel: channel, suspended: promptReplacementOpen,', '_jsx(PromptInput, { channel: channel, styleFields: statusFields, styleBackendMode: backendModeStatus, suspended: promptReplacementOpen,'],
  [BORDER, "import { useContext, useEffect, useReducer, useState } from 'react';", "import { cloneElement, useContext, useEffect, useReducer, useState } from 'react';\nimport { useUiStyle, fitSegments, piBackground } from '../uiStyle.js';\nimport { formatTokens } from '../terminal-utils/format.js';\nimport { displayWorkingDirectory, formatProject } from '../sessions/format.js';\nimport { homeDir } from '../utils/paths.js';\nimport { channelContextOccupancy } from '../screens/StatusMetrics.js';"],
  [BORDER, 'export function EffortInputBorder({ effort, levels, columns, idleColor, topRightLabel, children, }) {', INPUT_HELPERS + 'export function EffortInputBorder({ effort, levels, columns, idleColor, topRightLabel, children, channel, styleFields, styleBackendMode, }) {\n    const uiStyle = useUiStyle();'],
  [BORDER, '    return (_jsxs(Box, { flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", width: "100%", flexShrink: 0, children:', '    if (uiStyle === \'pi\') return renderPiInput({ channel, columns, idleColor, sweepColors, children, styleFields, styleBackendMode, themeName });\n    if (uiStyle === \'omp\') return renderOmpInput({ channel, columns, idleColor, sweepColors, children, styleFields, styleBackendMode, themeName });\n    return (_jsxs(Box, { flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", width: "100%", flexShrink: 0, children:'],
  [PROMPT, "import { EffortInputBorder } from './EffortInputBorder.js';", "import { EffortInputBorder } from './EffortInputBorder.js';\nimport { useUiStyle } from '../uiStyle.js';"],
  [PROMPT, 'export function PromptInput({ channel, toastSuppressed,', 'export function PromptInput({ channel, styleFields, styleBackendMode, toastSuppressed,'],
  [PROMPT, '    const nativeCursor = useNativeCursor();', '    const uiStyle = useUiStyle();\n    const nativeCursor = useNativeCursor();'],
  [PROMPT, '    const homeButtonCols = onOpenSessions === undefined ? 0 : HOME_BUTTON_COLS;', "    const homeButtonCols = uiStyle === 'dsh' ? (onOpenSessions === undefined ? 0 : HOME_BUTTON_COLS) : uiStyle === 'pi' ? 3 : 2;"],
  [PROMPT, '    const inputWidth = expanded\n', "    const inputWidth = !expanded && uiStyle !== 'dsh' ? Math.max(1, columns - 5 - vimBadgeCols) : expanded\n"],
  [PROMPT, '_jsx(EffortInputBorder, { effort: channel.reasoningEffort,', '_jsx(EffortInputBorder, { channel: channel, styleFields: styleFields, styleBackendMode: styleBackendMode, effort: channel.reasoningEffort,'],
  [FOOTER, "import React from 'react';", "import React from 'react';\nimport { useUiStyle } from '../uiStyle.js';"],
  [FOOTER, '    const { columns } = useTerminalSize();', '    const uiStyle = useUiStyle();\n    const { columns } = useTerminalSize();'],
  [FOOTER, '    return (_jsx(Box, { paddingX: 1, width: columns, flexShrink: 0, children:', "    if (uiStyle !== 'dsh') return null; // ceulen-style: safety and plugin fields are in the input rail.\n    return (_jsx(Box, { paddingX: 1, width: columns, flexShrink: 0, children:"],
  [USER, "import { POINTER } from '../../terminal-utils/figures.js';", "import { POINTER } from '../../terminal-utils/figures.js';\nimport { useUiStyle, piBackground } from '../../uiStyle.js';"],
  [USER, "import { Box, Text, useTerminalSize } from '../../ui.js';", "import { Box, Text, useTerminalSize, useTheme } from '../../ui.js';"],
  [USER, 'export function UserPromptMessage({ text, marginTopOnTurn, isSelected = false, onClick, }) {', USER_HELPER + 'export function UserPromptMessage({ text, marginTopOnTurn, isSelected = false, onClick, }) {\n    const uiStyle = useUiStyle();\n    const [themeName] = useTheme();'],
  [USER, '    return (_jsx(Box, { flexDirection: "column", marginTop: marginTopOnTurn ? 1 : 0, backgroundColor:', "    if (uiStyle === 'pi') return renderPiUserPrompt({ text, columns, marginTopOnTurn, onClick, themeName });\n    return (_jsx(Box, { flexDirection: \"column\", marginTop: marginTopOnTurn ? 1 : 0, backgroundColor:"],
  [TOOL, "import React from 'react';", "import React from 'react';\nimport { useUiStyle } from '../../uiStyle.js';"],
  [TOOL, '    useRevealVersion(revealVersion === undefined);', '    const uiStyle = useUiStyle();\n    useRevealVersion(revealVersion === undefined);'],
  [LOGO, "import React from 'react';", "import React from 'react';\nimport { useUiStyle } from '../uiStyle.js';"],
  [LOGO, "export function LogoV2({ model = '',", LOGO_HELPERS + "export function LogoV2({ provider = '', model = '',"],
  [LOGO, '    const [sequence] = React.useState(() => OPENING_SEQUENCES[intro ?? pickOpeningSequence().id]);', '    const uiStyle = useUiStyle();\n    const [sequence] = React.useState(() => OPENING_SEQUENCES[intro ?? pickOpeningSequence().id]);'],
  [LOGO, '    return (_jsxs(Box, { ref: ref, flexDirection: "column", marginTop: 1,', "    if (uiStyle === 'pi') return renderPiLogo({ model, cwd });\n    if (uiStyle === 'omp') return renderOmpLogo({ model, provider, columns });\n    return (_jsxs(Box, { ref: ref, flexDirection: \"column\", marginTop: 1,"],
  [CHAT, '_jsx(LogoHeader, { model: channel.modelDisplay ?? channel.model,', '_jsx(LogoHeader, { provider: channel.provider, model: channel.modelDisplay ?? channel.model,'],
  [LIST, "import React, { useState } from 'react';", "import React, { useState } from 'react';\nimport { useUiStyle } from '../uiStyle.js';"],
  [LIST, 'export function LogoHeader({ model, effort, cwd,', "function renderStyleLogoHeader({ model, effort, cwd, provider }) {\n    return _jsx(Box, { flexDirection: 'column', marginBottom: 1, children: _jsx(LogoV2, { model, effort, cwd, provider, skipIntro: true }) });\n}\nexport function LogoHeader({ provider, model, effort, cwd,"],
  [LIST, '    // The minimal UI drops the whole splash (whale art AND wordmark)', '    const uiStyle = useUiStyle();\n    // The minimal UI drops the whole splash (whale art AND wordmark)'],
  [LIST, '    return (_jsx(Box, { flexDirection: "column", marginBottom: 1, children: _jsx(LogoV2,', "    if (uiStyle !== 'dsh') return renderStyleLogoHeader({ model, effort, cwd, provider });\n    return (_jsx(Box, { flexDirection: \"column\", marginBottom: 1, children: _jsx(LogoV2,"],
  [CHAT, '_jsx(Launchpad, { query: launchpadDraft,', '_jsx(Launchpad, { provider: channel.provider, query: launchpadDraft,'],
  [LAUNCH, 'export function Launchpad({ query,', 'export function Launchpad({ provider, query,'],
  [LAUNCH, '    const { columns, rows } = useTerminalSize();', '    const uiStyle = useUiStyle();\n    const { columns, rows } = useTerminalSize();'],
  [LAUNCH, LAUNCH_LOGO, "(uiStyle === 'dsh' ? " + LAUNCH_LOGO + ' : _jsx(LogoV2, { provider, model, effort, cwd, skipIntro: true }))'],
  [LAUNCH, "import React", "import { useUiStyle } from '../uiStyle.js';\nimport React"],
  // Slash suggestions: `/theme ` offers `style`, `/theme style ` offers the three styles.
  [COMPLETE, "import { listThemeCatalog } from '../../themeCatalog.js';", "import { listThemeCatalog } from '../../themeCatalog.js';\nimport { UI_STYLES, getUiStyle } from '../../uiStyle.js'; // ceulen-style"],
  [COMPLETE, "                    { name: 'status', description: 'Show the current theme', descriptionKey: 'sugg-status-desc' },", "                    { name: 'style', description: 'Switch the UI style: dsh, pi or omp' }, // ceulen-style\n                    { name: 'status', description: 'Show the current theme', descriptionKey: 'sugg-status-desc' },"],
  [COMPLETE, "            if (path.length === 1 && path[0] === 'color')", "            if (path.length === 2 && path[0] === 'theme' && path[1] === 'style') // ceulen-style\n                return UI_STYLES.map(style => ({ name: style.id, description: style.description, ...(getUiStyle() === style.id ? { tag: 'current' } : {}) }));\n            if (path.length === 1 && path[0] === 'color')"],
  [COMMANDS, "    { name: 'theme', description: 'Switch the color theme (auto, built-in or custom)' },", "    { name: 'theme', description: 'Switch the color theme, or the UI style with /theme style (dsh, pi, omp)' }, // ceulen-style"],
]

const args = process.argv.slice(2)
let action = 'check'
let root = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tui' && args[i + 1]) root = args[++i]
  else if (['apply', 'check', 'revert'].includes(args[i])) action = args[i]
  else {
    console.error('usage: node scripts/tui-style-patch.mjs apply|check|revert [--tui <dir>]')
    process.exit(2)
  }
}
const fail = message => {
  console.error(message)
  process.exit(1)
}
const count = (text, anchor) => text.split(anchor).length - 1
try {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (!['0.19.0', '0.20.0'].includes(version)) fail('UI style patch requires dsh-tui 0.19.0 or 0.20.0; found ' + version + '. Nothing written.')
  swaps.push(toolCardSwap(readFileSync(join(root, TOOL), 'utf8')))
  const sources = new Map(swaps.map(([file]) => [file, readFileSync(join(root, file), 'utf8')]))
  const prefs = existsSync(join(root, PREFS)) ? readFileSync(join(root, PREFS), 'utf8') : undefined
  const applied = prefs === UI_STYLE && swaps.every(([file, , patched]) => count(sources.get(file), patched) === 1)
  const stock = prefs === undefined && swaps.every(([file, original, patched]) => count(sources.get(file), original) === 1 && count(sources.get(file), patched) === 0)
  if (action === 'check') {
    console.log('dsh-tui ' + version + ' UI style patch ' + (applied ? 'applied' : 'NOT applied'))
    process.exit(applied ? 0 : 1)
  }
  if ((action === 'apply' && applied) || (action === 'revert' && stock)) {
    console.log('UI style patch already ' + (applied ? 'applied' : 'stock'))
    process.exit(0)
  }
  if (action === 'apply' ? prefs !== undefined : prefs !== UI_STYLE) fail('uiStyle.js does not match the expected state. Nothing written.')
  // Validate every anchor before writing any file, including the newly created module.
  for (const [file, original, patched] of swaps) {
    const from = action === 'apply' ? original : patched
    const source = sources.get(file)
    if (count(source, from) !== 1) fail(file + ': anchor must match exactly once. Nothing written.')
    sources.set(file, source.replace(from, action === 'apply' ? patched : original))
  }
  for (const [file, source] of sources) writeFileSync(join(root, file), source)
  if (action === 'apply') writeFileSync(join(root, PREFS), UI_STYLE)
  else unlinkSync(join(root, PREFS))
  console.log('UI style patch ' + (action === 'apply' ? 'applied' : 'reverted') + ' on dsh-tui ' + version + '.')
} catch (error) {
  fail(String(error))
}
