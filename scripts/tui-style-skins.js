/** ceulen-style: the `skins` layout, after hellosverre/claude-skins (MIT).
 *  Layout only: every colour is a theme key, so `/theme ceulen-noir` gives the
 *  noir look and any other theme keeps its own ink. Written into dsh-tui as
 *  lib/types/uiStyleSkins.js by scripts/tui-style-patch.mjs. */
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { homedir } from 'node:os';
import { extname, isAbsolute, relative } from 'node:path';
import * as JsDiff from 'diff';
import { Box, NoSelect, Text } from './ui.js';
import { stringWidth } from './ink/stringWidth.js';
import { wrapWidth } from './sessions/format.js';
import { isPatchDiff, parseFilePatch } from './components/diffPatch.js';
import { SyntaxText } from './components/SyntaxText.js';

// Single-cell glyphs with no emoji presentation, one per kind of call.
const KINDS = {
    run: { glyph: '$', color: 'toolDotExec' },
    read: { glyph: '≡', color: 'toolDotRead' },
    write: { glyph: '✎', color: 'toolDotWrite' },
    search: { glyph: '⌕', color: 'toolDotRead' },
    web: { glyph: '◍', color: 'toolDotWeb' },
    agent: { glyph: '◈', color: 'toolDotTask' },
    mcp: { glyph: '◇', color: 'accent' },
    other: { glyph: '•', color: 'accent' },
};
/** Collapsed cards: diff rows and shell output fold to this many rows. */
const DIFF_ROWS = 10;
const OUTPUT_HEAD = 8;
const OUTPUT_TAIL = 4;
const ERROR_ROWS = 6;
const OPEN_ROWS = 400;

export function skinsKind(name, category, card) {
    const n = String(name ?? '').toLowerCase();
    if (card === 'terminal' || category === 'exec' || /^(bash|bashpersistent|sh|shell|terminal|powershell|rtk|job_)/.test(n))
        return 'run';
    if (card === 'diff' || category === 'mutate' || /^(edit|write|multiedit|notebookedit|apply_patch)$/.test(n))
        return 'write';
    if (n.startsWith('web_') || n === 'webfetch' || n === 'websearch')
        return 'web';
    if (card === 'read' || n.startsWith('read'))
        return 'read';
    if (card === 'search' || /grep|glob|find_files|resolve_file|search/.test(n))
        return 'search';
    if (n.startsWith('mcp__'))
        return 'mcp';
    if (/subagent|delegate|send_message|sendmessage|advisor|task/.test(n))
        return 'agent';
    return 'other';
}

/** A call's own time: `0.4s`, `2.1s`, `1m 4s`. */
export function skinsMs(ms) {
    if (ms === undefined || !Number.isFinite(ms))
        return '';
    if (ms < 100)
        return '<0.1s';
    if (ms < 60_000)
        return (ms / 1000).toFixed(1) + 's';
    const seconds = Math.round(ms / 1000);
    return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

/** A path as the row shows it: relative under the working folder, `~` under home. */
export function skinsPath(path) {
    if (typeof path !== 'string' || !isAbsolute(path))
        return path;
    const inside = relative(process.cwd(), path);
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside))
        return inside;
    const home = homedir();
    return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

function firstLine(text) {
    const line = String(text ?? '').split('\n').find(part => part.trim() !== '') ?? '';
    return line.trim();
}

function targetOf({ name, title, displayArgs, filePath }) {
    let text = title !== undefined && title.trim() !== '' ? title.trim() : String(displayArgs ?? '');
    // `Read /path (1 - 100)` and `Bash(cmd)` both lead with the tool's own name.
    if (text.toLowerCase().startsWith(String(name).toLowerCase()))
        text = text.slice(String(name).length).trim();
    if (text.startsWith('(') && text.endsWith(')'))
        text = text.slice(1, -1);
    if (typeof filePath === 'string' && filePath !== '')
        text = text.split(filePath).join(skinsPath(filePath));
    return firstLine(text);
}

