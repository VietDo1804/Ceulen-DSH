/** ceulen-style: the `thread` layout. One rail per turn and no boxes: the prompt
 *  opens the rail (●), each call hangs off it (├ glyph name target time), a
 *  subagent is a lane (├─◈), and the answer closes it (╰). The plan is pinned
 *  above the prompt. Layout only: every colour is a theme key, and
 *  `/theme ceulen-ink` is the palette it was drawn for. Written into dsh-tui as
 *  lib/types/uiStyleThread.js by scripts/tui-style-patch.mjs. */
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import React from 'react';
import { Box, NoSelect, Text, useAnimationFrame } from './ui.js';
import { TerminalSizeContext } from './ink/components/TerminalSizeContext.js';
import { stringWidth } from './ink/stringWidth.js';
import { wrapWidth } from './sessions/format.js';
import { firstLine, skinsDiffRows, skinsFileRows, skinsMs, skinsPath, targetOf } from './uiStyleSkins.js';

/** Fifteen families, one single-cell glyph and one theme key each. */
const FAMILIES = {
    run: { glyph: '$', color: 'toolDotExec' },
    read: { glyph: '≡', color: 'toolDotRead' },
    search: { glyph: '⌕', color: 'toolDotRead' },
    write: { glyph: '✎', color: 'toolDotWrite' },
    web: { glyph: '◍', color: 'toolDotWeb' },
    agent: { glyph: '◈', color: 'toolDotTask' },
    mem: { glyph: '※', color: 'suggestion' },
    plan: { glyph: '☐', color: 'planMode' },
    check: { glyph: '⊡', color: 'warning' },
    code: { glyph: 'λ', color: 'accent' },
    git: { glyph: '⑂', color: 'ide' },
    mcp: { glyph: '◇', color: 'ide' },
    cron: { glyph: '⟳', color: 'ide' },
    files: { glyph: '▤', color: 'toolDotWrite' },
    cold: { glyph: '◌', color: 'subtle' },
    other: { glyph: '•', color: 'accent' },
};
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const DIFF_ROWS = 10;
const OUTPUT_TAIL = 8;
const ERROR_ROWS = 6;
const OPEN_ROWS = 400;

export function threadFamily(name, category, card) {
    const n = String(name ?? '').toLowerCase();
    if (n === 'ceulen_tools')
        return 'cold';
    if (card === 'files' || n === 'present')
        return 'files';
    if (/^(munin_|agentmem_|rule_get|memory)/.test(n))
        return 'mem';
    if (/^(todo_?write|plan|exit_?plan|enter_?plan)/.test(n))
        return 'plan';
    if (n.startsWith('cron'))
        return 'cron';
    if (/^(github|gh_|git)/.test(n))
        return 'git';
    if (/^(codemode|code_mode)/.test(n))
        return 'code';
    if (/^(validate_|ux_audit|classify|lint|typecheck)/.test(n))
        return 'check';
    if (/^(subagent|delegate|send_message|sendmessage|wait_agent|list_agents|interrupt_agent|advisor|workflow|task|a2a_)/.test(n))
        return 'agent';
    if (n.startsWith('web_') || n === 'webfetch' || n === 'websearch')
        return 'web';
    if (n.startsWith('mcp__') || n.startsWith('serena') || n === 'notebooklm')
        return 'mcp';
    if (card === 'terminal' || category === 'exec' || /^(bash|bashpersistent|sh|shell|terminal|powershell|rtk|job_)/.test(n))
        return 'run';
    if (card === 'diff' || category === 'mutate' || /^(edit|write|multiedit|notebookedit|apply_patch|ast_edit)$/.test(n))
        return 'write';
    if (card === 'read' || n.startsWith('read'))
        return 'read';
    if (card === 'search' || /grep|glob|fff|jfind|find|search|ast_grep/.test(n))
        return 'search';
    return 'other';
}

