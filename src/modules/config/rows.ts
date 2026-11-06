import { credential } from '../../core/credentials.js'
import { clampNumber } from './helpers.js'
import type { ConfigContext, ConfigKind, ConfigRow, ConfigValue, RowOptions } from './types.js'

export function row(
  key: string,
  label: string,
  kind: ConfigKind,
  value: ConfigValue,
  set: ((value: ConfigValue) => void) | undefined,
  options: RowOptions = {},
): ConfigRow {
  return {
    key,
    label,
    kind,
    value,
    ...(set === undefined ? {} : { set }),
    ...(options.picker === undefined ? {} : { picker: options.picker }),
    ...(options.pickerAppend === undefined ? {} : { pickerAppend: options.pickerAppend }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.warning === undefined ? {} : { warning: options.warning }),
    ...(options.values === undefined ? {} : { values: options.values }),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.min === undefined ? {} : { min: options.min }),
    ...(options.max === undefined ? {} : { max: options.max }),
  }
}

export function text(
  key: string,
  label: string,
  value: string,
  set: (value: string) => void,
  options: RowOptions = {},
): ConfigRow {
  return row(key, label, 'text', value, next => { set(String(next)) }, options)
}

export function toggle(key: string, label: string, value: boolean, set: (value: boolean) => void, options: RowOptions = {}): ConfigRow {
  return row(key, label, 'toggle', value, next => { set(next === true) }, options)
}

export function number(
  key: string,
  label: string,
  value: number,
  set: (value: number) => void,
  min: number,
  max: number,
  options: RowOptions = {},
): ConfigRow {
  return row(key, label, 'number', value, next => { set(clampNumber(Number(next), min, max)) }, { ...options, min, max })
}

export function option(
  key: string,
  label: string,
  value: string,
  values: readonly string[],
  set: (value: string) => void,
  options: RowOptions = {},
): ConfigRow {
  return row(key, label, 'enum', value, next => { set(String(next)) }, { ...options, values })
}

export function info(key: string, label: string, value: string, description?: string): ConfigRow {
  return row(key, label, 'info', value, undefined, description === undefined ? {} : { description })
}

/**
 * A credential row: shows presence only and edits go to the DSH credential
 * store, so no secret ever lands in settings.json or the transcript.
 */
export function secret(context: ConfigContext, key: string, label: string, ref: string, description?: string): ConfigRow {
  const env = context.env ?? process.env
  const fromEnv = env[ref] !== undefined && env[ref] !== ''
  return row(key, label, 'secret', fromEnv ? 'set (env)' : secretStatus(ref), undefined, {
    ref,
    ...(description === undefined ? {} : { description }),
  })
}

/** Presence label for a credential ref; never the value. */
export function secretStatus(ref: string): string {
  const resolved = credential(ref)
  if (resolved.source === 'dsh-credential') return 'set (credential store)'
  if (resolved.source === 'env') return 'set (env)'
  return 'unset'
}
