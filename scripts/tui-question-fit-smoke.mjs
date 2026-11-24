#!/usr/bin/env node
/**
 * Headless layout smoke for the two question cards (behaviour 5 of
 * tui-plan-patch.mjs). `check` there only proves the anchors are in place;
 * this renders the installed PlanReviewPanel and AskUserQuestionPanel inside a
 * Chat-like fullscreen stack (a growing transcript, a band of rows standing in
 * for the goal/todo panel, the card, then a usage band) into a headless
 * terminal, and asserts that every control the user needs is on screen.
 *
 * A stock dsh-tui fails the band cases: "Keep planning", the feedback row and
 * the hint fall off the bottom, and a short plan leaves a blank block.
 *
 * Usage: node scripts/tui-question-fit-smoke.mjs [--tui <dir>]
 * Exit 0 when every case passes, 1 when one fails, 2 when it cannot run.
 * The stack is a stand-in, not the real Chat screen: a live check after a
 * restart is still the final word.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const types = join(root, 'lib', 'types')
if (!existsSync(join(types, 'components', 'questions', 'PlanReviewPanel.js'))) {
  console.error(`dsh-tui not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}

// The headless terminal ships with the global dsh core.
let Terminal
try {
  const globalRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  Terminal = createRequire(join(globalRoot, '@deepseek-ai', 'dsh', 'package.json'))('@xterm/headless').Terminal
} catch (error) {
  console.error(`@xterm/headless not found next to the global @deepseek-ai/dsh: ${error instanceof Error ? error.message : error}`)
  process.exit(2)
}

const requireTui = createRequire(join(types, 'ui.js'))
const { jsx, jsxs } = requireTui('react/jsx-runtime')
const load = rel => import(pathToFileURL(join(types, rel)).href)
const { Box, Text, ThemeProvider } = await load('ui.js')
const { renderSync } = await load('ink/root.js')
const { PlanReviewPanel } = await load('components/questions/PlanReviewPanel.js')
const { AskUserQuestionPanel } = await load('components/questions/AskUserQuestionPanel.js')

const COLUMNS = 160

/** Render one card under `band` filler rows on a `rows`-high screen; the visible lines. */
async function screen({ rows, band, card }) {
  const term = new Terminal({ cols: COLUMNS, rows, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _encoding, done) { term.write(chunk.toString(), done) } })
  Object.assign(stdout, { columns: COLUMNS, rows, isTTY: true })
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const tree = jsx(ThemeProvider, {
    children: jsxs(Box, {
      flexDirection: 'column', height: rows, width: '100%', flexShrink: 0, children: [
        jsx(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', children: jsx(Text, { children: 'transcript' }) }),
        jsxs(Box, {
          flexDirection: 'column', flexShrink: 0, children: [
            ...Array.from({ length: band }, (_, index) => jsx(Text, { children: `band row ${index + 1}` }, `band${index}`)),
            jsxs(Box, { flexDirection: 'column', flexShrink: 0, children: [card, jsx(Text, { children: 'USAGE-BAND' })] }),
          ],
        }),
      ],
    }),
  })
  const instance = renderSync(tree, { stdout, stdin, stderr: process.stderr, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  // Layout effects measure, set state and lay out again: give it a few frames.
  await new Promise(resolve => setTimeout(resolve, 600))
  const buffer = term.buffer.active
  const lines = []
  for (let y = 0; y < rows; y++) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
  // Unmount restores terminal modes with writeSync on a TTY stream's fd (1 for
  // this fake one): keep those bytes out of the report.
  stdout.isTTY = false
  instance.unmount()
  instance.cleanup?.()
  return lines
}

const noop = () => {}
const planCard = planLines => jsx(PlanReviewPanel, {
  question: {
    id: 'plan-review',
    header: 'Plan change',
    question: 'The lead changed the plan you approved (adds T4). Approve the new plan?',
    detail: Array.from({ length: planLines }, (_, index) => `- plan line ${index + 1}`).join('\n'),
    options: [
      { label: 'Approve', description: 'The lead dispatches the team on this plan.' },
      { label: 'Keep planning', description: 'Nothing is dispatched; your feedback goes back to the lead.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
  },
  onAnswer: noop,
  onCancel: noop,
})
const askCard = count => jsx(AskUserQuestionPanel, {
  question: {
    id: 'pick',
    header: 'Route',
    question: 'Which route should the lead use for the follow-up task?',
    detail: 'Pick one. The lead keeps the plan otherwise.',
    options: Array.from({ length: count }, (_, index) => ({ label: `Option ${index + 1}`, description: `What option ${index + 1} means` })),
  },
  position: 0,
  total: 1,
  answered: [],
  onAnswer: noop,
  onCancel: noop,
  fullscreen: true,
})

const has = (lines, pattern) => lines.some(line => pattern.test(line))
const index = (lines, pattern) => lines.findIndex(line => pattern.test(line))
const planChecks = planLines => lines => {
  const failures = []
  if (!has(lines, /2\. Keep planning/)) failures.push('"Keep planning" is off screen')
  if (!has(lines, /✎/)) failures.push('the feedback row is off screen')
  if (!has(lines, /Esc/)) failures.push('the key hint is off screen')
  if (!has(lines, /USAGE-BAND/)) failures.push('the band under the card is off screen')
  const last = index(lines, new RegExp(`plan line ${planLines}$`))
  const approve = index(lines, /1\. Approve/)
  if (last >= 0 && approve >= 0 && approve - last > 4) failures.push(`${approve - last - 1} rows between the plan and the options`)
  return failures
}
const askChecks = count => lines => {
  const failures = []
  if (!has(lines, /✎/)) failures.push('the answer row is off screen')
  if (!has(lines, /Esc/)) failures.push('the key hint is off screen')
  if (!has(lines, /USAGE-BAND/)) failures.push('the band under the card is off screen')
  if (count <= 3 && lines.filter(line => /Option \d+\s*$/.test(line)).length !== count) failures.push('a short option list lost an option')
  return failures
}

const cases = [
  { name: 'plan card, short plan, todo band up (the reported bug)', rows: 98, band: 10, card: planCard(56), check: planChecks(56) },
  { name: 'plan card, short plan, no band (first plan)', rows: 98, band: 0, card: planCard(56), check: planChecks(56) },
  { name: 'plan card, long plan scrolls, todo band up', rows: 60, band: 8, card: planCard(80), check: planChecks(80) },
  { name: 'question card, 15 options, todo band up', rows: 40, band: 8, card: askCard(15), check: askChecks(15) },
  { name: 'question card, 3 options, todo band up', rows: 40, band: 8, card: askCard(3), check: askChecks(3) },
]

let failed = 0
for (const entry of cases) {
  const failures = entry.check(await screen(entry))
  if (failures.length > 0) failed += 1
  console.log(`${failures.length === 0 ? 'ok  ' : 'FAIL'} ${entry.name}${failures.length === 0 ? '' : `: ${failures.join('; ')}`}`)
}
console.log(failed === 0 ? 'question cards fit the screen.' : `${failed} case${failed === 1 ? '' : 's'} failed: run scripts/tui-plan-patch.mjs apply, or the anchors moved.`)
process.exit(failed === 0 ? 0 : 1)