/** Diff rows with old and new line numbers where the backend gave positions. */
export function skinsDiffRows(diffs) {
    const rows = [];
    let added = 0;
    let removed = 0;
    const list = Array.isArray(diffs) ? diffs : [];
    for (const diff of list) {
        if (list.length > 1)
            rows.push({ kind: 'path', text: skinsPath(diff.path) });
        if (isPatchDiff(diff)) {
            const parsed = parseFilePatch(diff);
            if (parsed.raw !== undefined) {
                for (const line of parsed.raw) {
                    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
                    if (kind === 'add') added++;
                    if (kind === 'del') removed++;
                    rows.push({ kind, text: kind === 'ctx' ? line : line.slice(1) });
                }
                continue;
            }
            parsed.hunks.forEach((hunk, index) => {
                if (index > 0)
                    rows.push({ kind: 'gap' });
                for (const line of hunk.lines) {
                    const kind = line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : 'ctx';
                    if (kind === 'add') added++;
                    if (kind === 'del') removed++;
                    rows.push({ kind, text: line.text, oldNo: kind === 'add' ? undefined : line.oldNo, newNo: kind === 'del' ? undefined : line.newNo });
                }
            });
            continue;
        }
        const patch = JsDiff.structuredPatch('', '', diff.oldText ?? '', diff.newText ?? '', undefined, undefined, {
            context: 3, maxEditLength: 4000, timeout: 100,
        });
        if (patch === undefined) {
            for (const line of String(diff.oldText ?? '').split('\n')) { removed++; rows.push({ kind: 'del', text: line }); }
            for (const line of String(diff.newText ?? '').split('\n')) { added++; rows.push({ kind: 'add', text: line }); }
            continue;
        }
        // Numbers only when the backend said where the texts start; never guessed.
        const at = (base, offset) => (base === undefined ? undefined : base + offset - 1);
        patch.hunks.forEach((hunk, index) => {
            if (index > 0)
                rows.push({ kind: 'gap' });
            let oldNo = hunk.oldStart;
            let newNo = hunk.newStart;
            for (const raw of hunk.lines) {
                if (raw.startsWith('\\'))
                    continue;
                const text = raw.slice(1);
                if (raw[0] === '-') {
                    removed++;
                    rows.push({ kind: 'del', text, oldNo: at(diff.oldStart, oldNo++) });
                }
                else if (raw[0] === '+') {
                    added++;
                    rows.push({ kind: 'add', text, newNo: at(diff.newStart, newNo++) });
                }
                else {
                    rows.push({ kind: 'ctx', text, oldNo: at(diff.oldStart, oldNo++), newNo: at(diff.newStart, newNo++) });
                }
            }
        });
    }
    return { rows, added, removed };
}

function languageOf(path) {
    const ext = typeof path === 'string' ? extname(path).slice(1).toLowerCase() : '';
    return ext === '' ? undefined : ext;
}

function statSpans(added, removed) {
    if (added + removed === 0)
        return [];
    return [
        _jsx(Text, { color: 'diffAddedWord', children: '+' + added }, 'add'),
        _jsx(Text, { color: 'diffRemovedWord', children: ' −' + removed }, 'del'),
    ];
}

/** A rounded card under the row, its header on a band (a rule inside the frame
 *  cannot join the frame's sides, so the band does the separating). */
function card({ head, right, children, key, width }) {
    // An explicit width: the transcript row is wider than the painted column, so 100% overflows the frame.
    return _jsx(Box, { flexDirection: 'column', paddingLeft: 2, width, flexShrink: 0, children:
            _jsxs(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', width: Math.max(8, width - 2), children: [
                _jsxs(Box, { flexDirection: 'row', paddingX: 1, backgroundColor: 'toolCardBackground', children: [
                    _jsx(Box, { flexGrow: 1, flexShrink: 1, children: head }),
                    right === undefined ? null : _jsx(Box, { flexShrink: 0, paddingLeft: 2, children: right }),
                ] }),
                ...children,
            ] }) }, key);
}

function moreRow(hidden, key) {
    return _jsx(Box, { paddingX: 1, children: _jsx(Text, { color: 'subtle', children: '▾ ' + hidden + ' more line' + (hidden === 1 ? '' : 's') }) }, key);
}

