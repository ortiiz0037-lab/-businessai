/**
 * Point of sale (S8, migration 0044): the common shapes. Every source — the BusinessAI register,
 * Square, Clover, Shopify POS, Lightspeed, CSV files of traditional registers, the local bridge —
 * is reduced to NormalizedSale before it reaches the database (ba_private.pos_ingest_one), which
 * validates it again before any stock or ledger change.
 */
export type PaymentMethod = 'cash' | 'check' | 'ath_movil' | 'transfer' | 'card' | 'card_external' | 'gift_card' | 'store_credit' | 'other'
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'check', 'ath_movil', 'transfer', 'card', 'card_external', 'gift_card', 'store_credit', 'other']
/** methods the BusinessAI register records itself (an integrated card needs a processor terminal) */
export const NATIVE_METHODS: readonly PaymentMethod[] = ['cash', 'ath_movil', 'card_external', 'check', 'transfer', 'other']
export const METHODS_WITH_REFERENCE: readonly PaymentMethod[] = ['check', 'ath_movil', 'transfer', 'card_external']

export type ProviderId = 'square' | 'clover' | 'shopify' | 'lightspeed_x' | 'lightspeed_r' | 'csv' | 'bridge'

export type NormalizedLine = {
  external_line_id: string
  item_ref?: string | null          // the provider's catalog id (mapped in pos_item_maps)
  sku?: string | null               // barcode / SKU / catalog code (looked up in the catalog)
  name: string
  qty: string                       // decimal text, up to 3 decimals
  unit_price_cents: string          // integer cents as text
  discount_cents?: string
  tax_cents?: string
  tax_rate?: string | null
  catalog_required?: boolean        // false: a department / open-price sale without a product
}
export type NormalizedPayment = {
  method: PaymentMethod
  amount_cents: string
  provider_payment_id?: string | null
  card_brand?: string | null
  card_last4?: string | null
  reference?: string | null
  status?: 'captured' | 'authorized' | 'failed' | 'voided'
}
export type NormalizedRefund = {
  external_id: string
  method?: PaymentMethod
  reason?: string | null
  occurred_at?: string | null
  restock?: boolean
  lines: { external_line_id: string; qty: string }[]
}
export type NormalizedSale = {
  external_id: string
  version: string                   // monotonic per order (provider version or update time in ms)
  state: 'completed' | 'voided' | 'open'
  occurred_at: string
  location_id: string
  register_ref?: string | null
  cashier_ref?: string | null
  currency?: string
  total_cents?: string
  note?: string | null
  lines: NormalizedLine[]
  payments: NormalizedPayment[]
  refunds?: NormalizedRefund[]
}

export type WebhookEvent = { eventKey: string; accountId: string; eventType: string; objectType: string; objectId: string; version: string | null }
