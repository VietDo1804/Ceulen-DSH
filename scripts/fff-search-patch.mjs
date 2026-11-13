#!/usr/bin/env node
// dsh-fff 0.1.0: repeatable local fix until the plugin ships these changes.
// Usage: node scripts/fff-search-patch.mjs [apply|check|revert] [--fff <package-dir>]
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function ignoredFileList(subprocess, cwd, signal, skipDirs, cap) {
  if (!subprocess) return undefined
  let rg
  try {
    rg = await subprocess.resolveExecutable('rg', undefined, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined // ponytail: retain the original walker when rg is unavailable.
  }
  const argv = [rg, '--files', '--hidden', '--null', '--no-require-git']
  for (const dir of skipDirs) argv.push('--glob', `!**/${dir}/**`)
  argv.push('--', '.')
  const handle = subprocess.spawn({
    argv, cwd, signal, graceMs: 300,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 4096 } },
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    const error = await handle.collected.stderr.readFrom(0)
    throw new Error(`dsh-fff: file listing failed: ${error.text || outcome.exitCode}`)
  }
  const output = await handle.collected.stdout.readFrom(0)
  // Do not cache a partial list as a complete index.
  if (output.lossy || (output.text && !output.text.endsWith('\0'))) {
    throw new Error('dsh-fff: file listing exceeded its output budget; use scoped glob/grep')
  }
  const files = output.text.split('\0').filter(Boolean).map(path => path.replace(/^\.\//, ''))
  if (files.length > cap) throw new Error(`dsh-fff: more than ${cap} files; use scoped glob/grep`)
  return files
}

export async function exactSearchScope(fs, cwd, path, signal) {
  const root = await fs.resolve('.', { cwd, signal })
  const target = await fs.resolve(path, { cwd, signal })
  const base = root.displayPath.replaceAll('\\', '/').replace(/\/+$/, '')
  const absolute = target.displayPath.replaceAll('\\', '/')
  if (absolute !== base && !absolute.startsWith(`${base}/`)) {
    throw new Error('dsh-fff: search scope must stay inside the workspace')
  }
  const relative = absolute === base ? '.' : absolute.slice(base.length + 1)
  // Exact paths must not add symlink escapes that the old file walk excluded.
  let prefix = ''
  for (const part of relative.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part
    if ((await fs.lstat(prefix, { cwd }, signal))?.type === 'symlink') {
      throw new Error('dsh-fff: symlink search scopes are not supported')
    }
  }
  const info = await fs.stat(target, signal)
  return info && (info.type === 'directory' || info.type === 'file') ? relative : undefined
}

export const edits = [
  {
    from: 'const INDEX_TTL_MS = 60000',
    to: `${ignoredFileList.toString()}\n\n${exactSearchScope.toString()}\n\nconst INDEX_TTL_MS = 60000`,
  },
  {
    from: `      if (indexFresh(cwd)) return index.files
      const files = []`,
    to: `      if (indexFresh(cwd)) return index.files
      const nativeFiles = await ignoredFileList(subprocess, cwd, signal, SKIP_DIRS, MAX_INDEX_FILES)
      if (nativeFiles !== undefined) {
        index.cwd = cwd
        index.builtAt = Date.now()
        index.files = nativeFiles
        return nativeFiles
      }
      const files = []`,
  },
  {
    from: `          const files = await buildIndex(cwd, exec.signal)
          scope = resolveBest(String(args.path), files)
          if (scope === undefined) {
            return { text: \`Could not resolve scope "\${args.path}" to a file; searched from the workspace root instead.\` }
          }`,
    to: `          scope = await exactSearchScope(fs, cwd, String(args.path).trim(), exec.signal)
          if (scope === undefined) {
            const files = await buildIndex(cwd, exec.signal)
            scope = resolveBest(String(args.path), files)
          }
          if (scope === undefined) {
            throw new Error(\`Could not resolve scope "\${args.path}"; no search was run. Use an exact directory/file path or find_files.\`)
          }`,
  },
  {
    from: `      const argv = [exe, '--no-heading', '--line-number', '--color', 'never', '-m', String(maxMatches)]`,
    to: `      const argv = [exe, '--no-heading', '--with-filename', '--line-number', '--color', 'never', '-m', String(maxMatches)]`,
  },
  {
    from: `      argv.push(pattern)
      if (relPath) argv.push(relPath)`,
    to: `      argv.push('-e', pattern, '--', relPath || '.')`,
  },
  {
    from: 'Supports a fuzzy path/folder scope and glob filters. Falls back to the built-in grep tool when ripgrep is not installed.',
    to: 'Supports exact directory/file paths, fuzzy file scopes, and glob filters. Requires ripgrep; use the built-in grep tool if it is unavailable.',
  },
]

export function patchSource(source, action) {
  for (const edit of edits) {
    const [from, to] = action === 'revert' ? [edit.to, edit.from] : [edit.from, edit.to]
    if (action !== 'revert' && source.includes(edit.to)) continue
    if (action === 'revert' && source.includes(to) && !source.includes(from)) continue
    if (source.split(from).length !== 2) throw new Error('FFF source anchor mismatch; nothing written')
    source = source.replace(from, () => to)
  }
  return source
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const action = args[0] ?? 'check'
    if (!['apply', 'check', 'revert'].includes(action)) throw new Error('usage: fff-search-patch.mjs [apply|check|revert] [--fff <package-dir>]')
    const flag = args.indexOf('--fff')
    if (flag >= 0 && !args[flag + 1]) throw new Error('--fff requires a package directory')
    const root = flag >= 0 ? args[flag + 1] : join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles/tui/node_modules/dsh-fff')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (pkg.name !== 'dsh-fff' || pkg.version !== '0.1.0') throw new Error('expected dsh-fff 0.1.0; review patch anchors for this version')
    const path = join(root, 'src/host.js')
    const before = readFileSync(path, 'utf8')
    if (action === 'check') {
      const applied = edits.every(edit => before.split(edit.to).length === 2)
      console.log(`dsh-fff ${pkg.version}: search patch ${applied ? 'applied' : 'NOT applied'}`)
      process.exitCode = applied ? 0 : 1
    } else {
      const after = patchSource(before, action)
      new Function(after) // Parse the complete host before touching the installation.
      if (after !== before) writeFileSync(path, after)
      console.log(`dsh-fff ${pkg.version}: ${action} complete. Restart DSH to reload the plugin.`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
