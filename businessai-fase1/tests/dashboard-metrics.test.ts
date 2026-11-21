import { describe, expect, it } from 'vitest'
import {
  changePct, computeDashboard, dayKey, daysBetween, lastMonths,
  type DashClient, type DashDocument, type DashPayment,
} from '@/lib/dashboard/metrics'

// 2026-11-10 15:00 UTC = 11:00 in Puerto Rico.
const NOW = new Date('2026-11-10T15:00:00Z')

const doc = (p: Partial<DashDocument> & { id: string }): DashDocument => ({
  client_id: null, document_type: 'invoice', document_number: p.id.toUpperCase(), title: null, status: 'sent',
  total: 0, issue_date: '2026-11-01', due_date: null, created_at: '2026-11-01T12:00:00Z', ...p,
})
const pay = (p: Partial<DashPayment> & { id: string }): DashPayment => ({
  document_id: null, amount: 0, paid_at: null, created_at: '2026-11-02T12:00:00Z', ...p,
})
const clients: DashClient[] = [
  { id: 'c1', name: 'Café Sol', created_at: '2026-11-03T12:00:00Z' },
  { id: 'c2', name: 'Taller Norte', created_at: '2026-05-01T12:00:00Z' },
]

describe('date helpers', () => {
  it('buckets timestamps in the company time zone', () => {
    // 02:30 UTC on Nov 1 is still Oct 31 in Puerto Rico (UTC−4).
    expect(dayKey('2026-11-01T02:30:00Z', 'America/Puerto_Rico')).toBe('2026-10-31')
    expect(dayKey('2026-11-01T02:30:00Z', 'UTC')).toBe('2026-11-01')
    expect(dayKey('2026-07-04', 'America/Puerto_Rico')).toBe('2026-07-04')
  })
  it('lists the last 12 months ending this month, across years', () => {
    expect(lastMonths('2026-02-15')).toEqual([
      '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08',
      '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
    ])
  })
  it('counts days and changes', () => {
    expect(daysBetween('2026-10-31', '2026-11-10')).toBe(10)
    expect(changePct(150, 100)).toBe(50)
    expect(changePct(50, 0)).toBeNull()
    expect(changePct(0, 80)).toBe(-100)
  })
})