function diffCard({ rows, added, removed, path, open, width }) {
    const shown = open ? rows.slice(0, OPEN_ROWS) : rows.slice(0, DIFF_ROWS);
    const numbered = rows.some(row => row.oldNo !== undefined || row.newNo !== undefined);
    const digits = Math.max(1, ...rows.map(row => String(row.oldNo ?? row.newNo ?? '').length));
    const language = languageOf(path);
    const body = shown.map((row, index) => {
        if (row.kind === 'gap')
            return _jsx(Box, { paddingX: 1, children: _jsx(Text, { color: 'subtle', children: '⋯' }) }, index);
        if (row.kind === 'path')
            return _jsx(Box, { paddingX: 1, children: _jsx(Text, { color: 'text', bold: true, children: row.text }) }, index);
        const tint = row.kind === 'del' ? 'diffRemoved' : row.kind === 'add' ? 'diffAdded' : undefined;
        const mark = row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : ' ';
        const gutter = numbered
            ? ' ' + String(row.oldNo ?? '').padStart(digits) + ' ' + String(row.newNo ?? '').padStart(digits) + ' '
            : ' ';
        return _jsxs(Box, { flexDirection: 'row', backgroundColor: tint, children: [
            _jsx(NoSelect, { flexShrink: 0, children: _jsx(Text, { color: row.kind === 'del' ? 'diffRemovedWord' : row.kind === 'add' ? 'diffAddedWord' : 'subtle', children: row.kind === 'ctx' ? ' ' : '▎' }) }),
            _jsx(NoSelect, { flexShrink: 0, children: _jsx(Text, { color: 'subtle', children: gutter }) }),
            _jsx(NoSelect, { flexShrink: 0, children: _jsx(Text, { color: row.kind === 'del' ? 'diffRemovedWord' : row.kind === 'add' ? 'diffAddedWord' : 'subtle', bold: row.kind !== 'ctx', children: mark + ' ' }) }),
            _jsx(Box, { flexGrow: 1, flexShrink: 1, children: row.kind === 'del' || language === undefined
                    ? _jsx(Text, { color: row.kind === 'del' ? 'text' : row.kind === 'ctx' ? 'subtle' : 'text', children: row.text || ' ' })
                    : _jsx(SyntaxText, { text: row.text || ' ', language, dimColor: row.kind === 'ctx' }) }),
        ] }, index);
    });
    const hidden = rows.length - shown.length;
    return card({
        key: 'skins-diff',
        width,
        head: _jsxs(Text, { wrap: 'truncate-end', children: [_jsx(Text, { color: 'toolDotWrite', children: '✎ ' }), _jsx(Text, { color: 'text', bold: true, children: skinsPath(path) ?? '' })] }),
        right: _jsx(Text, { children: statSpans(added, removed) }),
        children: [...body, hidden > 0 ? moreRow(hidden, 'more') : null],
    });
}

/** Shell output: stdout in the card, stderr under its own label, each folded to 8 + 4 rows. */
function shellCard({ output, exitCode, signal, isRunning, isError, open, live, width }) {
    const lines = String(output ?? '').replace(/\s+$/, '').split('\n');
    const rows = [];
    let stderr = false;
    for (const line of lines) {
        if (line.trim() === '[stderr]') {
            stderr = true;
            rows.push({ label: 'stderr' });
            continue;
        }
        rows.push({ text: line, error: stderr });
    }
    const failed = isError || (exitCode !== undefined && exitCode !== 0) || signal !== undefined;
    const fold = !open && rows.length > OUTPUT_HEAD + OUTPUT_TAIL + 1;
    const shown = fold ? [...rows.slice(0, OUTPUT_HEAD), { more: rows.length - OUTPUT_HEAD - OUTPUT_TAIL }, ...rows.slice(-OUTPUT_TAIL)] : rows.slice(0, OPEN_ROWS);
    const body = shown.map((row, index) => row.more !== undefined
        ? moreRow(row.more, index)
        : row.label !== undefined
            ? _jsx(Box, { paddingX: 1, children: _jsx(Text, { color: 'error', dimColor: true, children: row.label }) }, index)
            : _jsx(Box, { paddingX: 1, children: _jsx(Text, { color: row.error ? 'error' : 'text', children: row.text || ' ' }) }, index));
    for (const [index, line] of (live ?? []).entries())
        body.push(_jsx(Box, { paddingX: 1, children: _jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: line.text }) }, 'live' + index));
    const status = isRunning
        ? _jsx(Text, { color: 'subtle', children: 'running' })
        : failed
            ? _jsx(Text, { color: 'error', bold: true, children: signal !== undefined ? '✗ ' + String(signal) : '✗ exit ' + (exitCode ?? '?') })
            : _jsx(Text, { color: 'text', bold: true, children: 'ok' });
    return card({
        key: 'skins-shell',
        width,
        head: _jsxs(Text, { children: [_jsx(Text, { color: 'subtle', children: '›_ ' }), _jsx(Text, { color: 'subtle', children: 'Output' })] }),
        right: status,
        children: body,
    });
}

