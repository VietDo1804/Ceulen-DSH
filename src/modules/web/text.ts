const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16) || 0)
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10) || 0)
    return ENTITIES[entity.toLowerCase()] ?? whole
  })
}

export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch === null ? '' : decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, '')).trim()
  const links: string[] = []
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) links.push(decodeEntities(match[1]!))
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(stripped)
    .split('\n')
    .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text, links }
}

