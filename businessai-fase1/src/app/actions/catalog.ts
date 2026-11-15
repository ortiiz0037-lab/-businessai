'use server'
/**
 * Catalog actions (migration 0039). Writes run with the user's session through
 * catalog_save / catalog_set_status: PostgreSQL checks catalog.manage, the
 * company, unique codes, the optimistic version and keeps the history.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { CODE_RE, catalogErrorCode, parsePriceCents, parseTaxRate } from '@/lib/catalog'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
  for (const k of ['done', 'error']) sp.delete(k)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${base}?${sp.toString()}`)
}
async function company() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/catalog')
  const m = await getActiveMembership(supabase, user.id)
  if (!m) redirect('/onboarding')
  return { supabase, companyId: m.companyId }
}

/** Create (no id) or update (id + version) a catalog item. */
export async function saveCatalogItem(formData: FormData) {
  const id = text(formData, 'id')
  const isNew = !id
  const back = isNew ? '/catalog' : `/catalog/${id}`
  if (!isNew && !UUID.test(id)) go('/catalog', { error: 'catalog_not_found' })
  const code = text(formData, 'code'), name = text(formData, 'name'), unit = text(formData, 'unit') || 'unidad'
  const kind = text(formData, 'kind') === 'service' ? 'service' : 'product'
  const price = parsePriceCents(text(formData, 'price'))
  if (price === null) go(back, { error: 'price' })
  const tax = parseTaxRate(text(formData, 'tax_rate'))
  if (tax === undefined) go(back, { error: 'tax' })
  if (!CODE_RE.test(code) || !name || name.length > 160 || unit.length > 20) go(back, { error: 'catalog_invalid' })
  const version = Number(text(formData, 'version'))
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('catalog_save', {
    target: companyId, item: isNew ? null : id, p_code: code, p_name: name, p_description: text(formData, 'description').slice(0, 1000) || null,
    p_kind: kind, p_unit: unit, p_price_cents: price, p_tax_rate: tax, p_track_inventory: kind === 'product' && formData.get('track_inventory') === 'on',
    expected_version: isNew ? null : (Number.isInteger(version) ? version : -1),
  })
  const row = ((data ?? []) as { id: string; version: number }[])[0]
  if (error || !row) go(back, { error: catalogErrorCode(error) })
  revalidatePath('/catalog', 'layout')
  go(`/catalog/${row.id}`, { done: isNew ? 'created' : 'saved' })
}

/** Archive or restore (documents that used the item keep their copy). */
export async function setCatalogStatus(formData: FormData) {
  const id = text(formData, 'id')
  if (!UUID.test(id)) go('/catalog', { error: 'catalog_not_found' })
  const status = text(formData, 'status') === 'active' ? 'active' : 'archived'
  const { supabase } = await company()
  const { error } = await supabase.rpc('catalog_set_status', { item: id, p_status: status, expected_version: Number(text(formData, 'version')) || -1 })
  if (error) go(`/catalog/${id}`, { error: catalogErrorCode(error) })
  revalidatePath('/catalog', 'layout')
  go(`/catalog/${id}`, { done: status === 'archived' ? 'archived' : 'restored' })
}