/**
 * The skins tool row and its card. Called from inside AssistantToolUseMessage
 * after its hooks ran, with the values it already derived; returns undefined to
 * leave a call to the stock card (SendMessage keeps its own).
 */
export function renderSkinsTool(o) {
    const { tool, view, name, sendMessage, isRunning, isError, elapsedMs, interactive, hovered, setHovered, isSelected, onClick, marginTopOnTurn, viewportRef } = o;
    if (sendMessage !== undefined)
        return undefined;
    const open = o.verbose || o.isExpanded;
    const kind = skinsKind(tool.name, view?.category ?? tool.callView?.category, view?.card);
    const look = KINDS[kind];
    const target = targetOf({ name, title: o.title, displayArgs: o.displayArgs, filePath: o.filePath });
    const rv = tool.resultView;
    const diff = !isError && view?.card === 'diff' ? skinsDiffRows(view.diffs) : undefined;
    const body = [];
    let expandable = false;
    if (isError) {
        const lines = String(tool.errorText ?? '').replace(/\s+$/, '').split('\n').filter(line => line !== '');
        const shown = open ? lines : lines.slice(0, ERROR_ROWS);
        body.push(...shown.map((line, index) => _jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: 'error', children: (index === 0 ? '└ ' : '  ') + line }) }, 'err' + index)));
        if (shown.length < lines.length) {
            expandable = true;
            body.push(_jsx(Box, { paddingLeft: 4, children: _jsx(Text, { color: 'subtle', children: '▾ ' + (lines.length - shown.length) + ' more lines' }) }, 'err-more'));
        }
    }
    else if (diff !== undefined && diff.rows.length > 0) {
        const path = view.diffs?.[0]?.path ?? o.filePath;
        body.push(diffCard({ ...diff, path, open, width: o.columns }));
        expandable = diff.rows.length > DIFF_ROWS;
    }
    else if (view?.card === 'terminal') {
        const output = rv !== undefined && rv.card === 'terminal' && 'output' in rv ? rv.output : '';
        const live = isRunning ? o.liveLines : [];
        if ((output ?? '').trim() !== '' || (live ?? []).length > 0 || (rv?.exitCode ?? 0) !== 0)
            body.push(shellCard({ output, exitCode: rv?.exitCode, signal: rv?.signal, isRunning, isError, open, live, width: o.columns }));
        expandable = String(output ?? '').split('\n').length > OUTPUT_HEAD + OUTPUT_TAIL + 1;
    }
    else {
        // Reads, searches and the rest stay one row; opening the row shows the body.
        const lines = (o.lines ?? []).filter(line => line.tone !== 'hint');
        expandable = lines.length > 0;
        if (open)
            body.push(...lines.map((line, index) => _jsxs(Box, { flexDirection: 'row', paddingLeft: 2, children: [
                    _jsx(NoSelect, { flexShrink: 0, children: _jsx(Text, { color: 'subtle', children: '│ ' }) }),
                    _jsx(Box, { flexGrow: 1, flexShrink: 1, children: _jsx(Text, { color: line.tone === 'error' ? 'error' : line.tone === 'dim' ? 'subtle' : 'text', children: line.text || ' ' }) }),
                ] }, 'line' + index)));
        else if (isRunning && (o.liveLines ?? []).length > 0)
            body.push(...o.liveLines.slice(-3).map((line, index) => _jsx(Box, { paddingLeft: 4, children: _jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: line.text }) }, 'live' + index)));
    }
    if (o.footnote !== undefined)
        body.push(_jsx(Box, { paddingLeft: 4, children: _jsx(Text, { color: 'subtle', children: o.footnote }) }, 'footnote'));
    const stats = diff === undefined ? [] : statSpans(diff.added, diff.removed);
    const time = skinsMs(elapsedMs);
    const meta = [...stats, time === '' ? null : _jsx(Text, { color: 'subtle', children: (stats.length > 0 ? '  ' : '') + time }, 'time'),
        interactive && expandable ? _jsx(Text, { color: hovered ? 'text' : 'subtle', children: open ? '  ▾' : '  ▸' }, 'open') : null];
    const glyphColor = isError ? 'error' : isRunning ? 'subtle' : look.color;
    const row = _jsxs(Box, { flexDirection: 'row', width: o.columns, children: [
        _jsx(Box, { flexShrink: 0, width: 2, children: _jsx(Text, { color: glyphColor, bold: true, children: isError ? '✕' : look.glyph }) }),
        _jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, color: isError ? 'error' : 'text', children: name }) }),
        _jsx(Box, { flexGrow: 1, flexShrink: 1, paddingLeft: 1, children: _jsx(Text, { color: isError ? 'error' : 'subtle', wrap: 'truncate-end', children: target }) }),
        _jsx(Box, { flexShrink: 0, paddingLeft: 2, children: _jsx(Text, { children: meta }) }),
    ] });
    return _jsxs(Box, { ref: viewportRef, flexDirection: 'column', width: o.columns, marginTop: marginTopOnTurn ? 1 : 0, onClick,
        backgroundColor: isSelected ? 'messageActionsBackground' : undefined,
        onMouseEnter: interactive ? () => setHovered(true) : undefined, onMouseLeave: interactive ? () => setHovered(false) : undefined,
        children: [row, ...body] });
}

