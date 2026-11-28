/**
 * Assistant S4: catalog, branches, receivables ageing, rule-based
 * recommendations (with reasons and verified figures), Finance draft proposals
 * (0040) and the extra prepared operations. Permissions decide which tools
 * exist; tools never invent signals or figures.
 */
import { describe, expect, it } from 'vitest'
import { findTool, rankSignals, toolsFor, PERMISSION_KEYS, type Access, type Signal, type ToolContext } from '@/lib/assistant/tools'
import { FactStore } from '@/lib/intelligence/facts'
import { classify } from '@/lib/intelligence/router'
import { screenFromPath, systemPrompt } from '@/lib/assistant/prompt'

const allPerms = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as Access['perms']
const noPerms = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Access['perms']
const OWNER: Access = { perms: allPerms, workforce: { manages: true, supervisedDepartments: [] }, features: { employees: true, timeClock: true } }
const MEMBER: Access = { perms: { ...noPerms, 'documents.view': true, 'studio.view': true, 'studio.edit': true, 'catalog.view': true }, workforce: { manages: false, supervisedDepartments: [] }, features: { employees: true, timeClock: true } }

type Res = { data: unknown; error: { message: string; hint?: string } | null; count?: number }
/** A chainable stand-in for the Supabase client: every query of a table / every RPC resolves to the scripted result. */
function fake(tables: Record<string, Res>, rpcs: Record<string, Res> = {}) {
  const calls: { kind: string; name: string; args?: unknown }[] = []
  const chain = (r: Res): unknown => new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (ok: (v: Res) => unknown) => Promise.resolve(r).then(ok)
      if (prop === 'maybeSingle') return () => Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data })
      return () => chain(r)
    },
  })
  return {
    calls,
    client: {
      from: (t: string) => { calls.push({ kind: 'from', name: t }); return chain(tables[t] ?? { data: [], error: null, count: 0 }) },
      rpc: (n: string, args: unknown) => { calls.push({ kind: 'rpc', name: n, args }); return chain(rpcs[n] ?? { data: [], error: null }) },
    },
  }
}
const ctx = (access: Access, supabase: unknown, locale: 'es' | 'en' = 'es'): ToolContext => ({ supabase: supabase as ToolContext['supabase'], companyId: '00000000-0000-4000-8000-0000000000aa', userId: 'u1',
  locale, today: '2026-11-15', turnId: '00000000-0000-4000-8000-0000000000cc', access, currency: 'USD', facts: new FactStore() })
const run = (name: string, c: ToolContext, input: unknown = {}) => (findTool(name)!.run as unknown as (c: ToolContext, i: unknown) => Promise<unknown>)(c, input)

describe('which S4 tools exist for whom', () => {
  it('reads and proposals follow the module permissions', () => {
    const member = toolsFor(MEMBER).map((t) => t.name)
    expect(member).toEqual(expect.arrayContaining(['search_catalog', 'list_branches', 'propose_collection_letter']))
    for (const n of ['get_receivables_aging', 'get_recommendations', 'propose_payment_voucher']) expect(member).not.toContain(n)
    expect(toolsFor({ ...MEMBER, perms: { ...MEMBER.perms, 'catalog.view': false } }).map((t) => t.name)).not.toContain('search_catalog')
    expect(toolsFor({ ...MEMBER, perms: { ...MEMBER.perms, 'studio.edit': false } }).map((t) => t.name)).not.toContain('propose_collection_letter')
    expect(toolsFor(OWNER).map((t) => t.name)).toEqual(expect.arrayContaining(['get_receivables_aging', 'get_recommendations', 'propose_payment_voucher']))
  })
  it('schemas: ids are uuids; no company or user parameter', () => {
    const id = '7d6c2b1a-1111-4222-8333-444455556666'
    expect(findTool('propose_collection_letter')!.schema.safeParse({ invoice_id: id }).success).toBe(true)
    expect(findTool('propose_collection_letter')!.schema.safeParse({ invoice_id: 'FAC-1' }).success).toBe(false)
    expect(findTool('propose_payment_voucher')!.schema.safeParse({ bill_id: id, company_id: id }).success).toBe(false)
    expect(findTool('search_catalog')!.schema.safeParse({ kind: 'kit' }).success).toBe(false)
  })
})

