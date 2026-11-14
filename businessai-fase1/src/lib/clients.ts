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

/** CRM fields of a client (0035): kind, legal name, tax ID, lifecycle, source, responsible, branch. */
export type ClientCrmInput = { kind: 'individual' | 'company'; legal_name: string | null; tax_id: string | null; lifecycle: 'lead' | 'prospect' | 'customer' | 'former'
  source: string | null; owner_id: string | null; branch_id: string | null }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function parseClientCrm(get: (key: string) => string): { ok: true; value: ClientCrmInput } | { ok: false; error: string } {
  const kind = get('kind').trim() || 'individual'
  const lifecycle = get('lifecycle').trim() || 'customer'
  if (kind !== 'individual' && kind !== 'company') return { ok: false, error: 'kind' }
  if (!['lead', 'prospect', 'customer', 'former'].includes(lifecycle)) return { ok: false, error: 'lifecycle' }
  const legal = get('legal_name').trim(), tax = get('tax_id').trim(), source = get('source').trim()
  if (legal.length > 200 || tax.length > 40 || source.length > 80) return { ok: false, error: 'too_long' }
  const owner = get('owner_id').trim(), branch = get('branch_id').trim()
  return { ok: true, value: { kind: kind as ClientCrmInput['kind'], legal_name: legal || null, tax_id: tax || null, lifecycle: lifecycle as ClientCrmInput['lifecycle'],
    source: source || null, owner_id: UUID_RE.test(owner) ? owner : null, branch_id: UUID_RE.test(branch) ? branch : null } }
}