/** The typed prompt in a rounded outline that hugs its text. */
export function renderSkinsUserPrompt({ text, columns, marginTopOnTurn, onClick, isSelected }) {
    const lines = wrapWidth(text, Math.max(1, columns - 6));
    return _jsx(Box, { flexDirection: 'column', marginTop: marginTopOnTurn ? 1 : 0, onClick, children:
            _jsx(Box, { borderStyle: 'round', borderColor: 'subtle', paddingX: 1, alignSelf: 'flex-start', flexDirection: 'column',
                backgroundColor: isSelected ? 'messageActionsBackground' : undefined,
                children: lines.map((line, index) => _jsx(Text, { color: 'text', children: line || ' ' }, index)) }) });
}

const PHASES = {
    thinking: { word: 'Thinking', frames: ['◉', '◎'], every: 600 },
    'tool-use': { word: 'Running a tool', frames: ['◜', '◝', '◞', '◟'], every: 120 },
    'tool-input': { word: 'Running a tool', frames: ['◜', '◝', '◞', '◟'], every: 120 },
    responding: { word: 'Writing the reply', frames: ['▁▃▅', '▃▅▇', '▅▇▅', '▇▅▃', '▅▃▁', '▃▁▃'], every: 140 },
    requesting: { word: 'Waiting', frames: ['•··', '·•·', '··•', '·•·'], every: 220 },
};
/** The spinner: a glyph per phase, the phase word with a band of light across it. */
export function renderSkinsSpinner({ viewportRef, mode, time, reducedMotion, elapsedTimeMs, formatDuration }) {
    const phase = PHASES[mode] ?? PHASES.requesting;
    const frame = reducedMotion ? 0 : Math.floor(time / phase.every) % phase.frames.length;
    const letters = [...phase.word];
    const head = reducedMotion ? -10 : (Math.floor(time / 70) % (letters.length + 10)) - 5;
    const runs = [];
    for (const [index, letter] of letters.entries()) {
        const distance = Math.abs(index - head);
        const color = distance === 0 ? 'text' : distance <= 2 ? 'inactive' : 'subtle';
        const bold = distance === 0;
        const last = runs[runs.length - 1];
        if (last !== undefined && last.color === color && last.bold === bold)
            last.text += letter;
        else
            runs.push({ color, bold, text: letter });
    }
    return _jsxs(Box, { ref: viewportRef, flexDirection: 'row', flexWrap: 'wrap', marginTop: 1, width: '100%', children: [
        _jsx(Box, { flexShrink: 0, width: stringWidth(phase.frames[0]) + 1, children: _jsx(Text, { color: 'text', children: phase.frames[frame] }) }),
        _jsx(Text, { children: runs.map((run, index) => _jsx(Text, { color: run.color, bold: run.bold, children: run.text }, index)) }),
        _jsx(Text, { color: 'subtle', children: '  ' + formatDuration(elapsedTimeMs) }),
    ] });
}

