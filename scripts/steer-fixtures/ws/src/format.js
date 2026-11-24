// Formatting helpers for the steer fixtures.
export function pad(value, width) {
  const text = String(value)
  if (text.length >= width) return text
  return ' '.repeat(width - text.length) + text
}
