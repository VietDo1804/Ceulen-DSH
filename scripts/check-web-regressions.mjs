#!/usr/bin/env node
// Real Chrome: PNG dimensions alone do not prove the page's viewport width.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerWebTools } from '../lib/modules/web/tools.js'
import { captureScreenshot, findChromeBinary } from '../lib/vendor/ceulen/web/chrome.js'

if (!findChromeBinary()) {
  console.log('web regressions: SKIPPED (Chrome/Chromium unavailable)')
  process.exit(0)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, '.devhome'), { recursive: true })
const home = mkdtempSync(join(root, '.devhome', 'web-regressions-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const widths = []
const server = createServer((request, response) => {
  if (request.url.startsWith('/probe?')) {
    widths.push(Number(new URL(request.url, 'http://localhost').searchParams.get('width')))
    response.end('ok')
    return
  }
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>fetch("/probe?width="+innerWidth)</script>viewport probe')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

try {
  for (const fullPage of [false, true]) {
    widths.length = 0
    const capture = await captureScreenshot({ url, width: 390, height: 844, fullPage, waitForSec: 0.2, timeoutMs: 15_000 })
    const png = Buffer.from(capture.base64, 'base64')
    assert.equal(png.readUInt32BE(16), 390)
    assert.equal(png.readUInt32BE(20), fullPage ? 8000 : 844)
    assert.deepEqual(widths, [390], '390px PNG must render at 390px, not Chrome’s 500px minimum')
  }

  const tools = new Map()
  let attachments = 0
  registerWebTools({
    get: name => name === 'attachments' ? { saveImage: async () => { attachments += 1; return { id: 'test-image' } } } : undefined,
    tools: { register: tool => tools.set(tool.name, tool), get: name => tools.get(name) },
  })
  const interact = tools.get('web_interact')
  assert.ok(interact, 'web_interact must be registered')
  const exec = { signal: new AbortController().signal }
  await assert.rejects(
    interact.execute({ url, steps: [{ evaluate: 'throw new Error("expected regression failure")' }] }, exec),
    error => /FAIL.*expected regression failure/s.test(error.message) && /Screenshot saved to/.test(error.message),
    'failed steps must reject even when an attachment store is available',
  )
  assert.equal(attachments, 0, 'error screenshots must be saved for inspection instead of hiding the failure')
  const captures = join(home, 'ceulen', 'captures')
  const files = readdirSync(captures)
  assert.equal(files.length, 1)
  assert.equal(readFileSync(join(captures, files[0])).readUInt32BE(0), 0x89504e47)
  const success = await interact.execute({ url, steps: [{ evaluate: '1 + 1' }] }, exec)
  assert.ok(success.image, 'successful interactions still return inline images')
  assert.equal(attachments, 1)
  console.log('web regressions: PASS (390px viewport, tall capture, failed-step rejection + saved PNG, success image)')
} finally {
  server.close()
  server.closeAllConnections()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
}