const TARGET_KEYS = ['path', 'file_path', 'filePath', 'pattern', 'query', 'command', 'cmd', 'url', 'name', 'task', 'prompt', 'description', 'role', 'op'];
/** A target that is still raw JSON arguments reads as its most telling value instead. */
export function threadTarget(text) {
    const raw = String(text ?? '').trim();
    if (!raw.startsWith('{'))
        return raw;
    // A patch names its files; show those rather than the patch header.
    const files = [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/g)].map(match => skinsPath(match[1].trim()));
    if (files.length > 0)
        return files[0] + (files.length > 1 ? ' +' + (files.length - 1) : '');
    let args;
    try {
        args = JSON.parse(raw);
    }
    catch {
        // Truncated JSON: take the first quoted value.
        const match = raw.match(/^\{\s*"[^"]+"\s*:\s*"((?:[^"\\]|\\.)*)/);
        return match === null ? raw : firstLine(match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
    if (args === null || typeof args !== 'object')
        return raw;
    const key = TARGET_KEYS.find(name => typeof args[name] === 'string' && args[name].trim() !== '');
    const value = key !== undefined ? args[key] : Object.values(args).find(entry => typeof entry === 'string' && entry.trim() !== '');
    if (value !== undefined)
        return firstLine(value);
    if (Array.isArray(args.todos))
        return args.todos.length + ' step' + (args.todos.length === 1 ? '' : 's');
    return '';
}

/** A lane is a call that runs another agent. */
export function threadIsLane(name) {
    return threadFamily(name) === 'agent';
}

// ── the rail ────────────────────────────────────────────────────────────────

const RAIL_MARK = { open: '●', step: '├', lane: '├─', think: '┊', flow: '│', close: '╰', after: ' ' };
const RAIL_STEP = new Set(['step', 'lane']);
const borderOf = left => ({ topLeft: ' ', top: ' ', topRight: ' ', right: ' ', bottomRight: ' ', bottom: ' ', bottomLeft: ' ', left });

/**
 * One rail per turn. A turn starts at a prompt row and runs to the row before
 * the next prompt; it is closed once a later prompt exists or the agent is
 * idle. Consecutive calls sit flush on the rail; every other block keeps the
 * stock one-row gap, drawn as rail.
 */
export function threadRailMap(rows, margins, working) {
    const rails = new Map();
    let turn = [];
    const flush = closed => {
        if (turn.length === 0)
            return;
        let close = -1;
        if (closed)
            for (let i = turn.length - 1; i >= 0; i--) {
                if (turn[i].kind !== 'turn-summary' && !(i === 0 && opens(turn[i]))) {
                    close = i;
                    break;
                }
            }
        const end = close >= 0 ? close : turn.length - 1;
        let prev;
        turn.forEach((row, i) => {
            let kind;
            if (i === 0 && opens(row))
                kind = 'open';
            else if (i === close)
                kind = 'close';
            else if (close >= 0 && i > close)
                kind = 'after';
            else if (row.kind === 'reasoning')
                kind = 'think';
            else if (row.kind === 'subagent' || (row.kind === 'tool' && threadIsLane(row.tool?.name)))
                kind = 'lane';
            else if (row.kind === 'tool' || row.kind === 'job' || row.kind === 'compact' || row.kind === 'user')
                kind = 'step';
            else
                kind = 'flow';
            const gap = margins.get(row.id) === true;
            // Calls on the rail sit flush; a summary hugs the answer it closes.
            const margin = kind === 'after' ? false : RAIL_STEP.has(kind) && RAIL_STEP.has(prev) ? false : gap;
            rails.set(row.id, { kind, margin, cont: kind !== 'close' && kind !== 'after' && i < end, lead: kind !== 'open' && i > 0 });
            prev = kind;
        });
        turn = [];
    };
    // A team message (a child writing to its parent) arrives mid-turn: it hangs on the rail, it does not open a turn.
    const opens = row => row.kind === 'user' && row.label !== 'team-message';
    for (const row of rows) {
        if (opens(row))
            flush(true);
        turn.push(row);
    }
    flush(!working);
    return rails;
}

/** A transcript row on the rail: the gutter draws the mark and its continuation;
 *  the body is told it has two fewer columns, so it wraps inside the rail. */
export function renderThreadRow({ rail, rowRef, size, body }) {
    const mark = RAIL_MARK[rail.kind] ?? '│';
    const below = rail.kind === 'think' ? '┊' : rail.cont ? '│' : undefined;
    const columns = Math.max(8, size.columns - 2);
    const row = _jsxs(Box, { flexDirection: 'row', width: size.columns, children: [
        _jsx(NoSelect, { flexShrink: 0, children: _jsxs(Box, { flexDirection: 'column', width: 2, flexShrink: 0, children: [
            _jsx(Text, { color: rail.kind === 'open' ? 'accent' : 'subtle', bold: rail.kind === 'open', children: mark }),
            below === undefined ? null : _jsx(Box, { flexGrow: 1, borderStyle: borderOf(below), borderTop: false, borderRight: false, borderBottom: false, borderColor: 'subtle' }),
        ] }) }),
        _jsx(TerminalSizeContext.Provider, { value: { ...size, columns }, children: _jsx(Box, { flexDirection: 'column', width: columns, flexShrink: 0, children: body }) }),
    ] });
    return _jsxs(Box, { flexDirection: 'column', ref: rowRef, children: [
        rail.margin ? _jsx(Text, { color: 'subtle', children: rail.lead ? '│' : ' ' }) : null,
        row,
    ] });
}

// ── calls ───────────────────────────────────────────────────────────────────

function ThreadSpin() {
    const [ref, time] = useAnimationFrame(80);
    return _jsx(Box, { ref, flexShrink: 0, width: 2, children: _jsx(Text, { color: 'accent', children: SPIN[Math.floor(time / 80) % SPIN.length] }) });
}

function hang(children, key, tint) {
    return _jsxs(Box, { flexDirection: 'row', paddingLeft: 2, backgroundColor: tint, children: [
        _jsx(NoSelect, { flexShrink: 0, children: _jsx(Text, { color: 'subtle', children: '╎ ' }) }),
        _jsx(Box, { flexGrow: 1, flexShrink: 1, children }),
    ] }, key);
}

function moreRow(hidden, key) {
    return hang(_jsx(Text, { color: 'subtle', children: '▾ ' + hidden + ' more line' + (hidden === 1 ? '' : 's') }), key);
}

function diffRows({ rows, open }) {
    const shown = open ? rows.slice(0, OPEN_ROWS) : rows.slice(0, DIFF_ROWS);
    const numbered = rows.some(row => row.oldNo !== undefined || row.newNo !== undefined);
    const digits = Math.max(1, ...rows.map(row => String(row.newNo ?? row.oldNo ?? '').length));
    const out = shown.map((row, index) => {
        if (row.kind === 'gap')
            return hang(_jsx(Text, { color: 'subtle', children: '⋯' }), 'd' + index);
        if (row.kind === 'path')
            return hang(_jsx(Text, { color: 'text', bold: true, children: row.text }), 'd' + index);
        const tint = row.kind === 'del' ? 'diffRemoved' : row.kind === 'add' ? 'diffAdded' : undefined;
        const word = row.kind === 'del' ? 'diffRemovedWord' : row.kind === 'add' ? 'diffAddedWord' : 'subtle';
        const number = numbered ? String(row.newNo ?? row.oldNo ?? '').padStart(digits) + ' ' : '';
        return hang(_jsxs(Text, { children: [
            _jsx(Text, { color: 'subtle', children: number }),
            _jsx(Text, { color: word, bold: row.kind !== 'ctx', children: (row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : ' ') + ' ' }),
            _jsx(Text, { color: row.kind === 'ctx' ? 'subtle' : 'text', children: row.text || ' ' }),
        ] }), 'd' + index, tint);
    });
    if (rows.length > shown.length)
        out.push(moreRow(rows.length - shown.length, 'd-more'));
    return out;
}

/**
 * The thread call row: glyph, name, target, and its own time on the right.
 * Output folds away unless the call failed or the row is open; a failed call
 * keeps its tail open under the rail. Returns undefined to keep the stock card.
 */
export function renderThreadTool(o) {
    const { tool, view, name, sendMessage, isRunning, isError, elapsedMs, interactive, hovered, setHovered, isSelected, onClick, marginTopOnTurn, viewportRef } = o;
    if (sendMessage !== undefined)
        return undefined;
    const open = o.verbose || o.isExpanded;
    const family = threadFamily(tool.name, view?.category ?? tool.callView?.category, view?.card);
    const look = FAMILIES[family];
    const lane = family === 'agent';
    const target = threadTarget(targetOf({ name, title: o.title, displayArgs: o.displayArgs, filePath: o.filePath }));
    const rv = tool.resultView;
    const diff = !isError && view?.card === 'diff' ? skinsDiffRows(view.diffs) : undefined;
    const body = [];
    let expandable = false;
    let verdict;
    if (isError) {
        const lines = String(tool.errorText ?? '').replace(/\s+$/, '').split('\n').filter(line => line !== '');
        const shown = open ? lines : lines.slice(-ERROR_ROWS);
        body.push(...shown.map((line, index) => hang(_jsx(Text, { color: 'error', children: line }), 'e' + index)));
        if (shown.length < lines.length) {
            expandable = true;
            body.unshift(moreRow(lines.length - shown.length, 'e-more'));
        }
    }
    else if (diff !== undefined && diff.rows.length > 0) {
        body.push(...diffRows({ rows: diff.rows, open }));
        expandable = diff.rows.length > DIFF_ROWS;
    }
    else if (view?.card === 'terminal') {
        const output = rv !== undefined && rv.card === 'terminal' && 'output' in rv ? String(rv.output ?? '') : '';
        const failed = (rv?.exitCode !== undefined && rv.exitCode !== 0) || rv?.signal !== undefined;
        if (failed)
            verdict = rv?.signal !== undefined ? '✗ ' + String(rv.signal) : '✗ exit ' + rv.exitCode;
        const lines = output.replace(/\s+$/, '').split('\n').filter((line, index, all) => all.length > 1 || line !== '');
        expandable = lines.length > 0 && !failed;
        if (isRunning)
            body.push(...(o.liveLines ?? []).slice(-3).map((line, index) => hang(_jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: line.text }), 'l' + index)));
        else if (open || failed) {
            const shown = open ? lines.slice(0, OPEN_ROWS) : lines.slice(-OUTPUT_TAIL);
            if (!open && shown.length < lines.length)
                body.push(moreRow(lines.length - shown.length, 'o-more'));
            body.push(...shown.map((line, index) => hang(_jsx(Text, { color: line.trim() === '[stderr]' ? 'error' : failed ? 'text' : 'subtle', children: line || ' ' }), 'o' + index)));
            expandable = expandable || lines.length > shown.length;
        }
    }
    else if (view?.card === 'files') {
        body.push(...skinsFileRows(o.lines, o.onOpenFile));
    }
    else {
        const lines = (o.lines ?? []).filter(line => line.tone !== 'hint');
        expandable = lines.length > 0;
        if (open)
            body.push(...lines.map((line, index) => hang(_jsx(Text, { color: line.tone === 'error' ? 'error' : line.tone === 'dim' ? 'subtle' : 'text', children: line.text || ' ' }), 'r' + index)));
        else if (isRunning && (o.liveLines ?? []).length > 0)
            body.push(...o.liveLines.slice(-3).map((line, index) => hang(_jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: line.text }), 'l' + index)));
        else if (lane && !isRunning) {
            // A lane shows the task while it runs and the child's answer once done.
            const answer = firstLine(tool.resultText);
            if (answer !== '' && !/^[[{]/.test(answer))
                body.push(hang(_jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: answer }), 'answer'));
        }
    }
    if (o.footnote !== undefined)
        body.push(hang(_jsx(Text, { color: 'subtle', children: o.footnote }), 'footnote'));
    const time = isRunning ? '' : skinsMs(elapsedMs);
    const meta = [
        diff !== undefined && diff.added + diff.removed > 0 ? _jsxs(Text, { children: [
            _jsx(Text, { color: 'diffAddedWord', children: '+' + diff.added }),
            _jsx(Text, { color: 'diffRemovedWord', children: ' −' + diff.removed }),
            '  '] }, 'stat') : null,
        verdict === undefined ? null : _jsx(Text, { color: 'error', bold: true, children: verdict + '  ' }, 'verdict'),
        time === '' ? null : _jsx(Text, { color: 'subtle', children: time }, 'time'),
        interactive && expandable ? _jsx(Text, { color: hovered ? 'text' : 'subtle', children: open ? '  ▾' : '  ▸' }, 'open') : null,
    ];
    const failed = isError || verdict !== undefined;
    const glyph = isRunning
        ? _jsx(ThreadSpin, {}, 'spin')
        : _jsx(Box, { flexShrink: 0, width: 2, children: _jsx(Text, { color: failed ? 'error' : look.color, bold: true, children: failed ? '✗' : look.glyph }) });
    const row = _jsxs(Box, { flexDirection: 'row', width: o.columns, children: [
        glyph,
        _jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, color: failed ? 'error' : lane ? 'toolDotTask' : 'text', children: name }) }),
        _jsx(Box, { flexGrow: 1, flexShrink: 1, paddingLeft: 1, children: _jsx(Text, { color: failed ? 'error' : 'subtle', wrap: 'truncate-end', children: target }) }),
        _jsx(Box, { flexShrink: 0, paddingLeft: 2, children: _jsx(Text, { children: meta }) }),
    ] });
    return _jsxs(Box, { ref: viewportRef, flexDirection: 'column', width: o.columns, marginTop: marginTopOnTurn ? 1 : 0, onClick,
        backgroundColor: isSelected ? 'messageActionsBackground' : undefined,
        onMouseEnter: interactive ? () => setHovered(true) : undefined, onMouseLeave: interactive ? () => setHovered(false) : undefined,
        children: [row, ...body] });
}

