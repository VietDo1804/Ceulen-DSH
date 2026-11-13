import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { edits, exactSearchScope, ignoredFileList, patchSource } from './fff-search-patch.mjs'

const temp = mkdtempSync(join(tmpdir(), 'fff-search-'))
after(() => rmSync(temp, { recursive: true, force: true }))
function put(path, content = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const cwd = join(temp, 'repo')
put(join(cwd, '.gitignore'), '.devhome/\n.ux-bench/\n.npm-cache/\n*.log\n')
put(join(cwd, 'src/jfind/index.ts'), 'const needle = "--needle"\n')
put(join(cwd, 'src/space name.ts'), 'needle\n')
put(join(cwd, 'src/line\nbreak.ts'), 'needle\n')
put(join(cwd, '.devhome/jfind.ts'), 'noise')
put(join(cwd, '.ux-bench/jfind.ts'), 'noise')
put(join(cwd, '.npm-cache/jfind.ts'), 'noise')
put(join(cwd, 'node_modules/jfind.ts'), 'noise')
put(join(cwd, 'ignored.log'), 'noise')
put(join(temp, 'outside.ts'), 'needle\n')
symlinkSync(join(temp, 'outside.ts'), join(cwd, 'link.ts'))
symlinkSync(temp, join(cwd, 'linked-dir'))

const calls = []
const subprocess = {
  async resolveExecutable() { return 'rg' },
  spawn(spec) {
    calls.push(spec.argv)
    const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, encoding: 'utf8', maxBuffer: 9 * 1024 * 1024 })
    if (result.error) throw result.error
    return {
      done: Promise.resolve({ exitCode: result.status }),
      collected: {
        stdout: { readFrom: () => ({ text: result.stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: result.stderr, lossy: false }) },
      },
    }
  },
}
const fs = {
  async resolve(path, opts) { return { displayPath: resolve(opts.cwd, path) } },
  async stat(target) {
    try {
      const info = statSync(target.displayPath)
      return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' }
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  },
  async lstat(path, opts) {
    try {
      return { type: lstatSync(resolve(opts.cwd, path)).isSymbolicLink() ? 'symlink' : 'file' }
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  },
}

test('native file index respects ignores even outside git and preserves special filenames', async () => {
  const files = await ignoredFileList(subprocess, cwd, undefined, new Set(['node_modules', '.git']), 50000)
  assert(files.includes('src/jfind/index.ts'))
  assert(files.includes('src/space name.ts'))
  assert(files.includes('src/line\nbreak.ts'))
  assert(!files.some(path => /node_modules|devhome|ux-bench|npm-cache|ignored.log|link/.test(path)))
})

test('file index refuses capped or lossy results and preserves aborts', async () => {
  await assert.rejects(ignoredFileList(subprocess, cwd, undefined, new Set(), 1), /more than 1 files/)
  const lossy = { ...subprocess, spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: 'tail\0', lossy: true }) } } }) }
  await assert.rejects(ignoredFileList(lossy, cwd, undefined, new Set(), 50000), /output budget/)
  const absent = { resolveExecutable: async () => { throw new Error('missing rg') } }
  assert.equal(await ignoredFileList(absent, cwd, undefined, new Set(), 50000), undefined)
  await assert.rejects(ignoredFileList(absent, cwd, AbortSignal.abort(), new Set(), 50000), /missing rg/)
})

test('exact directories and files bypass the fuzzy index, without accepting escapes or symlinks', async () => {
  assert.equal(await exactSearchScope(fs, cwd, 'src/jfind/', undefined), 'src/jfind')
  assert.equal(await exactSearchScope(fs, cwd, join(cwd, 'src/space name.ts'), undefined), 'src/space name.ts')
  assert.equal(await exactSearchScope(fs, cwd, '.', undefined), '.')
  assert.equal(await exactSearchScope(fs, cwd, 'missing', undefined), undefined)
  await assert.rejects(exactSearchScope(fs, cwd, '../outside.ts', undefined), /inside the workspace/)
  await assert.rejects(exactSearchScope(fs, cwd, 'link.ts', undefined), /symlink/)
  await assert.rejects(exactSearchScope(fs, cwd, 'linked-dir/outside.ts', undefined), /symlink/)
})

