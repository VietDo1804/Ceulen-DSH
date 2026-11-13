import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginContext } from '../../core/types.js'
import { ceulenHome } from '../../core/paths.js'
import { assertCaptureUrl } from '../../vendor/ceulen/web/chrome.js'
import { captureUrlProblem } from './url-guard.js'

export function assertCaptureScope(url: string, cwd: string): void {
  assertCaptureUrl(url)
  // Schemes are case-insensitive: `FILE:///etc/passwd` must take the file branch,
  // so read the parsed protocol and not the raw string.
  const parsed = URL.parse(url)
  if (parsed === null) throw new Error(`Invalid capture URL (${url.slice(0, 80)})`)
  if (parsed.protocol !== 'file:') {
    const problem = captureUrlProblem(url)
    if (problem !== undefined) throw new Error(problem)
    return
  }
  // ponytail: lexical resolve, not realpath — symlinks inside the workspace stay allowed
  const path = resolve(fileURLToPath(parsed))
  const root = resolve(cwd)
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error('file:// capture must stay inside the session workspace')
  }
}

export async function saveScreenshot(ctx: PluginContext, base64: string, name: string, attach = true): Promise<{ text: string; image?: unknown }> {
  const bytes = Buffer.from(base64, 'base64')
  let attachments: { saveImage?: (input: { data: Uint8Array; mediaType: string; name: string }) => Promise<unknown> } | undefined
  try {
    attachments = attach ? ctx.get('attachments', false) : undefined
  } catch {
    attachments = undefined
  }
  if (attachments !== undefined && typeof attachments.saveImage === 'function') {
    try {
      const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name })
      return { text: `Screenshot captured: ${name}.`, image: ref }
    } catch {
      // Fall through to a file when the attachment store refuses the image.
    }
  }
  const dir = join(ceulenHome(), 'captures')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60)
  const file = join(dir, `${safe}-${Date.now()}.png`)
  await writeFile(file, bytes, { mode: 0o600 })
  return { text: `Screenshot saved to ${file}. Use read_image to view it.` }
}

export async function savePdfFile(pdfBase64: string, name: string): Promise<string> {
  const dir = join(ceulenHome(), 'captures')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60)
  const file = join(dir, `${safe}-${Date.now()}.pdf`)
  await writeFile(file, Buffer.from(pdfBase64, 'base64'), { mode: 0o600 })
  return file
}

export const IMAGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    image: { type: 'object', additionalProperties: true },
  },
  required: ['text'],
}

export const imageRender = (_args: unknown, value: unknown) => {
  const record = value as { text?: string; image?: unknown }
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; attachment?: unknown }> = []
  if (record?.image !== undefined) out.push({ type: 'image', attachment: record.image })
  out.push({ type: 'text', text: String(record?.text ?? '') })
  return out as never
}