/** The typed prompt: plain bold text beside the rail's ●. */
export function renderThreadUserPrompt({ text, columns, marginTopOnTurn, onClick, isSelected }) {
    return _jsx(Box, { flexDirection: 'column', marginTop: marginTopOnTurn ? 1 : 0, onClick,
        backgroundColor: isSelected ? 'messageActionsBackground' : undefined,
        children: wrapWidth(text, Math.max(1, columns - 1)).map((line, index) => _jsx(Text, { color: 'text', bold: true, children: line || ' ' }, index)) });
}

// ── subagent lanes ──────────────────────────────────────────────────────────

function clockOf(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

/** A native subagent as a lane: who, the task, a call count and the clock.
 *  Never the child's tool names; open the row (Ctrl+O) for the stock card. */
export function ThreadLane({ subagent, marginTopOnTurn, onClick }) {
    const running = subagent.status === 'running' || subagent.status === 'starting';
    const [ref] = useAnimationFrame(running ? 1000 : null);
    const failed = subagent.status === 'failed' || subagent.status === 'cancelled';
    const calls = subagent.reportedToolUses ?? subagent.toolCalls?.length ?? 0;
    const end = subagent.endedAt ?? subagent.completedAt;
    const ms = subagent.reportedDurationMs ?? ((end ?? Date.now()) - subagent.startedAt);
    const clock = running ? clockOf(Date.now() - subagent.startedAt) : skinsMs(ms);
    // The child's last own words: text events first, never its ⏵ narration lines.
    const said = line => String(line ?? '').trim() !== '' && !/^\s*⏵/.test(String(line));
    const events = (subagent.outputEvents ?? []).filter(event => event.kind === 'text').map(event => event.text);
    const lastText = [...(events.length > 0 ? events : subagent.output ?? [])].reverse().find(said);
    // A child that answered by message leaves only narration here; its message row carries the answer.
    const answer = failed ? (subagent.error ?? subagent.status) : firstLine([subagent.summary, lastText].find(said) ?? '');
    return _jsxs(Box, { ref, flexDirection: 'column', marginTop: marginTopOnTurn ? 1 : 0, onClick, children: [
        _jsxs(Box, { flexDirection: 'row', children: [
            running ? _jsx(ThreadSpin, {}) : _jsx(Box, { flexShrink: 0, width: 2, children: _jsx(Text, { color: failed ? 'error' : 'toolDotTask', bold: true, children: failed ? '✗' : '◈' }) }),
            _jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, color: failed ? 'error' : 'toolDotTask', children: subagent.name ?? 'agent' }) }),
            _jsx(Box, { flexGrow: 1, flexShrink: 1, paddingLeft: 1, children: _jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: firstLine(subagent.description) }) }),
            _jsx(Box, { flexShrink: 0, paddingLeft: 2, children: _jsx(Text, { color: 'subtle', children: calls + ' call' + (calls === 1 ? '' : 's') + ' · ' + clock }) }),
        ] }),
        !running && answer !== '' ? hang(_jsx(Text, { color: failed ? 'error' : 'subtle', wrap: 'truncate-end', children: answer }), 'answer') : null,
    ] });
}

