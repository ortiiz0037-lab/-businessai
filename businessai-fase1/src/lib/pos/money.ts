/** Exact conversions for provider amounts (never through floating point). */

/** '12.34' | '12.3' | '12' | '-0.50' → cents as bigint; null when not a plain decimal with ≤ 2 decimals. */
export function decimalToCents(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '') : String(v).trim()
  const m = /^(-)?(\d{1,13})(?:\.(\d{1,2})0*)?$/.exec(s)
  if (!m) return null
  const c = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -c : c
}

/** Quantity text with ≤ 3 decimals ('2', '0.5', '1.250'); thousandths integers (Clover unitQty) via fromThousandths. */
export function qtyText(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = typeof v === 'number' ? String(v) : String(v).trim()
  const m = /^(\d{1,7})(?:\.(\d{1,3})0*)?$/.exec(s)
  if (!m) return null
  const dec = (m[2] ?? '').replace(/0+$/, '')
  return dec ? `${Number(m[1])}.${dec}` : String(Number(m[1]))
}
export const fromThousandths = (n: number) => (Number.isSafeInteger(n) && n > 0 ? qtyText((n / 1000).toFixed(3)) : null)

/** gross = round(qty × unit) in cents, half away from zero — the same as round() in PostgreSQL. */
export function lineGross(qty: string, unitCents: bigint): bigint {
  const [i, d = ''] = qty.split('.')
  const milli = BigInt(i) * 1000n + BigInt(d.padEnd(3, '0') || '0')
  const x = milli * unitCents
  return (x + 500n) / 1000n
}

/** Splits `total` over `weights` by the largest remainder (ties: first); the parts always add up to `total`. */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (sum === 0n || total === 0n) return weights.map(() => 0n)
  const base = weights.map((w) => (total * w) / sum)
  const rem = weights.map((w, i) => ({ i, r: total * w - base[i] * sum }))
  let left = total - base.reduce((a, b) => a + b, 0n)
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  for (const { i } of rem) { if (left <= 0n) break; base[i] += 1n; left -= 1n }
  return base
}

/** round(value × rate / 100) half away from zero for non-negative value; rate with ≤ 3 decimals. */
export function percentOf(value: bigint, rate: string | number): bigint {
  const s = typeof rate === 'number' ? rate.toFixed(3) : rate
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(s.trim())
  if (!m) throw new Error('RATE_INVALID')
  const milli = BigInt(m[1]) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0') || '0')
  const x = value * milli
  return (x + 50000n) / 100000n
}
