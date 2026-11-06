export type ConfigValue = string | number | boolean

export type ConfigKind = 'toggle' | 'text' | 'number' | 'enum' | 'info' | 'secret'

export interface ConfigRow {
  readonly key: string
  readonly label: string
  readonly kind: ConfigKind
  /** Effective value rendered by the panel. */
  readonly value: ConfigValue
  /** Text row whose Enter opens the model picker instead of the inline editor. */
  readonly picker?: boolean
  /**
   * Picker appends the picked route to this row's comma list instead of
   * replacing it — the fallback rows are lists, not a single route.
   */
  readonly pickerAppend?: boolean
  readonly description?: string
  readonly warning?: string
  /** Closed value set for `enum` rows. */
  readonly values?: readonly string[]
  /** Credential reference a `secret` row writes through the DSH store. */
  readonly ref?: string
  /** Shown when a text row's value is empty. */
  readonly placeholder?: string
  readonly min?: number
  readonly max?: number
  /** Mutates the working settings object; omitted for `info` rows. */
  readonly set?: (value: ConfigValue) => void
}

export interface ConfigSection {
  readonly id: string
  readonly label: string
  readonly rows: readonly ConfigRow[]
}

export interface ConfigTab {
  readonly id: string
  readonly label: string
  readonly sections: readonly ConfigSection[]
}

export interface ConfigContext {
  readonly settingsFile: string
  readonly routes?: readonly string[]
  /** `provider/model` for every model the registered providers advertise. */
  readonly modelRoutes?: () => Promise<readonly string[]>
  /** Whether the DSH PTC runtime is mounted for the codemode tool. */
  readonly codemodeRuntime?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface RowOptions {
  picker?: boolean
  pickerAppend?: boolean
  description?: string
  warning?: string
  values?: readonly string[]
  ref?: string
  placeholder?: string
  min?: number
  max?: number
}
