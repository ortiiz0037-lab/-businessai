import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tr } from '@/lib/i18n/t'

/**
 * "Deposited into" for a client payment (0026). Lists the active bank
 * accounts the user can see; empty = Cash (as before). Without 0026, or
 * for roles that cannot see bank accounts, nothing is shown.
 */
export async function DepositAccountField({ supabase, companyId, tr }: { supabase: SupabaseClient; companyId: string; tr: Tr }) {
  const { data, error } = await supabase.from('bank_accounts').select('name, last4, ledger_account_id').eq('company_id', companyId).eq('status', 'active').order('name')
  const accounts = (data ?? []) as { name: string; last4: string | null; ledger_account_id: string }[]
  if (error || accounts.length === 0) return null
  return (
    <label className="field-label">{tr('Depositado en', 'Deposited into')}
      <select name="deposit_account_id" defaultValue="" className="field mt-2">
        <option value="">{tr('Efectivo (predeterminado)', 'Cash (default)')}</option>
        {accounts.map((a) => <option key={a.ledger_account_id} value={a.ledger_account_id}>{a.name}{a.last4 ? ` ••${a.last4}` : ''}</option>)}
      </select>
    </label>
  )
}