// Exercise the actual plugin body when installed, without modifying that installation.
const installed = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/tui/node_modules/dsh-fff/src/host.js')
test('installed host: patch round-trip, directory/file/root search, cache hygiene and truthful failures', { skip: !existsSync(installed) }, async () => {
  const original = patchSource(readFileSync(installed, 'utf8'), 'revert')
  const patched = patchSource(original, 'apply')
  assert.equal(patchSource(patched, 'apply'), patched)
  assert.equal(patchSource(patched, 'revert'), original)
  assert.throws(() => patchSource(original.replace(edits[2].from, 'changed upstream'), 'apply'), /anchor mismatch/)
  const packageDir = join(temp, 'plugin')
  const host = join(packageDir, 'src/host.js')
  put(join(packageDir, 'package.json'), JSON.stringify({ name: 'dsh-fff', version: '0.1.0' }))
  put(host, original)
  const run = action => spawnSync(process.execPath, [resolve('scripts/fff-search-patch.mjs'), action, '--fff', packageDir], { encoding: 'utf8' })
  assert.equal(run('check').status, 1)
  for (const action of ['apply', 'apply', 'check', 'revert', 'revert']) {
    const result = run(action)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  assert.equal(readFileSync(host, 'utf8'), original)
  const changed = original.replace(edits[2].from, 'changed upstream')
  put(host, changed)
  assert.equal(run('apply').status, 1)
  assert.equal(readFileSync(host, 'utf8'), changed, 'failed preflight must not partially write')
  const tools = new Map()
  const plugin = new Function(patched)()
  plugin.apply({
    get(name) { return { fs, subprocess, systemPrompt: { section() {} } }[name] },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  })
  const exec = { agent: { session: { header: { cwd } } } }
  const grep = tools.get('fff_grep')
  const before = calls.length
  const directory = await grep.execute({ pattern: 'needle', path: 'src/jfind' }, exec)
  assert.match(directory.text, /src\/jfind\/index.ts \(1 match\)\n[ ]{2}1:/)
  assert.equal(calls.length - before, 1, 'exact directory should not build an index')
  const single = await grep.execute({ pattern: '--needle', literal: true, path: 'src/jfind/index.ts' }, exec)
  assert.match(single.text, /src\/jfind\/index.ts \(1 match\)\n[ ]{2}1:/)
  const root = await grep.execute({ pattern: 'needle' }, exec)
  assert.match(root.text, /src\/jfind\/index.ts/)
  const fuzzy = await grep.execute({ pattern: 'needle', path: 'jfind index' }, exec)
  assert.match(fuzzy.text, /src\/jfind\/index.ts/)
  const find = await tools.get('find_files').execute({ query: 'jfind' }, exec)
  assert.match(find.text, /src\/jfind\/index.ts/)
  assert.doesNotMatch(find.text, /devhome|ux-bench|npm-cache/)
  await assert.rejects(grep.execute({ pattern: 'needle', path: 'zzzz-no-such-scope' }, exec), /no search was run/)
  await assert.rejects(grep.execute({ pattern: '[', path: 'src' }, exec), /ripgrep error/)
})

const dshRequire = createRequire(join(dirname(dirname(process.execPath)), 'lib/node_modules/@deepseek-ai/dsh/package.json'))
let hasRuntime = false
try { hasRuntime = Boolean(dshRequire.resolve('@deepseek-ai/dsh-fs-local')) } catch { /* optional global DSH installation */ }
test('real installed DSH fs and subprocess: scoped search, index, and lossy-output detection', { skip: !hasRuntime || !existsSync(installed) }, async () => {
  const load = name => import(pathToFileURL(dshRequire.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { LocalFileSystem } = await load('@deepseek-ai/dsh-fs-local')
  const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
  const ctx = new Context()
  try {
    const realFs = new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
    const realSubprocess = new LocalSubprocessRuntime(ctx)
    const tools = new Map()
    const plugin = new Function(patchSource(readFileSync(installed, 'utf8'), 'apply'))()
    plugin.apply({
      get: name => ({ fs: realFs, subprocess: realSubprocess, systemPrompt: { section() {} } })[name],
      tools: { register: tool => tools.set(tool.name, tool) },
    })
    const exec = { agent: { session: { header: { cwd } } }, signal: AbortSignal.timeout(10000) }
    for (const path of ['src/jfind', 'src/jfind/index.ts']) {
      const result = await tools.get('fff_grep').execute({ pattern: 'needle', path }, exec)
      assert.match(result.text, /src\/jfind\/index.ts/)
    }
    const result = await tools.get('find_files').execute({ query: 'jfind' }, exec)
    assert.match(result.text, /src\/jfind\/index.ts/)
    assert.doesNotMatch(result.text, /devhome|ux-bench|npm-cache/)
    const handle = realSubprocess.spawn({ argv: [process.execPath, '-e', 'process.stdout.write("hello")'], cwd, graceMs: 300,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 2 }, stderr: { maxBytes: 4096 } } })
    await handle.done
    assert.equal(handle.collected.stdout.readFrom(0).lossy, true)
  } finally {
    await ctx.fiber.dispose()
  }
})
