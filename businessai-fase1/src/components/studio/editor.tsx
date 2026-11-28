'use client'
/**
 * Document Studio editor: edits the blocks (not a static preview), shows the
 * exact page layout next to them, and saves through a server action that
 * checks the version (conflicts are reported, never overwritten).
 */
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Locale } from '@/lib/i18n/app'
import { PAGE_DEFAULTS, studioMessage, type Align, type Block, type Brand, type DocContent, type Kind, type PageSettings } from '@/lib/studio/model'
import { FIELDS, makeFormatters, type StudioData } from '@/lib/studio/merge'
import { StudioPreview, type PreviewImages } from '@/components/studio/preview'
import type { SaveState } from '@/app/actions/studio'
import type { PickerItem } from '@/components/catalog-line-picker'
import { FAMILIES, FAMILY_INFO, type Family } from '@/lib/studio/fonts'
import { applySpan, clearFormatting, toggleMark, type Edit, type SpanProps } from '@/lib/studio/format'
import { deleteCol, deleteRow, duplicateRow, insertCol, insertRow, moveCol, moveRow, setColAlign, setColWidth, MAX_COLS, type Table } from '@/lib/studio/tables'

type Asset = { id: string; name: string; width: number; height: number }
type Props = {
  mode: 'document' | 'template'
  id: string; version?: number; title: string; folder?: string | null; kind: Kind
  content: DocContent; page: PageSettings
  brand: Brand; accentFallback: string | null; data: StudioData; locale: Locale; currency: string
  images: PreviewImages; assets: Asset[]; canUpload: boolean
  catalog?: PickerItem[]   // 0039: active catalog items; a table row can be added from one (a copy)
  families?: Family[]      // S5 / 0041: typefaces the database accepts (sans / serif without 0041)
  action: (state: SaveState, fd: FormData) => Promise<SaveState>
}

const BLOCK_TYPES: Block['type'][] = ['heading', 'paragraph', 'fields', 'table', 'items', 'totals', 'payments', 'statement', 'bill', 'aging', 'image', 'signature', 'stamp', 'spacer', 'divider', 'pagebreak']
const LABELS: Record<Locale, Record<string, string>> = {
  es: { heading: 'Título', paragraph: 'Párrafo', fields: 'Datos (etiqueta / valor)', table: 'Tabla', items: 'Líneas del documento comercial', totals: 'Totales', payments: 'Pagos registrados',
    statement: 'Estado de cuenta (facturas abiertas)', bill: 'Líneas del gasto vinculado', aging: 'Antigüedad del saldo del cliente', image: 'Imagen', signature: 'Firma', stamp: 'Sello', spacer: 'Espacio', divider: 'Separador', pagebreak: 'Salto de página' },
  en: { heading: 'Heading', paragraph: 'Paragraph', fields: 'Data (label / value)', table: 'Table', items: 'Business document lines', totals: 'Totals', payments: 'Recorded payments',
    statement: 'Account statement (open invoices)', bill: 'Lines of the linked expense', aging: 'Client balance ageing', image: 'Image', signature: 'Signature', stamp: 'Stamp', spacer: 'Space', divider: 'Divider', pagebreak: 'Page break' },
}
const DATA_HELP: Record<Locale, Record<string, string>> = {
  es: { items: 'Se toman de la factura o cotización vinculada; no se escriben aquí.', totals: 'Subtotal, impuesto, total, pagado y balance de la factura vinculada.',
    payments: 'Pagos registrados en Pagos para la factura vinculada.', statement: 'Facturas con balance del cliente vinculado (Cuentas por cobrar).', bill: 'Líneas, total y saldo del gasto vinculado (Gastos).', aging: 'Saldo del cliente por antigüedad: corriente, 1–30, 31–60, 61–90 y más de 90 días.' },
  en: { items: 'Taken from the linked invoice or quote; not typed here.', totals: 'Subtotal, tax, total, paid and balance of the linked invoice.',
    payments: 'Payments recorded in Payments for the linked invoice.', statement: 'Invoices with a balance of the linked client (Receivables).', bill: 'Lines, total and balance of the linked expense (Expenses).', aging: 'Client balance by age: current, 1–30, 31–60, 61–90 and over 90 days.' },
}

