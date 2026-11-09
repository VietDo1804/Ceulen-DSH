/** ponytail: heuristic redaction, not a guarantee that arbitrary prose is secret-free. */
export function redact(text) {
  let out = String(text ?? '')
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:key|token|secret|password|credential)/i.test(name) && value?.length >= 8) out = out.split(value).join('[redacted]')
  }
  return out
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, '[redacted private key]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[\w]{12,})\b/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/(\b(?:[\w-]*[_-])?(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|token|secret|password|passwd|credential|private[_-]?key)(?:[_-][\w-]+)?["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;"'<>]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