/** Plan-limit meters from the ceulen usage field (`Go · 5h 98% 1H · W 79% 3D · M 3% 3D`,
 *  percent = what is LEFT). The context meter stays in the stock footer, which already shows it. */
export function skinsMeters(fields) {
    let provider;
    const meters = [];
    for (const field of fields ?? []) {
        const text = String(field?.text ?? '');
        const found = [...text.matchAll(/(?:^|·\s*)(5h|W|M) (\d{1,3})%(?: (\d+[MHD]))?/g)];
        if (found.length === 0)
            continue;
        const head = text.split(' · ')[0]?.trim();
        if (provider === undefined && head !== undefined && head !== '' && !/^(5h|W|M) \d/.test(head))
            provider = head;
        for (const match of found)
            meters.push({ label: match[1] === 'W' ? '7d' : match[1] === 'M' ? 'month' : '5h', percent: Math.max(0, Math.min(100, 100 - Number(match[2]))), reset: match[3] });
    }
    return { provider, meters };
}

/** The footer without the fields the skins band already draws (no duplicate usage). */
export function skinsFooterFields(style, fields) {
    if (style !== 'skins' || !Array.isArray(fields))
        return fields;
    const kept = fields.filter(field => skinsMeters([field]).meters.length === 0);
    return kept.length === fields.length ? fields : kept;
}

/** The settled thinking marker in the skins style (stock: ⚓): the DSH whale resting in the water. */
export const SKINS_THINKING_MARKER = '∼🐋∽';

// While reasoning streams the whale swims left along a 7-cell track and comes round
// again; the water ripples (∼/∽ swap every step). 🐋 takes two cells, so every frame
// is 7 cells and the label never shifts.
const WHALE_TRACK = 7;
const WHALE_POSITIONS = [5, 4, 3, 2, 1, 0];
const WHALE_STEP_MS = 200;
export function skinsWhaleFrame(frame, intervalMs) {
    const step = Math.floor((frame * intervalMs) / WHALE_STEP_MS);
    const at = WHALE_POSITIONS[step % WHALE_POSITIONS.length];
    let line = '';
    for (let cell = 0; cell < WHALE_TRACK; cell++) {
        if (cell === at) {
            line += '🐋';
            cell++;
            continue;
        }
        line += (cell + step) % 2 === 0 ? '∼' : '∽';
    }
    return line;
}

/** The live `Thinking…` label with the same band of light as the skins spinner. */
export function renderSkinsThinkingLabel(label, frame, hovered) {
    const letters = [...label];
    const head = (frame % (letters.length + 10)) - 5;
    return _jsxs(Text, { italic: true, children: [' ', ...letters.map((letter, index) => {
            const distance = Math.abs(index - head);
            return _jsx(Text, { color: distance === 0 || hovered ? 'text' : distance <= 2 ? 'inactive' : 'subtle', bold: distance === 0, children: letter }, index);
        })] });
}

