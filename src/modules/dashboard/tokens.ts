/**
 * Dashboard presentation tokens. Colours are host THEME KEYS, not hex: the
 * terminal already owns a palette (light/dark/pink/claude + user themes), so a
 * card surface borrowed from tui-dashboard/DESIGN.md would clash whenever the
 * user switches theme. Cell metrics stay here; the terminal owns the font.
 */
export const tokens = {
  text: 'text', muted: 'subtle', focus: 'accent', card: 'inactive',
  success: 'success', danger: 'error',
  inset: 1, wide: 120, minColumns: 30, minRows: 10,
} as const

/** The one shared animation clock, used only while a native run is live. */
export const motion = { tickMs: 80 } as const
