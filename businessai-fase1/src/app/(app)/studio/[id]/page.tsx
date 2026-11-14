import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { BindingFields } from '@/components/studio/bindings'
import { StudioEditor } from '@/components/studio/editor'
import { StudioPreview, type PreviewImages } from '@/components/studio/preview'
import { studioPage } from '@/lib/studio/page'
import { bindingOptions } from '@/lib/studio/options'
import { imageKeys, loadBrand, loadData, loadDoc, loadImage } from '@/lib/studio/server'
import { imageInfo } from '@/lib/studio/images'
import { KIND_SOURCES, effectiveBrand, kindLabel, statusLabel, statusTone, studioMessage } from '@/lib/studio/model'
import { missingFields } from '@/lib/studio/merge'
import { archiveDocument, duplicateDocument, finalizeDocument, prepareEmail, restoreVersion, saveBindings, saveDocumentState } from '@/app/actions/studio'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EVENT: Record<string, [string, string]> = {
  created: ['Creado', 'Created'], drafted_by_assistant: ['Borrador del asistente', 'Assistant draft'], duplicated: ['Duplicado', 'Duplicated'], version_restored: ['Versión restaurada', 'Version restored'],
  finalized: ['Emitido', 'Issued'], archived: ['Archivado', 'Archived'], exported_pdf: ['PDF generado', 'PDF generated'], printed: ['Impreso', 'Printed'], email_prepared: ['Correo preparado', 'E-mail prepared'],
}

type SP = { done?: string; error?: string; missing?: string; to?: string }

