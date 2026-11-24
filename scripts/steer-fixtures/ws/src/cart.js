// Cart totals for the steer fixtures. Line numbers matter: the fixtures ask for them.
export const TAX_RATE = 0.08

// TODO: load discounts from the price list
export function applyDiscount(amount, percent) {
  return amount - (amount * percent) / 100
}

// TODO: round per line item, not per order
export function computeTotal(items) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  return subtotal + subtotal * TAX_RATE
}

// TODO: support more than one currency
export function formatTotal(total) {
  return `$${total.toFixed(2)}`
}
