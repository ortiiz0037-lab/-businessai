import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * Does the database have migration 0015 (document lifecycle)? Probed once per
 * request through document_transition_allowed, a function 0015 creates and
 * grants to signed-in users. Without 0015 the app hides what the database
 * would refuse (accepting / rejecting quotes) and does not send the payment
 * idempotency key (that column does not exist yet).
 */
export const lifecycleAvailable = cache(async (): Promise<boolean> => {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('document_transition_allowed', {
    doc_type: 'quote', from_status: 'sent', to_status: 'accepted',
  })
  return !error && data === true
})

/** A fresh key for one rendering of a payment form (repeated submits share it). */
export function newIdempotencyKey(): string {
  return `pay-${crypto.randomUUID()}`
}

export const IDEMPOTENCY_KEY = /^pay-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Does the database have migration 0019 (archived clients, document language)? */
export const crmAvailable = cache(async (): Promise<boolean> => {
  const supabase = await createClient()
  const { error } = await supabase.from('clients').select('archived_at').limit(1)
  return !error
})

/** Does the database have migration 0035 (CRM fields on clients, pipeline)? */
export const crmProAvailable = cache(async (): Promise<boolean> => {
  const supabase = await createClient()
  const { error } = await supabase.from('clients').select('lifecycle').limit(1)
  return !error
})