// ── the plan dock ───────────────────────────────────────────────────────────

const FLASH_MS = 1100;
const HOLD_MS = 2600;
const DOCK_ROWS = 8;

/**
 * The todo board pinned above the prompt. A step that just finished flashes
 * `✓ … done`, then settles struck through and dim; ▸ marks the step in
 * progress; once every step is done the dock says so, holds, and folds away.
 * `collapsed` (ctrl+q, or a click on the header) keeps only the header line.
 */
export function ThreadPlanDock({ channel, collapsed = false, onToggle }) {
    const todos = channel.todos ?? [];
    const seen = React.useRef(undefined);
    const doneAt = React.useRef(undefined);
    const now = Date.now();
    if (seen.current === undefined) {
        // Steps already done when the dock mounts never flash.
        seen.current = new Map(todos.filter(todo => todo.status === 'completed').map(todo => [todo.content, 0]));
    }
    for (const todo of todos)
        if (todo.status === 'completed' && !seen.current.has(todo.content))
            seen.current.set(todo.content, now);
    const done = todos.filter(todo => todo.status === 'completed').length;
    const allDone = todos.length > 0 && done === todos.length;
    if (allDone && doneAt.current === undefined)
        doneAt.current = now;
    if (!allDone)
        doneAt.current = undefined;
    const flashing = todos.some(todo => todo.status === 'completed' && now - (seen.current.get(todo.content) ?? 0) < FLASH_MS);
    const holding = allDone && now - doneAt.current < HOLD_MS;
    const [ref, time] = useAnimationFrame(flashing || holding ? 100 : todos.some(todo => todo.status === 'in_progress') ? 400 : null);
    if (todos.length === 0 || (allDone && !holding))
        return null;
    const filled = Math.round((done / todos.length) * 8);
    const active = todos.find(todo => todo.status === 'in_progress') ?? todos.find(todo => todo.status === 'pending');
    const header = _jsxs(Box, { flexDirection: 'row', onClick: onToggle, children: [
        _jsx(Text, { color: allDone ? 'success' : 'planMode', bold: true, children: allDone ? '✓ ' : '☐ ' }),
        _jsx(Text, { color: 'text', bold: true, children: 'Plan ' }),
        _jsx(Text, { color: allDone ? 'success' : 'subtle', children: allDone ? 'all ' + todos.length + ' done ' : done + '/' + todos.length + ' ' }),
        _jsx(Text, { color: allDone ? 'success' : 'accent', children: '━'.repeat(filled) }),
        _jsx(Text, { color: 'subtle', children: '─'.repeat(8 - filled) }),
        collapsed && active !== undefined && !allDone ? _jsx(Box, { flexShrink: 1, paddingLeft: 2, children: _jsx(Text, { color: 'text', wrap: 'truncate-end', children: '▸ ' + active.content }) }) : null,
    ] });
    if (collapsed)
        return _jsx(Box, { ref, flexDirection: 'column', paddingX: 1, marginTop: 1, flexShrink: 0, children: header });
    const shimmer = Math.floor(time / 400) % 2 === 0;
    const shown = todos.slice(0, DOCK_ROWS);
    const rows = shown.map((todo, index) => {
        let glyph;
        let text;
        if (todo.status === 'completed' && now - (seen.current.get(todo.content) ?? 0) < FLASH_MS) {
            glyph = _jsx(Text, { color: 'success', bold: true, children: '✓ ' });
            text = _jsxs(Text, { color: 'success', bold: true, wrap: 'truncate-end', children: [todo.content, '  done'] });
        }
        else if (todo.status === 'completed') {
            glyph = _jsx(Text, { color: 'subtle', children: '✓ ' });
            text = _jsx(Text, { color: 'subtle', dimColor: true, strikethrough: true, wrap: 'truncate-end', children: todo.content });
        }
        else if (todo.status === 'in_progress') {
            glyph = _jsx(Text, { color: shimmer ? 'accentShimmer' : 'accent', bold: true, children: '▸ ' });
            text = _jsx(Text, { color: 'text', bold: true, wrap: 'truncate-end', children: todo.content });
        }
        else {
            glyph = _jsx(Text, { color: 'subtle', children: '○ ' });
            text = _jsx(Text, { color: 'subtle', wrap: 'truncate-end', children: todo.content });
        }
        return _jsxs(Box, { flexDirection: 'row', paddingLeft: 2, children: [glyph, _jsx(Box, { flexShrink: 1, children: text })] }, index);
    });
    if (todos.length > shown.length)
        rows.push(_jsx(Box, { paddingLeft: 4, children: _jsx(Text, { color: 'subtle', children: '+' + (todos.length - shown.length) + ' more' }) }, 'more'));
    return _jsxs(Box, { ref, flexDirection: 'column', paddingX: 1, marginTop: 1, flexShrink: 0, children: [header, ...rows] });
}

