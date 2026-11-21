/**
 * Verified figures (replaces "extract numbers from the text").
 *
 * Every tool returns typed data: each field has a declared KIND (money,
 * count, date, hours, percent, text) and the result has metadata (company,
 * currency, period / as_of, completeness, source). Each tool call gets a
 * reference (T1, T2, …). The model never types a figure: it writes a
 * placeholder such as [[T1.sum_balance]] or [[T2.invoices.0.number]] and the
 * SERVER renders the value from the recorded result. The verifier refuses:
 *   - placeholders that do not resolve to a scalar of a declared kind;
 *   - any digit left in the prose that does not come from the user's own
 *     question (or a list marker) — i.e. figures typed by the model.
 * Derived figures come from `calculate`, which operates on references (not
 * on numbers written by the model) with exact integer arithmetic and refuses
 * to mix currencies.
 */
import type { Locale } from '@/lib/i18n/app'
import { formatCents } from '@/lib/finance/money'

export type Kind = 'money' | 'count' | 'date' | 'hours' | 'percent' | 'text'
export type ToolMeta = { source: string; complete: boolean; currency?: string; as_of?: string; from?: string; to?: string; note?: string }
export type ToolOutput = { data: Record<string, unknown>; kinds: Record<string, Kind>; meta: ToolMeta }
export type Fact = { ref: string; tool: string; output: ToolOutput }

export class FactStore {
  private facts: Fact[] = []
  add(tool: string, output: ToolOutput): string {
    const ref = `T${this.facts.length + 1}`
    this.facts.push({ ref, tool, output })
    return ref
  }
  get(ref: string) { return this.facts.find((f) => f.ref === ref) }
  all() { return [...this.facts] }
}

// ------------------------------------------------------------- exact decimals
const DEC = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/
/** '1000.35' → 100035n (exact); null when not a money decimal. */
export function decimalToCents(v: unknown): bigint | null {
  if (typeof v === 'bigint') return null
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : null) : typeof v === 'string' ? v.trim() : null
  if (s === null) return null
  const m = DEC.exec(s)
  if (!m) return null
  const c = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -c : c
}
/** 100035n → '1000.35' */
export function centsToDecimal(c: bigint): string {
  const neg = c < 0n, a = neg ? -c : c
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}
/** minutes → '7.5' hours (one decimal, rounded half up, integer arithmetic) */
export function minutesToHours(min: number): string {
  const tenths = Math.floor((Math.max(0, Math.round(min)) * 10 + 30) / 60)
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}

// ------------------------------------------------------------- resolution and rendering
export type Resolved = { value: unknown; kind: Kind; currency: string | undefined }
export function resolve(store: FactStore, path: string): Resolved | { error: string } {
  const [ref, ...keys] = path.split('.')
  const fact = store.get(ref)
  if (!fact) return { error: `unknown_ref:${ref}` }
  let node: unknown = fact.output.data
  let currency = fact.output.meta.currency
  let leafKey = ''
  for (const k of keys) {
    if (node && typeof node === 'object' && !Array.isArray(node) && typeof (node as Record<string, unknown>).currency === 'string') currency = (node as Record<string, string>).currency
    if (Array.isArray(node) && /^\d+$/.test(k)) node = node[Number(k)]
    else if (node && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, k)) { node = (node as Record<string, unknown>)[k]; leafKey = k }
    else return { error: `unknown_path:${path}` }
  }
  if (node !== null && typeof node === 'object') return { error: `not_a_value:${path}` }
  const declared = fact.output.kinds[leafKey]
  if (declared) return { value: node, kind: declared, currency }
  if (typeof node === 'string' && !/\d/.test(node)) return { value: node, kind: 'text', currency }
  if (node === null || typeof node === 'boolean') return { value: node, kind: 'text', currency }
  return { error: `undeclared_kind:${leafKey}` }
}

const tag = (l: Locale) => (l === 'en' ? 'en-US' : 'es-PR')
export function renderValue(r: Resolved, locale: Locale): string | null {
  const { value, kind } = r
  if (value === null || value === undefined) return '—'
  switch (kind) {
    case 'money': { const c = decimalToCents(value); return c === null ? null : formatCents(c, locale, r.currency ?? 'USD') }
    case 'count': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN
      return Number.isSafeInteger(n) ? new Intl.NumberFormat(tag(locale)).format(n) : null
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
      return new Intl.DateTimeFormat(tag(locale), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
    }
    case 'hours': return typeof value === 'string' && /^\d+\.\d$/.test(value) ? `${locale === 'en' ? value : value.replace('.', ',')} h` : null
    case 'percent': return typeof value === 'string' && /^-?\d+(\.\d)?$/.test(value) ? `${locale === 'en' ? value : value.replace('.', ',')} %` : null
    case 'text': return typeof value === 'boolean' ? (value ? (locale === 'en' ? 'yes' : 'sí') : 'no') : String(value).replace(/\[\[|\]\]|[<>]/g, '').slice(0, 300)
  }
}

// ------------------------------------------------------------- verification
export const PLACEHOLDER = /\[\[\s*(T\d{1,3}(?:\.[A-Za-z0-9_]{1,40}){1,8})\s*\]\]/g
const INTERNAL_PATH = /\/(?:dashboard|clients|documents|receivables|payments|payables|bank|finance|accounting|workforce|studio|billing|settings|assistant)(?:\/[\w\-/]*)?(?:\?[\w=&\-.%]*)?/g
export type Verification = { ok: boolean; rendered: string; violations: string[]; refs: string[] }

