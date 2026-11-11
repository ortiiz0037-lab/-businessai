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
