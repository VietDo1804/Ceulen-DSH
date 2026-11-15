/**
 * Dashboard presentation tokens. Colours are host THEME KEYS, not hex: the
 * terminal already owns a palette (light/dark/pink/claude + user themes), so a
 * card surface borrowed from tui-dashboard/DESIGN.md would clash whenever the
 * user switches theme. Cell metrics stay here; the terminal owns the font.
 */
export const tokens = {
  text: 'text', muted: 'subtle', focus: 'accent', card: 'inactive',
  success: 'success', warning: 'warning', danger: 'error',
  inset: 1, wide: 120, stacked: 80, minColumns: 30, minRows: 10,
  /** Rows the title/lead/banner/region strip and the three footer lines take. */
  chrome: 7, kpiRows: 5, minCard: 5,
} as const

/** The one shared animation clock: 80ms is 12.5fps, measured ~3.5ms/frame at 120x40. */
export const motion = { tickMs: 80, rampMs: 700 } as const