export function verifyAndRender(text: string, store: FactStore, opts: { locale: Locale; question: string }): Verification {
  const violations: string[] = []
  const refs: string[] = []
  const rendered = text.replace(PLACEHOLDER, (_m, path: string) => {
    const r = resolve(store, path)
    if ('error' in r) { violations.push(r.error); return '[?]' }
    const v = renderValue(r, opts.locale)
    if (v === null) { violations.push(`bad_value:${path}`); return '[?]' }
    refs.push(path)
    return v
  })
  // prose without placeholders, links and list markers must not contain figures
  const prose = text.replace(PLACEHOLDER, ' ').replace(INTERNAL_PATH, ' ').replace(/^\s*\d{1,2}[.)]\s/gm, ' ')
  const allowed = new Set((opts.question.match(/\d[\d.,:/-]*/g) ?? []).map((s) => s.replace(/[.,:/-]+$/, '')))
  for (const tok of prose.match(/\d[\d.,:/-]*/g) ?? []) {
    const t = tok.replace(/[.,:/-]+$/, '')
    if (!allowed.has(t)) violations.push(`unsourced_figure:${t}`)
  }
  if (/\[\[/.test(rendered)) violations.push('malformed_placeholder')
  return { ok: violations.length === 0, rendered, violations: [...new Set(violations)].slice(0, 20), refs: [...new Set(refs)] }
}

// ------------------------------------------------------------- calculate
export type CalcOp = 'sum' | 'difference' | 'percent_of' | 'percent_change'
export function calculate(store: FactStore, op: CalcOp, paths: string[]): ToolOutput {
  const vals = paths.map((p) => ({ p, r: resolve(store, p) }))
  const bad = vals.find((v) => 'error' in v.r)
  if (bad) throw new Error(`calc:${(bad.r as { error: string }).error}`)
  const rs = vals.map((v) => v.r as Resolved)
  const kinds = new Set(rs.map((r) => r.kind))
  if (kinds.size !== 1 || !(kinds.has('money') || kinds.has('count'))) throw new Error('calc:operands_must_share_kind_money_or_count')
  const kind = [...kinds][0]
  const currencies = new Set(rs.map((r) => r.currency ?? 'USD'))
  if (kind === 'money' && currencies.size > 1) throw new Error('calc:mixed_currencies')
  const ints = rs.map((r) => (kind === 'money' ? decimalToCents(r.value) : typeof r.value === 'number' && Number.isSafeInteger(r.value) ? BigInt(r.value) : typeof r.value === 'string' && /^-?\d+$/.test(r.value) ? BigInt(r.value) : null))
  if (ints.some((x) => x === null)) throw new Error('calc:not_numeric')
  const n = ints as bigint[]
  const asValue = (x: bigint) => (kind === 'money' ? centsToDecimal(x) : x.toString())
  const pct = (num: bigint, den: bigint) => {
    if (den === 0n) throw new Error('calc:division_by_zero')
    const tenths = (num * 1000n + (num >= 0n === den >= 0n ? den / 2n : -den / 2n)) / den   // one decimal, half away from zero
    const neg = tenths < 0n, a = neg ? -tenths : tenths
    return `${neg ? '-' : ''}${a / 10n}.${a % 10n}`
  }
  let data: Record<string, unknown>
  let k: Kind
  switch (op) {
    case 'sum': data = { result: asValue(n.reduce((s, x) => s + x, 0n)) }; k = kind; break
    case 'difference': if (n.length !== 2) throw new Error('calc:needs_two'); data = { result: asValue(n[0] - n[1]) }; k = kind; break
    case 'percent_of': if (n.length !== 2) throw new Error('calc:needs_two'); data = { result: pct(n[0], n[1]) }; k = 'percent'; break
    case 'percent_change': if (n.length !== 2) throw new Error('calc:needs_two'); data = { result: pct(n[1] - n[0], n[0]) }; k = 'percent'; break
  }
  return { data: { ...data, operation: op, operands: paths }, kinds: { result: k }, meta: { source: 'calculate', complete: true, currency: kind === 'money' ? [...currencies][0] : undefined } }
}

// ------------------------------------------------------------- fallback (verification failed twice)
const LABELS: Record<string, [string, string]> = {
  total_matching: ['Registros', 'Records'], shown: ['Mostrados', 'Shown'], sum_balance: ['Saldo total', 'Total balance'], open_invoices: ['Facturas abiertas', 'Open invoices'],
  open_balance: ['Saldo abierto', 'Open balance'], overdue_invoices: ['Facturas vencidas', 'Overdue invoices'], overdue_balance: ['Saldo vencido', 'Overdue balance'],
  invoices: ['Facturas', 'Invoices'], payments: ['Pagos', 'Payments'], total: ['Total', 'Total'], net_income: ['Utilidad neta', 'Net income'], result: ['Resultado', 'Result'],
  as_of: ['Al', 'As of'], from: ['Desde', 'From'], to: ['Hasta', 'To'], number: ['Número', 'Number'], balance: ['Saldo', 'Balance'], name: ['Nombre', 'Name'],
}
export function fallbackText(store: FactStore, locale: Locale, intro: string): string {
  const en = locale === 'en'
  const lines: string[] = [intro]
  for (const f of store.all()) {
    if (f.tool === 'calculate') continue
    lines.push('', `**${f.tool}** (${f.output.meta.source}${f.output.meta.complete ? '' : en ? ', incomplete' : ', incompleto'})`)
    for (const [k, v] of Object.entries(f.output.data)) {
      if (v === null || typeof v === 'object') continue
      const r = resolve(store, `${f.ref}.${k}`)
      if ('error' in r) continue
      const val = renderValue(r, locale)
      if (val !== null) lines.push(`- ${(LABELS[k]?.[en ? 1 : 0]) ?? k.replace(/_/g, ' ')}: ${val}`)
    }
  }
  return lines.join('\n')
}