describe('computeDashboard', () => {
  it('no data: everything zero, hasData false, no invented values', () => {
    const m = computeDashboard({ documents: [], payments: [], clients: [], now: NOW })
    expect(m.hasData).toBe(false)
    expect(m.collected).toEqual({ current: 0, previous: 0, changePct: null })
    expect(m.receivable).toEqual({ total: 0, count: 0 })
    expect(m.months).toHaveLength(12)
    expect(m.months.every((p) => p.invoiced === 0 && p.collected === 0)).toBe(true)
    expect(m.topClients).toEqual([])
    expect(m.activity).toEqual([])
  })

  it('collected and invoiced compare this month with the previous one', () => {
    const m = computeDashboard({
      documents: [
        doc({ id: 'i1', client_id: 'c1', total: 300, issue_date: '2026-11-02' }),
        doc({ id: 'i2', client_id: 'c2', total: '200.50', issue_date: '2026-10-15' }),
        doc({ id: 'd1', total: 999, status: 'draft' }),
        doc({ id: 'x1', total: 999, status: 'cancelled' }),
        doc({ id: 'q1', document_type: 'quote', total: 999 }),
      ],
      payments: [
        pay({ id: 'p1', document_id: 'i1', amount: 100, paid_at: '2026-11-05T12:00:00Z' }),
        pay({ id: 'p2', document_id: 'i2', amount: '50', paid_at: '2026-10-20T12:00:00Z' }),
        pay({ id: 'p3', document_id: 'i2', amount: 50, paid_at: null, created_at: '2026-11-01T02:30:00Z' }), // Oct 31 in PR
      ],
      clients, now: NOW,
    })
    expect(m.invoiced).toEqual({ current: 300, previous: 200.5, changePct: 49.6 })
    expect(m.collected).toEqual({ current: 100, previous: 100, changePct: 0 })
    expect(m.months.at(-1)).toEqual({ key: '2026-11', invoiced: 300, collected: 100 })
    expect(m.months.at(-2)).toEqual({ key: '2026-10', invoiced: 200.5, collected: 100 })
  })

  it('receivables, overdue and due soon use the payments of each invoice', () => {
    const m = computeDashboard({
      documents: [
        doc({ id: 'late', client_id: 'c1', total: 500, due_date: '2026-10-31' }),                 // 10 days late, 200 paid
        doc({ id: 'flag', client_id: 'c2', total: 80, status: 'overdue', due_date: null }),       // marked overdue
        doc({ id: 'soon', client_id: 'c2', total: 120, due_date: '2026-11-15' }),                 // in 5 days
        doc({ id: 'later', total: 60, due_date: '2026-12-31' }),                                  // open, not soon
        doc({ id: 'full', total: 90, due_date: '2026-10-01' }),                                   // fully paid
        doc({ id: 'marked', total: 70, status: 'paid', due_date: '2026-10-01' }),                 // marked paid
      ],
      payments: [
        pay({ id: 'a', document_id: 'late', amount: 200 }),
        pay({ id: 'b', document_id: 'full', amount: 90 }),
      ],
      clients, now: NOW,
    })
    expect(m.receivable).toEqual({ total: 560, count: 4 })
    expect(m.overdue.count).toBe(2)
    expect(m.overdue.total).toBe(380)
    expect(m.overdue.items[0]).toMatchObject({ id: 'late', outstanding: 300, daysOverdue: 10, clientName: 'Café Sol' })
    expect(m.overdue.items[1]).toMatchObject({ id: 'flag', outstanding: 80, daysOverdue: null })
    expect(m.dueSoon).toMatchObject({ count: 1, total: 120 })
    expect(m.dueSoon.items[0]).toMatchObject({ id: 'soon', dueDate: '2026-11-15' })
  })

  it('open quotes are the sent ones; stale after 14 days', () => {
    const m = computeDashboard({
      documents: [
        doc({ id: 'q1', document_type: 'quote', status: 'sent', total: 400, issue_date: '2026-11-08' }),
        doc({ id: 'q2', document_type: 'quote', status: 'sent', total: 100, issue_date: '2026-10-20' }),
        doc({ id: 'q3', document_type: 'quote', status: 'draft', total: 999 }),
      ],
      payments: [], clients, now: NOW,
    })
    expect(m.quotes).toEqual({ openCount: 2, openTotal: 500, staleCount: 1 })
  })

  it('clients, top clients (last 12 months) and the activity feed', () => {
    const m = computeDashboard({
      documents: [
        doc({ id: 'i1', client_id: 'c1', total: 100, issue_date: '2026-09-01', created_at: '2026-09-01T12:00:00Z' }),
        doc({ id: 'i2', client_id: 'c2', total: 700, issue_date: '2026-10-01', created_at: '2026-10-01T12:00:00Z' }),
        doc({ id: 'old', client_id: 'c1', total: 5000, issue_date: '2025-10-31', created_at: '2025-10-31T12:00:00Z' }),
      ],
      payments: [pay({ id: 'p1', document_id: 'i2', amount: 700, created_at: '2026-11-09T12:00:00Z' })],
      clients, now: NOW,
    })
    expect(m.clients).toEqual({ total: 2, newThisMonth: 1 })
    expect(m.topClients).toEqual([
      { id: 'c2', name: 'Taller Norte', invoiced: 700 },
      { id: 'c1', name: 'Café Sol', invoiced: 100 },
    ])
    expect(m.activity.map((a) => `${a.kind}:${a.id}`)).toEqual([
      'payment:p1', 'client:c1', 'document:i2', 'document:i1', 'client:c2', 'document:old',
    ])
    expect(m.activity[0]).toMatchObject({ kind: 'payment', amount: 700, documentNumber: 'I2' })
  })
})

