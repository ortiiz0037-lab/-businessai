import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tr } from '@/lib/i18n/t'

/**
 * S6 (0042): branch, notes and evidence of a manual payment. The evidence is
 * a receipt capture of the company (photo or PDF kept in private storage).
 * Without 0042 nothing is shown and the payment is recorded as before.
 */
export async function PaymentExtrasFields({ supabase, companyId, tr }: { supabase: SupabaseClient; companyId: string; tr: Tr }) {
  const probe = await supabase.from('receipt_captures').select('id').limit(1)
  if (probe.error) return null
  const [{ data: br }, { data: caps }] = await Promise.all([
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name'),
    supabase.from('receipt_captures').select('id, file_name, created_at, confirmed').eq('company_id', companyId).neq('status', 'discarded').order('created_at', { ascending: false }).limit(30),
  ])
  const branches = (br ?? []) as { id: string; name: string; code: string }[]
  const captures = (caps ?? []) as { id: string; file_name: string; created_at: string; confirmed: { merchant?: string | null } | null }[]
  return (
    <>
      {branches.length > 0 && (
        <label className="field-label">{tr('Sucursal', 'Branch')}
          <select name="branch_id" defaultValue="" className="field mt-2">
            <option value="">{tr('Sin sucursal', 'No branch')}</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
          </select>
        </label>
      )}
      <label className="field-label">{tr('Evidencia (foto o documento)', 'Evidence (photo or document)')}
        <select name="evidence_capture_id" defaultValue="" className="field mt-2" data-testid="payment-evidence">
          <option value="">{tr('Sin evidencia', 'No evidence')}</option>
          {captures.map((c) => <option key={c.id} value={c.id}>{c.confirmed?.merchant ? `${c.confirmed.merchant} · ` : ''}{c.file_name}</option>)}
        </select>
        <Link href="/bank/receipts" className="mt-1 inline-block text-xs text-accent hover:underline">{tr('Capturar una foto o subir un documento', 'Take a photo or upload a document')}</Link>
      </label>
      <label className="field-label sm:col-span-2">{tr('Notas', 'Notes')}
        <textarea name="notes" maxLength={500} rows={2} className="field mt-2" placeholder={tr('Opcional: quién lo entregó, detalles…', 'Optional: who delivered it, details…')} />
      </label>
    </>
  )
}