describe('recommendations are rules over real records, with reasons', () => {
  const data = () => fake({
    payment_promises: { data: [{ status: 'broken', promised_date: '2026-11-01' }, { status: 'pending', promised_date: '2026-11-10' }], error: null },
    bills: { data: [{ due_date: '2026-11-10', total_cents: 50000, paid_cents: 10000, currency: 'USD' }, { due_date: '2026-11-20', total_cents: 25000, paid_cents: 0, currency: 'USD' }], error: null },
    crm_activities: { data: null, error: null, count: 3 },
    leave_requests: { data: null, error: null, count: 2 },
  }, {
    ar_aging: { data: [{ client_id: 'c1', client_name: 'Cliente Uno', overdue_cents: '100000', b61_90: '100000', b90_plus: '0', oldest_days: 75 },
      { client_id: 'c2', client_name: 'Cliente Dos', overdue_cents: '0', b61_90: '0', b90_plus: '0', oldest_days: 0 }], error: null },
    assistant_bank_summary: { data: [{ unmatched_count: 4, unmatched_cents: '12345' }], error: null },
  })
  it('every rule that fires is returned with its figures, ordered by priority', async () => {
    const r = await run('get_recommendations', ctx(OWNER, data().client)) as unknown as { data: { recommendations: Signal[]; not_authorized: string[] } }
    const keys = r.data.recommendations.map((s) => s.key)
    expect(keys).toEqual(['payables_due', 'promises_not_kept', 'receivables_overdue', 'bank_unreconciled', 'crm_followups_overdue', 'leave_requests_pending'])
    const ar = r.data.recommendations.find((s) => s.key === 'receivables_overdue')!
    expect(ar.priority).toBe('high')   // a client over 60 days
    expect(ar.figures).toMatchObject({ clients_overdue: 1, overdue_total: '1000.00', clients_over_60_days: 1 })
    expect(r.data.recommendations.find((s) => s.key === 'payables_due')!.figures).toMatchObject({ overdue_bills: 1, overdue_balance: '400.00', due_next_7_days: 1, due_next_7_days_balance: '250.00' })
    expect(r.data.recommendations.find((s) => s.key === 'promises_not_kept')!.figures).toEqual({ broken: 1, expired_pending: 1 })
    for (const s of r.data.recommendations) { expect(s.reason.length).toBeGreaterThan(10); expect(s.next_step.length).toBeGreaterThan(10); expect(s.link).toMatch(/^\//); expect(s.reason).not.toMatch(/\d/); expect(s.next_step).not.toMatch(/\d/) }
    expect(r.data.not_authorized).toEqual([])
  })
  it('areas the user may not see are not evaluated, and say so', async () => {
    const f = data()
    const viewer: Access = { ...MEMBER, perms: { ...MEMBER.perms, 'crm.view': true } }
    const r = await run('get_recommendations', ctx(viewer, f.client)) as unknown as { data: { recommendations: Signal[]; not_authorized: string[] } }
    expect(r.data.recommendations.map((s) => s.key)).toEqual(['crm_followups_overdue'])
    expect(r.data.not_authorized).toEqual(expect.arrayContaining(['receivables', 'payables', 'bank', 'workforce']))
    expect(f.calls.some((c) => c.name === 'ar_aging' || c.name === 'bills' || c.name === 'assistant_bank_summary' || c.name === 'leave_requests')).toBe(false)
  })
  it('nothing to recommend → an empty list (never invented)', async () => {
    const r = await run('get_recommendations', ctx(OWNER, fake({}).client)) as unknown as { data: { recommendations_count: number } }
    expect(r.data.recommendations_count).toBe(0)
  })
  it('in English, the reasons are in English', async () => {
    const r = await run('get_recommendations', ctx(OWNER, data().client, 'en')) as unknown as { data: { recommendations: Signal[] } }
    expect(r.data.recommendations[0].reason).toMatch(/^There are/)
  })
  it('ranking is stable: priority, then key', () => {
    const s = (key: string, priority: Signal['priority']): Signal => ({ key, priority, area: 'x', reason: '', figures: {}, next_step: '', link: '/' })
    expect(rankSignals([s('b', 'low'), s('c', 'high'), s('a', 'high'), s('d', 'medium')]).map((x) => x.key)).toEqual(['a', 'c', 'd', 'b'])
  })
})

describe('ageing, catalog and branches read real data', () => {
  it('ageing totals come from every client row, shown rows are limited', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ client_id: `c${i}`, client_name: `C${i}`, b0_30: '100', b31_60: '200', b61_90: '0', b90_plus: '50', total_cents: '350', overdue_cents: '250', invoices: 2, oldest_days: 95 }))
    const r = await run('get_receivables_aging', ctx(OWNER, fake({}, { ar_aging: { data: rows, error: null } }).client), { limit: 2 }) as unknown as { data: Record<string, unknown> & { clients: unknown[] }; meta: { complete: boolean } }
    expect(r.data).toMatchObject({ clients_with_balance: 3, total_open: '10.50', total_overdue: '7.50', buckets: { d0_30: '3.00', d31_60: '6.00', d61_90: '0.00', d90_plus: '1.50' }, shown: 2 })
    expect(r.meta.complete).toBe(false)
  })
  it('the catalog says when the module is not enabled in this database', async () => {
    await expect(run('search_catalog', ctx(MEMBER, fake({ catalog_items: { data: null, error: { message: 'relation "public.catalog_items" does not exist' } } }).client), { query: 'cemento' })).rejects.toThrow('module_not_enabled')
    const r = await run('search_catalog', ctx(MEMBER, fake({ catalog_items: { data: [{ id: 'i1', code: 'MAT-1', name: 'Cemento', kind: 'product', unit: 'saco', price_cents: 1250, tax_rate: 11.5, track_inventory: true, status: 'active' }], error: null, count: 1 } }).client)) as unknown as { data: { items: Record<string, unknown>[] } }
    expect(r.data.items[0]).toMatchObject({ code: 'MAT-1', price: '12.50', own_tax_rate: '11.50', link: '/catalog/i1' })
  })
  it('branches mark the ones the user belongs to', async () => {
    const r = await run('list_branches', ctx(MEMBER, fake({ branches: { data: [{ id: 'b1', name: 'Centro', code: 'CEN', address: null, archived_at: null }, { id: 'b2', name: 'Norte', code: 'NOR', address: null, archived_at: null }], error: null },
      branch_members: { data: [{ branch_id: 'b2' }], error: null }, crm_settings: { data: { branch_scoping: true }, error: null } }).client)) as unknown as { data: { crm_limited_by_branch: boolean; branches: { code: string; i_belong: boolean }[] } }
    expect(r.data.crm_limited_by_branch).toBe(true)
    expect(r.data.branches.map((b) => `${b.code}:${b.i_belong}`)).toEqual(['CEN:false', 'NOR:true'])
  })
})