describe('demo company data (scripts/staging/demo-data.mjs) through the real metrics', () => {
  it('is identifiable, consistent and exercises every dashboard section', async () => {
    const { buildDemoData, DEMO_PREFIX, DEMO_SOURCE } = await import('../scripts/staging/demo-data.mjs')
    let n = 0
    const data = buildDemoData(NOW, () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`)
    expect(data.clients.every((c: { name: string }) => c.name.startsWith(DEMO_PREFIX))).toBe(true)
    expect(data.documents.every((d: { document_number: string; metadata: { demo: boolean; source: string } }) =>
      d.document_number.startsWith('DEMO-') && d.metadata.demo === true && d.metadata.source === DEMO_SOURCE)).toBe(true)
    const ids = new Set(data.documents.map((d: { id: string }) => d.id))
    expect(data.payments.every((p: { document_id: string }) => ids.has(p.document_id))).toBe(true)
    // Never more paid than invoiced, never dated in the future.
    for (const d of data.documents) {
      const paid = data.payments.filter((p: { document_id: string }) => p.document_id === d.id).reduce((s: number, p: { amount: number }) => s + p.amount, 0)
      expect(paid).toBeLessThanOrEqual(d.total + 0.001)
      expect(d.issue_date <= '2026-11-10').toBe(true)
    }
    expect(data.payments.every((p: { paid_at: string }) => p.paid_at <= NOW.toISOString())).toBe(true)

    const m = computeDashboard({ documents: data.documents, payments: data.payments, clients: data.clients, now: NOW })
    expect(m.hasData).toBe(true)
    expect(m.overdue.count).toBeGreaterThanOrEqual(2)
    expect(m.dueSoon.count).toBeGreaterThanOrEqual(1)
    expect(m.quotes.staleCount).toBeGreaterThanOrEqual(2)
    expect(m.clients.newThisMonth).toBe(2)
    expect(m.topClients).toHaveLength(5)
    expect(m.months.filter((p) => p.invoiced > 0).length).toBeGreaterThanOrEqual(11)
    expect(m.activity).toHaveLength(8)
  })
})

describe('formatters and locale resolution', () => {
  it('format money, percents and months per language', async () => {
    const { formatters } = await import('@/lib/i18n/app')
    const es = formatters('es'); const en = formatters('en')
    expect(en.money(1234.5)).toBe('$1,234.50')
    expect(en.pct(28.5)).toBe('+28.5%')
    expect(es.pct(-93.5)).toBe('-93.5 %') // es-PR uses a decimal point, like the US
    expect(en.monthLong('2026-11')).toBe('November 2026')
    expect(es.monthLong('2026-11')).toBe('Noviembre de 2026')
    expect(es.month('2026-05')).toBe('May')
  })
  it('resolves the language: cookie, then browser, then Spanish', async () => {
    const { resolveLocale } = await import('@/lib/i18n/server')
    expect(resolveLocale('en', 'es-PR,es')).toBe('en')
    expect(resolveLocale(undefined, 'en-US,en;q=0.9')).toBe('en')
    expect(resolveLocale(undefined, 'es-PR')).toBe('es')
    expect(resolveLocale('fr', null)).toBe('es')
  })
  it('picks the active company only among the user memberships', async () => {
    const { pickMembership } = await import('@/lib/active-company')
    const opts = [
      { companyId: 'own', companyName: 'Mi Empresa', role: 'owner' as const },
      { companyId: 'demo', companyName: 'BusinessAI Demo (QA)', role: 'admin' as const },
    ]
    expect(pickMembership(opts, 'demo')?.companyId).toBe('demo')
    expect(pickMembership(opts, 'someone-elses-company')?.companyId).toBe('own')
    expect(pickMembership(opts, undefined)?.companyId).toBe('own')
    expect(pickMembership([], 'demo')).toBeNull()
  })
})
