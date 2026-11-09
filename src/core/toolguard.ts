/**
 * Call-shape helpers for the contract layer: derive the accepted call shape
 * from a JSON object schema and repair the literal mistakes models make.
 *
 * Pure functions, no harness import, no module knowledge. `tools.ts` imports
 * this file and not the other way round, so there is no cycle.
 */

type JsonRecord = Record<string, unknown>

function plainRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function properties(schema: JsonRecord): JsonRecord {
  return plainRecord(schema.properties) ?? {}
}

function requiredKeys(schema: JsonRecord): string[] {
  const required = schema.required
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === 'string') : []
}

function declaredType(schema: JsonRecord): string | undefined {
  const type = schema.type
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return type.find((entry): entry is string => typeof entry === 'string')
  return undefined
}

/** Strict literal number parse; `Number('')` and `parseFloat` leniency stay out. */
function parseNumber(text: string): number | undefined {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** True when `value` satisfies the declared type, `enum` and `const` of a schema. */
function matchesType(value: unknown, schema: JsonRecord): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return false
  const type = declaredType(schema)
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return plainRecord(value) !== undefined
    case 'null':
      return value === null
    case undefined:
      return true
    default:
      return false
  }
}

/** Parse a string into the schema's scalar type, or return it trimmed. */
function parseScalar(text: string, schema: JsonRecord): unknown {
  const type = declaredType(schema)
  if (type === 'integer' || type === 'number') {
    const parsed = parseNumber(text)
    if (parsed !== undefined && matchesType(parsed, schema)) return parsed
    return text
  }
  if (type === 'boolean' && (text === 'true' || text === 'false')) {
    const parsed = text === 'true'
    if (matchesType(parsed, schema)) return parsed
  }
  return text
}

/** Wrap one value as `[value]` when it matches the declared item schema. */
function wrapSingleton(value: unknown, itemsSchema: unknown): unknown {
  if (Array.isArray(value)) return value
  const element = typeof value === 'string' ? parseScalar(value, plainRecord(itemsSchema) ?? {}) : value
  return matchesType(element, plainRecord(itemsSchema) ?? {}) ? [element] : value
}

function coerceValue(value: unknown, propSchema: unknown): unknown {
  const prop = plainRecord(propSchema) ?? {}
  if (prop.items !== undefined) return wrapSingleton(value, prop.items)
  if (typeof value !== 'string') return value
  // No trim: a string is data (`content`, `patch`), and silently shortening it
  // is a corruption, not a repair. Only literal number/boolean parses may fire.
  return parseScalar(value, prop)
}

/**
 * Rename the single undeclared key to the single missing required key when the
 * value is valid for it (`file` → `path`, `cmd` → `command`) — no alias table.
 * The target must declare a type or enum, otherwise any value "matches" and the
 * rename would be a guess.
 */
function renameStray(out: JsonRecord, props: JsonRecord, required: string[]): JsonRecord {
  const strays = Object.keys(out).filter(key => !Object.hasOwn(props, key))
  const missing = required.filter(key => !Object.hasOwn(out, key))
  if (strays.length !== 1 || missing.length !== 1) return out
  const stray = strays[0]
  const target = missing[0]
  if (stray === undefined || target === undefined) return out
  if (!Object.hasOwn(props, target)) return out
  const targetSchema = plainRecord(props[target]) ?? {}
  if (declaredType(targetSchema) === undefined && !Array.isArray(targetSchema.enum)) return out
  if (!matchesType(out[stray], targetSchema)) return out
  const renamed: JsonRecord = { ...out, [target]: out[stray] }
  delete renamed[stray]
  return renamed
}

/**
 * Call shape derived from a JSON object schema: `read_slice({ path, start? })`,
 * required keys first, optional keys marked `?`. Written as a call so a
 * one-key shape (`apply_patch({ patch })`) cannot be read as a tool name.
 */
export function synthesizeUsage(schema: Record<string, unknown>, name?: string): string {
  const props = properties(schema)
  const required = requiredKeys(schema)
  const optional = Object.keys(props).filter(key => !required.includes(key))
  const parts = [...required, ...optional.map(key => `${key}?`)]
  const body = parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`
  return name === undefined ? body : `${name}(${body})`
}

/** Append `Call as: <shape>` to a message; no-op when the marker is already there. */
export function withCallShape(message: string, shape: Record<string, unknown> | string, name?: string): string {
  if (message.includes('Call as:')) return message
  return `${message}\n\nCall as: ${typeof shape === 'string' ? shape : synthesizeUsage(shape, name)}`
}

function quoted(keys: readonly string[]): string {
  return keys.map(key => `"${key}"`).join(', ')
}

/** The required keys an arguments object does not carry. */
export function missingRequired(args: unknown, schema: Record<string, unknown>): string[] {
  const record = plainRecord(args) ?? {}
  return requiredKeys(schema).filter(key => !Object.hasOwn(record, key) || record[key] === undefined)
}

/**
 * What is wrong with the arguments object against the top level of its schema,
 * or undefined when it fits. This decides whether a failure is about the call
 * shape: a body that rejects well-shaped arguments (a hunk that does not match,
 * a refused path) gains nothing from being told the shape again.
 */
export function shapeProblem(args: unknown, schema: Record<string, unknown>): string | undefined {
  const record = plainRecord(args)
  if (record === undefined) return 'arguments must be one JSON object'
  const missing = missingRequired(record, schema)
  if (missing.length > 0) return `missing required argument${missing.length > 1 ? 's' : ''} ${quoted(missing)}`
  const props = properties(schema)
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(record).filter(key => !Object.hasOwn(props, key))
    if (unknown.length > 0) return `unknown argument${unknown.length > 1 ? 's' : ''} ${quoted(unknown)}`
  }
  for (const [key, prop] of Object.entries(props)) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) continue
    const propSchema = plainRecord(prop) ?? {}
    if (!matchesType(record[key], propSchema)) {
      const expected = Array.isArray(propSchema.enum) ? `one of ${propSchema.enum.map(entry => JSON.stringify(entry)).join(', ')}` : `of type ${declaredType(propSchema) ?? 'declared in the schema'}`
      return `argument "${key}" must be ${expected}`
    }
  }
  return undefined
}

/** Coerce literal strings and single values; never invents a missing required key. */
export function coerceBySchema(raw: unknown, schema: Record<string, unknown>): Record<string, unknown> {
  const props = properties(schema)
  const out: JsonRecord = { ...(plainRecord(raw) ?? {}) }
  for (const [key, prop] of Object.entries(props)) {
    if (!Object.hasOwn(out, key)) continue
    const value = out[key]
    const coerced = coerceValue(value, prop)
    if (coerced !== value) out[key] = coerced
  }
  return renameStray(out, props, requiredKeys(schema))
}
