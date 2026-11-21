/**
 * Cart pricing for the register screen. It mirrors ba_private.pos_price (0044) exactly so the
 * cashier sees the amount the server will charge; the server recomputes everything from the
 * catalog and is the only source of the stored amounts (tests compare both on the same carts).
 *   gross    = round(qty × unit price)
 *   line     = discount in cents or percent of the gross
 *   cart     = discount in cents or percent of the lines' net, allocated by largest remainder
 *   tax      = round((gross − discounts) × rate / 100) per line
 */
import { allocate, lineGross, percentOf } from '@/lib/pos/money'

export type CartLineInput = { key: string; name: string; qty: string; unitCents: bigint; taxRate: string; discountCents?: bigint; discountPct?: string }
export type PricedLine = CartLineInput & { gross: bigint; discount: bigint; tax: bigint; total: bigint }
export type PricedCart = { lines: PricedLine[]; subtotal: bigint; discount: bigint; tax: bigint; total: bigint; discountPct: number }

export class PricingError extends Error {}

export function priceCart(input: CartLineInput[], cart: { cents?: bigint; pct?: string } = {}): PricedCart {
  const pre = input.map((l) => {
    if (!/^\d{1,7}(\.\d{1,3})?$/.test(l.qty) || Number(l.qty) <= 0) throw new PricingError('POS_QTY_INVALID')
    const gross = lineGross(l.qty, l.unitCents)
    const d = l.discountPct !== undefined ? percentOf(gross, l.discountPct) : (l.discountCents ?? 0n)
    if (d < 0n || d > gross || (l.discountPct !== undefined && Number(l.discountPct) > 100)) throw new PricingError('POS_DISCOUNT_INVALID')
    return { l, gross, lineDisc: d }
  })
  const nets = pre.map((p) => p.gross - p.lineDisc)
  const sumNet = nets.reduce((a, b) => a + b, 0n)
  const cartCents = cart.cents ?? (cart.pct !== undefined ? percentOf(sumNet, cart.pct) : 0n)
  if (cartCents < 0n || cartCents > sumNet) throw new PricingError('POS_DISCOUNT_INVALID')
  const alloc = allocate(cartCents, nets)
  const lines = pre.map((p, i) => {
    const discount = p.lineDisc + alloc[i]
    const tax = percentOf(p.gross - discount, p.l.taxRate)
    return { ...p.l, gross: p.gross, discount, tax, total: p.gross - discount + tax }
  })
  const subtotal = lines.reduce((a, l) => a + l.gross, 0n)
  const discount = lines.reduce((a, l) => a + l.discount, 0n)
  const tax = lines.reduce((a, l) => a + l.tax, 0n)
  return { lines, subtotal, discount, tax, total: subtotal - discount + tax, discountPct: subtotal === 0n ? 0 : Math.round(Number((discount * 10000n) / subtotal)) / 100 }
}

/** Cash tendered → change; null when the cash does not cover the amount. */
export function changeFor(amountCents: bigint, tenderedCents: bigint): bigint | null {
  return tenderedCents >= amountCents ? tenderedCents - amountCents : null
}

/** Quick-cash buttons: the exact amount, then the next round bills above it. */
export function quickCash(amountCents: bigint): bigint[] {
  const out = new Set<bigint>([amountCents])
  for (const bill of [100n, 500n, 1000n, 2000n, 5000n, 10000n]) {
    const up = ((amountCents + bill - 1n) / bill) * bill
    if (up > amountCents) out.add(up)
    if (out.size >= 4) break
  }
  return [...out].sort((a, b) => (a < b ? -1 : 1)).slice(0, 4)
}
