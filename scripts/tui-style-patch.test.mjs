import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const patches = ['advisor', 'context', 'toolname', 'plan', 'effort', 'style', 'usage', 'panel']
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const command = (file, args, cwd) => {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr)
  return result.stdout
}
const snapshot = root => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => {
    const file = join(entry.parentPath, entry.name)
    return [file.slice(root.length + 1), createHash('sha256').update(readFileSync(file)).digest('hex')]
  }).sort(([a], [b]) => a.localeCompare(b)))

// ponytail: pinned npm tarballs exercise real upstream anchors without a local
// profile or installed dependencies; npm's cache avoids repeat downloads.
for (const version of ['0.20.0', '0.20.1', '0.20.2']) {
  test(`stock dsh-tui ${version}: reversible patches and refusal without writes`, { timeout: 300_000 }, () => {
    const workspace = resolve('.devhome')
    mkdirSync(workspace, { recursive: true })
    const temp = mkdtempSync(join(workspace, 'tui-style-test-'))
    const root = join(temp, 'package')
    const run = (patch, action, status = 0) => {
      const result = spawnSync(process.execPath,
        [resolve(`scripts/tui-${patch}-patch.mjs`), action, '--tui', root], { encoding: 'utf8' })
      assert.equal(result.status, status, result.stdout + result.stderr)
    }
    const refuse = (patch = 'style') => {
      const before = snapshot(root)
      run(patch, 'apply', 1)
      assert.deepEqual(snapshot(root), before)
    }
    try {
      command(npm, ['pack', `@deepseek-harness-tui/dsh-tui@${version}`, '--ignore-scripts', '--silent'], temp)
      const tarball = readdirSync(temp).find(file => file.endsWith('.tgz'))
      assert.ok(tarball)
      command('tar', ['-xzf', tarball], temp)
      const stock = snapshot(root)
      run('style', 'check', 1)
      for (const patch of patches) run(patch, 'apply')
      const applied = snapshot(root)
      for (const patch of patches) {
        run(patch, 'check')
        run(patch, 'apply')
      }
      assert.deepEqual(snapshot(root), applied)
      for (const [file, hash] of Object.entries(applied)) {
        if (file.endsWith('.js') && hash !== stock[file]) command(process.execPath, ['--check', join(root, file)])
      }
      if (version !== '0.20.0') {
        assert.match(readFileSync(join(root, 'lib/types/screens/Chat.js'), 'utf8'), /mentionProviders: extensionMentions/)
        assert.match(readFileSync(join(root, 'lib/types/components/PromptInput.js'), 'utf8'), /styleBackendMode, mentionProviders,/)
      }
      if (version === '0.20.2') {
        const card = readFileSync(join(root, 'lib/types/components/messages/AssistantToolUseMessage.js'), 'utf8')
        assert.match(card, /presentSurface\?\.background \?\? 'toolCardBackgroundDim'/)
        assert.match(card, /columns, onOpenFile \}\);/)
        assert.match(readFileSync(join(root, 'lib/types/uiStyleSkins.js'), 'utf8'), /view\?\.card === 'files'/)
      }
      const helperFile = join(root, 'lib/types/uiStyle.js')
      const helper = readFileSync(helperFile)
      rmSync(helperFile)
      refuse() // interrupted apply must not duplicate props on a second apply
      writeFileSync(helperFile, helper)
      for (const patch of [...patches].reverse()) run(patch, 'revert')
      assert.deepEqual(snapshot(root), stock)
      writeFileSync(helperFile, helper) // recover an orphan helper beside stock files
      run('style', 'apply')
      run('style', 'check')
      run('style', 'revert')
      assert.deepEqual(snapshot(root), stock)
      const pkg = join(root, 'package.json')
      const original = readFileSync(pkg, 'utf8')
      writeFileSync(pkg, JSON.stringify({ ...JSON.parse(original), version: '99.0.0' }))
      refuse()
      writeFileSync(pkg, original)
      const prompt = join(root, 'lib/types/components/PromptInput.js')
      const source = readFileSync(prompt, 'utf8')
      const anchor = 'export function PromptInput({ channel,'
      for (const invalid of [source.replace(anchor, 'export function PromptInput({ missingChannel,'), source + '\n' + anchor]) {
        writeFileSync(prompt, invalid)
        refuse()
      }
      writeFileSync(prompt, source)
      for (const [patch, file, anchor] of [
        ['advisor', 'lib/types/components/MessageList.js', "        case 'notice':"],
        ['toolname', 'lib/types/components/messages/AssistantToolUseMessage.js', '    if (name.length === 0)'],
        ['panel', 'lib/types/components/sidePanel/useSidePanel.js', '            view.openPanel(request.id, { focus: true });'],
      ]) {
        const path = join(root, file)
        const original = readFileSync(path, 'utf8')
        assert.ok(original.includes(anchor))
        writeFileSync(path, original.replace(anchor, '/* moved anchor */'))
        refuse(patch) // a bad later anchor must not write earlier edits
        writeFileSync(path, original)
      }
      assert.deepEqual(snapshot(root), stock)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
}
