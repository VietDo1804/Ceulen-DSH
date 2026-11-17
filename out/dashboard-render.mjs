import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Writable, PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { stripVTControlCharacters } from 'node:util'
import { createDashboardScene } from '../lib/modules/dashboard/scene.js'
const host = process.env.DASHBOARD_TUI_ROOT
assert(host, 'Set DASHBOARD_TUI_ROOT to the installed TUI package root')
const require = createRequire(`${host}/package.json`)
const React = require('react')
const ui = await import(pathToFileURL(`${host}/lib/types/ui.js`).href)
const { stringWidth: width } = await import(pathToFileURL(`${host}/lib/types/ink/stringWidth.js`).href)
const Scene = createDashboardScene()
for (const [columns, rows] of [[80, 24], [120, 40], [45, 18], [20, 8]]) {
  const frames = []
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frames.push(String(chunk)); done() } }), { columns, rows, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {}, isRaw: false })
  let listener
  let closed = 0
  let disposed = 0
  const channel = {
    sessionId: 'render-session', agentBindingGeneration: 1, provider: 'test', model: 'test', status: 'idle',
    tokens: { input: 1200, output: 300 },
    lastUserText: 'Render request',
    todos: [
      { content: 'Checklist item', status: 'in_progress' },
      { content: 'Second item', status: 'pending' },
    ],
    team: { enabled: true, tasks: Array.from({ length: 25 }, (_, i) => ({ id: String(i), subject: `Task ${i} 你好 👩‍💻 ${'long '.repeat(80)}`, status: 'pending', ownerName: 'worker', ready: false, blockedBy: ['0'], writeScopes: ['src/**'], writeScopeWarnings: ['overlap'], description: 'DETAIL '.repeat(300) })) },
    subagents: [{ agentId: 'child', runId: 'run1', name: 'child-worker', status: 'running', provider: 'native', model: 'test', tokens: { input: 2400, output: 0 }, toolCalls: [
      { name: 'old-a', status: 'ok', startedAt: 1 },
      { name: 'old-b', status: 'ok', startedAt: 2 },
      { name: 'recent-a', status: 'ok', startedAt: 3 },
      { name: 'recent-b', status: 'ok', startedAt: 4 },
      { name: 'live-tool', status: 'running', startedAt: 0 },
    ], outputEvents: [{ kind: 'thinking', text: 'MUST_NOT_APPEAR', at: 1 }] }],
    subscribe(fn) { listener = fn; return () => { disposed++ } }, subscribeAgentView() { return () => { disposed++ } },
  }
  const instance = ui.renderSync(React.createElement(Scene, { React, ui, channel, close() { closed++ } }), { stdout, stdin, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  // Let the open frame commit before reading the first capture.
  await new Promise(resolve => setTimeout(resolve, 900))
  // Raw chunk stream, kept for debugging only: it embeds live animation frames, so writing it
  // on every run would churn a tracked file. Opt in when you actually need it.
  if (process.env.DASHBOARD_DEBUG_DUMP === '1') writeFileSync(`out/dashboard-render-debug-${columns}.txt`, frames.join(''))
  const frame = stripVTControlCharacters(frames.filter(frame => stripVTControlCharacters(frame).includes(columns < 30 ? 'Too small' : 'CEULEN · dashboard')).at(-1) ?? '')
  assert(frame, `No native frame at ${columns}x${rows}`)
  assert(!frame.includes('MUST_NOT_APPEAR'))
  // The overview is Tasks + Workflow only: no KPI strip, sparkline, or activity feed.
  assert(!frame.includes('TASKS') && !frame.includes('AGENTS') && !frame.includes('Activity ·'))
  const lines = frame.trimEnd().split('\n')
  assert(lines.length <= rows, `Height overflow ${lines.length}/${rows}`)
  assert(lines.every(line => width(line) <= columns), `Cell overflow at ${columns}`)
  if (columns >= 30) {
    assert(frame.includes('Esc: chat'))
    assert(frame.includes('Tasks') && frame.includes('Workflow'))
    // 120 columns lays both region cards out side by side; narrower terminals tab between them.
    if (columns >= 120) assert(frame.includes('child-worker') && frame.includes('Lead'), 'Workflow card is missing')
    else assert(frame.includes('[Tasks]') && !frame.includes('child-worker'), 'Narrow tabs should start on Tasks')
    // Check the real narrow Workflow tab too, not just the default Tasks tab.
    stdin.write('\t'); await settle()
    stdin.write('\x1b[B'); await settle()
    const workflow = stripVTControlCharacters(frames.at(-1) ?? '')
    for (const expected of ['└─', 'child-worker', 'IN 2.4k / OUT 0', 'live-tool', 'recent-a', 'recent-b', '+2 earlier']) assert(workflow.includes(expected), `Missing workflow content at ${columns}: ${expected}`)
    assert(!workflow.includes('old-a') && !workflow.includes('old-b'), 'More than three tool previews rendered')
    stdin.write('\t'); await settle()
    stdin.write('\r'); await settle()
    const detail = stripVTControlCharacters(frames.at(-1) ?? '')
    assert(detail.includes('Esc: overview'), 'Detail did not open')
    assert(detail.includes('Source: session checklist (todo_write)'), 'Checklist detail is missing')
    stdin.write('\x1b'); await settle()
    // session:0, session:1, then the first native Team task.
    stdin.write('\x1b[B'); await settle()
    stdin.write('\x1b[B'); await settle()
    stdin.write('\r'); await settle()
    stdin.write('\x1b[F'); await settle()
    assert(stripVTControlCharacters(frames.at(-1) ?? '').includes('WARNING: overlap'), 'Detail did not scroll')
    stdin.write('\x1b'); await settle()
    assert.equal(closed, 0, 'Detail Esc must not close overview')
    channel.subagents[0].runId = 'run2'; channel.subagents[0].status = 'completed'; listener(); await settle()
    channel.sessionId = 'new-session'; channel.agentBindingGeneration++; instance.rerender(React.createElement(Scene, { React, ui, channel, close() { closed++ } })); await settle()
    assert.equal(disposed, 2, 'Session rebind leaked listeners')
  }
  stdin.write('\x1b'); await settle()
  assert.equal(closed, 1, 'Esc did not return to chat')
  // Every braille cell is one animation frame (running-run spinner). A static capture
  // cannot show motion, so pin them to one glyph instead of storing whichever frame came out.
  writeFileSync(`out/dashboard-render-${columns}x${rows}.txt`, frame.replace(/[\u2800-\u28ff]/g, '⠋'))
  instance.unmount(); instance.cleanup(); stdin.destroy()
  assert.equal(disposed, columns >= 30 ? 4 : 2, 'Unmount leaked listeners')
  console.log(`PASS ${columns}x${rows}: Unicode cells, height, detail, escape, session rebind, cleanup`)
}
