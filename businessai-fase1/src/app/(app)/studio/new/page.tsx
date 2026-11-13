import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { BindingFields } from '@/components/studio/bindings'
import { studioPage } from '@/lib/studio/page'
import { bindingOptions } from '@/lib/studio/options'
import { systemTemplates } from '@/lib/studio/templates'
import { KINDS, kindLabel, studioMessage } from '@/lib/studio/model'
import { assistantDraft, createDocument } from '@/app/actions/studio'

export const dynamic = 'force-dynamic'

/** New document: from a system or company template, or as a draft prepared by the assistant. */
export default async function NewStudioDocument({ searchParams }: { searchParams: Promise<{ template?: string; source?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await studioPage()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  if (!access.edit) return <NoStudioAccess tr={tr} unavailable={false} />
  const [options, { data: own }] = await Promise.all([
    bindingOptions(supabase, companyId, access),
    supabase.from('studio_templates').select('id, kind, name, description').eq('company_id', companyId).eq('status', 'active').order('name'),
  ])
  const system = systemTemplates(locale)
  const company = (own ?? []) as { id: string; kind: string; name: string; description: string | null }[]
  const chosen = sp.template ?? `sys:${system[0].key}`
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Document Studio" title={tr('Nuevo documento', 'New document')}
        description={tr('Elige una plantilla y, si corresponde, el cliente, la factura o el empleado: los datos se leen de BusinessAI.', 'Choose a template and, where it applies, the client, invoice or employee: the data is read from BusinessAI.')} />
      <StudioNav tr={tr} current="/studio/new" />
      <Flash error={studioMessage(sp.error, locale)} />
      <form action={createDocument} className="space-y-5">
        <fieldset className="card p-4">
          <legend className="px-1 font-display text-lg font-semibold text-fg">{tr('1. Plantilla', '1. Template')}</legend>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[...company.map((t) => ({ ref: `tpl:${t.id}`, kind: t.kind, name: t.name, description: t.description ?? tr('Plantilla de la empresa', 'Company template'), own: true })),
              ...system.map((t) => ({ ref: `sys:${t.key}`, kind: t.kind, name: t.name, description: t.description, own: false }))].map((t) => (
              <label key={t.ref} className="flex cursor-pointer gap-3 rounded-xl border border-line bg-card/60 p-3 has-[:checked]:border-electric/70 has-[:checked]:bg-brand/15">
                <input type="radio" name="template" value={t.ref} defaultChecked={t.ref === chosen} className="mt-1" required />
                <span className="min-w-0"><span className="block font-semibold text-fg">{t.name}{t.own && <span className="badge-accent ml-2">{tr('Empresa', 'Company')}</span>}</span>
                  <span className="block text-xs text-muted">{kindLabel(t.kind, locale)} · {t.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="card space-y-3 p-4">
          <legend className="px-1 font-display text-lg font-semibold text-fg">{tr('2. Datos', '2. Data')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className="field-label">{tr('Título (opcional)', 'Title (optional)')}</span><input name="title" maxLength={160} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Carpeta (opcional)', 'Folder (optional)')}</span><input name="folder" maxLength={60} className="field" /></label>
          </div>
          <BindingFields tr={tr} options={options} value={{ source_document_id: /^[0-9a-f-]{36}$/i.test(sp.source ?? '') ? sp.source : null }} />
          <p className="text-xs text-muted">{tr('Facturas, cotizaciones y recibos se diseñan sobre el documento comercial existente: no se crea otra factura ni otros importes.',
            'Invoices, quotes and receipts are laid out on the existing business document: no second invoice and no other amounts are created.')}</p>
        </fieldset>
        <SubmitButton className="w-full sm:w-auto">{tr('Crear borrador', 'Create draft')}</SubmitButton>
      </form>

      <section aria-labelledby="assistant" className="card space-y-3 p-4">
        <h2 id="assistant" className="font-display text-lg font-semibold text-fg">BusinessAI Assistant</h2>
        <p className="text-sm text-muted">{tr('Describe el documento. El asistente crea un BORRADOR con la plantilla adecuada y los datos autorizados de la empresa; no inventa datos (marca lo que falte) y nunca emite ni envía: tú lo revisas y confirmas.',
          'Describe the document. The assistant creates a DRAFT with the right template and the company data you are allowed to see; it invents nothing (missing data is marked) and never issues or sends: you review and confirm.')}</p>
        <form action={assistantDraft} className="space-y-3">
          <label className="block text-sm"><span className="field-label">{tr('Instrucción', 'Instruction')}</span>
            <textarea name="instruction" required minLength={5} maxLength={4000} rows={3} className="field" placeholder={tr('Ej.: Carta para agradecer a Cliente Uno la renovación del servicio anual.', 'E.g. Letter thanking Client One for renewing the yearly service.')} /></label>
          <label className="block text-sm sm:w-72"><span className="field-label">{tr('Tipo (opcional: se deduce de la instrucción)', 'Kind (optional: inferred from the instruction)')}</span>
            <select name="kind" className="field" defaultValue=""><option value="">{tr('Automático', 'Automatic')}</option>{KINDS.map((k) => <option key={k} value={k}>{kindLabel(k, locale)}</option>)}</select></label>
          <BindingFields tr={tr} options={options} />
          <SubmitButton className="w-full sm:w-auto">{tr('Crear borrador con el asistente', 'Create a draft with the assistant')}</SubmitButton>
        </form>
      </section>
    </div>
  )
}
