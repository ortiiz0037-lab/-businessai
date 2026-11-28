import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Document numbers are assigned by the database (migration 0015): the app
 * inserts WITHOUT a number and gets <PREFIX>-<YEAR>-<0001…>, consecutive per
 * company, type and year. Same prefixes as the database.
 */
export const NUMBER_PREFIX: Record<string, string> = {
  invoice: 'FAC',
  quote: 'COT',
  receipt: 'RCB',
  work_order: 'OT',
  letter: 'CARTA',
  payment_reminder: 'REC',
}

/** Previous format, only used when the database does not number yet (0015 not applied). */
export function legacyDocumentNumber(type: string, year: number, random: string): string {
  return `${NUMBER_PREFIX[type] ?? 'DOC'}-${year}-${random.slice(0, 8).toUpperCase()}`
}

type InsertResult = { data: { id: string; document_number: string } | null; error: { code?: string; message: string } | null }

/**
 * Inserts a document and returns its id and number. Without 0015 the
 * insert fails on the NOT NULL number (23502); it is then retried once with
 * the previous random format, so the app keeps working until the
 * migration is applied.
 */
export async function insertDocument(supabase: SupabaseClient, row: Record<string, unknown>): Promise<InsertResult> {
  const first = await supabase.from('documents').insert(row).select('id, document_number').single()
  if (!first.error) return first as InsertResult
  if (first.error.code === '23502' && /document_number/.test(first.error.message)) {
    const year = new Date().getFullYear()
    const retry = await supabase.from('documents')
      .insert({ ...row, document_number: legacyDocumentNumber(String(row.document_type), year, crypto.randomUUID().replace(/-/g, '')) })
      .select('id, document_number').single()
    return retry as InsertResult
  }
  return first as InsertResult
}
