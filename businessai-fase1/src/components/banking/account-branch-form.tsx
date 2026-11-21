import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tr } from '@/lib/i18n/t'
import { SubmitButton } from '@/components/submit-button'
import { setAccountBranch } from '@/app/actions/banking'

/** S6 (0042): the branch a bank account belongs to (its new lines inherit it). Hidden without 0042 or branches. */
export async function AccountBranchForm({ supabase, companyId, accountId, tr }: { supabase: SupabaseClient; companyId: string; accountId: string; tr: Tr }) {
  const [{ data: acc, error }, { data: br }] = await Promise.all([
    supabase.from('bank_accounts').select('branch_id').eq('id', accountId).maybeSingle(),
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name'),
  ])
  const branches = (br ?? []) as { id: string; name: string; code: string }[]
  if (error || !acc || branches.length === 0) return null
  return (
    <form action={setAccountBranch} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end" data-testid="account-branch-form">
      <input type="hidden" name="bank_account_id" value={accountId} />
      <input type="hidden" name="back" value={`/bank/accounts/${accountId}`} />
      <label className="field-label min-w-0 flex-1">{tr('Sucursal de la cuenta', 'Account branch')}
        <select name="branch_id" defaultValue={(acc as { branch_id: string | null }).branch_id ?? ''} className="field mt-2">
          <option value="">{tr('Toda la empresa (sin sucursal)', 'Whole company (no branch)')}</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
        </select>
      </label>
      <SubmitButton className="w-full sm:w-auto">{tr('Guardar sucursal', 'Save branch')}</SubmitButton>
    </form>
  )
}
