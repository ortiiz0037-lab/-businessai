'use client'
/**
 * The BusinessAI register: search by name / SKU / barcode (USB / Bluetooth HID scanners, camera,
 * typing), cart with variants and quantities, discounts (approval above the company limit), client,
 * split payments (cash with change, ATH Móvil, card on a stand-alone terminal, check, transfer).
 * Amounts shown here come from the same pricing rules as the database; the database prices the sale
 * again from the catalog and is the only source of the stored amounts. No card is processed here.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ScanInput, type ScanCopy } from '@/components/inventory/scan-input'
import { posCreateSale, posSearch, type ProductHit } from '@/app/actions/pos'
import { priceCart, quickCash, PricingError } from '@/lib/pos/pricing'
import { decimalToCents } from '@/lib/pos/money'

export type RegisterCopy = Record<string, string>
type Line = { key: string; hit: ProductHit; qty: string; discountPct: string }
type Pay = { id: number; method: string; amount: string; tendered: string; reference: string; last4: string }
const METHODS = ['cash', 'ath_movil', 'card_external', 'check', 'transfer', 'other'] as const
const NEEDS_REF = ['ath_movil', 'card_external', 'check', 'transfer']

function fmt(c: bigint, locale: string) {
  const neg = c < 0n, a = neg ? -c : c
  return `${neg ? '−' : ''}$${(a / 100n).toLocaleString(locale === 'en' ? 'en-US' : 'es-PR')}.${(a % 100n).toString().padStart(2, '0')}`
}
const newIdem = () => `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export function Register({ locale, copy, scan, branchId, registerId, shiftId, clients, maxDiscountPct, methodLabels, errors }: {
  locale: 'es' | 'en'; copy: RegisterCopy; scan: ScanCopy; branchId: string; registerId: string; shiftId: string | null
  clients: { id: string; name: string }[]; maxDiscountPct: number; methodLabels: Record<string, string>; errors: Record<string, string>
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ProductHit[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [cartPct, setCartPct] = useState('')
  const [reason, setReason] = useState('')
  const [code, setCode] = useState('')
  const [client, setClient] = useState('')
  const [pays, setPays] = useState<Pay[]>([{ id: 1, method: 'cash', amount: '', tendered: '', reference: '', last4: '' }])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string; saleId?: string } | null>(null)
  const [needApproval, setNeedApproval] = useState(false)
  const idem = useRef(newIdem())

  const priced = useMemo(() => {
    try {
      return priceCart(lines.map((l) => ({ key: l.key, name: l.hit.name, qty: l.qty, unitCents: BigInt(l.hit.priceCents), taxRate: l.hit.taxRate,
        discountPct: l.discountPct ? l.discountPct : undefined })), cartPct ? { pct: cartPct } : {})
    } catch (e) { return e instanceof PricingError ? null : null }
  }, [lines, cartPct])
  const total = priced?.total ?? 0n
  const paidCents = pays.reduce((s, p) => s + (decimalToCents(p.amount || '0') ?? 0n), 0n)
  const remaining = total - paidCents
  const overLimit = (priced?.discountPct ?? 0) > maxDiscountPct

  const add = useCallback((h: ProductHit) => {
    setMsg(null)
    setLines((ls) => {
      const key = `${h.item}|${h.variant ?? ''}`
      const i = ls.findIndex((l) => l.key === key)
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, qty: String(Number(l.qty) + 1) } : l))
      return [...ls, { key, hit: h, qty: '1', discountPct: '' }]
    })
    idem.current = newIdem()
  }, [])

  const search = useCallback(async (q: string, fromScan: boolean) => {
    if (!q.trim()) { setHits([]); return }
    const r = await posSearch(q, branchId)
    if (fromScan && r.length === 1) { add(r[0]); setHits([]); return }
    setHits(r)
    if (!r.length) setMsg({ tone: 'err', text: copy.notFound })
  }, [add, branchId, copy.notFound])

  function setQty(key: string, delta: number) {
    setLines((ls) => ls.flatMap((l) => (l.key !== key ? [l] : Number(l.qty) + delta <= 0 ? [] : [{ ...l, qty: String(Number(l.qty) + delta) }])))
    idem.current = newIdem()
  }
  function setPay(id: number, patch: Partial<Pay>) { setPays((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p))); idem.current = newIdem() }

  async function charge() {
    if (!priced || !lines.length) return
    setBusy(true); setMsg(null)
    const payments = total === 0n ? [] : pays.filter((p) => p.amount).map((p) => ({ method: p.method, amount_cents: String(decimalToCents(p.amount) ?? 0n),
      tendered_cents: p.method === 'cash' && p.tendered ? String(decimalToCents(p.tendered) ?? '') : null, reference: p.reference || null, card_last4: p.last4 || null }))
    const r = await posCreateSale({ branch: branchId, register: registerId, shift: shiftId, client: client || null, cartPct: cartPct || null, discountReason: reason || null,
      approvalCode: code || null, note: null, idem: idem.current,
      lines: lines.map((l) => ({ item: l.hit.item, variant: l.hit.variant, qty: l.qty, ...(l.discountPct ? { discount_pct: l.discountPct } : {}) })), payments })
    setBusy(false)
    if (!r.ok) {
      if (r.error === 'pos_approval_required') setNeedApproval(true)
      setMsg({ tone: 'err', text: errors[r.error] ?? errors.save })
      return
    }
    setMsg({ tone: 'ok', text: `${copy.sold} ${r.number}${BigInt(r.changeCents) > 0n ? ` · ${copy.change} ${fmt(BigInt(r.changeCents), locale)}` : ''}`, saleId: r.id })
    setLines([]); setCartPct(''); setReason(''); setCode(''); setClient(''); setNeedApproval(false)
    setPays([{ id: Date.now(), method: 'cash', amount: '', tendered: '', reference: '', last4: '' }])
    idem.current = newIdem()
  }

  const cashPay = pays.find((p) => p.method === 'cash')
  const change = cashPay && cashPay.tendered ? (decimalToCents(cashPay.tendered) ?? 0n) - (decimalToCents(cashPay.amount || '0') ?? 0n) : null

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]" data-testid="pos-register">
      <section className="card min-w-0 space-y-4 p-4 sm:p-5" aria-label={copy.products}>
        <ScanInput copy={scan} busy={busy} allowRepeat onCode={(c) => { void search(c, true) }} />
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(query, false) }}>
          <label className="sr-only" htmlFor="pos-q">{copy.searchName}</label>
          <input id="pos-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.searchName} className="field min-w-0 flex-1" data-testid="pos-search" />
          <button className="btn-secondary min-h-11 shrink-0">{copy.search}</button>
        </form>
        {hits.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" data-testid="pos-hits">
            {hits.map((h) => (
              <li key={`${h.item}${h.variant}`}>
                <button type="button" onClick={() => add(h)} className="flex h-full min-h-20 w-full flex-col items-start justify-between rounded-xl border border-line bg-elevated p-3 text-left transition hover:border-electric/60 active:scale-[0.98]">
                  <span className="line-clamp-2 text-sm font-semibold text-fg">{h.name}</span>
                  <span className="mt-1 flex w-full items-end justify-between gap-2 text-xs text-muted">
                    <span className="font-mono">{h.sku}</span>
                    <span className="text-base font-bold text-fg tabular-nums">{fmt(BigInt(h.priceCents), locale)}</span>
                  </span>
                  {h.available !== null && <span className={`text-[11px] ${Number(h.available) > 0 ? 'text-muted' : 'text-amber-300'}`}>{copy.available}: {Number(h.available)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {msg && <p role={msg.tone === 'err' ? 'alert' : 'status'} className={msg.tone === 'err' ? 'alert-danger' : 'alert-info'} data-testid={msg.tone === 'err' ? 'pos-error' : 'pos-sold'}>
          {msg.text}{msg.saleId && <> · <Link className="underline" href={`/pos/sales/${msg.saleId}`}>{copy.receipt}</Link></>}</p>}
      </section>

      <section className="card min-w-0 space-y-4 p-4 sm:p-5 lg:sticky lg:top-4 lg:self-start" aria-label={copy.cart}>
        <h2 className="font-display text-lg font-semibold text-fg">{copy.cart}</h2>
        {lines.length === 0 ? <p className="text-sm text-muted">{copy.empty}</p> : (
          <ul className="divide-y divide-line/60" data-testid="pos-cart">
            {lines.map((l) => {
              const p = priced?.lines.find((x) => x.key === l.key)
              return (
                <li key={l.key} className="py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 text-sm text-fg">{l.hit.name}<span className="block text-xs text-muted">{fmt(BigInt(l.hit.priceCents), locale)} · {copy.tax} {l.hit.taxRate}%</span></span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">{p ? fmt(p.total, locale) : '—'}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" aria-label={copy.less} onClick={() => setQty(l.key, -1)} className="btn-secondary h-11 w-11 p-0 text-lg">−</button>
                    <span className="w-10 text-center font-semibold tabular-nums" data-testid="pos-qty">{l.qty}</span>
                    <button type="button" aria-label={copy.more} onClick={() => setQty(l.key, 1)} className="btn-secondary h-11 w-11 p-0 text-lg">+</button>
                    <label className="ml-auto flex items-center gap-1 text-xs text-muted">{copy.discount} %
                      <input inputMode="decimal" value={l.discountPct} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, discountPct: e.target.value.replace(/[^\d.]/g, '') } : x)))}
                        className="field h-11 w-16 px-2 text-right" /></label>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted">{copy.cartDiscount} %
            <input inputMode="decimal" value={cartPct} onChange={(e) => { setCartPct(e.target.value.replace(/[^\d.]/g, '')); idem.current = newIdem() }} className="field mt-1 h-11 w-full" data-testid="pos-cart-discount" /></label>
          <label className="text-xs text-muted">{copy.client}
            <select value={client} onChange={(e) => setClient(e.target.value)} className="field mt-1 h-11 w-full">
              <option value="">{copy.noClient}</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        {(priced?.discount ?? 0n) > 0n && (
          <div className="space-y-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={copy.discountReason} className="field h-11 w-full" data-testid="pos-discount-reason" />
            {(overLimit || needApproval) && <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder={copy.approvalCode}
              className="field h-11 w-full font-mono tracking-widest" data-testid="pos-approval-code" />}
            {overLimit && <p className="text-xs text-amber-300">{copy.overLimit}</p>}
          </div>
        )}
        <dl className="space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between"><dt className="text-muted">{copy.subtotal}</dt><dd className="tabular-nums">{fmt(priced?.subtotal ?? 0n, locale)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">{copy.discount}</dt><dd className="tabular-nums">−{fmt(priced?.discount ?? 0n, locale)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">{copy.tax}</dt><dd className="tabular-nums">{fmt(priced?.tax ?? 0n, locale)}</dd></div>
          <div className="flex justify-between text-xl font-bold text-fg"><dt>{copy.total}</dt><dd className="tabular-nums" data-testid="pos-total">{fmt(total, locale)}</dd></div>
        </dl>

        {total > 0n && (
          <div className="space-y-3 border-t border-line pt-3">
            <h3 className="text-sm font-semibold text-fg">{copy.payment}</h3>
            {pays.map((p, i) => (
              <div key={p.id} className="space-y-2 rounded-xl border border-line p-3">
                <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={copy.method}>
                  {METHODS.map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={p.method === m} onClick={() => setPay(p.id, { method: m })}
                      className={`min-h-11 rounded-lg border px-2 text-xs font-semibold ${p.method === m ? 'border-electric bg-brand/25 text-fg' : 'border-line bg-elevated text-slate-300'}`}>{methodLabels[m]}</button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <label className="flex-1 text-xs text-muted">{copy.amount}
                    <input inputMode="decimal" value={p.amount} onChange={(e) => setPay(p.id, { amount: e.target.value.replace(/[^\d.]/g, '') })} className="field mt-1 h-11 w-full text-right tabular-nums" data-testid="pos-pay-amount" /></label>
                  <button type="button" className="btn-secondary mt-5 min-h-11 shrink-0" onClick={() => setPay(p.id, { amount: ((remaining + (decimalToCents(p.amount || '0') ?? 0n)) / 100n).toString() + '.' + ((remaining + (decimalToCents(p.amount || '0') ?? 0n)) % 100n).toString().padStart(2, '0') })}
                    data-testid="pos-pay-rest">{copy.rest}</button>
                </div>
                {p.method === 'cash' && (
                  <div className="space-y-2">
                    <label className="block text-xs text-muted">{copy.tendered}
                      <input inputMode="decimal" value={p.tendered} onChange={(e) => setPay(p.id, { tendered: e.target.value.replace(/[^\d.]/g, '') })} className="field mt-1 h-11 w-full text-right" data-testid="pos-tendered" /></label>
                    <div className="flex flex-wrap gap-1.5">{quickCash(decimalToCents(p.amount || '0') ?? 0n).map((q) => (
                      <button key={q.toString()} type="button" className="btn-secondary min-h-11 px-3 text-xs" onClick={() => setPay(p.id, { tendered: `${q / 100n}.${(q % 100n).toString().padStart(2, '0')}` })}>{fmt(q, locale)}</button>))}</div>
                  </div>
                )}
                {NEEDS_REF.includes(p.method) && (
                  <div className="flex gap-2">
                    <input value={p.reference} onChange={(e) => setPay(p.id, { reference: e.target.value })} placeholder={copy.reference} className="field h-11 min-w-0 flex-1" data-testid="pos-reference" />
                    {p.method === 'card_external' && <input inputMode="numeric" value={p.last4} onChange={(e) => setPay(p.id, { last4: e.target.value.replace(/\D/g, '').slice(0, 4) })} placeholder={copy.last4} className="field h-11 w-20" />}
                  </div>
                )}
                {i > 0 && <button type="button" className="text-xs text-red-200 underline" onClick={() => setPays((ps) => ps.filter((x) => x.id !== p.id))}>{copy.removePayment}</button>}
              </div>
            ))}
            <button type="button" className="text-sm text-accent underline" onClick={() => setPays((ps) => [...ps, { id: Date.now(), method: 'ath_movil', amount: '', tendered: '', reference: '', last4: '' }])}>{copy.splitPayment}</button>
            <p className="flex justify-between text-sm"><span className="text-muted">{remaining >= 0n ? copy.remaining : copy.overpaid}</span>
              <span className={`font-semibold tabular-nums ${remaining === 0n ? 'text-green-300' : 'text-amber-300'}`} data-testid="pos-remaining">{fmt(remaining < 0n ? -remaining : remaining, locale)}</span></p>
            {change !== null && change >= 0n && <p className="flex justify-between text-lg font-bold text-fg"><span>{copy.change}</span><span className="tabular-nums" data-testid="pos-change">{fmt(change, locale)}</span></p>}
            <p className="text-[11px] leading-4 text-muted">{copy.cardNote}</p>
          </div>
        )}
        <button type="button" disabled={busy || !lines.length || !priced || (total > 0n && remaining !== 0n)} onClick={charge}
          className="btn-primary min-h-14 w-full text-lg" data-testid="pos-charge">{busy ? copy.charging : `${copy.charge} ${fmt(total, locale)}`}</button>
      </section>
    </div>
  )
}
