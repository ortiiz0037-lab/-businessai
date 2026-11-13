import { randomUUID } from 'node:crypto'
import type { Tr } from '@/lib/i18n/t'
import type { Locale, formatters } from '@/lib/i18n/app'
import type { Member } from '@/lib/crm/page'
import { memberName } from '@/lib/crm/page'
import { ACTIVITY_KINDS, crmLabel, isOverdue } from '@/lib/crm/core'
import { SubmitButton } from '@/components/submit-button'
import { saveActivity, setActivityStatus } from '@/app/actions/crm'

export type ActivityRow = { id: string; kind: string; subject: string; body: string | null; direction: string | null; due_at: string | null; status: string; outcome: string | null
  assigned_to: string | null; created_by: string | null; created_at: string; completed_at: string | null; version: number; origin: string; client_id: string | null; opportunity_id: string | null }
type F = ReturnType<typeof formatters>

/** Activities with their state; pending ones can be completed (with an outcome) or cancelled. */
export function ActivityList({ rows, members, locale, tr, f, canManage, back, names }: {
  rows: ActivityRow[]; members: Member[]; locale: Locale; tr: Tr; f: F; canManage: boolean; back: string; names?: Map<string, string>
}) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-muted">{tr('Sin actividades.', 'No activities.')}</p>
  return (
    <ul className="mt-2 divide-y divide-line text-sm" data-testid="activity-list">
      {rows.map((a) => {
        const late = isOverdue(a)
        return (
          <li key={a.id} className="py-3" data-activity-status={a.status}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="badge-neutral mr-2">{crmLabel(a.kind, locale)}{a.direction ? ` · ${crmLabel(a.direction, locale)}` : ''}</span>
                <strong className="text-fg">{a.subject}</strong>
                {a.origin === 'assistant' && <span className="badge-accent ml-2">{tr('Preparada por el asistente', 'Prepared by the assistant')}</span>}
                <span className="block text-xs text-muted">
                  {names && a.client_id ? `${names.get(a.client_id) ?? ''} · ` : ''}{tr('Responsable', 'Owner')}: {memberName(members, a.assigned_to)}
                  {a.due_at ? ` · ${tr('vence', 'due')} ${f.dateTime(a.due_at)}` : ''} · {tr('registrada', 'logged')} {f.dateTime(a.created_at)}
                </span>
                {a.kind === 'email' && <span className="block text-xs text-amber-200/80">{tr('Registro de un correo: BusinessAI no envía emails.', 'Log of an email: BusinessAI does not send emails.')}</span>}
                {a.body && <p className="mt-1 whitespace-pre-wrap text-slate-300">{a.body}</p>}
                {a.outcome && <p className="mt-1 text-xs text-emerald-200">{tr('Resultado', 'Outcome')}: {a.outcome}</p>}
              </div>
              <span className={a.status === 'completed' ? 'badge-success' : a.status === 'cancelled' ? 'badge-neutral' : late ? 'badge-danger' : 'badge-warning'}>
                {late ? tr('Atrasada', 'Overdue') : crmLabel(a.status, locale)}</span>
            </div>
            {canManage && a.kind !== 'note' && (
              <div className="mt-2 flex flex-wrap gap-2">
                {a.status === 'pending' ? <>
                  <form action={setActivityStatus} className="flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={a.id} /><input type="hidden" name="version" value={a.version} /><input type="hidden" name="status" value="completed" /><input type="hidden" name="back" value={back} />
                    <input name="outcome" maxLength={1000} placeholder={tr('Resultado (opcional)', 'Outcome (optional)')} aria-label={tr('Resultado', 'Outcome')} className="field w-48 py-1 text-xs" />
                    <button type="submit" className="btn-secondary btn-sm">{tr('Completar', 'Complete')}</button>
                  </form>
                  <form action={setActivityStatus}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="version" value={a.version} /><input type="hidden" name="status" value="cancelled" /><input type="hidden" name="back" value={back} />
                    <button type="submit" className="btn-ghost btn-sm">{tr('Cancelar', 'Cancel')}</button></form>
                </> : (
                  <form action={setActivityStatus}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="version" value={a.version} /><input type="hidden" name="status" value="pending" /><input type="hidden" name="back" value={back} />
                    <button type="submit" className="btn-ghost btn-sm">{tr('Reabrir', 'Reopen')}</button></form>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Log a call, email, meeting, task, note or reminder for a client and / or an opportunity. */
export function ActivityForm({ tr, locale, members, selfId, clientId, opportunityId, contacts, clients, back }: {
  tr: Tr; locale: Locale; members: Member[]; selfId: string; clientId?: string | null; opportunityId?: string | null
  contacts?: { id: string; first_name: string; last_name: string | null }[]; clients?: { id: string; name: string }[]; back: string
}) {
  return (
    <form action={saveActivity} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="activity-form" id="new">
      <input type="hidden" name="idem" value={randomUUID()} /><input type="hidden" name="back" value={back} />
      {opportunityId && <input type="hidden" name="opportunity_id" value={opportunityId} />}
      {clientId ? <input type="hidden" name="client_id" value={clientId} /> : clients && (
        <label className="field-label sm:col-span-2">{tr('Cliente *', 'Client *')}<select name="client_id" required defaultValue="" className="field mt-1">
          <option value="" disabled>{tr('Elige…', 'Choose…')}</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>)}
      <label className="field-label">{tr('Tipo', 'Type')}<select name="kind" defaultValue="task" className="field mt-1">
        {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{crmLabel(k, locale)}</option>)}</select></label>
      <label className="field-label">{tr('Dirección (llamada / email)', 'Direction (call / email)')}<select name="direction" defaultValue="" className="field mt-1">
        <option value="">—</option><option value="outbound">{crmLabel('outbound', locale)}</option><option value="inbound">{crmLabel('inbound', locale)}</option></select></label>
      <label className="field-label sm:col-span-2">{tr('Asunto *', 'Subject *')}<input name="subject" required maxLength={160} className="field mt-1" /></label>
      <label className="field-label">{tr('Fecha y hora (tareas y recordatorios)', 'Date and time (tasks and reminders)')}<input name="due_at" type="datetime-local" className="field mt-1" /></label>
      <label className="field-label">{tr('Responsable', 'Owner')}<select name="assigned_to" defaultValue={selfId} className="field mt-1">
        {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select></label>
      {contacts && contacts.length > 0 && <label className="field-label">{tr('Contacto', 'Contact')}<select name="contact_id" defaultValue="" className="field mt-1"><option value="">—</option>
        {contacts.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name ?? ''}</option>)}</select></label>}
      <label className="field-label sm:col-span-2 lg:col-span-4">{tr('Detalle', 'Details')}<textarea name="body" rows={2} maxLength={4000} className="field mt-1" /></label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <SubmitButton pendingLabel="…" className="w-auto">{tr('Registrar actividad', 'Log activity')}</SubmitButton>
        <span className="text-xs text-muted">{tr('Hora de Puerto Rico. Registrar un email no lo envía; no hay recordatorios automáticos en esta versión.', 'Puerto Rico time. Logging an email does not send it; there are no automatic reminders in this version.')}</span>
      </div>
    </form>
  )
}
