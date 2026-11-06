/**
 * Typed delegation: the schema subset `delegate` accepts and the validator the
 * parent runs on the child's final text.
 *
 * The DSH subagent service starts a child and returns its id; it exposes no
 * final-text hook to the plugin. So the contract is enforced in two places we
 * do control: the child prompt (append the schema, "end with exactly one JSON
 * object") and the `validate_schema` tool the parent calls on the reply it
 * received. A malformed reply fails loudly, naming the failing field — never a
 * silent pass.
 */

export interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  required?: string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  enum?: unknown[]
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** First schema violation as `path: reason`, or undefined when the value fits. */
export function validateValue(schema: SchemaNode, value: unknown, path = '$'): string | undefined {
  if (schema.enum !== undefined) {
    return schema.enum.some(candidate => candidate === value)
      ? undefined
      : `${path}: expected one of ${schema.enum.map(show).join(' | ')}, got ${show(value)}`
  }
  switch (schema.type) {
    case undefined:
      return undefined
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected an object`
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in record)) return `${path}.${key}: required field is missing`
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!(key in record)) continue
        const error = validateValue(child, record[key], `${path}.${key}`)
        if (error !== undefined) return error
      }
      return undefined
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected an array`
      if (schema.items !== undefined) {
        for (const [index, item] of value.entries()) {
          const error = validateValue(schema.items, item, `${path}[${index}]`)
          if (error !== undefined) return error
        }
      }
      return undefined
    }
    case 'string':
      return typeof value === 'string' ? undefined : `${path}: expected a string, got ${show(value)}`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : `${path}: expected a number, got ${show(value)}`
    case 'integer':
      return Number.isInteger(value) ? undefined : `${path}: expected an integer, got ${show(value)}`
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${path}: expected a boolean, got ${show(value)}`
    default:
      return `${path}: unsupported schema type ${show(schema.type)}`
  }
}

/** The last plausible JSON object in a reply: whole text, fenced block, or brace span. */
function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim()
  const attempts: string[] = [trimmed]
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) attempts.push(match[1] ?? '')
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1))
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/** Parse and validate a child reply; throws with the failing field named. */
export function parseTypedReply(schema: SchemaNode, text: string): unknown {
  const value = extractJson(text)
  if (value === undefined) {
    throw new Error('reply contains no JSON object; the child must end with exactly one JSON object')
  }
  const error = validateValue(schema, value)
  if (error !== undefined) throw new Error(`reply does not match the schema: ${error}`)
  return value
}

/** The child-prompt contract appended when `delegate` carries a schema. */
export function contractBlock(schema: SchemaNode): string {
  return [
    'Reply contract: end your reply with exactly one JSON object matching this schema, and no prose after it.',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n')
}
