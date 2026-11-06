import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Read UTF-8 text, returning `undefined` for any missing/unreadable file. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Read and parse JSON, returning `undefined` for missing or malformed files. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode })
}

/**
 * Atomic write: create a sibling temp file, fsync by close, rename over the
 * target, then tighten the mode. A failed write never leaves a partial file.
 */
export async function writeAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, data, { encoding: 'utf8', mode })
    await rename(temp, path)
    await chmod(path, mode).catch(() => undefined)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Normalize CRLF so vendored-file hashes are platform-independent. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Fail after `ms` with a clear error; used around optional network calls. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
