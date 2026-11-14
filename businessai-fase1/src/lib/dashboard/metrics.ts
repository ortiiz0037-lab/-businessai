/**
 * Executive dashboard metrics, computed ONLY from the company's own rows
 * (read through RLS). Pure functions: no I/O, no invented values. When there
 * is no data the numbers are 0 and `hasData` is false, so the page shows an
 * empty state instead of a chart.
 *
 * Definitions (documented in docs/DASHBOARD.md):
 *   invoice      document_type 'invoice', status not draft/cancelled
 *   paid         sum of the payments recorded against the document
 *   outstanding  max(total − paid, 0); 0 when the invoice is marked paid
 *   overdue      outstanding > 0 and (status 'overdue' or due_date < today)
 *   due soon     outstanding > 0, not overdue, due within the next 7 days
 *   collected    payments by payment date (paid_at, else created_at)
 *   invoiced     invoices by issue date
 *   open quote   quote with status 'sent'; stale when issued > 14 days ago
 * Dates are bucketed in the company's time zone (default Puerto Rico).
 */

export const DEFAULT_TIME_ZONE = 'America/Puerto_Rico'
export const DUE_SOON_DAYS = 7
export const STALE_QUOTE_DAYS = 14

export type DashDocument = {
  id: string
  client_id: string | null
  document_type: string | null
  document_number: string | null
  title: string | null
  status: string | null
  total: number | string | null
  issue_date: string | null
  due_date: string | null
  created_at: string | null
}
export type DashPayment = {
  id: string
  document_id: string | null
  amount: number | string | null
  paid_at: string | null
  created_at: string | null
}
export type DashClient = { id: string; name: string | null; created_at: string | null }

export type MonthPoint = { key: string; invoiced: number; collected: number }
export type InvoiceLine = {
  id: string
  number: string | null
  title: string | null
  clientName: string | null
  dueDate: string | null
  outstanding: number
  daysOverdue: number | null
}
export type Activity =
  | { kind: 'client'; id: string; at: string; name: string | null }
  | { kind: 'document'; id: string; at: string; type: string | null; number: string | null; total: number; status: string | null }
  | { kind: 'payment'; id: string; at: string; amount: number; documentId: string | null; documentNumber: string | null }

export type Comparison = { current: number; previous: number; changePct: number | null }

export type DashboardMetrics = {
  today: string
  hasData: boolean
  collected: Comparison
  invoiced: Comparison
  receivable: { total: number; count: number }
  overdue: { total: number; count: number; items: InvoiceLine[] }
  dueSoon: { total: number; count: number; items: InvoiceLine[] }
  quotes: { openCount: number; openTotal: number; staleCount: number }
  clients: { total: number; newThisMonth: number }
  months: MonthPoint[]
  topClients: { id: string; name: string | null; invoiced: number }[]
  activity: Activity[]
}