/** A table row copied from a catalog item, fitted to the table's columns: [code,] name, [unit,] price. */
export function catalogRow(it: PickerItem, cols: number, money: (cents: number) => string): string[] {
  const price = `${money(it.price_cents)} / ${it.unit}`
  const cells = cols >= 4 ? [it.code, it.name, it.unit, money(it.price_cents)] : cols === 3 ? [it.name, it.unit, money(it.price_cents)] : cols === 2 ? [it.name, price] : [`${it.name} · ${price}`]
  return [...cells, ...Array(Math.max(0, cols - cells.length)).fill('')]
}

function newBlock(t: Block['type']): Block {
  switch (t) {
    case 'heading': return { type: 'heading', level: 2, text: '' }
    case 'paragraph': return { type: 'paragraph', text: '' }
    case 'table': return { type: 'table', header: true, rows: [['', '', ''], ['', '', '']] }
    case 'fields': return { type: 'fields', rows: [['', '']] }
    case 'image': return { type: 'image', asset: 'logo', width: 30 }
    case 'signature': return { type: 'signature', withImage: false }
    case 'stamp': return { type: 'stamp' }
    case 'spacer': return { type: 'spacer', size: 8 }
    default: return { type: t } as Block
  }
}

export function StudioEditor(p: Props) {
  const es = p.locale !== 'en'
  const tr = (a: string, b: string) => (es ? a : b)
  const [blocks, setBlocks] = useState<Block[]>(p.content.blocks)
  const [page, setPage] = useState<PageSettings>(p.page)
  const [title, setTitle] = useState(p.title)
  const [folder, setFolder] = useState(p.folder ?? '')
  const [assets, setAssets] = useState(p.assets)
  const [images, setImages] = useState(p.images)
  const money = useMemo(() => { const fm = makeFormatters(p.locale, p.currency || 'USD'); return (c: number) => fm.money(c / 100) }, [p.locale, p.currency])
  const [edits, setEdits] = useState(0)            // edits since the page loaded
  const [submitted, setSubmitted] = useState(0)    // edits included in the last save request
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [selected, setSelected] = useState<number | null>(null)
  const [addType, setAddType] = useState<Block['type']>('paragraph')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const [layoutInfo, setLayoutInfo] = useState<{ pages: number; missing: string[] }>({ pages: 0, missing: [] })
  const focused = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; apply: (v: string) => void } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [state, formAction, pending] = useActionState(p.action, { ok: true } as SaveState)

  const version = state.version ?? p.version ?? 0
  const dirty = edits > 0 && !(state.ok && state.at && submitted === edits)
  const setDirty = (dirtied: boolean) => { if (dirtied) setEdits((n) => n + 1) }
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); formRef.current?.requestSubmit() } }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [])

  const content: DocContent = useMemo(() => ({ v: 1, blocks }), [blocks])
  const onLayout = useCallback((r: { pages: number; missing: string[] }) => setLayoutInfo(r), [])
  const change = (i: number, b: Block) => { setBlocks((bs) => bs.map((x, k) => (k === i ? b : x))); setDirty(true) }
  const move = (i: number, d: -1 | 1) => { setBlocks((bs) => { const n = [...bs]; const j = i + d; if (j < 0 || j >= n.length) return bs; [n[i], n[j]] = [n[j], n[i]]; return n }); setSelected(i + d); setDirty(true) }
  const remove = (i: number) => { setBlocks((bs) => bs.filter((_, k) => k !== i)); setSelected(null); setDirty(true) }
  const duplicate = (i: number) => { setBlocks((bs) => [...bs.slice(0, i + 1), structuredClone(bs[i]), ...bs.slice(i + 1)]); setDirty(true) }
  const add = () => { const at = selected === null ? blocks.length : selected + 1; setBlocks((bs) => [...bs.slice(0, at), newBlock(addType), ...bs.slice(at)]); setSelected(at); setDirty(true) }
  const setPg = (patch: Partial<PageSettings>) => { setPage((pg) => ({ ...pg, ...patch })); setDirty(true) }
  const track = (el: HTMLInputElement | HTMLTextAreaElement, apply: (v: string) => void) => { focused.current = { el, apply } }
  const insertField = (path: string) => {
    const f = focused.current
    if (!f) return
    const { el } = f, tag = `{{${path}}}`, s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s
    const v = el.value.slice(0, s) + tag + el.value.slice(e)
    f.apply(v)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + tag.length, s + tag.length) })
  }
  /** Applies a formatting edit to the selected words of the focused field (S5: bold, italic, colour, size, underline, strike, highlight, typeface). */
  const editSel = (fn: (e: Edit) => Edit) => {
    const f = focused.current
    if (!f) return
    const { el } = f, start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start
    const r = fn({ value: el.value, start, end })
    if (r.value === el.value) return
    f.apply(r.value)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end) })
  }
  const format = (mark: '**' | '__') => editSel((e) => toggleMark(e, mark))
  const span = (p: SpanProps) => editSel((e) => applySpan(e, p))
  const [inkColor, setInkColor] = useState('#C0392B')
  const [markColor, setMarkColor] = useState('#FFF59D')
  async function upload(file: File, i: number | null) {
    setUploadMsg(tr('Subiendo…', 'Uploading…'))
    const fd = new FormData(); fd.append('file', file)
    const r = await fetch('/studio/assets', { method: 'POST', body: fd })
    const j = await r.json().catch(() => ({ error: 'save' }))
    if (!r.ok || !j.id) { setUploadMsg(studioMessage(j.error ?? 'save', p.locale)); return }
    setAssets((a) => [...a, { id: j.id, name: j.name, width: j.width, height: j.height }])
    setImages((m) => ({ ...m, [j.id]: { width: j.width, height: j.height, url: `/studio/image?key=${j.id}` } }))
    if (i !== null) { const b = blocks[i]; if (b.type === 'image') change(i, { ...b, asset: j.id }) }
    setUploadMsg(tr('Imagen subida.', 'Image uploaded.'))
  }

  const text = (i: number, b: Block & { text: string }, multiline: boolean, label: string) => {
    const props = {
      value: b.text, 'aria-label': label, className: 'field',
      onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => track(e.currentTarget, (v) => change(i, { ...b, text: v } as Block)),
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(i, { ...b, text: e.target.value } as Block),
    }
    return multiline ? <textarea rows={Math.min(14, Math.max(3, b.text.split('\n').length + 1))} {...props} /> : <input {...props} />
  }
  const alignSel = (i: number, b: Block & { align?: Align }) => (
    <select value={b.align ?? 'left'} onChange={(e) => change(i, { ...b, align: e.target.value as Align } as Block)} className="field w-auto" aria-label={tr('Alineación', 'Alignment')}>
      <option value="left">{tr('Izquierda', 'Left')}</option><option value="center">{tr('Centro', 'Center')}</option><option value="right">{tr('Derecha', 'Right')}</option><option value="justify">{tr('Justificado', 'Justified')}</option>
    </select>
  )
  const cellInput = (value: string, onChange: (v: string) => void, label: string) => (
    <input value={value} aria-label={label} className="field min-w-24 px-2 py-1 text-xs" onFocus={(e) => track(e.currentTarget, onChange)} onChange={(e) => onChange(e.target.value)} />
  )

  function body(b: Block, i: number) {
    switch (b.type) {
      case 'heading': return <div className="flex flex-col gap-2 sm:flex-row">{text(i, b, false, tr('Texto del título', 'Heading text'))}
        <select value={b.level} onChange={(e) => change(i, { ...b, level: Number(e.target.value) as 1 | 2 | 3 })} className="field w-auto" aria-label={tr('Nivel', 'Level')}><option value={1}>H1</option><option value={2}>H2</option><option value={3}>H3</option></select>{alignSel(i, b)}</div>
      case 'paragraph': return <div className="space-y-2">{text(i, b, true, tr('Texto del párrafo', 'Paragraph text'))}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">{alignSel(i, b)}
          <label className="flex items-center gap-1">{tr('Tamaño', 'Size')} <input type="number" min={7} max={24} step={0.5} value={b.size ?? ''} placeholder="auto" onChange={(e) => change(i, { ...b, size: e.target.value ? Number(e.target.value) : undefined })} className="field w-20 px-2 py-1" /></label>
          <span>{tr('Seleccione palabras y use la barra de formato', 'Select words and use the formatting bar')}</span></div></div>
      case 'fields': return <div className="space-y-2">{b.rows.map((r, k) => (
        <div key={k} className="flex flex-wrap gap-2">{cellInput(r[0], (v) => change(i, { ...b, rows: b.rows.map((x, j) => (j === k ? [v, x[1]] : x)) as [string, string][] }), tr('Etiqueta', 'Label'))}
          {cellInput(r[1], (v) => change(i, { ...b, rows: b.rows.map((x, j) => (j === k ? [x[0], v] : x)) as [string, string][] }), tr('Valor', 'Value'))}
          <button type="button" className="btn-secondary btn-sm" onClick={() => change(i, { ...b, rows: b.rows.filter((_, j) => j !== k) })} aria-label={tr('Quitar fila', 'Remove row')}>−</button></div>))}
        <button type="button" className="btn-secondary btn-sm" onClick={() => change(i, { ...b, rows: [...b.rows, ['', '']] })}>{tr('+ Fila', '+ Row')}</button></div>
      case 'table': {
        const cols = b.rows[0]?.length ?? 1
        const set = (t: Table) => change(i, t)
        const tb = 'btn-secondary btn-sm min-h-9 min-w-9 px-2'
        return <div className="space-y-2" data-testid="studio-table-editor"><div className="overflow-x-auto"><table className="text-xs"><thead><tr><th className="w-24" />
          {Array.from({ length: cols }, (_, j) => (
            <th key={j} className="p-0.5 align-bottom font-normal" scope="col">
              <div className="flex flex-col gap-1">
                <span className="flex gap-1" role="group" aria-label={`${tr('Columna', 'Column')} ${j + 1}`}>
                  <button type="button" className={tb} disabled={j === 0} onClick={() => set(moveCol(b, j, -1))} aria-label={`${tr('Mover columna a la izquierda', 'Move column left')} ${j + 1}`}>←</button>
                  <button type="button" className={tb} disabled={j === cols - 1} onClick={() => set(moveCol(b, j, 1))} aria-label={`${tr('Mover columna a la derecha', 'Move column right')} ${j + 1}`}>→</button>
                  <button type="button" className={tb} disabled={cols >= MAX_COLS} onClick={() => set(insertCol(b, j + 1))} aria-label={`${tr('Insertar columna a la derecha de', 'Insert column right of')} ${j + 1}`}>+</button>
                  <button type="button" className={tb} disabled={cols < 2} onClick={() => set(deleteCol(b, j))} aria-label={`${tr('Eliminar columna', 'Delete column')} ${j + 1}`}>✕</button>
                </span>
                <span className="flex gap-1">
                  <select value={b.align?.[j] ?? 'left'} onChange={(e) => set(setColAlign(b, j, e.target.value as Align))} className="field w-auto px-1 py-1 text-xs" aria-label={`${tr('Alineación de la columna', 'Column alignment')} ${j + 1}`}>
                    <option value="left">⇤</option><option value="center">↔</option><option value="right">⇥</option></select>
                  <input type="number" min={1} max={100} value={b.widths?.[j] ?? ''} placeholder={tr('ancho', 'width')} onChange={(e) => set(setColWidth(b, j, Number(e.target.value)))} className="field w-16 px-1 py-1 text-xs" aria-label={`${tr('Ancho relativo de la columna', 'Relative width of column')} ${j + 1}`} />
                </span>
              </div>
            </th>))}</tr></thead>
          <tbody>{b.rows.map((r, k) => (
          <tr key={k}><td className="p-0.5 align-top"><span className="flex gap-1" role="group" aria-label={`${tr('Fila', 'Row')} ${k + 1}`}>
            <button type="button" className={tb} disabled={k === 0} onClick={() => set(moveRow(b, k, -1))} aria-label={`${tr('Subir fila', 'Move row up')} ${k + 1}`}>↑</button>
            <button type="button" className={tb} disabled={k === b.rows.length - 1} onClick={() => set(moveRow(b, k, 1))} aria-label={`${tr('Bajar fila', 'Move row down')} ${k + 1}`}>↓</button>
            <button type="button" className={tb} onClick={() => set(insertRow(b, k + 1))} aria-label={`${tr('Insertar fila debajo de', 'Insert row below')} ${k + 1}`}>+</button>
            <button type="button" className={tb} onClick={() => set(duplicateRow(b, k))} aria-label={`${tr('Duplicar fila', 'Duplicate row')} ${k + 1}`}>⧉</button>
            <button type="button" className={tb} disabled={b.rows.length < 2} onClick={() => set(deleteRow(b, k))} aria-label={`${tr('Eliminar fila', 'Delete row')} ${k + 1}`}>✕</button></span></td>
            {r.map((c, j) => <td key={j} className="p-0.5">{cellInput(c, (v) => change(i, { ...b, rows: b.rows.map((x, rr) => (rr === k ? x.map((y, cc) => (cc === j ? v : y)) : x)) }), `${tr('Fila', 'Row')} ${k + 1}, ${tr('columna', 'column')} ${j + 1}`)}</td>)}</tr>))}</tbody></table></div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button type="button" className="btn-secondary btn-sm" onClick={() => set(insertRow(b, b.rows.length))}>{tr('+ Fila al final', '+ Row at the end')}</button>
            <button type="button" className="btn-secondary btn-sm" disabled={cols >= MAX_COLS} onClick={() => set(insertCol(b, cols))}>{tr('+ Columna al final', '+ Column at the end')}</button>
            <label className="flex items-center gap-1 text-muted"><input type="checkbox" checked={b.header} onChange={(e) => change(i, { ...b, header: e.target.checked })} /> {tr('Primera fila como encabezado', 'First row as header')}</label>
            <label className="flex items-center gap-1 text-muted"><input type="checkbox" checked={!!b.total} onChange={(e) => change(i, { ...b, total: e.target.checked || undefined })} /> {tr('Última fila como total', 'Last row as total')}</label>
            <label className="flex items-center gap-1 text-muted">{tr('Estilo', 'Style')}
              <select value={b.style ?? 'zebra'} onChange={(e) => change(i, { ...b, style: e.target.value as Table['style'] })} className="field w-auto py-1 text-xs">
                <option value="zebra">{tr('Bandas', 'Banded')}</option><option value="grid">{tr('Cuadrícula', 'Grid')}</option><option value="plain">{tr('Simple', 'Plain')}</option></select></label>
            {(p.catalog?.length ?? 0) > 0 && (
              <select value="" className="field w-auto py-1 text-xs" aria-label={tr('Añadir fila del catálogo', 'Add a row from the catalog')} data-testid="studio-table-catalog"
                onChange={(e) => { const it = p.catalog!.find((x) => x.id === e.target.value); if (it) change(i, { ...b, rows: [...b.rows, catalogRow(it, cols, money)] }) }}>
                <option value="">{tr('+ Fila del catálogo…', '+ Row from the catalog…')}</option>
                {p.catalog!.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
              </select>)}
          </div></div>
      }
      case 'image': return <div className="flex flex-wrap items-center gap-2">
        <select value={b.asset} onChange={(e) => change(i, { ...b, asset: e.target.value })} className="field w-auto" aria-label={tr('Imagen', 'Image')}>
          <option value="logo">{tr('Logo de la empresa', 'Company logo')}</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <label className="flex items-center gap-1 text-xs text-muted">{tr('Ancho', 'Width')} <input type="range" min={5} max={100} value={b.width} onChange={(e) => change(i, { ...b, width: Number(e.target.value) })} /> {b.width}%</label>
        {alignSel(i, b)}
        {p.canUpload && <label className="btn-secondary btn-sm cursor-pointer">{tr('Subir imagen', 'Upload image')}<input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f, i); e.target.value = '' }} /></label>}
      </div>
      case 'signature': return <div className="grid gap-2 sm:grid-cols-2">
        <input value={b.name ?? ''} placeholder={tr('Nombre (por defecto: el de identidad)', 'Name (default: from identity)')} aria-label={tr('Nombre', 'Name')} className="field" onChange={(e) => change(i, { ...b, name: e.target.value || undefined })} />
        <input value={b.title ?? ''} placeholder={tr('Cargo', 'Title')} aria-label={tr('Cargo', 'Title')} className="field" onChange={(e) => change(i, { ...b, title: e.target.value || undefined })} />
        <input value={b.label ?? ''} placeholder={tr('Leyenda (p. ej. «Aceptado por el cliente»)', 'Caption (e.g. "Accepted by the client")')} aria-label={tr('Leyenda', 'Caption')} className="field" onFocus={(e) => track(e.currentTarget, (v) => change(i, { ...b, label: v }))} onChange={(e) => change(i, { ...b, label: e.target.value || undefined })} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><label className="flex items-center gap-1"><input type="checkbox" checked={!!b.withImage} onChange={(e) => change(i, { ...b, withImage: e.target.checked })} /> {tr('Con la firma de la empresa', 'With the company signature')}</label>{alignSel(i, b)}</div>
      </div>
      case 'stamp': return <div className="flex items-center gap-2 text-xs text-muted">{alignSel(i, b)} {tr('El sello se configura en Identidad.', 'The stamp is set in Identity.')}</div>
      case 'spacer': return <label className="flex items-center gap-2 text-xs text-muted">{tr('Alto (mm)', 'Height (mm)')} <input type="number" min={1} max={100} value={b.size} onChange={(e) => change(i, { ...b, size: Number(e.target.value) || 1 })} className="field w-24 px-2 py-1" /></label>
      case 'items': case 'totals': case 'payments': case 'statement': case 'bill': case 'aging': return <p className="text-xs text-muted">{DATA_HELP[p.locale][b.type]}</p>
      default: return null
    }
  }

  const pg = { ...PAGE_DEFAULTS, ...page }
  const status = pending ? tr('Guardando…', 'Saving…') : !state.ok ? studioMessage(state.error, p.locale) : dirty ? tr('Cambios sin guardar', 'Unsaved changes') : state.at ? tr('Guardado', 'Saved') : ''
  return (
    <div className="space-y-4">
      <form ref={formRef} action={formAction} onSubmit={() => setSubmitted(edits)} className="card flex flex-col gap-2 p-3 sm:sticky sm:top-0 sm:z-20 sm:flex-row sm:items-end sm:gap-3">
        <input type="hidden" name="id" value={p.id} /><input type="hidden" name="version" value={version} />
        <input type="hidden" name="content" value={JSON.stringify(content)} /><input type="hidden" name="page" value={JSON.stringify(page)} />
        <label className="min-w-0 flex-1 text-sm"><span className="field-label">{p.mode === 'template' ? tr('Nombre de la plantilla', 'Template name') : tr('Título', 'Title')}</span>
          <input name="title" value={title} maxLength={p.mode === 'template' ? 120 : 160} required className="field" onChange={(e) => { setTitle(e.target.value); setDirty(true) }} /></label>
        <div className="flex items-end gap-2 sm:gap-3">
          {p.mode === 'document' && <label className="min-w-0 flex-1 text-sm sm:w-40 sm:flex-none"><span className="field-label">{tr('Carpeta', 'Folder')}</span><input name="folder" value={folder} maxLength={60} className="field" onChange={(e) => { setFolder(e.target.value); setDirty(true) }} /></label>}
          <button type="submit" disabled={pending} className="btn-primary shrink-0">{tr('Guardar', 'Save')}</button>
        </div>
        <span role="status" aria-live="polite" className={`text-xs sm:self-center ${!state.ok ? 'text-red-300' : dirty ? 'text-amber-300' : 'text-muted'}`}>{status}</span>
      </form>

      <div className="flex gap-2 lg:hidden" role="tablist" aria-label={tr('Vista', 'View')}>
        {(['edit', 'preview'] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
          className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${tab === t ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300'}`}>{t === 'edit' ? tr('Editar', 'Edit') : tr('Vista previa', 'Preview')}</button>)}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label={tr('Contenido', 'Content')} className={`min-w-0 space-y-3 ${tab === 'preview' ? 'hidden lg:block' : ''}`}>
          <div className="card sticky top-0 z-10 flex flex-wrap items-end gap-2 p-3 sm:static" data-testid="studio-toolbar">
            <label className="text-sm"><span className="field-label">{tr('Añadir bloque', 'Add block')}</span>
              <select value={addType} onChange={(e) => setAddType(e.target.value as Block['type'])} className="field w-auto">{BLOCK_TYPES.map((t) => <option key={t} value={t}>{LABELS[p.locale][t]}</option>)}</select></label>
            <button type="button" onClick={add} className="btn-secondary">{tr('Añadir', 'Add')}{selected !== null ? tr(' debajo', ' below') : ''}</button>
            <label className="text-sm"><span className="field-label">{tr('Insertar campo', 'Insert field')}</span>
              <select value="" onChange={(e) => { if (e.target.value) insertField(e.target.value) }} className="field w-auto">
                <option value="">{tr('Elegir dato…', 'Choose data…')}</option>
                {FIELDS.map((g) => <optgroup key={g.group.es} label={es ? g.group.es : g.group.en}>{g.fields.map((f) => <option key={f.path} value={f.path}>{es ? f.es : f.en}</option>)}</optgroup>)}
              </select></label>
            <span className="flex flex-wrap items-center gap-1" role="group" aria-label={tr('Formato del texto seleccionado', 'Format the selected text')} data-testid="studio-format">
              {/* onMouseDown prevents the field from losing its selection; touch devices keep it (selectionStart/End persist) */}
              <button type="button" className="btn-secondary btn-sm min-h-10 min-w-10 font-bold" onMouseDown={(e) => e.preventDefault()} onClick={() => format('**')} aria-label={tr('Negrita', 'Bold')}>B</button>
              <button type="button" className="btn-secondary btn-sm min-h-10 min-w-10 italic" onMouseDown={(e) => e.preventDefault()} onClick={() => format('__')} aria-label={tr('Cursiva', 'Italic')}>I</button>
              <button type="button" className="btn-secondary btn-sm min-h-10 min-w-10 underline" onMouseDown={(e) => e.preventDefault()} onClick={() => span({ u: true })} aria-label={tr('Subrayado', 'Underline')}>U</button>
              <button type="button" className="btn-secondary btn-sm min-h-10 min-w-10 line-through" onMouseDown={(e) => e.preventDefault()} onClick={() => span({ x: true })} aria-label={tr('Tachado', 'Strike-through')}>S</button>
              <span className="flex items-center gap-1 rounded-lg border border-line px-1">
                <input type="color" value={inkColor} onChange={(e) => setInkColor(e.target.value.toUpperCase())} className="h-8 w-8 cursor-pointer bg-transparent" aria-label={tr('Color del texto', 'Text colour')} />
                <button type="button" className="btn-secondary btn-sm min-h-10" onMouseDown={(e) => e.preventDefault()} onClick={() => span({ c: inkColor })} style={{ color: inkColor }}>{tr('Color', 'Colour')}</button>
              </span>
              <span className="flex items-center gap-1 rounded-lg border border-line px-1">
                <input type="color" value={markColor} onChange={(e) => setMarkColor(e.target.value.toUpperCase())} className="h-8 w-8 cursor-pointer bg-transparent" aria-label={tr('Color de resaltado', 'Highlight colour')} />
                <button type="button" className="btn-secondary btn-sm min-h-10" onMouseDown={(e) => e.preventDefault()} onClick={() => span({ h: markColor })}>{tr('Resaltar', 'Highlight')}</button>
              </span>
              <select value="" onChange={(e) => { if (e.target.value) span({ s: Number(e.target.value) }) }} className="field w-auto min-h-10 py-1 text-xs" aria-label={tr('Tamaño de las palabras', 'Size of the words')}>
                <option value="">{tr('Tamaño…', 'Size…')}</option>{[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36].map((n) => <option key={n} value={n}>{n} pt</option>)}</select>
              <select value="" onChange={(e) => { if (e.target.value) span({ f: e.target.value as Family }) }} className="field w-auto min-h-10 py-1 text-xs" aria-label={tr('Tipografía de las palabras', 'Typeface of the words')}>
                <option value="">{tr('Tipografía…', 'Typeface…')}</option>{(p.families ?? FAMILIES).map((f) => <option key={f} value={f}>{FAMILY_INFO[f].label}</option>)}</select>
              <button type="button" className="btn-secondary btn-sm min-h-10" onMouseDown={(e) => e.preventDefault()} onClick={() => editSel(clearFormatting)} aria-label={tr('Quitar formato', 'Clear formatting')}>⌫ {tr('Formato', 'Format')}</button>
            </span>
            {uploadMsg && <span role="status" className="text-xs text-muted">{uploadMsg}</span>}
          </div>
          <ol className="space-y-2">
            {blocks.map((b, i) => (
              <li key={i} className={`card min-w-0 p-3 ${selected === i ? 'ring-1 ring-electric/60' : ''}`} onFocusCapture={() => setSelected(i)}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-blue-300">{LABELS[p.locale][b.type]}</span>
                  <span className="flex gap-1">
                    <button type="button" className="btn-secondary btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={tr('Subir bloque', 'Move block up')}>↑</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} aria-label={tr('Bajar bloque', 'Move block down')}>↓</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => duplicate(i)} aria-label={tr('Duplicar bloque', 'Duplicate block')}>⧉</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => remove(i)} aria-label={tr('Eliminar bloque', 'Delete block')}>✕</button>
                  </span>
                </div>
                {body(b, i)}
              </li>
            ))}
          </ol>
          {blocks.length === 0 && <p className="card p-4 text-sm text-muted">{tr('Documento vacío: añade un bloque.', 'Empty document: add a block.')}</p>}

          <details className="card p-3">
            <summary className="cursor-pointer text-sm font-semibold text-fg">{tr('Página y tipografía', 'Page and typography')}</summary>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-sm"><span className="field-label">{tr('Tamaño', 'Size')}</span><select value={pg.size} onChange={(e) => setPg({ size: e.target.value as 'letter' })} className="field"><option value="letter">Carta / Letter</option><option value="a4">A4</option><option value="legal">Legal</option></select></label>
              <label className="text-sm"><span className="field-label">{tr('Orientación', 'Orientation')}</span><select value={pg.orientation} onChange={(e) => setPg({ orientation: e.target.value as 'portrait' })} className="field"><option value="portrait">{tr('Vertical', 'Portrait')}</option><option value="landscape">{tr('Horizontal', 'Landscape')}</option></select></label>
              <label className="text-sm"><span className="field-label">{tr('Tipografía', 'Typeface')}</span><select value={pg.font} onChange={(e) => setPg({ font: e.target.value as Family })} className="field" data-testid="studio-page-font">{(p.families ?? FAMILIES).map((f) => <option key={f} value={f}>{FAMILY_INFO[f].label}{f === 'sans' ? ' (Arial)' : f === 'serif' ? ' (Times)' : ''}</option>)}</select></label>
              <label className="text-sm"><span className="field-label">{tr('Cuerpo (pt)', 'Body (pt)')}</span><input type="number" min={8} max={16} step={0.5} value={pg.fontSize} onChange={(e) => setPg({ fontSize: Number(e.target.value) })} className="field" /></label>
              <label className="text-sm"><span className="field-label">{tr('Color de acento', 'Accent colour')}</span>
                <input type="color" value={page.accent ?? p.brand.accent_color ?? p.accentFallback ?? '#1D4ED8'} onChange={(e) => setPg({ accent: e.target.value })} className="field h-10 p-1" aria-label={tr('Color de acento del documento', 'Document accent colour')} /></label>
              <label className="text-sm"><span className="field-label">{tr('Interlineado', 'Line spacing')}</span><input type="number" min={1} max={2.2} step={0.05} value={pg.lineHeight} onChange={(e) => setPg({ lineHeight: Number(e.target.value) })} className="field" /></label>
              {(['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const).map((k) => (
                <label key={k} className="text-sm"><span className="field-label">{({ marginTop: tr('Margen sup.', 'Top margin'), marginRight: tr('Margen der.', 'Right margin'), marginBottom: tr('Margen inf.', 'Bottom margin'), marginLeft: tr('Margen izq.', 'Left margin') })[k]} (mm)</span>
                  <input type="number" min={8} max={50} value={pg[k]} onChange={(e) => setPg({ [k]: Number(e.target.value) })} className="field" /></label>))}
            </div>
          </details>
        </section>

        <section aria-label={tr('Vista previa', 'Preview')} className={`min-w-0 ${tab === 'edit' ? 'hidden lg:block' : ''}`}>
          <div className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
            <p className="mb-2 text-xs text-muted">{tr(`Vista exacta del PDF · ${layoutInfo.pages} página(s)`, `Exact PDF view · ${layoutInfo.pages} page(s)`)}
              {layoutInfo.missing.length > 0 && <span className="ml-2 text-red-300">{tr('Faltan datos: ', 'Missing data: ')}{layoutInfo.missing.join(', ')}</span>}</p>
            <StudioPreview content={content} page={page} brand={p.brand} accentFallback={p.accentFallback} data={p.data} locale={p.locale} currency={p.currency} images={images} kind={p.kind} title={title} onLayout={onLayout} />
          </div>
        </section>
      </div>
    </div>
  )
}
