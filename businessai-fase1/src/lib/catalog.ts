/**
 * Catalog of products and services (migration 0039).
 *
 * The catalog is a source of values, never a link that rewrites history:
 * a document line chosen from it COPIES name, price and unit, and records
 * `catalog_item_id` / `code` inside the line (documents.items). Changing or
 * archiving an item never changes what a document already says.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'

export type CatalogItem = {
  id: string; code: string; name: string; description: string | null; kind: 'product' | 'service'; unit: string
  price_cents: number; tax_rate: number | null; track_inventory: boolean; status: 'active' | 'archived'; version: number
}
export const CATALOG_COLUMNS = 'id, code, name, description, kind, unit, price_cents, tax_rate, track_inventory, status, version'
export const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/

export type CatalogAccess = { view: boolean; manage: boolean; available: boolean }
export async function catalogAccess(supabase: SupabaseClient, companyId: string): Promise<CatalogAccess> {
  const [v, m, probe] = await Promise.all([
    supabase.rpc('has_permission', { target: companyId, permission: 'catalog.view' }),
    supabase.rpc('has_permission', { target: companyId, permission: 'catalog.manage' }),
    supabase.from('catalog_items').select('id').eq('company_id', companyId).limit(1),
  ])
  return { view: !v.error && v.data === true, manage: !m.error && m.data === true, available: !probe.error }
}

/** Active items, for pickers (documents, Studio). Empty without 0039 or without catalog.view. */
export async function activeCatalog(supabase: SupabaseClient, companyId: string): Promise<CatalogItem[]> {
  const { data, error } = await supabase.from('catalog_items').select(CATALOG_COLUMNS).eq('company_id', companyId).eq('status', 'active').order('name').limit(500)
  return error ? [] : ((data ?? []) as CatalogItem[])
}

/** "12.50" / "12,50" / "1,234.50" → 1250 cents; null when not a valid non-negative amount (max 1,000,000,000.00). */
export function parsePriceCents(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, '')
  if (!t) return null
  const normal = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.')
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(normal)) return null
  const [whole, frac = ''] = normal.split('.')
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  return cents <= 100_000_000_000 ? cents : null
}

/** Tax rate "11.5" → 11.5; '' → null (the document's rate applies); undefined when invalid. */
export function parseTaxRate(raw: string): number | null | undefined {
  const t = raw.trim().replace(',', '.')
  if (!t) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined
  const n = Number(t)
  return n >= 0 && n <= 100 ? n : undefined
}

export function catalogErrorCode(e: { message?: string; code?: string } | null | undefined): string {
  const m = e?.message ?? ''
  for (const c of ['CATALOG_CODE_TAKEN', 'CATALOG_CONFLICT', 'CATALOG_ARCHIVED', 'CATALOG_NOT_FOUND', 'CATALOG_INVALID']) if (m.includes(c)) return c.toLowerCase()
  if (m.includes('FORBIDDEN') || e?.code === '42501') return 'forbidden'
  return 'unexpected'
}

const MESSAGES: Record<string, [string, string]> = {
  catalog_code_taken: ['Ese código ya existe en el catálogo (también cuenta si está archivado).', 'That code already exists in the catalog (archived items count too).'],
  catalog_conflict: ['Otra persona cambió este artículo mientras lo editabas. Revisa los datos actuales y vuelve a guardar.', 'Someone else changed this item while you were editing. Check the current data and save again.'],
  catalog_archived: ['El artículo está archivado: restáuralo para editarlo.', 'The item is archived: restore it to edit it.'],
  catalog_not_found: ['El artículo no existe o no tienes acceso.', 'The item does not exist or you have no access.'],
  catalog_invalid: ['Revisa los datos: código (letras, números, . _ / -), nombre, unidad, precio ≥ 0 e impuesto entre 0 y 100. Un servicio no lleva inventario.',
    'Check the data: code (letters, numbers, . _ / -), name, unit, price ≥ 0 and tax between 0 and 100. A service holds no stock.'],
  price: ['El precio no es válido (usa por ejemplo 12.50).', 'The price is not valid (use e.g. 12.50).'],
  tax: ['El impuesto debe estar entre 0 y 100.', 'The tax must be between 0 and 100.'],
  forbidden: ['No tienes permiso para gestionar el catálogo.', 'You are not allowed to manage the catalog.'],
  unexpected: ['No se pudo completar la operación. Inténtalo de nuevo.', 'The operation could not be completed. Try again.'],
}
export const catalogMessage = (code: string | undefined | null, locale: Locale): string | null => (code ? (MESSAGES[code] ?? MESSAGES.unexpected)[locale === 'en' ? 1 : 0] : null)

export const kindName = (k: string, locale: Locale) => (k === 'service' ? (locale === 'en' ? 'Service' : 'Servicio') : (locale === 'en' ? 'Product' : 'Producto'))