export default async function StudioDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  if (!UUID.test(id)) notFound()
  const { locale, tr, f, today, supabase, companyId, access, who } = await studioPage()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  const doc = await loadDoc(supabase, companyId, id)
  if (!doc) notFound()
  const [ctx, { data, error: dataError }, { data: assetRows }, { data: versionRows }, { data: eventRows }, name, options] = await Promise.all([
    loadBrand(supabase, companyId), loadData(supabase, doc, today),
    supabase.from('studio_assets').select('id, file_name, width, height').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200),
    supabase.from('studio_versions').select('version, title, saved_by, saved_at').eq('document_id', id).order('version', { ascending: false }).limit(20),
    supabase.from('studio_events').select('action, details, actor, created_at').eq('document_id', id).order('id', { ascending: false }).limit(50),
    who(), bindingOptions(supabase, companyId, access),
  ])
  const assets = ((assetRows ?? []) as { id: string; file_name: string; width: number; height: number }[]).map((a) => ({ id: a.id, name: a.file_name, width: a.width, height: a.height }))
  // preview images: uploaded assets (known size) + logo / signature / stamp (read once to know their size)
  const images: PreviewImages = Object.fromEntries(assets.map((a) => [a.id, { width: a.width, height: a.height, url: `/studio/image?key=${a.id}` }]))
  for (const k of imageKeys(doc.content, ctx.brand).filter((k) => ['logo', 'signature', 'stamp'].includes(k)).concat(['logo', 'signature'])) {
    if (images[k]) continue
    const img = await loadImage(supabase, companyId, k, ctx)
    const info = img ? imageInfo(img.bytes) : null
    if (info) images[k] = { width: info.width, height: info.height, url: `/studio/image?key=${k}` }
  }
  const draft = doc.status === 'draft'
  const canEdit = draft && access.edit
  const missing = draft ? missingFields(doc.content.blocks, data, locale) : []
  const src = KIND_SOURCES[doc.kind]
  const back = `/studio/${id}`
  const done: Record<string, string> = {
    created: tr('Borrador creado.', 'Draft created.'), duplicated: tr('Copia creada como borrador.', 'Copy created as a draft.'), bindings: tr('Datos vinculados actualizados.', 'Linked data updated.'),
    finalized: tr('Documento emitido: número asignado y datos congelados.', 'Document issued: number assigned and data frozen.'), archived: tr('Documento archivado.', 'Document archived.'),
    restored: tr('Versión restaurada.', 'Version restored.'), assistant: tr('Borrador creado por el asistente. Revíselo antes de emitirlo.', 'Draft created by the assistant. Review it before issuing.'),
    email: tr('Correo preparado (no se envió).', 'E-mail prepared (not sent).'),
  }
  const errorText = sp.error ? `${studioMessage(sp.error, locale)}${sp.missing ? ` (${sp.missing.split(',').join(', ')})` : ''}` : null
  const versions = (versionRows ?? []) as { version: number; title: string; saved_by: string | null; saved_at: string }[]
  const events = (eventRows ?? []) as { action: string; details: Record<string, unknown>; actor: string | null; created_at: string }[]
  const pdf = `/studio/${id}/pdf`
  const mailTo = sp.to && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(sp.to) ? sp.to : null
  const subject = `${kindLabel(doc.kind, locale)} ${doc.number ?? ''} — ${ctx.companyName}`.trim()
  const body = tr(`Hola,\n\nAdjuntamos ${kindLabel(doc.kind, locale).toLowerCase()} ${doc.number ?? ''}.\n\nSaludos,\n${ctx.companyName}`, `Hello,\n\nPlease find attached ${kindLabel(doc.kind, locale).toLowerCase()} ${doc.number ?? ''}.\n\nRegards,\n${ctx.companyName}`)
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={`Document Studio · ${kindLabel(doc.kind, locale)}`} title={`${doc.title}${doc.number ? ` · ${doc.number}` : ''}`}
        description={draft ? tr('Borrador: los datos se leen en vivo de BusinessAI. Al emitir se congelan y se asigna el número.', 'Draft: data is read live from BusinessAI. Issuing freezes it and assigns the number.')
          : doc.status === 'final' ? tr(`Emitido el ${f.dateTime(doc.finalized_at!)}: no se modifica.`, `Issued on ${f.dateTime(doc.finalized_at!)}: it cannot change.`) : tr(`Archivado: ${doc.archive_reason ?? ''}`, `Archived: ${doc.archive_reason ?? ''}`)}
        actions={<div className="flex flex-wrap items-center gap-2"><span className={statusTone(doc.status)}>{statusLabel(doc.status, locale)}</span>
          <a href={pdf} target="_blank" rel="noopener" className="btn-secondary btn-sm">{tr('Ver PDF / Imprimir', 'View PDF / Print')}</a>
          <a href={`${pdf}?download=1`} download className="btn-secondary btn-sm">{tr('Descargar PDF', 'Download PDF')}</a></div>} />
      <StudioNav tr={tr} current="/studio" />
      <Flash done={sp.done ? done[sp.done] : null} error={errorText} />
      {dataError && <div role="alert" className="alert-warning p-4 text-sm">{studioMessage('forbidden', locale)} {tr('(no puedes leer alguno de los datos vinculados)', '(you cannot read some of the linked data)')}</div>}

      {canEdit ? (
        <StudioEditor mode="document" id={doc.id} version={doc.version} title={doc.title} folder={doc.folder} kind={doc.kind} content={doc.content} page={doc.page}
          brand={effectiveBrand(ctx.brand, doc.status, locale)} accentFallback={ctx.accentFallback} data={data} locale={locale} currency={ctx.currency} images={images} assets={assets} canUpload={access.edit} action={saveDocumentState} />
      ) : (
        <section aria-label={tr('Documento', 'Document')} className="mx-auto max-w-3xl">
          <StudioPreview content={doc.content} page={doc.page} brand={effectiveBrand(ctx.brand, doc.status, locale)} accentFallback={ctx.accentFallback}
            data={data} locale={locale} currency={ctx.currency} images={images} kind={doc.kind} title={doc.title} />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {canEdit && (
          <form action={saveBindings} className="card space-y-3 p-4">
            <input type="hidden" name="id" value={doc.id} /><input type="hidden" name="version" value={doc.version} /><input type="hidden" name="back" value={back} />
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Datos vinculados', 'Linked data')}</h2>
            <p className="text-xs text-muted">{tr('Guarda el contenido antes de cambiar estos datos (la página se recarga).', 'Save the content before changing these (the page reloads).')}</p>
            <BindingFields tr={tr} options={options} docTypes={src.document} value={doc} />
            <SubmitButton className="w-full sm:w-auto">{tr('Actualizar datos vinculados', 'Update linked data')}</SubmitButton>
          </form>
        )}
        {draft && access.issue && (
          <form action={finalizeDocument} className="card space-y-3 p-4">
            <input type="hidden" name="id" value={doc.id} /><input type="hidden" name="version" value={doc.version} /><input type="hidden" name="back" value={back} />
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Emitir', 'Issue')}</h2>
            <p className="text-sm text-muted">{doc.source_document_id ? tr('Usará el número del documento comercial vinculado.', 'It will use the linked business document\'s number.') : tr('Se asignará el siguiente número de la empresa para este tipo.', 'The company\'s next number for this kind will be assigned.')}
              {' '}{tr('La base de datos guarda una copia inmutable de los datos tal como están hoy.', 'The database keeps an immutable copy of the data as it is today.')}</p>
            {missing.length > 0 && <div role="alert" className="alert-warning p-3 text-sm">{studioMessage('missing_data', locale)} <span className="block text-xs">{missing.join(', ')}</span></div>}
            <label className="flex items-start gap-2 text-sm text-slate-300"><input type="checkbox" name="confirm" value="yes" required className="mt-1" />
              {tr('Revisé el documento y confirmo su emisión. Entiendo que no se podrá modificar.', 'I reviewed the document and confirm its issue. I understand it cannot be changed.')}</label>
            <SubmitButton className="w-full sm:w-auto">{tr('Emitir documento', 'Issue document')}</SubmitButton>
          </form>
        )}
        {draft && access.edit && !access.issue && <p className="card p-4 text-sm text-muted">{tr('Solo el propietario y los administradores emiten documentos.', 'Only owners and admins issue documents.')}</p>}

        {doc.status === 'final' && (
          <div className="card space-y-3 p-4">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Preparar correo', 'Prepare e-mail')}</h2>
            {mailTo ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted">{tr('BusinessAI no envía el correo: descarga el PDF y adjúntalo en tu programa de correo.', 'BusinessAI does not send the e-mail: download the PDF and attach it in your e-mail app.')}</p>
                <dl className="grid grid-cols-[6rem_1fr] gap-1"><dt className="text-muted">{tr('Para', 'To')}</dt><dd className="text-fg">{mailTo}</dd><dt className="text-muted">{tr('Asunto', 'Subject')}</dt><dd className="text-fg">{subject}</dd></dl>
                <pre className="whitespace-pre-wrap rounded-xl border border-line bg-card/60 p-3 text-xs text-slate-300">{body}</pre>
                <div className="flex flex-wrap gap-2">
                  <a href={`${pdf}?download=1`} download className="btn-secondary btn-sm">{tr('1. Descargar PDF', '1. Download PDF')}</a>
                  <a href={`mailto:${encodeURIComponent(mailTo)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`} className="btn-primary btn-sm">{tr('2. Abrir en mi correo', '2. Open in my e-mail')}</a>
                </div>
              </div>
            ) : (
              <form action={prepareEmail} className="space-y-2">
                <input type="hidden" name="id" value={doc.id} /><input type="hidden" name="back" value={back} />
                <label className="block text-sm"><span className="field-label">{tr('Destinatario', 'Recipient')}</span>
                  <input type="email" name="to" required maxLength={200} defaultValue={String(data.client?.email ?? data.vendor?.email ?? '')} className="field" /></label>
                <SubmitButton className="w-full sm:w-auto">{tr('Preparar', 'Prepare')}</SubmitButton>
              </form>
            )}
          </div>
        )}

        <div className="card space-y-3 p-4">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Acciones', 'Actions')}</h2>
          {access.edit && <form action={duplicateDocument} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={doc.id} /><input type="hidden" name="back" value={back} />
            <label className="text-sm"><span className="field-label">{tr('Título de la copia', 'Copy title')}</span><input name="title" maxLength={160} className="field" placeholder={tr(`Copia de ${doc.title}`, `Copy of ${doc.title}`)} /></label>
            <SubmitButton className="w-full sm:w-auto">{tr('Duplicar', 'Duplicate')}</SubmitButton></form>}
          {doc.status !== 'archived' && (draft ? access.edit : access.issue) && <form action={archiveDocument} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={doc.id} /><input type="hidden" name="back" value={back} />
            <label className="text-sm"><span className="field-label">{tr('Motivo para archivar', 'Reason to archive')}</span><input name="reason" required minLength={3} maxLength={300} className="field" /></label>
            <SubmitButton className="w-full sm:w-auto">{tr('Archivar', 'Archive')}</SubmitButton></form>}
          <Link href="/studio" className="text-sm text-accent">{tr('← Todos los documentos', '← All documents')}</Link>
        </div>

        {draft && versions.length > 1 && (
          <div className="card space-y-2 p-4">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Versiones guardadas', 'Saved versions')}</h2>
            <ul className="divide-y divide-line/60 text-sm">
              {versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-slate-300">v{v.version} · {f.dateTime(v.saved_at)} · {name(v.saved_by)}</span>
                  {access.edit && v.version !== doc.version && <form action={restoreVersion}><input type="hidden" name="id" value={doc.id} /><input type="hidden" name="version" value={doc.version} />
                    <input type="hidden" name="from_version" value={v.version} /><input type="hidden" name="back" value={back} /><button type="submit" className="btn-secondary btn-sm">{tr('Restaurar', 'Restore')}</button></form>}
                </li>))}
            </ul>
          </div>
        )}
        <div className="card space-y-2 p-4">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Historial', 'History')}</h2>
          <ul className="divide-y divide-line/60 text-sm">
            {events.map((e, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 py-2"><span className="text-fg">{(EVENT[e.action] ?? [e.action, e.action])[locale === 'en' ? 1 : 0]}
                {e.action === 'finalized' && e.details?.number ? ` · ${String(e.details.number)}` : ''}{e.action === 'email_prepared' && e.details?.to ? ` · ${String(e.details.to)}` : ''}{e.action === 'archived' && e.details?.reason ? ` · ${String(e.details.reason)}` : ''}</span>
                <span className="text-xs text-muted">{name(e.actor)} · {f.dateTime(e.created_at)}</span></li>))}
          </ul>
        </div>
      </div>
    </div>
  )
}
