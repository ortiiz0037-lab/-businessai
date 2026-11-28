import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { CrmFlash, CrmNav, NoCrmAccess } from '@/components/crm-nav'
import { crmPage, loadMembers, loadStages } from '@/lib/crm/page'
import { crmLabel, percent, TAG_CLASS, TAG_COLORS, type TagColor } from '@/lib/crm/core'
import { archiveBranch, saveBranch, saveCrmSettings, saveStage, saveTag, setBranchMember } from '@/app/actions/crm'

export const dynamic = 'force-dynamic'

/** CRM settings: pipeline stages and probabilities, tags, branch visibility and branches (configure / branches.manage). */
export default async function CrmSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, supabase, user, companyId, can, available } = await crmPage('/crm/settings')
  if (!available) return <NoCrmAccess tr={tr} reason="unavailable" />
  if (!can.configure && !can.branches) return <NoCrmAccess tr={tr} reason="role" />
  const [stages, members, { data: tagData }, { data: setData }, { data: brData }, { data: bmData }, plan] = await Promise.all([
    loadStages(supabase, companyId), loadMembers(supabase, companyId, { id: user.id, email: user.email }),
    supabase.from('crm_tags').select('id, name, color, archived_at').eq('company_id', companyId).order('name'),
    supabase.from('crm_settings').select('branch_scoping, share_clients_across_branches').eq('company_id', companyId).maybeSingle(),
    supabase.from('branches').select('id, name, code, address, archived_at').eq('company_id', companyId).order('archived_at', { nullsFirst: true }).order('name'),
    supabase.from('branch_members').select('branch_id, user_id').eq('company_id', companyId),
    supabase.rpc('company_feature', { target: companyId, feature: 'branches' }),
  ])
  const tags = (tagData ?? []) as { id: string; name: string; color: TagColor; archived_at: string | null }[]
  const settings = (setData ?? { branch_scoping: false, share_clients_across_branches: true }) as { branch_scoping: boolean; share_clients_across_branches: boolean }
  const branches = (brData ?? []) as { id: string; name: string; code: string; address: string | null; archived_at: string | null }[]
  const bm = (bmData ?? []) as { branch_id: string; user_id: string }[]
  const feat = ((plan.data ?? []) as { available: boolean; max_allowed: number | null; used: number }[])[0]

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="CRM" title={tr('Configuración del CRM', 'CRM settings')} />
      <CrmNav tr={tr} current="/crm/settings" configure={can.configure} />
      <CrmFlash locale={locale} done={params.done} error={params.error} />

      {can.configure && <>
        <section className="card p-5" aria-labelledby="stages-title" data-testid="stage-settings">
          <h2 id="stages-title" className="font-display text-lg font-semibold text-fg">{tr('Etapas del pipeline', 'Pipeline stages')}</h2>
          <p className="mt-1 text-xs text-muted">{tr('Las probabilidades son valores de partida que puedes ajustar; Ganado (100 %) y Perdido (0 %) son fijos.', 'Probabilities are starting values you can adjust; Won (100 %) and Lost (0 %) are fixed.')}</p>
          <ul className="mt-3 divide-y divide-line">
            {stages.map((s) => (
              <li key={s.id} className="py-3">
                <form action={saveStage} className="grid gap-2 sm:grid-cols-[4rem_1fr_1fr_6rem_auto_auto] sm:items-end">
                  <input type="hidden" name="id" value={s.id} />
                  <label className="field-label">{tr('Orden', 'Order')}<input name="position" type="number" min={0} max={1000} defaultValue={s.position} className="field mt-1 py-1.5" /></label>
                  <label className="field-label">{tr('Nombre (ES)', 'Name (ES)')}<input name="name_es" required maxLength={40} defaultValue={s.name_es} className="field mt-1 py-1.5" /></label>
                  <label className="field-label">{tr('Nombre (EN)', 'Name (EN)')}<input name="name_en" required maxLength={40} defaultValue={s.name_en} className="field mt-1 py-1.5" /></label>
                  <label className="field-label">%<input name="probability" inputMode="decimal" defaultValue={String(s.probability_bp / 100)} readOnly={s.outcome !== 'open'} className="field mt-1 py-1.5" /></label>
                  <label className="flex items-center gap-1 pb-2 text-sm text-slate-300">
                    <select name="active" defaultValue={s.active ? 'yes' : 'no'} disabled={s.outcome !== 'open'} aria-label={tr('Activa', 'Active')} className="field w-auto py-1.5">
                      <option value="yes">{tr('Activa', 'Active')}</option><option value="no">{tr('Inactiva', 'Inactive')}</option></select>
                    {s.outcome !== 'open' && <span className="badge-neutral">{crmLabel(s.outcome, locale)}</span>}</label>
                  <button type="submit" className="btn-secondary btn-sm mb-1.5">{tr('Guardar', 'Save')}</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={saveStage} className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-[4rem_1fr_1fr_6rem_auto] sm:items-end">
            <label className="field-label">{tr('Orden', 'Order')}<input name="position" type="number" min={0} max={1000} defaultValue={60} className="field mt-1 py-1.5" /></label>
            <label className="field-label">{tr('Nueva etapa (ES)', 'New stage (ES)')}<input name="name_es" required maxLength={40} className="field mt-1 py-1.5" /></label>
            <label className="field-label">{tr('Nombre (EN)', 'Name (EN)')}<input name="name_en" maxLength={40} className="field mt-1 py-1.5" /></label>
            <label className="field-label">%<input name="probability" required inputMode="decimal" className="field mt-1 py-1.5" /></label>
            <SubmitButton pendingLabel="…" className="mb-0.5 w-auto">{tr('Añadir etapa', 'Add stage')}</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted">{stages.filter((s) => s.active).map((s) => `${locale === 'en' ? s.name_en : s.name_es} ${percent(s.probability_bp)}`).join(' → ')}</p>
        </section>

        <section className="card p-5" aria-labelledby="tags-title" data-testid="tag-settings">
          <h2 id="tags-title" className="font-display text-lg font-semibold text-fg">{tr('Etiquetas de clientes', 'Client tags')}</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {tags.length === 0 && <li className="text-sm text-muted">{tr('Todavía no hay etiquetas.', 'No tags yet.')}</li>}
            {tags.map((t) => (
              <li key={t.id} className="flex items-center gap-1">
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TAG_CLASS[t.color]} ${t.archived_at ? 'opacity-50 line-through' : ''}`}>{t.name}</span>
                <form action={saveTag}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="name" value={t.name} /><input type="hidden" name="color" value={t.color} />
                  <input type="hidden" name="archived" value={t.archived_at ? 'no' : 'yes'} />
                  <button type="submit" className="btn-ghost btn-sm text-xs">{t.archived_at ? tr('Restaurar', 'Restore') : tr('Archivar', 'Archive')}</button></form>
              </li>
            ))}
          </ul>
          <form action={saveTag} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <label className="field-label">{tr('Nombre', 'Name')}<input name="name" required maxLength={40} className="field mt-1 py-1.5" /></label>
            <label className="field-label">{tr('Color', 'Color')}<select name="color" className="field mt-1 py-1.5">{TAG_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <SubmitButton pendingLabel="…" className="w-auto">{tr('Crear etiqueta', 'Create tag')}</SubmitButton>
          </form>
        </section>

        <section className="card p-5" aria-labelledby="vis-title" data-testid="visibility-settings">
          <h2 id="vis-title" className="font-display text-lg font-semibold text-fg">{tr('Visibilidad por sucursal', 'Visibility by branch')}</h2>
          <form action={saveCrmSettings} className="mt-3 space-y-2 text-sm text-slate-300">
            <label className="flex items-start gap-2"><input type="checkbox" name="branch_scoping" defaultChecked={settings.branch_scoping} className="mt-1" />
              <span>{tr('Limitar a cada miembro asignado a sucursales: solo ve clientes y oportunidades de sus sucursales (propietario y administradores ven todo; quien no tiene sucursal también).',
                'Limit each member assigned to branches to the clients and opportunities of their branches (owner and admins see everything; so does anyone without a branch).')}</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" name="share_clients" defaultChecked={settings.share_clients_across_branches} className="mt-1" />
              <span>{tr('Compartir los clientes entre sucursales (las oportunidades siguen separadas). Desmárcalo para compartir cliente por cliente.',
                'Share clients across branches (opportunities stay separate). Untick it to share client by client.')}</span></label>
            <SubmitButton pendingLabel="…" className="w-auto">{tr('Guardar visibilidad', 'Save visibility')}</SubmitButton>
          </form>
        </section>
      </>}

      {can.branches && (
        <section className="card p-5" aria-labelledby="br-title" data-testid="branch-settings">
          <h2 id="br-title" className="font-display text-lg font-semibold text-fg">{tr('Sucursales', 'Branches')}</h2>
          <p className="mt-1 text-xs text-muted">{feat ? (feat.available ? tr(`Plan: ${feat.used} de ${feat.max_allowed ?? '∞'} sucursales activas.`, `Plan: ${feat.used} of ${feat.max_allowed ?? '∞'} active branches.`)
            : tr('Tu plan no incluye sucursales.', 'Your plan does not include branches.')) : ''} {tr('Modelo preparado para el módulo de sucursales: por ahora se usa en el CRM.', 'Model prepared for the branches module: for now it is used by the CRM.')}</p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {branches.length === 0 && <li className="py-2 text-muted">{tr('Sin sucursales.', 'No branches.')}</li>}
            {branches.map((b) => (
              <li key={b.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><strong className="text-fg">{b.code} · {b.name}</strong>{b.archived_at && <span className="badge-neutral ml-2">{tr('Archivada', 'Archived')}</span>}
                    {b.address && <span className="block text-xs text-muted">{b.address}</span>}</span>
                  <form action={archiveBranch}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="archived" value={b.archived_at ? 'no' : 'yes'} />
                    <button type="submit" className="btn-ghost btn-sm">{b.archived_at ? tr('Restaurar', 'Restore') : tr('Archivar', 'Archive')}</button></form>
                </div>
                {!b.archived_at && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {bm.filter((x) => x.branch_id === b.id).map((x) => (
                      <form key={x.user_id} action={setBranchMember} className="flex items-center gap-1"><input type="hidden" name="branch_id" value={b.id} /><input type="hidden" name="user_id" value={x.user_id} /><input type="hidden" name="assigned" value="no" />
                        <span className="badge-neutral">{members.find((m) => m.user_id === x.user_id)?.email ?? x.user_id.slice(0, 8)}</span>
                        <button type="submit" className="btn-ghost btn-sm text-xs" aria-label={tr('Quitar', 'Remove')}>×</button></form>
                    ))}
                    <form action={setBranchMember} className="flex items-center gap-1"><input type="hidden" name="branch_id" value={b.id} />
                      <select name="user_id" aria-label={tr('Miembro', 'Member')} className="field w-auto py-1 text-xs">{members.filter((m) => !bm.some((x) => x.branch_id === b.id && x.user_id === m.user_id)).map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select>
                      <button type="submit" className="btn-secondary btn-sm">{tr('Asignar', 'Assign')}</button></form>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <form action={saveBranch} className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-[6rem_1fr_1fr_auto] sm:items-end">
            <label className="field-label">{tr('Código', 'Code')}<input name="code" required maxLength={12} pattern="[A-Za-z0-9_\-]{1,12}" className="field mt-1 py-1.5" /></label>
            <label className="field-label">{tr('Nombre', 'Name')}<input name="name" required maxLength={80} className="field mt-1 py-1.5" /></label>
            <label className="field-label">{tr('Dirección', 'Address')}<input name="address" maxLength={240} className="field mt-1 py-1.5" /></label>
            <SubmitButton pendingLabel="…" className="mb-0.5 w-auto">{tr('Crear sucursal', 'Create branch')}</SubmitButton>
          </form>
        </section>
      )}
    </div>
  )
}
