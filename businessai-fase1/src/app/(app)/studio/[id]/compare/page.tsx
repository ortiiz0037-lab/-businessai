import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { studioPage } from '@/lib/studio/page'
import { parseContent, parsePage } from '@/lib/studio/model'
import { diffBlocks, diffPage, summary, type BlockChange } from '@/lib/studio/diff'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Two saved versions of a Studio document side by side: what was added, removed or changed (to the word). Read-only. */
export default async function CompareVersions({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, supabase, companyId, access } = await studioPage()
  if (!UUID.test(id)) notFound()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  const [{ data: doc }, { data: list }] = await Promise.all([
    supabase.from('studio_documents').select('id, title, version').eq('id', id).eq('company_id', companyId).maybeSingle(),
    supabase.from('studio_versions').select('version, saved_at').eq('document_id', id).order('version', { ascending: false }).limit(200),
  ])
  if (!doc) notFound()
  const versions = (list ?? []) as { version: number; saved_at: string }[]
  const nums = versions.map((v) => v.version)
  const to = nums.includes(Number(sp.to)) ? Number(sp.to) : nums[0]
  const from = nums.includes(Number(sp.from)) && Number(sp.from) !== to ? Number(sp.from) : nums.find((n) => n < (to ?? 0)) ?? nums[1]
  const { data: rows } = from && to ? await supabase.from('studio_versions').select('version, title, content, page, saved_at').eq('document_id', id).in('version', [from, to]) : { data: [] }
  const byV = new Map(((rows ?? []) as { version: number; title: string; content: unknown; page: unknown; saved_at: string }[]).map((r) => [r.version, r]))
  const a = from ? byV.get(from) : undefined, b = to ? byV.get(to) : undefined
  const ca = a ? parseContent(a.content) : null, cb = b ? parseContent(b.content) : null
  const changes: BlockChange[] = ca?.ok && cb?.ok ? diffBlocks(ca.content.blocks, cb.content.blocks) : []
  const pageChanges = a && b ? diffPage(parsePage(a.page), parsePage(b.page)) : []
  const sum = summary(changes)
  const KEYS: Record<string, [string, string]> = { font: ['Tipografía', 'Typeface'], size: ['Tamaño de página', 'Page size'], orientation: ['Orientación', 'Orientation'], fontSize: ['Cuerpo (pt)', 'Body (pt)'],
    lineHeight: ['Interlineado', 'Line spacing'], accent: ['Color de acento', 'Accent colour'], marginTop: ['Margen sup.', 'Top margin'], marginRight: ['Margen der.', 'Right margin'], marginBottom: ['Margen inf.', 'Bottom margin'], marginLeft: ['Margen izq.', 'Left margin'] }
  const label = (k: string) => (KEYS[k] ?? [k, k])[locale === 'en' ? 1 : 0]
  const opTone: Record<BlockChange['op'], string> = { same: 'border-line/60', added: 'border-emerald-500/60 bg-emerald-500/5', removed: 'border-red-500/60 bg-red-500/5', changed: 'border-amber-500/60 bg-amber-500/5' }
  const opName: Record<BlockChange['op'], string> = { same: tr('Sin cambios', 'Unchanged'), added: tr('Añadido', 'Added'), removed: tr('Eliminado', 'Removed'), changed: tr('Modificado', 'Changed') }
  const onlyChanges = true   // unchanged blocks are summarised, not listed
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Document Studio" title={tr('Comparar versiones', 'Compare versions')} description={doc.title} />
      <StudioNav tr={tr} current="/studio" />
      <form className="card flex flex-wrap items-end gap-3 p-4" data-testid="compare-form">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span>
          <select name="from" defaultValue={from} className="field">{versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {f.dateTime(v.saved_at)}</option>)}</select></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span>
          <select name="to" defaultValue={to} className="field">{versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {f.dateTime(v.saved_at)}</option>)}</select></label>
        <button type="submit" className="btn-secondary">{tr('Comparar', 'Compare')}</button>
        <Link href={`/studio/${doc.id}`} className="text-sm text-accent">{tr('← Volver al documento', '← Back to the document')}</Link>
      </form>
      {!a || !b ? <p className="card p-4 text-sm text-muted">{tr('Hace falta al menos dos versiones guardadas.', 'At least two saved versions are needed.')}</p> : (
        <>
          <section className="card space-y-2 p-4" data-testid="compare-summary">
            <p className="text-sm text-fg">v{from} → v{to}: <span className="text-emerald-300">{sum.added} {tr('añadidos', 'added')}</span> · <span className="text-red-300">{sum.removed} {tr('eliminados', 'removed')}</span> · <span className="text-amber-300">{sum.changed} {tr('modificados', 'changed')}</span> · {sum.same} {tr('sin cambios', 'unchanged')}</p>
            {a.title !== b.title && <p className="text-sm text-muted">{tr('Título', 'Title')}: <del className="text-red-300">{a.title}</del> → <ins className="text-emerald-300 no-underline">{b.title}</ins></p>}
            {pageChanges.length > 0 && <ul className="text-sm text-muted">{pageChanges.map((c) => <li key={c.key}>{label(c.key)}: <del className="text-red-300">{c.from}</del> → <ins className="text-emerald-300 no-underline">{c.to}</ins></li>)}</ul>}
          </section>
          <ol className="space-y-2" data-testid="compare-blocks">
            {changes.filter((c) => !onlyChanges || c.op !== 'same' || changes.every((x) => x.op === 'same')).map((c, i) => (
              <li key={i} className={`card min-w-0 border-l-4 p-3 ${opTone[c.op]}`} data-op={c.op}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{opName[c.op]} · {c.type}{c.op === 'changed' && c.formatOnly ? ` · ${tr('solo formato', 'formatting only')}` : ''}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">
                  {c.op === 'changed' ? c.segs.map((s, k) => s.op === 'eq' ? <span key={k}>{s.text}</span>
                    : s.op === 'add' ? <ins key={k} className="rounded bg-emerald-500/20 px-0.5 text-emerald-200 no-underline">{s.text}</ins>
                    : <del key={k} className="rounded bg-red-500/20 px-0.5 text-red-200">{s.text}</del>)
                    : c.op === 'removed' ? <del className="text-red-200">{c.text || '—'}</del> : c.op === 'added' ? <ins className="text-emerald-200 no-underline">{c.text || '—'}</ins> : (c.text || '—')}
                </p>
              </li>))}
          </ol>
          {sum.same > 0 && sum.added + sum.removed + sum.changed > 0 && <p className="text-xs text-muted">{tr(`${sum.same} bloque(s) sin cambios no se muestran.`, `${sum.same} unchanged block(s) are not shown.`)}</p>}
        </>
      )}
    </div>
  )
}
