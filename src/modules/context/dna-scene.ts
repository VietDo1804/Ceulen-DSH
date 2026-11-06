/**
 * Full-screen `/context --play` scene: the recorded context DNA, replayed.
 *
 * Registered through the TUI's `tuiScenes` seam. The host injects its own
 * React and ui kit, so this file imports no React and no dsh-tui package — a
 * headless composition never loads it. Colours are the host's semantic names,
 * never ANSI: the scene renders through `<Text color=…>`, not through the
 * registry-command path that `scripts/tui-context-patch.mjs` sanitizes.
 */

import {
  BAND_GLYPHS,
  describeSnapshot,
  formatTokens,
  layoutGenome,
  type DnaCategory,
  type DnaSnapshot,
} from './dna.js'

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

export interface DnaSceneOptions {
  /** Read on mount: the frames collected for the session that opened the scene. */
  snapshots(): readonly DnaSnapshot[]
  /** Replay speed, one frame per tick. Defaults to 140 ms. */
  intervalMs?: number
}

/** Category → the host's semantic colour names (the config scene's vocabulary). */
const CAT_COLORS: Record<DnaCategory, string | undefined> = {
  system: 'accent',
  tools: 'success',
  messages: 'text',
  other: 'subtle',
}

const EMPTY: DnaSnapshot = { seq: 0, turn: 1, items: [], total: 0 }

export function createDnaScene(options: DnaSceneOptions): (props: SceneProps) => unknown {
  return function DnaScene(props: SceneProps): unknown {
    const React = props.React
    const ui = props.ui
    const h = React.createElement as (
      type: unknown,
      properties?: Record<string, unknown> | null,
      ...children: unknown[]
    ) => unknown

    const [frames] = React.useState(() => options.snapshots())
    const last = Math.max(0, frames.length - 1)
    const [frame, setFrame] = React.useState(last)
    const [playing, setPlaying] = React.useState(false)
    const [focus, setFocus] = React.useState(0)
    const size = ui.useTerminalSize()
    const current = frames[Math.min(frame, last)] ?? EMPTY

    React.useEffect(() => {
      if (!playing) return
      const timer = setTimeout(() => {
        if (frame >= last) {
          setPlaying(false)
          return
        }
        setFrame(frame + 1)
      }, options.intervalMs ?? 140)
      return () => clearTimeout(timer)
    }, [playing, frame, last])

    ui.useInput((input, key) => {
      if (key.escape) {
        setPlaying(false)
        props.close()
        return
      }
      if (input === ' ' || key.return) {
        if (playing) {
          setPlaying(false)
          return
        }
        if (frame >= last) {
          setFrame(0)
          setFocus(0)
        }
        setPlaying(true)
        return
      }
      if (key.leftArrow) {
        setPlaying(false)
        setFrame(Math.max(0, frame - 1))
        return
      }
      if (key.rightArrow) {
        setPlaying(false)
        setFrame(Math.min(last, frame + 1))
        return
      }
      if (key.upArrow) {
        setFocus(Math.max(0, focus - 1))
        return
      }
      if (key.downArrow) {
        setFocus(focus + 1)
        return
      }
      if (key.home) {
        setPlaying(false)
        setFrame(0)
        return
      }
      if (key.end) {
        setPlaying(false)
        setFrame(last)
      }
    })

    const barWidth = Math.max(20, (size.columns ?? 80) - 16)
    const bars = Math.max(3, Math.min((size.rows ?? 24) - 12, 10))
    const start = Math.max(0, Math.min(frame - bars + 1, Math.max(0, frames.length - bars)))
    const visible = frames.slice(start, Math.min(frames.length, start + bars))
    const ranked = [...current.items].sort((a, b) => b.tokens - a.tokens).slice(0, 6)
    const focused = ranked[Math.min(focus, Math.max(0, ranked.length - 1))]

    const row = (snapshot: DnaSnapshot, index: number, isCurrent: boolean): unknown => {
      const bands = layoutGenome(snapshot, { width: barWidth, maxBands: 12 })
      const glyphs = bands.map((band, position) => h(
        ui.Text,
        {
          key: `band-${index}-${position}`,
          color: CAT_COLORS[band.cat],
          bold: isCurrent && focused !== undefined && band.key === focused.key,
        },
        BAND_GLYPHS[band.cat].repeat(band.cells),
      ))
      return h(
        ui.Box,
        { key: `row-${index}`, flexDirection: 'row' },
        h(ui.Text, { color: isCurrent ? 'accent' : 'subtle' }, isCurrent ? '❯' : ' '),
        h(ui.Text, { color: 'subtle' }, `T${snapshot.turn} `.padEnd(4)),
        ...glyphs,
        h(ui.Text, { color: 'subtle' }, ` ${formatTokens(snapshot.total).padStart(7)}`),
      )
    }

    const lines: unknown[] = [
      h(
        ui.Text,
        { key: 'header', color: 'accent', bold: true },
        ` Context DNA · ${describeSnapshot(current, { index: frame, count: Math.max(1, frames.length) })}${playing ? ' · ▶' : ''}`,
      ),
      h(ui.Text, { key: 'legend', color: 'subtle' }, ' █ system  ▓ tools  ▒ messages  ░ folded'),
    ]

    if (frames.length === 0) {
      lines.push(h(ui.Text, { key: 'empty', color: 'subtle' }, ' No model request recorded in this session yet.'))
    } else {
      for (const [index, snapshot] of visible.entries()) {
        lines.push(row(snapshot, index, start + index === frame))
      }
      if (frames.length > visible.length) {
        lines.push(h(ui.Text, { key: 'window', color: 'subtle' }, ` ${frames.length} requests recorded · showing ${visible.length}`))
      }
      lines.push(h(ui.Text, { key: 'gap' }, ' '))
      for (const [index, item] of ranked.entries()) {
        lines.push(h(
          ui.Text,
          { key: `item-${index}`, color: CAT_COLORS[item.cat] },
          `${index === Math.min(focus, ranked.length - 1) ? '❯' : ' '}${BAND_GLYPHS[item.cat]} ${item.label.padEnd(18).slice(0, 18)} ${formatTokens(item.tokens).padStart(7)}`,
        ))
      }
      if (current.items.length > ranked.length) {
        lines.push(h(ui.Text, { key: 'more', color: 'subtle' }, `  +${current.items.length - ranked.length} more items`))
      }
    }

    lines.push(h(
      ui.Text,
      { key: 'footer', color: 'subtle' },
      ' space play/pause · ←/→ step · ↑/↓ item · home/end · esc close',
    ))

    return h(
      ui.Box,
      {
        flexDirection: 'column',
        width: size.columns,
        height: size.rows,
        borderStyle: 'round',
        borderColor: 'accent',
        paddingX: 1,
      },
      ...lines,
    )
  }
}
