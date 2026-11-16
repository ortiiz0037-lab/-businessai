import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { formatCents } from '@/lib/finance/money'
import { ZERO_KEY } from '@/lib/inventory/labels'

export type InventoryAccess = { view: boolean; operate: boolean; approve: boolean; catalog: boolean; payables: boolean; available: boolean }
export type Branch = { id: string; name: string; code: string }
export type ProductRef = { id: string; code: string; name: string; unit: string; cost_cents: number | null; status: string; variants: { id: string; sku: string; attributes: Record<string, string>; status: string }[] }

export async function inventoryAccess(supabase: SupabaseClient, companyId: string): Promise<InventoryAccess> {
  const keys = ['inventory.view', 'inventory.operate', 'inventory.approve', 'catalog.manage', 'payables.view']
  const [answers, probe] = await Promise.all([
    Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: k }))),
    supabase.from('inventory_settings').select('company_id').limit(1),
  ])
  const [view, operate, approve, catalog, payables] = answers.map((a) => !a.error && a.data === true)
  return { view, operate, approve, catalog, payables, available: !probe.error }
}

/** Common context of the inventory pages (/inventory/*). */
export async function inventoryPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/inventory')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const companyId = member.companyId
  const access = await inventoryAccess(supabase, companyId)
  const money = (c: number | string | null | undefined) => formatCents(Math.round(Number(c ?? 0)), locale)
  return { locale, tr, f, money, supabase, user, companyId, access }
}

/** Branches the caller may work with (the database applies the same rule on every write). */
export async function myBranches(supabase: SupabaseClient, companyId: string): Promise<Branch[]> {
  const { data } = await supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name')
  const all = (data ?? []) as Branch[]
  const ok = await Promise.all(all.map((b) => supabase.rpc('inventory_branch_ok', { target: companyId, branch: b.id })))
  return all.filter((_, i) => ok[i].data === true)
}

/** Tracked products with their variants (for pickers and labels). */
export async function trackedProducts(supabase: SupabaseClient, companyId: string): Promise<ProductRef[]> {
  const [{ data: items }, { data: vars }] = await Promise.all([
    supabase.from('catalog_items').select('id, code, name, unit, cost_cents, status').eq('company_id', companyId).eq('track_inventory', true).order('name').limit(2000),
    supabase.from('catalog_variants').select('id, item_id, sku, attributes, status').eq('company_id', companyId).order('sku').limit(5000),
  ])
  const byItem = new Map<string, ProductRef['variants']>()
  for (const v of (vars ?? []) as { id: string; item_id: string; sku: string; attributes: Record<string, string>; status: string }[]) {
    byItem.set(v.item_id, [...(byItem.get(v.item_id) ?? []), { id: v.id, sku: v.sku, attributes: v.attributes, status: v.status }])
  }
  return ((items ?? []) as Omit<ProductRef, 'variants'>[]).map((i) => ({ ...i, variants: byItem.get(i.id) ?? [] }))
}

/** "item|variant" option values for selects; the variant part is empty for products without variants. */
export function stockOptions(products: ProductRef[]) {
  const out: { value: string; label: string; item: string; variant: string | null }[] = []
  for (const p of products) {
    const active = p.variants.filter((v) => v.status === 'active')
    if (active.length) for (const v of active) out.push({ value: `${p.id}|${v.id}`, label: `${p.name} · ${Object.values(v.attributes).join(' / ')} (${v.sku})`, item: p.id, variant: v.id })
    else if (p.status === 'active') out.push({ value: `${p.id}|`, label: `${p.name} (${p.code})`, item: p.id, variant: null })
  }
  return out
}

export function productLabel(products: ProductRef[], item: string, variantKey: string | null) {
  const p = products.find((x) => x.id === item)
  if (!p) return '—'
  const v = variantKey && variantKey !== ZERO_KEY ? p.variants.find((x) => x.id === variantKey) : null
  return v ? `${p.name} · ${Object.values(v.attributes).join(' / ')}` : p.name
}
export function productCode(products: ProductRef[], item: string, variantKey: string | null) {
  const p = products.find((x) => x.id === item)
  const v = variantKey && variantKey !== ZERO_KEY ? p?.variants.find((x) => x.id === variantKey) : null
  return v?.sku ?? p?.code ?? ''
}
