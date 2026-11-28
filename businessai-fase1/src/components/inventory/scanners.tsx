'use client'
import Link from 'next/link'
import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { countRecord, lookupCode, type LookupResult } from '@/app/actions/inventory'
import { ScanInput, type ScanCopy } from '@/components/inventory/scan-input'

type Msg = { tone: 'ok' | 'warn' | 'error'; text: string }
const tone = (t: Msg['tone']) => (t === 'ok' ? 'border-green-400/40 bg-green-400/10 text-green-100' : t === 'warn' ? 'border-amber-400/40 bg-amber-400/10 text-amber-100' : 'border-red-400/40 bg-red-400/10 text-red-100')
const keyOf = (r: Extract<LookupResult, { ok: true }>) => `${r.item}|${r.variant ?? ''}`
const nameOf = (r: Extract<LookupResult, { ok: true }>) => `${r.name}${Object.keys(r.attributes).length ? ` · ${Object.values(r.attributes).join(' / ')}` : ''}`

/** Scan page: a code → the product, at once; unknown codes are said so (and can be assigned in the catalog). */
export function ScanLookup({ copy, labels, canAssign }: { copy: ScanCopy; canAssign: boolean
  labels: { unknown: string; notTracked: string; archived: string; open: string; assign: string; matched: Record<string, string>; history: string; errors: Record<string, string> } }) {
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState<{ code: string; r: LookupResult; at: number }[]>([])
  const onCode = useCallback(async (code: string) => {
    setBusy(true)
    const r = await lookupCode(code)
    setItems((prev) => [{ code, r, at: Date.now() }, ...prev].slice(0, 15))
    setBusy(false)
  }, [])
  const last = items[0]
  return (
    <div className="space-y-4">
      <ScanInput onCode={onCode} copy={copy} busy={busy} />
      {last && (last.r.ok ? (
        <div className={`rounded-xl border p-4 ${tone(last.r.tracked && last.r.status === 'active' ? 'ok' : 'warn')}`} role="status" data-testid="scan-result" data-found="yes">
          <p className="font-semibold">{nameOf(last.r)}</p>
          <p className="text-xs opacity-80">{last.r.sku} · {labels.matched[last.r.matched_by] ?? last.r.matched_by}{!last.r.tracked ? ` · ${labels.notTracked}` : ''}{last.r.status !== 'active' ? ` · ${labels.archived}` : ''}</p>
          <Link href={`/inventory/items/${last.r.item}${last.r.variant ? `?variant=${last.r.variant}` : ''}`} className="mt-2 inline-block text-sm font-semibold underline">{labels.open}</Link>
        </div>
      ) : (
        <div className={`rounded-xl border p-4 ${tone('error')}`} role="alert" data-testid="scan-result" data-found="no">
          <p className="font-semibold">{last.code}</p>
          <p className="text-sm">{labels.errors[last.r.error] ?? labels.unknown}</p>
          {canAssign && last.r.error === 'unknown_code' && <Link href={`/catalog?code=${encodeURIComponent(last.code)}`} className="mt-2 inline-block text-sm font-semibold underline">{labels.assign}</Link>}
        </div>
      ))}
      {items.length > 1 && (
        <section aria-label={labels.history}>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{labels.history}</h2>
          <ul className="mt-2 divide-y divide-line/60 text-sm">{items.slice(1).map((i) => (
            <li key={i.at} className="flex justify-between gap-2 py-1.5"><span className="truncate font-mono text-xs">{i.code}</span><span className="truncate text-muted">{i.r.ok ? nameOf(i.r) : labels.unknown}</span></li>))}</ul>
        </section>
      )}
    </div>
  )
}

/** Physical count by scanning: each read adds one; the totals come back from the database. */
export function CountScanner({ countId, copy, labels }: { countId: string; copy: ScanCopy; labels: { added: string; unknown: string; notTracked: string; errors: Record<string, string> } }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const router = useRouter()
  const onCode = useCallback(async (code: string) => {
    setBusy(true)
    const r = await lookupCode(code)
    if (!r.ok) { setMsg({ tone: 'error', text: `${code}: ${labels.errors[r.error] ?? labels.unknown}` }); setBusy(false); return }
    if (!r.tracked) { setMsg({ tone: 'warn', text: `${nameOf(r)}: ${labels.notTracked}` }); setBusy(false); return }
    const c = await countRecord({ count: countId, item: r.item, variant: r.variant, qty: 1, mode: 'add' })
    setMsg(c.ok ? { tone: 'ok', text: labels.added.replace('{name}', nameOf(r)).replace('{n}', String(c.counted)) } : { tone: 'error', text: labels.errors[c.error] ?? labels.errors.save })
    setBusy(false)
    router.refresh()
  }, [countId, labels, router])
  return (
    <div className="space-y-3">
      <ScanInput onCode={onCode} copy={copy} busy={busy} allowRepeat />
      {msg && <p className={`rounded-xl border p-3 text-sm ${tone(msg.tone)}`} role={msg.tone === 'error' ? 'alert' : 'status'} data-testid="count-scan-msg">{msg.text}</p>}
    </div>
  )
}

/**
 * Receiving / preparing by scanning: each read adds one to the quantity field of that product in
 * the form below (fields carry data-scan-key="item|variant"). Codes not in the document are reported.
 */