describe('Finance draft proposals (0040) are proposals only', () => {
  const id = '7d6c2b1a-1111-4222-8333-444455556666'
  it('a collection letter only about an issued invoice; it is a pending proposal', async () => {
    await expect(run('propose_collection_letter', ctx(OWNER, fake({ documents: { data: [{ id, document_number: 'FAC-1', document_type: 'invoice', status: 'draft', client_id: null }], error: null } }).client), { invoice_id: id })).rejects.toThrow('invoice_not_issued')
    await expect(run('propose_collection_letter', ctx(OWNER, fake({ documents: { data: [{ id, document_number: 'COT-1', document_type: 'quote', status: 'sent', client_id: null }], error: null } }).client), { invoice_id: id })).rejects.toThrow('not_found')
    const f = fake({ documents: { data: [{ id, document_number: 'FAC-1', document_type: 'invoice', status: 'overdue', client_id: 'c1' }], error: null }, clients: { data: [{ id: 'c1', name: 'Cliente Uno' }], error: null } },
      { assistant_propose: { data: 'act-1', error: null } })
    const r = await run('propose_collection_letter', ctx(OWNER, f.client), { invoice_id: id }) as unknown as { data: Record<string, unknown> }
    expect(r.data).toMatchObject({ action_id: 'act-1', status: 'awaiting_user_confirmation', level: 'draft', invoice: 'FAC-1', client: 'Cliente Uno' })
    expect(f.calls.find((c) => c.name === 'assistant_propose')?.args).toMatchObject({ act_kind: 'studio_collection_letter', act_payload: { invoice_id: id } })
  })
  it('a voucher needs a recorded payment, and asks which one when there are several', async () => {
    const bill = { data: [{ id, vendor_invoice_number: 'P-100', description: 'Suministros', vendor_id: 'v' }], error: null }
    await expect(run('propose_payment_voucher', ctx(OWNER, fake({ bills: bill, bill_payments: { data: [], error: null } }).client), { bill_id: id })).rejects.toThrow('no_recorded_payment')
    const two = fake({ bills: bill, bill_payments: { data: [{ id: 'p1', paid_on: '2026-11-01', amount_cents: 1000 }, { id: 'p2', paid_on: '2026-11-05', amount_cents: 2000 }], error: null } })
    const r = await run('propose_payment_voucher', ctx(OWNER, two.client), { bill_id: id }) as unknown as { data: { needs_payment_choice: boolean; payments: unknown[] } }
    expect(r.data.needs_payment_choice).toBe(true); expect(r.data.payments).toHaveLength(2)
    expect(two.calls.some((c) => c.name === 'assistant_propose')).toBe(false)
    const one = fake({ bills: bill, bill_payments: { data: [{ id: 'p1', paid_on: '2026-11-01', amount_cents: 1000 }], error: null } }, { assistant_propose: { data: 'act-2', error: null } })
    const v = await run('propose_payment_voucher', ctx(OWNER, one.client), { bill_id: id }) as unknown as { data: Record<string, unknown> }
    expect(v.data).toMatchObject({ action_id: 'act-2', payment_amount: '10.00', bill: 'P-100' })
    expect(one.calls.find((c) => c.name === 'assistant_propose')?.args).toMatchObject({ act_kind: 'studio_payment_voucher', act_payload: { bill_id: id, payment_id: 'p1' } })
  })
  it('the database refusal is reported as forbidden', async () => {
    const f = fake({ documents: { data: [{ id, document_number: 'FAC-1', document_type: 'invoice', status: 'sent', client_id: null }], error: null } }, { assistant_propose: { data: null, error: { message: 'FORBIDDEN' } } })
    await expect(run('propose_collection_letter', ctx(OWNER, f.client), { invoice_id: id })).rejects.toThrow('forbidden')
  })
})

