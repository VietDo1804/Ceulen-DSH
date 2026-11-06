/**
 * Full-screen `/config` scene.
 *
 * Registered through the TUI's `tuiScenes` seam. The host injects its own
 * React and ui kit, so this file imports no React and no dsh-tui package —
 * a headless composition never loads it.
 */

import { loadSettingsSync, saveSettings } from '../../core/settings.js'
import { errorMessage } from '../../core/tools.js'
import {
  appendRouteList,
  buildConfigTabs,
  displayValue,
  filterRoutes,
  keepEffort,
  parseEditValue,
  pickerRoute,
  type ConfigContext,
  type ConfigRow,
} from './model.js'

interface KeyFlags {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageUp: boolean
  pageDown: boolean
  wheelUp: boolean
  wheelDown: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
}

interface SceneReact {
  useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
}

interface SceneUi {
  Box: unknown
  Text: unknown
  useInput(handler: (input: string, key: KeyFlags) => void, options?: { isActive?: boolean }): void
  useTerminalSize(): { columns: number; rows: number }
}

export interface SceneProps {
  React: SceneReact
  ui: SceneUi
  close(): void
}

export interface ConfigSceneOptions {
  /** Rebuilt on every open so env/routes reflect the live process. */
  context: () => ConfigContext
  onSaved?: () => void
  /** DSH credential store writes for `secret` rows; absent means read-only. */
  secret?: { write(ref: string, value: string): Promise<void> }
}

interface EditState {
  key: string
  text: string
}

interface PickerState {
  key: string
  filter: string
  cursor: number
}

type Entry = { kind: 'section'; label: string } | { kind: 'row'; row: ConfigRow }

function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, 1)
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

