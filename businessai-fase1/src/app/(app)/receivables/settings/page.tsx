import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoReceivablesAccess, ReceivablesNav } from '@/components/receivables-nav'
import { receivablesPage } from '@/lib/finance/receivables-page'
import { arMessage, DEFAULT_MESSAGE, offsetLabel, renderReminder } from '@/lib/finance/receivables'
import { emailConfigured } from '@/lib/email/resend'
import { saveCollectionSettings } from '@/app/actions/receivables'

export const dynamic = 'force-dynamic'

/** Reminder rules: days relative to the due date, language, sender and message. */
export default async function ReceivablesSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await receivablesPage()
  if (!access.view) return <NoReceivablesAccess tr={tr} unavailable={!access.available} />
  const [{ data }, { data: co }] = await Promise.all([
    supabase.from('collection_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ])
  const s = (data ?? {}) as { reminders_enabled?: boolean; reminder_offsets?: number[]; language?: 'es' | 'en'; sender_name?: string | null; reply_to?: string | null; message_es?: string | null; message_en?: string | null }
  const offsets = s.reminder_offsets ?? [-3, 0, 7, 30]
  const lang = s.language ?? 'es'
  const sample = renderReminder({ locale: lang, template: lang === 'en' ? s.message_en : s.message_es, client: tr('Cliente Ejemplo', 'Sample Client'), invoice: 'FAC-2026-0001',
    balanceCents: 12550, due: '2026-12-01', company: s.sender_name || (co as { name?: string } | null)?.name || '' })
  const configured = emailConfigured()
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Cuentas por cobrar', 'Receivables')} title={tr('Recordatorios de cobro', 'Collection reminders')} />
      <ReceivablesNav tr={tr} current="/receivables/settings" />
      <Flash done={sp.done === 'settings' ? tr('Configuración guardada.', 'Settings saved.') : null} error={arMessage(sp.error, locale)} />
      <div role="note" className={`${configured ? 'alert-success' : 'alert-warning'} p-4 text-sm`}>
        {configured ? tr('El envío por email está configurado en el servidor.', 'Email sending is configured on the server.')
          : tr('El envío por email todavía no está configurado (falta Resend: RESEND_API_KEY y EMAIL_FROM en el servidor). Los recordatorios se preparan con su texto y quedan en la bandeja; ninguno se marca como enviado hasta que se configure.',
            'Email sending is not configured yet (Resend is missing: RESEND_API_KEY and EMAIL_FROM on the server). Reminders are prepared with their text and stay in the outbox; none is marked sent until it is configured.')}
      </div>
      <form action={saveCollectionSettings} className="card grid gap-4 p-5 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="enabled" defaultChecked={s.reminders_enabled ?? false} disabled={!access.manage} /> {tr('Preparar recordatorios automáticamente al actualizar el seguimiento', 'Prepare reminders automatically when the follow-up is refreshed')}</label>
        <label className="text-sm"><span className="field-label">{tr('Días respecto al vencimiento (negativos = antes)', 'Days relative to due date (negative = before)')}</span>
          <input name="offsets" defaultValue={offsets.join(', ')} className="field" disabled={!access.manage} />
          <span className="field-hint">{offsets.map((o) => offsetLabel(o, locale)).join(' · ')}</span></label>
        <label className="text-sm"><span className="field-label">{tr('Idioma de los recordatorios', 'Reminder language')}</span>
          <select name="language" defaultValue={lang} className="field" disabled={!access.manage}><option value="es">Español</option><option value="en">English</option></select></label>
        <label className="text-sm"><span className="field-label">{tr('Nombre del remitente', 'Sender name')}</span><input name="sender_name" maxLength={100} defaultValue={s.sender_name ?? ''} className="field" disabled={!access.manage} /></label>
        <label className="text-sm"><span className="field-label">{tr('Responder a (email)', 'Reply-to (email)')}</span><input type="email" name="reply_to" maxLength={200} defaultValue={s.reply_to ?? ''} className="field" disabled={!access.manage} /></label>
        <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Mensaje en español', 'Spanish message')}</span>
          <textarea name="message_es" rows={6} maxLength={2000} defaultValue={s.message_es ?? ''} placeholder={DEFAULT_MESSAGE.es} className="field" disabled={!access.manage} /></label>
        <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Mensaje en inglés', 'English message')}</span>
          <textarea name="message_en" rows={6} maxLength={2000} defaultValue={s.message_en ?? ''} placeholder={DEFAULT_MESSAGE.en} className="field" disabled={!access.manage} /></label>
        <p className="text-xs text-muted sm:col-span-2">{tr('Campos: {cliente} {factura} {balance} {vence} {empresa} (o en inglés {client} {invoice} {balance} {due} {company}). Vacío = mensaje predeterminado. Solo se preparan recordatorios de los últimos 7 días; las facturas en disputa o en pausa no reciben recordatorios.',
          'Fields: {client} {invoice} {balance} {due} {company} (or in Spanish {cliente} {factura} {balance} {vence} {empresa}). Empty = default message. Only reminders from the last 7 days are prepared; disputed or on-hold invoices get none.')}</p>
        {access.manage && <div><SubmitButton>{tr('Guardar', 'Save')}</SubmitButton></div>}
      </form>
      <section className="card space-y-2 p-5">
        <h2 className="font-display text-lg font-semibold text-fg">{tr('Vista previa', 'Preview')}</h2>
        <p className="text-sm font-semibold text-fg">{sample.subject}</p>
        <pre className="whitespace-pre-wrap font-sans text-sm text-slate-300">{sample.text}</pre>
      </section>
    </div>
  )
}