export function SkinsUsageBand({ fields }) {
    const { provider, meters } = skinsMeters(fields);
    if (meters.length === 0)
        return null;
    // marginTop 1 matches the blank row the prompt keeps above itself, so the band sits midway.
    return _jsxs(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, paddingX: 1, marginTop: 1, width: '100%', flexShrink: 0, children: [
        provider === undefined ? null : _jsx(Text, { color: 'subtle', bold: true, children: provider }, 'provider'),
        ...meters.map(meter => {
            const filled = Math.round(meter.percent / 12.5);
            const tone = meter.percent >= 90 ? 'error' : meter.percent >= 70 ? 'warning' : 'text';
            return _jsxs(Text, { children: [
                _jsx(Text, { color: tone, children: '▰'.repeat(filled) }),
                _jsx(Text, { color: 'subtle', children: '▱'.repeat(8 - filled) }),
                _jsx(Text, { color: tone, bold: true, children: ' ' + meter.percent + '%' }),
                _jsx(Text, { color: 'subtle', children: ' ' + meter.label + (meter.reset === undefined ? '' : ' · ' + meter.reset) }),
            ] }, meter.label);
        }),
    ] });
}

/** Table card: rounded frame, header band with a rule under it, zebra rows. Undefined = use the stock table. */
export function renderSkinsTable({ headerCells, rowCells, minWidths, idealWidths, align, terminalWidth, allocateWidths, wrapText, maxRowLines }) {
    const pad = 2;
    const count = headerCells.length;
    const budget = Math.max(0, terminalWidth - 2 - count * pad * 2 - 4);
    const allocation = allocateWidths(minWidths, idealWidths, budget);
    if (allocation.hardWrap)
        return undefined;
    const wrap = (cell, width) => wrapText(cell.formatted, width, false);
    const header = headerCells.map((cell, index) => wrapText(cell.plain.toUpperCase(), allocation.widths[index], false));
    const rows = rowCells.map(row => row.map((cell, index) => wrap(cell, allocation.widths[index])));
    if (Math.max(1, ...header.map(lines => lines.length), ...rows.flat().map(lines => lines.length)) > maxRowLines)
        return undefined;
    const justify = { left: 'flex-start', right: 'flex-end', center: 'center' };
    const line = (cells, isHeader, band, key) => _jsx(Box, { flexDirection: 'row', backgroundColor: band, children: cells.map((lines, index) => _jsx(Box, {
            width: allocation.widths[index] + pad * 2, paddingX: pad, flexShrink: 0, flexDirection: 'column', alignItems: justify[align[index] ?? 'left'] ?? 'flex-start',
            children: lines.map((text, at) => _jsx(Text, { color: isHeader ? 'subtle' : 'text', bold: isHeader, children: text }, at)),
        }, index)) }, key);
    return _jsxs(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', alignSelf: 'flex-start', children: [
        _jsx(Box, { borderStyle: 'single', borderTop: false, borderLeft: false, borderRight: false, borderBottom: true, borderColor: 'subtle', children: line(header, true, undefined, 'head') }),
        ...rows.map((cells, index) => line(cells, false, index % 2 === 1 ? 'toolCardBackground' : undefined, index)),
    ] });
}

/** Code card: language and line count on the header, numbered rows. */
export function renderSkinsCode({ label, body, dimColor }) {
    const rows = body === '' ? [] : body.split('\n');
    const width = String(Math.max(1, rows.length)).length;
    return _jsxs(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', width: '100%', children: [
        _jsxs(Box, { flexDirection: 'row', paddingX: 1, backgroundColor: 'toolCardBackground', children: [
            _jsx(Box, { flexGrow: 1, children: _jsx(Text, { color: 'subtle', bold: true, children: label.toUpperCase() }) }, 'label'),
            _jsx(Box, { flexShrink: 0, children: _jsx(Text, { color: 'subtle', children: rows.length + ' line' + (rows.length === 1 ? '' : 's') }) }, 'count'),
        ] }),
        ...rows.map((row, index) => _jsxs(Box, { flexDirection: 'row', children: [
            // NoSelect is not theme-aware: the themed Box carries the gutter fill.
            _jsx(Box, { flexShrink: 0, backgroundColor: 'toolCardBackgroundDim', children: _jsx(NoSelect, { children: _jsx(Text, { color: 'subtle', children: ' ' + String(index + 1).padStart(width) + ' ' }) }) }),
            _jsx(Box, { flexGrow: 1, flexShrink: 1, paddingLeft: 1, children: _jsx(Text, { dimColor, children: row || ' ' }) }),
        ] }, index)),
    ] });
}