// ── the footer ──────────────────────────────────────────────────────────────

const THREAD_BRAND = 'DEEPSEEK HARNESS';
const BRAND_STEP_MS = 90;
/** Bold accent text with a band of light sweeping across it, every 2.4 s while the
 *  agent works and every 8 s when idle. The footer's model name and its
 *  DEEPSEEK HARNESS corner both use it; `lead` starts the sweep later. */
function ThreadShimmer({ text, working, lead = 0 }) {
    const [ref, time] = useAnimationFrame(BRAND_STEP_MS);
    const letters = [...String(text)];
    const period = working ? 2400 : 8000;
    const head = Math.floor((time % period) / BRAND_STEP_MS) - 3 - lead;
    return _jsx(Box, { ref, flexShrink: 1, overflow: 'hidden', children: _jsx(Text, { bold: true, wrap: 'truncate-end', children: letters.map((letter, index) => {
            const distance = Math.abs(index - head);
            return _jsx(Text, { color: distance === 0 ? 'text' : distance <= 2 ? 'accentShimmer' : 'accent', children: letter }, index);
        }) }) });
}

/**
 * The thread footer, one line read from the left: model · effort, the PLAN MODE
 * badge, full access, tok/s, cache hit, ctx and the branch; the DEEPSEEK HARNESS
 * brand sits in the right corner. Plan limits live in the usage band above the
 * prompt (shared with skins). When the line is too narrow, the brand goes
 * first, then full access, the branch and the effort; the badge, tok/s, cache
 * and ctx always stay. PLAN MODE shows on every model while plan mode is on.
 */