describe('prepared operations need the permission of the screen', () => {
  it('a vendor payment needs payables.pay; it is never executed', async () => {
    const id = '7d6c2b1a-1111-4222-8333-444455556666'
    await expect(run('prepare_operation', ctx({ ...OWNER, perms: { ...OWNER.perms, 'payables.pay': false } }, fake({}).client), { operation: 'record_vendor_payment', bill_id: id })).rejects.toThrow('forbidden')
    const r = await run('prepare_operation', ctx(OWNER, fake({}).client), { operation: 'record_vendor_payment', bill_id: id }) as unknown as { data: Record<string, unknown> }
    expect(r.data).toMatchObject({ link: `/payables/${id}`, executed: false, user_must_complete_and_confirm_on_screen: true })
    await expect(run('prepare_operation', ctx(MEMBER, fake({}).client), { operation: 'new_catalog_item' })).rejects.toThrow('forbidden')
  })
})

describe('routing, screens and prompt (S4)', () => {
  it('catalog and branch questions are light queries; priorities and recommendations need data', () => {
    expect(classify('busca el producto cemento en el catálogo', null).tier).toBe('P1')
    expect(classify('¿qué precio tiene el cemento?', null).tier).toBe('P2')
    expect(classify('¿Qué debo priorizar en cobros esta semana?', null).tier).toBe('P3')
  })
  it('the catalog screen is recognised, with its record', () => {
    expect(screenFromPath('/catalog/7d6c2b1a-1111-4222-8333-444455556666')).toMatchObject({ area: 'catalog', recordKind: 'catalog_item' })
  })
  it('the prompt tells the model to explain recommendations and to stay within the branches it was shown', () => {
    const p = systemPrompt({ locale: 'es', today: '2026-11-15', companyName: 'Demo', role: 'owner', screen: null, tools: [], currency: 'USD' })
    expect(p).toMatch(/get_recommendations/); expect(p).toMatch(/WHY/); expect(p).toMatch(/BRANCHES/); expect(p).toMatch(/propose_payment_voucher/)
  })
})
