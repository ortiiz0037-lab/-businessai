import type { Tr } from '@/lib/i18n/t'
import type { Locale } from '@/lib/i18n/app'
import { CLIENT_KINDS, crmLabel, LIFECYCLES } from '@/lib/crm/core'

export type ClientCrmDefaults = { kind?: string | null; legal_name?: string | null; tax_id?: string | null; lifecycle?: string | null; source?: string | null; owner_id?: string | null; branch_id?: string | null }

/** CRM fields of the client form (create and edit). The database validates them again (0035). */
export function ClientCrmFields({ tr, locale, d, members, branches }: {
  tr: Tr; locale: Locale; d: ClientCrmDefaults; members: { user_id: string; email: string | null }[]; branches: { id: string; name: string; code: string }[]
}) {
  return (
    <fieldset className="space-y-4 rounded-2xl border border-line p-4" data-testid="client-crm-fields">
      <legend className="px-1 text-xs font-bold uppercase tracking-wide text-muted">{tr('Datos comerciales', 'Commercial details')}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field-label">{tr('Tipo', 'Type')}<select name="kind" defaultValue={d.kind ?? 'individual'} className="field mt-2">
          {CLIENT_KINDS.map((k) => <option key={k} value={k}>{crmLabel(k, locale)}</option>)}</select></label>
        <label className="field-label">{tr('Etapa del cliente', 'Client stage')}<select name="lifecycle" defaultValue={d.lifecycle ?? 'customer'} className="field mt-2">
          {LIFECYCLES.map((k) => <option key={k} value={k}>{crmLabel(k, locale)}</option>)}</select></label>
        <label className="field-label">{tr('Nombre legal', 'Legal name')}<input name="legal_name" maxLength={200} defaultValue={d.legal_name ?? ''} className="field mt-2" /></label>
        <label className="field-label">{tr('Identificación fiscal (opcional)', 'Tax ID (optional)')}<input name="tax_id" maxLength={40} defaultValue={d.tax_id ?? ''} autoComplete="off" className="field mt-2" /></label>
        <label className="field-label">{tr('Origen', 'Source')}<input name="source" maxLength={80} defaultValue={d.source ?? ''} placeholder={tr('Referido, web, feria…', 'Referral, web, fair…')} className="field mt-2" /></label>
        <label className="field-label">{tr('Responsable', 'Owner')}<select name="owner_id" defaultValue={d.owner_id ?? ''} className="field mt-2"><option value="">—</option>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email ?? m.user_id.slice(0, 8)}</option>)}</select></label>
        {branches.length > 0 && <label className="field-label">{tr('Sucursal', 'Branch')}<select name="branch_id" defaultValue={d.branch_id ?? ''} className="field mt-2">
          <option value="">{tr('Ninguna (compartido)', 'None (shared)')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></label>}
      </div>
    </fieldset>
  )
}