export function renderThreadFooter({ channel, columns, fields = [], backendMode, occupancy, cacheRate, modelPicker }) {
    const model = String(channel.modelDisplay ?? channel.model ?? '');
    const planOn = channel.mode?.plan === true || backendMode?.id === 'plan';
    const fullAccess = backendMode === undefined ? channel.mode?.sandbox === 'danger-full-access' : backendMode.id === 'bypassPermissions';
    const known = new Set(['ceulen:usage']);
    const others = fields.filter(field => field !== undefined && !known.has(field.key) && field.text);
    const left = [
        { id: 'model', text: model, color: 'text', bold: true, onClick: modelPicker?.onOpen },
        channel.reasoningEffort ? { id: 'effort', text: ' · ' + channel.reasoningEffort, color: 'subtle', drop: 1 } : undefined,
        planOn ? { id: 'plan', text: '  PLAN MODE', color: 'planMode', bold: true } : undefined,
        fullAccess ? { id: 'access', text: '  full access', color: 'warning', drop: 6 } : undefined,
    ].filter(Boolean);
    const tps = channel.tps;
    const right = [
        // The host measures tok/s only once a stream ran long enough; until then the slot holds a dash.
        tps !== undefined && Number.isFinite(tps) ? { id: 'tps', text: Math.round(tps) + ' tok/s', color: channel.working ? 'text' : 'subtle' } : { id: 'tps', text: '– tok/s', color: 'subtle' },
        cacheRate !== undefined ? { id: 'cache', text: 'cache ' + Math.round(Number.parseFloat(cacheRate)) + '%', color: 'subtle' } : undefined,
        ...others.map(field => ({ id: 'f:' + field.key, text: String(field.text), color: 'subtle', drop: 8 })),
    ].filter(Boolean);
    if (occupancy?.contextWindow > 0) {
        const pct = (occupancy.usedTokens / occupancy.contextWindow) * 100;
        right.push({ id: 'ctx', text: 'ctx ' + (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%', color: pct >= 95 ? 'error' : pct >= 80 ? 'warning' : 'subtle' });
    }
    if (channel.gitBranch)
        right.push({ id: 'branch', text: '⑂ ' + channel.gitBranch, color: 'ide', bold: true, drop: 5 });
    const GAP = 2;
    const width = (parts, gap) => parts.reduce((sum, part, index) => sum + stringWidth(part.text) + (index > 0 ? gap : 0), 0);
    let shownLeft = left;
    let shownRight = right;
    let brand = true;
    const budget = Math.max(10, columns - 2);
    // Everything reads as one group from the left; the brand sits in the right corner.
    const total = () => width(shownLeft, 0) + GAP + width(shownRight, GAP) + (brand ? GAP + stringWidth(THREAD_BRAND) : 0);
    // Drop the lowest-priority parts first: other plugin fields, the brand, full access, branch, effort.
    for (const level of [8, 7, 6, 5, 4, 3, 2, 1]) {
        if (total() <= budget)
            break;
        if (level === 7)
            brand = false;
        shownLeft = shownLeft.filter(part => part.drop !== level);
        shownRight = shownRight.filter(part => part.drop !== level);
    }
    // Still too wide: only the model name gives way (at least six cells).
    const span = (part, gap) => _jsxs(Box, { flexShrink: part.id === 'model' ? 1 : 0, minWidth: part.id === 'model' ? Math.min(6, stringWidth(part.text)) : undefined, onClick: part.onClick, children: [
        gap ? _jsx(Text, { children: ' '.repeat(GAP) }) : null,
        part.id === 'model'
            ? _jsx(ThreadShimmer, { text: part.text, working: channel.working === true })
            : _jsx(Text, { color: part.color, bold: part.bold === true, wrap: 'truncate-end', children: part.text }),
    ] }, part.id);
    return _jsxs(Box, { paddingX: 1, width: columns, flexShrink: 0, flexDirection: 'row', justifyContent: 'space-between', children: [
        _jsxs(Box, { flexDirection: 'row', flexShrink: 1, overflow: 'hidden', children: [
            ...shownLeft.map(part => span(part, false)),
            ...shownRight.map(part => span(part, true)),
        ] }),
        brand ? _jsx(Box, { flexShrink: 0, paddingLeft: GAP, children: _jsx(ThreadShimmer, { text: THREAD_BRAND, working: channel.working === true, lead: 4 }) }) : null,
    ] });
}

/** The todo board is pinned in the dock, so the todoview status line would repeat it. */
export function threadStatusEntries(style, entries) {
    if (style !== 'thread' || !Array.isArray(entries))
        return entries;
    const kept = entries.filter(entry => !String(entry?.key ?? '').endsWith('ceulen:todo'));
    return kept.length === entries.length ? entries : kept;
}