export function createConfigScene(options: ConfigSceneOptions): (props: SceneProps) => unknown {
  return function ConfigScene(props: SceneProps): unknown {
    const React = props.React
    const ui = props.ui
    const h = React.createElement as (type: unknown, properties?: Record<string, unknown> | null, ...children: unknown[]) => unknown

    const [draft] = React.useState(() => loadSettingsSync())
    const [context] = React.useState(() => options.context())
    const [tabIndex, setTabIndex] = React.useState(0)
    const [rowIndex, setRowIndex] = React.useState(0)
    const [editing, setEditing] = React.useState<EditState | undefined>(undefined)
    const [dirty, setDirty] = React.useState(false)
    const [notice, setNotice] = React.useState<string | undefined>(undefined)
    const [saving, setSaving] = React.useState(false)
    const [picker, setPicker] = React.useState<PickerState | undefined>(undefined)
    const [catalog, setCatalog] = React.useState<readonly string[]>([])
    const [catalogState, setCatalogState] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const [, setRevision] = React.useState(0)
    // The Enter that submitted `/ceulen-config` can reach the freshly mounted
    // scene in the same keystroke batch; ignore input until the screen settles
    // so opening the panel never toggles the first row.
    const [armed, setArmed] = React.useState(false)
    React.useEffect(() => {
      const timer = setTimeout(() => setArmed(true), 200)
      return () => clearTimeout(timer)
    }, [])

    const size = ui.useTerminalSize() ?? { columns: 80, rows: 24 }
    const columns = Math.max(20, size.columns)
    const terminalRows = Math.max(10, size.rows)
    const bodyHeight = Math.max(3, terminalRows - 8)

    const tabs = buildConfigTabs(draft, context)
    const activeTabIndex = Math.min(tabIndex, tabs.length - 1)
    const tab = tabs[activeTabIndex]!
    const rows = tab.sections.flatMap(section => section.rows)
    const index = rows.length === 0 ? 0 : Math.min(rowIndex, rows.length - 1)
    const selected: ConfigRow | undefined = rows[index]

    const pickerRow = picker === undefined ? undefined : rows.find(entry => entry.key === picker.key)
    const pickerVisible = picker === undefined ? [] : filterRoutes(catalog, picker.filter)
    const pickerCursor = pickerVisible.length === 0 ? 0 : Math.min(picker?.cursor ?? 0, pickerVisible.length - 1)

    const entries: Entry[] = []
    for (const section of tab.sections) {
      entries.push({ kind: 'section', label: section.label })
      for (const entry of section.rows) entries.push({ kind: 'row', row: entry })
    }
    const cursorEntry = selected === undefined ? 0 : entries.findIndex(entry => entry.kind === 'row' && entry.row.key === selected.key)
    const start = Math.max(0, Math.min(cursorEntry - Math.floor(bodyHeight / 2), entries.length - bodyHeight))
    const visible = entries.slice(start, start + bodyHeight)

    const applyValue = (entry: ConfigRow, value: string | number | boolean): boolean => {
      if (entry.set === undefined) return false
      try {
        entry.set(value)
        setDirty(true)
        setNotice(undefined)
        setRevision(revision => revision + 1)
        return true
      } catch (error) {
        setNotice(errorMessage(error))
        return false
      }
    }

    const move = (delta: number): void => {
      if (rows.length === 0) return
      setRowIndex(Math.min(rows.length - 1, Math.max(0, index + delta)))
      setNotice(undefined)
    }

    const changeTab = (delta: number): void => {
      setTabIndex((activeTabIndex + delta + tabs.length) % tabs.length)
      setRowIndex(0)
      setEditing(undefined)
      setNotice(undefined)
    }

    const beginEdit = (entry: ConfigRow): void => {
      if (entry.kind !== 'text' && entry.kind !== 'number' && entry.kind !== 'secret') return
      // Never prefill a secret: the field starts empty and shows presence only.
      setEditing({ key: entry.key, text: entry.kind === 'secret' ? '' : String(entry.value) })
      setNotice(undefined)
    }

    /** Open the filterable model list, loading the catalog on first use. */
    const openPicker = (entry: ConfigRow): void => {
      // A list row has no single current route, so the picker starts unfiltered.
      const current = entry.pickerAppend === true
        ? ''
        : String(entry.value).replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, '')
      setPicker({ key: entry.key, filter: '', cursor: 0 })
      setNotice(undefined)
      if (catalogState === 'loading' || catalogState === 'ready') {
        setPicker(state => state === undefined ? state : { ...state, cursor: Math.max(0, catalog.indexOf(current)) })
        return
      }
      const load = context.modelRoutes
      if (load === undefined) {
        setCatalogState('ready')
        return
      }
      setCatalogState('loading')
      void load()
        .then(routes => {
          setCatalog(routes)
          setCatalogState('ready')
          // Start on the row's current route, if the catalog lists it.
          setPicker(state => state === undefined || state.filter !== ''
            ? state
            : { ...state, cursor: Math.max(0, routes.indexOf(current)) })
        })
        .catch((error: unknown) => {
          setCatalogState('error')
          setNotice(`Model list failed: ${errorMessage(error)}`)
        })
    }

    const movePicker = (delta: number): void => {
      if (pickerVisible.length === 0) return
      const cursor = Math.max(0, Math.min(pickerVisible.length - 1, pickerCursor + delta))
      setPicker(state => state === undefined ? state : { ...state, cursor })
    }

    const commitPicker = (): void => {
      if (picker === undefined) return
      const entry = pickerRow
      if (entry === undefined) {
        setPicker(undefined)
        return
      }
      const picked = pickerRoute(pickerVisible, pickerCursor, picker.filter)
      if (picked === undefined) {
        setNotice('Pick a listed model or type provider/model')
        return
      }
      if (entry.pickerAppend === true) {
        if (applyValue(entry, appendRouteList(String(entry.value), picked))) setPicker(undefined)
        return
      }
      if (applyValue(entry, keepEffort(picked, String(entry.value)))) setPicker(undefined)
    }

    const commitEdit = (): void => {
      if (editing === undefined) return
      const entry = rows.find(candidate => candidate.key === editing.key)
      if (entry === undefined) {
        setEditing(undefined)
        return
      }
      if (entry.kind === 'secret') {
        const ref = entry.ref
        const writer = options.secret
        if (ref === undefined || writer === undefined) {
          setNotice('Credential store unavailable; set the key in the environment instead')
          return
        }
        const value = editing.text.trim()
        // Empty input must not silently wipe a working key; `-` is the
        // deliberate clear.
        if (value.length === 0) {
          setNotice(`No change to ${entry.label} (type - and Enter to clear it)`)
          return
        }
        setEditing(undefined)
        void writer.write(ref, value === '-' ? '' : value)
          .then(() => {
            setNotice(`${entry.label} ${value === '-' ? 'cleared' : 'saved'}`)
            setRevision(revision => revision + 1)
          })
          .catch((error: unknown) => setNotice(`Save failed: ${errorMessage(error)}`))
        return
      }
      const parsed = parseEditValue(entry, editing.text)
      if (parsed === undefined) {
        setNotice(`Invalid value — ${entry.label}`)
        return
      }
      if (applyValue(entry, parsed)) setEditing(undefined)
    }

    const saveAndClose = (): void => {
      if (!dirty) {
        props.close()
        return
      }
      setSaving(true)
      void saveSettings(draft)
        .then(() => {
          options.onSaved?.()
          props.close()
        })
        .catch((error: unknown) => {
          setSaving(false)
          setNotice(`Save failed: ${errorMessage(error)}`)
        })
    }

    ui.useInput((input, key) => {
      if (!armed || saving) return

      if (picker !== undefined) {
        if (key.escape) {
          setPicker(undefined)
          setNotice(undefined)
          return
        }
        if (key.return) {
          commitPicker()
          return
        }
        if (key.upArrow || key.wheelUp) {
          movePicker(-1)
          return
        }
        if (key.downArrow || key.wheelDown) {
          movePicker(1)
          return
        }
        if (key.backspace || key.delete) {
          setPicker(current => current === undefined ? current : { ...current, filter: current.filter.slice(0, -1), cursor: 0 })
          return
        }
        if (key.ctrl && input.toLowerCase() === 'u') {
          setPicker(current => current === undefined ? current : { ...current, filter: '', cursor: 0 })
          return
        }
        if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
          const text = input.replace(/[\r\n\t]/g, '')
          if (text.length > 0) {
            setPicker(current => current === undefined ? current : { ...current, filter: current.filter + text, cursor: 0 })
          }
        }
        return
      }

      if (editing !== undefined) {
        if (key.escape) {
          setEditing(undefined)
          setNotice(undefined)
          return
        }
        if (key.return) {
          commitEdit()
          return
        }
        if (key.backspace || key.delete) {
          setEditing(current => current === undefined ? current : { ...current, text: current.text.slice(0, -1) })
          return
        }
        if (key.ctrl && input.toLowerCase() === 'u') {
          setEditing(current => current === undefined ? current : { ...current, text: '' })
          return
        }
        if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
          const text = input.replace(/[\r\n\t]/g, ' ')
          if (text.length > 0) {
            setEditing(current => current === undefined ? current : { ...current, text: current.text + text })
          }
        }
        return
      }

      if (key.escape) {
        saveAndClose()
        return
      }
      if (key.upArrow || key.wheelUp) {
        move(-1)
        return
      }
      if (key.downArrow || key.wheelDown) {
        move(1)
        return
      }
      if (key.pageUp) {
        move(-bodyHeight)
        return
      }
      if (key.pageDown) {
        move(bodyHeight)
        return
      }
      if (key.home) {
        setRowIndex(0)
        return
      }
      if (key.end) {
        setRowIndex(Math.max(0, rows.length - 1))
        return
      }
      if (key.tab) {
        changeTab(key.shift ? -1 : 1)
        return
      }
      // `‹ value ›` promises arrows work. On an enum row they cycle the value;
      // anywhere else they still switch tabs.
      if (key.rightArrow || key.leftArrow) {
        const delta = key.rightArrow ? 1 : -1
        const values = selected?.kind === 'enum' ? (selected.values ?? []) : []
        if (selected !== undefined && values.length > 0) {
          const at = values.indexOf(String(selected.value))
          const next = values[(at + delta + values.length) % values.length]!
          applyValue(selected, next)
          return
        }
        changeTab(delta)
        return
      }
      if (key.return) {
        if (selected === undefined) return
        if (selected.kind === 'toggle') {
          applyValue(selected, selected.value !== true)
          return
        }
        if (selected.kind === 'enum') {
          const values = selected.values ?? []
          if (values.length === 0) return
          const at = values.indexOf(String(selected.value))
          applyValue(selected, values[(at + 1) % values.length]!)
          return
        }
        if (selected.kind === 'text' && selected.picker === true) {
          openPicker(selected)
          return
        }
        beginEdit(selected)
        return
      }
      if (input === ' ' && selected?.kind === 'toggle') {
        applyValue(selected, selected.value !== true)
      }
    })

    const labelWidth = Math.max(18, Math.min(30, Math.floor(columns * 0.4)))
    const headerRight = saving
      ? 'saving…'
      : `${dirty ? '● unsaved' : 'saved'} · ${rows.length === 0 ? '0' : index + 1}/${rows.length}`

    const renderRow = (entry: ConfigRow): unknown => {
      const isSelected = selected !== undefined && entry.key === selected.key
      const isEditing = editing !== undefined && entry.key === editing.key
      const emptyText = entry.kind === 'text' && String(entry.value).length === 0
      const valueText = isEditing
        ? entry.kind === 'secret' ? `${'•'.repeat(editing.text.length)}▏` : `${editing.text}▏`
        : entry.kind === 'toggle'
          ? (entry.value === true ? 'on' : 'off')
          : entry.kind === 'enum'
            ? `‹ ${String(entry.value)} ›`
            : emptyText
              ? (entry.placeholder ?? '(empty)')
              : displayValue(entry)
      const valueColor = isEditing
        ? 'accent'
        : entry.kind === 'toggle'
          ? (entry.value === true ? 'success' : 'inactive')
          : entry.kind === 'info' || emptyText
            ? 'subtle'
            : undefined
      return h(
        ui.Box,
        { key: entry.key, flexDirection: 'row' },
        h(ui.Text, { color: isSelected ? 'accent' : 'subtle' }, isSelected ? '❯ ' : '  '),
        h(
          ui.Box,
          { width: labelWidth, flexShrink: 0 },
          h(ui.Text, { bold: isSelected, color: isSelected ? 'accent' : undefined, wrap: 'truncate-end' }, entry.label),
        ),
        h(ui.Box, { flexGrow: 1 }, h(ui.Text, { color: valueColor, wrap: 'truncate-end' }, valueText)),
      )
    }

    const pickerWindow = Math.max(1, bodyHeight - 1)
    const pickerStart = Math.max(0, Math.min(pickerCursor - Math.floor(pickerWindow / 2), pickerVisible.length - pickerWindow))

    const pickerBody = (): unknown[] => {
      if (picker === undefined) return []
      const count = pickerVisible.length === 0 ? '' : `  ${pickerCursor + 1}/${pickerVisible.length}`
      const lines: unknown[] = [
        h(ui.Text, { key: 'picker:filter', color: 'accent', wrap: 'truncate-end' }, `Filter: ${picker.filter}▏${count}`),
      ]
      if (catalogState === 'loading') {
        lines.push(h(ui.Text, { key: 'picker:loading', color: 'subtle' }, ' loading models from registered providers…'))
        return lines
      }
      if (pickerVisible.length === 0) {
        const message = catalog.length === 0
          ? catalogState === 'error'
            ? 'model list unavailable — type provider/model and Enter'
            : 'no models advertised by registered providers — type provider/model and Enter'
          : 'no match — type provider/model and Enter'
        lines.push(h(ui.Text, { key: 'picker:empty', color: 'subtle', wrap: 'truncate-end' }, ` ${message}`))
        return lines
      }
      for (let position = pickerStart; position < Math.min(pickerStart + pickerWindow, pickerVisible.length); position += 1) {
        const route = pickerVisible[position]!
        const isCurrent = position === pickerCursor
        lines.push(h(
          ui.Box,
          { key: `picker:${route}`, flexDirection: 'row' },
          h(ui.Text, { color: isCurrent ? 'accent' : 'subtle' }, isCurrent ? '❯ ' : '  '),
          h(ui.Text, { color: isCurrent ? 'accent' : undefined, wrap: 'truncate-end' }, route),
        ))
      }
      return lines
    }

    const body = picker === undefined
      ? visible.map(entry => entry.kind === 'section'
        ? h(ui.Text, { key: `section:${tab.id}:${entry.label}`, color: 'subtle', bold: true }, ` ${entry.label}`)
        : renderRow(entry.row))
      : pickerBody()

    const warning = selected?.warning
    const hint = notice
      ?? (selected === undefined
        ? ''
        : [warning === undefined ? '' : `⚠ ${warning}`, selected.description ?? ''].filter(part => part.length > 0).join('  '))
    const hintColor = notice !== undefined ? 'error' : warning !== undefined ? 'warning' : 'subtle'
    const hints = saving
      ? 'saving settings…'
      : picker !== undefined
        ? "type filter · ↑↓ move · Enter select · Esc cancel · '-' clears"
        : editing !== undefined
          ? rows.find(entry => entry.key === editing.key)?.kind === 'secret'
            ? "Enter save · Esc cancel · input hidden · '-' clears"
            : 'Enter commit · Esc cancel · Backspace edit'
          : selected?.kind === 'text' && selected.picker === true
            ? 'Enter pick model · ↑↓ move · Tab switch tab · Esc save & close'
            : selected?.kind === 'enum'
              ? '↑↓ move · ←→ change · Tab switch tab · Esc save & close'
              : '↑↓ move · ←→ tab · Enter edit/toggle · Esc save & close'
    const tabLine = fit(tabs.map((entry, position) => position === activeTabIndex ? `[${entry.label}]` : ` ${entry.label} `).join(' · '), columns - 4)

    return h(
      ui.Box,
      { flexDirection: 'column', width: columns, height: terminalRows, borderStyle: 'round', borderColor: 'accent', paddingX: 1 },
      h(
        ui.Box,
        { flexDirection: 'row', justifyContent: 'space-between' },
        h(ui.Text, { bold: true, color: 'accent' }, 'Ceulen config'),
        h(ui.Text, { color: dirty ? 'warning' : 'subtle' }, headerRight),
      ),
      h(ui.Text, { color: 'text', wrap: 'truncate-end' }, tabLine),
      h(ui.Text, { color: 'subtle' }, '─'.repeat(Math.max(1, columns - 4))),
      h(ui.Box, { flexDirection: 'column', height: bodyHeight }, ...body),
      h(ui.Text, { color: 'subtle' }, '─'.repeat(Math.max(1, columns - 4))),
      h(ui.Text, { color: hintColor, wrap: 'truncate-end' }, hint.length > 0 ? hint : ' '),
      h(ui.Text, { color: 'subtle', wrap: 'truncate-end' }, hints),
    )
  }
}
