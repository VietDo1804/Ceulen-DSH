import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('usage cap: monthly text, idempotence, reversible writes and refusal gates', () => {
  mkdirSync(join(process.cwd(), '.devhome'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), '.devhome/usage-patch-'))
  const file = join(root, 'lib/types/dsh-adapter/status.js')
  const stock = 'const FIELD_CELLS_DEFAULT = 16;\nconst FIELD_CELLS_MAX = 32;\n'
  const run = action => spawnSync(process.execPath, ['scripts/tui-usage-patch.mjs', action, '--tui', root], { encoding: 'utf8' }).status
  try {
    mkdirSync(join(root, 'lib/types/dsh-adapter'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.20.0' }))
    writeFileSync(file, stock)
    assert.equal(run('check'), 1)
    assert.equal(run('apply'), 0)
    assert.equal(run('check'), 0)
    const patched = readFileSync(file, 'utf8')
    assert.equal(run('apply'), 0)
    assert.equal(readFileSync(file, 'utf8'), patched)
    const cap = Number(patched.match(/FIELD_CELLS_MAX = (\d+)/)?.[1])
    const usage = 'Go · 5h 100% 4H · W 51% 15H · M 94% 30D'
    assert.ok(usage.length > 32)
    assert.equal(usage.slice(0, Math.min(cap, 64)), usage)
    assert.equal(cap, 64)
    assert.ok(patched.includes('const FIELD_CELLS_DEFAULT = 16;'))
    assert.equal(run('revert'), 0)
    assert.equal(readFileSync(file, 'utf8'), stock)
    assert.equal(run('revert'), 0)
    for (const version of ['0.19.0', '99.0.0']) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
      assert.equal(run('apply'), 1)
      assert.equal(readFileSync(file, 'utf8'), stock)
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.20.0' }))
    for (const invalid of [stock.replace('32', '48'), stock + stock]) {
      writeFileSync(file, invalid)
      assert.equal(run('apply'), 1)
      assert.equal(readFileSync(file, 'utf8'), invalid)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