const num = (v: number | string | null | undefined) => {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
/** Rounds to cents to avoid binary float noise in sums. */
const cents = (n: number) => Math.round(n * 100) / 100

/** 'YYYY-MM-DD' of a timestamp in `timeZone`; date-only strings are kept as they are. */
export function dayKey(value: string | Date, timeZone: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export const monthOf = (day: string) => day.slice(0, 7)

/** The 12 month keys ending with the month of `today` (oldest first). */
export function lastMonths(today: string, count = 12): string[] {
  const [y, m] = today.split('-').map(Number)
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return keys
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'). */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

export function changePct(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

const isInvoice = (d: DashDocument) => d.document_type === 'invoice' && d.status !== 'draft' && d.status !== 'cancelled'

export function computeDashboard(input: {
  documents: DashDocument[]
  payments: DashPayment[]
  clients: DashClient[]
  now: Date
  timeZone?: string
}): DashboardMetrics {
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE
  const today = dayKey(input.now, tz)
  const months = lastMonths(today)
  const thisMonth = months[11]
  const prevMonth = months[10]
  const clientName = new Map(input.clients.map((c) => [c.id, c.name]))
  const docById = new Map(input.documents.map((d) => [d.id, d]))

  // Payments per document and per month.
  const paidByDoc = new Map<string, number>()
  const collectedByMonth = new Map<string, number>()
  for (const p of input.payments) {
    const amount = num(p.amount)
    if (p.document_id) paidByDoc.set(p.document_id, (paidByDoc.get(p.document_id) ?? 0) + amount)
    const when = p.paid_at ?? p.created_at
    if (when) {
      const key = monthOf(dayKey(when, tz))
      collectedByMonth.set(key, (collectedByMonth.get(key) ?? 0) + amount)
    }
  }

  // Invoices: invoiced per month, outstanding, overdue, due soon, top clients.
  const invoicedByMonth = new Map<string, number>()
  const invoicedByClient = new Map<string, number>()
  const firstMonth = months[0]
  let receivableTotal = 0
  let receivableCount = 0
  const overdue: InvoiceLine[] = []
  const dueSoon: InvoiceLine[] = []
  for (const d of input.documents) {
    if (!isInvoice(d)) continue
    const total = num(d.total)
    const issued = d.issue_date ?? (d.created_at ? dayKey(d.created_at, tz) : null)
    if (issued) {
      const key = monthOf(issued)
      invoicedByMonth.set(key, (invoicedByMonth.get(key) ?? 0) + total)
      if (key >= firstMonth && d.client_id) invoicedByClient.set(d.client_id, (invoicedByClient.get(d.client_id) ?? 0) + total)
    }
    const outstanding = d.status === 'paid' ? 0 : cents(Math.max(total - (paidByDoc.get(d.id) ?? 0), 0))
    if (outstanding <= 0) continue
    receivableTotal += outstanding
    receivableCount++
    const line: InvoiceLine = {
      id: d.id, number: d.document_number, title: d.title,
      clientName: d.client_id ? clientName.get(d.client_id) ?? null : null,
      dueDate: d.due_date, outstanding, daysOverdue: null,
    }
    const late = d.status === 'overdue' || (d.due_date !== null && d.due_date < today)
    if (late) {
      overdue.push({ ...line, daysOverdue: d.due_date ? Math.max(daysBetween(d.due_date, today), 0) : null })
    } else if (d.due_date && daysBetween(today, d.due_date) <= DUE_SOON_DAYS) {
      dueSoon.push(line)
    }
  }
  overdue.sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) || b.outstanding - a.outstanding)
  dueSoon.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))

  // Quotes waiting for the client's answer.
  let openCount = 0
  let openTotal = 0
  let staleCount = 0
  for (const d of input.documents) {
    if (d.document_type !== 'quote' || d.status !== 'sent') continue
    openCount++
    openTotal += num(d.total)
    const issued = d.issue_date ?? (d.created_at ? dayKey(d.created_at, tz) : null)
    if (issued && daysBetween(issued, today) > STALE_QUOTE_DAYS) staleCount++
  }

  const newThisMonth = input.clients.filter((c) => c.created_at && monthOf(dayKey(c.created_at, tz)) === thisMonth).length

  const topClients = [...invoicedByClient.entries()]
    .map(([id, invoiced]) => ({ id, name: clientName.get(id) ?? null, invoiced: cents(invoiced) }))
    .sort((a, b) => b.invoiced - a.invoiced)
    .slice(0, 5)

  const activity: Activity[] = [
    ...input.clients.filter((c) => c.created_at).map((c): Activity => ({ kind: 'client', id: c.id, at: c.created_at!, name: c.name })),
    ...input.documents.filter((d) => d.created_at).map((d): Activity => ({
      kind: 'document', id: d.id, at: d.created_at!, type: d.document_type, number: d.document_number, total: num(d.total), status: d.status,
    })),
    ...input.payments.filter((p) => p.created_at).map((p): Activity => ({
      kind: 'payment', id: p.id, at: p.created_at!, amount: num(p.amount), documentId: p.document_id,
      documentNumber: p.document_id ? docById.get(p.document_id)?.document_number ?? null : null,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8)

  const compare = (m: Map<string, number>): Comparison => {
    const current = cents(m.get(thisMonth) ?? 0)
    const previous = cents(m.get(prevMonth) ?? 0)
    return { current, previous, changePct: changePct(current, previous) }
  }

  return {
    today,
    hasData: input.documents.length + input.payments.length + input.clients.length > 0,
    collected: compare(collectedByMonth),
    invoiced: compare(invoicedByMonth),
    receivable: { total: cents(receivableTotal), count: receivableCount },
    overdue: { total: cents(overdue.reduce((s, l) => s + l.outstanding, 0)), count: overdue.length, items: overdue.slice(0, 5) },
    dueSoon: { total: cents(dueSoon.reduce((s, l) => s + l.outstanding, 0)), count: dueSoon.length, items: dueSoon.slice(0, 5) },
    quotes: { openCount, openTotal: cents(openTotal), staleCount },
    clients: { total: input.clients.length, newThisMonth },
    months: months.map((key) => ({ key, invoiced: cents(invoicedByMonth.get(key) ?? 0), collected: cents(collectedByMonth.get(key) ?? 0) })),
    topClients,
    activity,
  }
}
