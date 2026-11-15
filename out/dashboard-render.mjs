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
    sessionId: 'render-session', agentBindingGeneration: 1, provider: 'test', model: 'gpt-6-astra', status: 'idle',
    team: { enabled: true, tasks: Array.from({ length: 25 }, (_, i) => ({ id: String(i), subject: `Task ${i} 你好 👩‍💻 ${'long '.repeat(80)}`, status: 'pending', ownerName: 'worker', ready: false, blockedBy: ['0'], writeScopes: ['src/**'], writeScopeWarnings: ['overlap'], description: 'DETAIL '.repeat(300) })) },
    subagents: [{ agentId: 'child', runId: 'run1', name: 'worker', status: 'running', provider: 'native', model: 'test', toolCalls: [{ name: 'read', status: 'running', startedAt: 1 }], outputEvents: [{ kind: 'thinking', text: 'MUST_NOT_APPEAR', at: 1 }] }],
    subscribe(fn) { listener = fn; return () => { disposed++ } }, subscribeAgentView() { return () => { disposed++ } },
  }
  const instance = ui.renderSync(React.createElement(Scene, { React, ui, channel, close() { closed++ } }), { stdout, stdin, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  // Let the open gauge ramp finish so the committed capture does not depend on timing.
  await new Promise(resolve => setTimeout(resolve, 900))
  // Raw chunk stream, kept for debugging only: it embeds live animation frames, so writing it
  // on every run would churn a tracked file. Opt in when you actually need it.
  if (process.env.DASHBOARD_DEBUG_DUMP === '1') writeFileSync(`out/dashboard-render-debug-${columns}.txt`, frames.join(''))
  const frame = stripVTControlCharacters(frames.filter(frame => stripVTControlCharacters(frame).includes(columns < 30 ? 'Too small' : 'Native Agent Dashboard')).at(-1) ?? '')
  assert(frame, `No native frame at ${columns}x${rows}`)
  assert(!frame.includes('MUST_NOT_APPEAR'))
  const lines = frame.trimEnd().split('\n')
  assert(lines.length <= rows, `Height overflow ${lines.length}/${rows}`)
  assert(lines.every(line => width(line) <= columns), `Cell overflow at ${columns}`)
  if (columns >= 30) {
    assert(frame.includes('Esc: chat'))
    // The KPI strip is dropped below 80 columns, where one region card owns the body.
    if (columns >= 80) assert(frame.includes('TASKS') && frame.includes('AGENTS') && frame.includes('TOKENS'), 'KPI block titles are missing')
    // 120 columns lays the three region cards out side by side.
    if (columns >= 120) assert(frame.includes('Tasks ·') && frame.includes('Agents ·') && frame.includes('Activity ·'), 'region cards are missing')
    stdin.write('\r'); await settle()
    const detail = stripVTControlCharacters(frames.at(-1) ?? '')
    assert(detail.includes('Esc: overview'), 'Detail did not open')
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
  // Every braille cell is one animation frame (header badge, live run rows). A static capture
  // cannot show motion, so pin them to one glyph instead of storing whichever frame came out.
  writeFileSync(`out/dashboard-render-${columns}x${rows}.txt`, frame.replace(/[\u2800-\u28ff]/g, '⠋'))
  instance.unmount(); instance.cleanup(); stdin.destroy()
  assert.equal(disposed, columns >= 30 ? 4 : 2, 'Unmount leaked listeners')
  console.log(`PASS ${columns}x${rows}: Unicode cells, height, detail, escape, session rebind, cleanup`)
}
