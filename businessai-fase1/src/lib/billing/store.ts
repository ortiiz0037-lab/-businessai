import type { SupabaseClient } from '@supabase/supabase-js'
import type { BillingStore } from './webhook'
import type { PlanCatalogEntry, SubscriptionRow } from './sync'

/** BillingStore backed by Supabase with the SERVICE ROLE (server only). */
export function createBillingStore(admin: SupabaseClient): BillingStore {
  return {
    async claimEvent(id, type) {
      const { error } = await admin
        .from('stripe_events')
        .insert({ id, event_type: type, status: 'processing' })
      if (!error) return 'new'
      if (error.code !== '23505') throw error

      const { data, error: readError } = await admin
        .from('stripe_events')
        .select('status, attempts')
        .eq('id', id)
        .single()
      if (readError) throw readError
      if (data.status === 'processed') return 'processed'

      const { error: updateError } = await admin
        .from('stripe_events')
        .update({ status: 'processing', attempts: (data.attempts ?? 1) + 1, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (updateError) throw updateError
      return 'retry'
    },

    async markProcessed(id) {
      const stamp = new Date().toISOString()
      const { error } = await admin
        .from('stripe_events')
        .update({ status: 'processed', processed_at: stamp, updated_at: stamp, last_error: null })
        .eq('id', id)
      if (error) throw error
    },

    async markFailed(id, message) {
      // Best effort: never mask the original error.
      await admin
        .from('stripe_events')
        .update({ status: 'failed', last_error: message, updated_at: new Date().toISOString() })
        .eq('id', id)
    },

    async loadPlans() {
      const { data, error } = await admin.from('billing_plans').select('plan, stripe_lookup_key')
      if (error) throw error
      return (data ?? []) as PlanCatalogEntry[]
    },

    async companyExists(companyId) {
      const { data, error } = await admin.from('companies').select('id').eq('id', companyId).maybeSingle()
      if (error) throw error
      return Boolean(data)
    },

    async getSubscription(companyId) {
      const { data, error } = await admin
        .from('company_subscriptions')
        .select('stripe_customer_id, stripe_subscription_id, status')
        .eq('company_id', companyId)
        .maybeSingle()
      if (error) throw error
      return data
    },

    async saveSubscription(companyId, row: SubscriptionRow) {
      // Upsert on company_id: app-trial columns are not in `row`, so they are kept.
      const { error } = await admin
        .from('company_subscriptions')
        .upsert({ company_id: companyId, ...row }, { onConflict: 'company_id' })
      if (error) throw error
    },

    async setPaymentFailure(companyId, failure) {
      const { error } = await admin
        .from('company_subscriptions')
        .update({
          last_payment_failed_at: failure?.at ?? null,
          last_payment_error: failure?.message ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
      if (error) throw error
    },
  }
}
