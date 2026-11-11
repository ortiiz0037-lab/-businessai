/** Client form validation (pure). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const FIELDS = ['business_name', 'email', 'phone', 'address', 'city', 'state', 'postal_code', 'notes'] as const
const MAX: Record<string, number> = { name: 160, business_name: 160, email: 160, phone: 40, address: 240, city: 80, state: 80, postal_code: 20, notes: 2000 }

export type ClientInput = Record<'name' | (typeof FIELDS)[number], string | null> & { status: 'active' | 'inactive' }

export function parseClientInput(get: (key: string) => string): { ok: true; value: ClientInput } | { ok: false; error: string } {
  const name = get('name').trim()
  if (!name) return { ok: false, error: 'missing_name' }
  const value = { name } as ClientInput
  for (const f of FIELDS) value[f] = get(f).trim() || null
  for (const [k, max] of Object.entries(MAX)) {
    const v = (value as Record<string, string | null>)[k]
    if (v && v.length > max) return { ok: false, error: 'too_long' }
  }
  if (value.email && !EMAIL.test(value.email)) return { ok: false, error: 'email' }
  const status = get('status').trim()
  if (status !== 'active' && status !== 'inactive') return { ok: false, error: 'status' }
  value.status = status
  return { ok: true, value }
}

/**
 * Client totals from its invoices: billed = issued invoices that are not
 * drafts or voided; paid = payments on those invoices; balance = billed −
 * paid (never negative). Amounts in cents precision.
 */
export function clientSummary(
  invoices: { id: string; status: string; total: number | string | null }[],
  paidByDoc: Map<string, number>,
): { billed: number; paid: number; balance: number; issued: number } {
  const issued = invoices.filter((d) => d.status !== 'draft' && d.status !== 'cancelled')
  const cents = (n: number) => Math.round(n * 100) / 100
  const billed = cents(issued.reduce((s, d) => s + Number(d.total ?? 0), 0))
  const paid = cents(issued.reduce((s, d) => s + (paidByDoc.get(d.id) ?? 0), 0))
  return { billed, paid, balance: cents(Math.max(billed - paid, 0)), issued: issued.length }
}