export function ScanIntoForm({ formId, copy, labels }: { formId: string; copy: ScanCopy; labels: { added: string; notInDocument: string; unknown: string; errors: Record<string, string> } }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const onCode = useCallback(async (code: string) => {
    setBusy(true)
    const r = await lookupCode(code)
    setBusy(false)
    if (!r.ok) { setMsg({ tone: 'error', text: `${code}: ${labels.errors[r.error] ?? labels.unknown}` }); return }
    const field = document.getElementById(formId)?.querySelector<HTMLInputElement>(`input[data-scan-key="${keyOf(r)}"]`)
    if (!field) { setMsg({ tone: 'warn', text: `${nameOf(r)}: ${labels.notInDocument}` }); return }
    const max = field.max ? Number(field.max) : Infinity
    const next = Math.min(max, (Number(field.value.replace(',', '.')) || 0) + 1)
    field.value = String(next)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.classList.add('ring-2', 'ring-electric'); setTimeout(() => field.classList.remove('ring-2', 'ring-electric'), 600)
    setMsg({ tone: next >= max ? 'warn' : 'ok', text: labels.added.replace('{name}', nameOf(r)).replace('{n}', String(next)) })
  }, [formId, labels])
  return (
    <div className="space-y-3">
      <ScanInput onCode={onCode} copy={copy} busy={busy} allowRepeat autoFocus={false} />
      {msg && <p className={`rounded-xl border p-3 text-sm ${tone(msg.tone)}`} role={msg.tone === 'error' ? 'alert' : 'status'} data-testid="scan-form-msg">{msg.text}</p>}
    </div>
  )
}

export type LineOption = { value: string; label: string; cost?: string }
/** Editable product lines (select + quantity [+ cost]); scanning adds or increments a line. */
export function LineEditor({ options, withCost, copy, labels, initial }: { options: LineOption[]; withCost?: boolean; copy: ScanCopy; initial?: { value: string; qty: string; cost?: string }[]
  labels: { product: string; qty: string; cost: string; add: string; remove: string; unknown: string; notTracked: string; choose: string; errors: Record<string, string> } }) {
  const [rows, setRows] = useState<{ id: number; value: string; qty: string; cost: string }[]>(
    initial?.length ? initial.map((r, i) => ({ id: i, value: r.value, qty: r.qty, cost: r.cost ?? '' })) : [{ id: 0, value: '', qty: '', cost: '' }])
  const [msg, setMsg] = useState<Msg | null>(null)
  const [busy, setBusy] = useState(false)
  const costOf = (v: string) => options.find((o) => o.value === v)?.cost ?? ''
  const onCode = useCallback(async (code: string) => {
    setBusy(true)
    const r = await lookupCode(code)
    setBusy(false)
    if (!r.ok) { setMsg({ tone: 'error', text: `${code}: ${labels.errors[r.error] ?? labels.unknown}` }); return }
    const key = keyOf(r)
    if (!options.some((o) => o.value === key)) { setMsg({ tone: 'warn', text: `${nameOf(r)}: ${labels.notTracked}` }); return }
    setRows((prev) => {
      const i = prev.findIndex((x) => x.value === key)
      if (i >= 0) return prev.map((x, j) => (j === i ? { ...x, qty: String((Number(x.qty) || 0) + 1) } : x))
      const empty = prev.findIndex((x) => !x.value)
      const row = { id: Date.now(), value: key, qty: '1', cost: costOf(key) }
      return empty >= 0 ? prev.map((x, j) => (j === empty ? { ...row, id: x.id } : x)) : [...prev, row]
    })
    setMsg({ tone: 'ok', text: nameOf(r) })
  }, [options, labels]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-3" data-testid="line-editor">
      <ScanInput onCode={onCode} copy={copy} busy={busy} allowRepeat autoFocus={false} />
      {msg && <p className={`rounded-xl border p-2 text-xs ${tone(msg.tone)}`} role="status">{msg.text}</p>}
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.id} className={`grid grid-cols-1 gap-2 ${withCost ? 'sm:grid-cols-[minmax(0,1fr)_7rem_8rem_auto]' : 'sm:grid-cols-[minmax(0,1fr)_7rem_auto]'}`} data-testid="line-row">
            <label className="sr-only" htmlFor={`line-${r.id}`}>{labels.product} {i + 1}</label>
            <select id={`line-${r.id}`} name="line" value={r.value} className="field min-w-0"
              onChange={(e) => { const v = e.target.value; setRows((p) => p.map((x) => (x.id === r.id ? { ...x, value: v, cost: x.cost || costOf(v) } : x))) }}>
              <option value="">{labels.choose}</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <label className="sr-only" htmlFor={`qty-${r.id}`}>{labels.qty} {i + 1}</label>
            <input id={`qty-${r.id}`} name="qty" inputMode="decimal" placeholder={labels.qty} value={r.qty} className="field"
              onChange={(e) => { const v = e.target.value; setRows((p) => p.map((x) => (x.id === r.id ? { ...x, qty: v } : x))) }} />
            {withCost && <>
              <label className="sr-only" htmlFor={`cost-${r.id}`}>{labels.cost} {i + 1}</label>
              <input id={`cost-${r.id}`} name="cost" inputMode="decimal" placeholder={labels.cost} value={r.cost} className="field"
                onChange={(e) => { const v = e.target.value; setRows((p) => p.map((x) => (x.id === r.id ? { ...x, cost: v } : x))) }} />
            </>}
            <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((p) => (p.length > 1 ? p.filter((x) => x.id !== r.id) : [{ id: Date.now(), value: '', qty: '', cost: '' }]))}>{labels.remove}</button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((p) => [...p, { id: Date.now(), value: '', qty: '', cost: '' }])}>{labels.add}</button>
    </div>
  )
}
