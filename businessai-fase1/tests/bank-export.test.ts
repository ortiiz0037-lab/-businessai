import { describe, it, expect, vi, beforeEach } from 'vitest'

// The bank CSV export must never hand over a partial file: every page is read, and a read error or a
// result cut by the safety cap fails the request instead of downloading what was read so far.

type Page = { data: unknown[] | null; error: { message: string } | null }
let pageFor: (from: number, to: number) => Page

function builder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order']) b[m] = () => b
  b.range = async (from: number, to: number) => pageFor(from, to)
  // the account-name lookup is awaited directly
  b.then = (ok: (v: Page) => unknown) => Promise.resolve({ data: [{ id: 'acc', name: 'Operating' }], error: null }).then(ok)
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) }, from: () => builder() }),
}))
vi.mock('@/lib/active-company', () => ({ getActiveMembership: async () => ({ companyId: 'c1' }) }))

const row = (i: number) => ({ bank_account_id: 'acc', file_name: `f${i}.csv`, file_sha256: 'x', row_count: 1, imported_count: 1, duplicate_count: 0,
  first_date: '2026-01-01', last_date: '2026-01-01', status: 'imported', revert_reason: null, created_at: '2026-01-01T00:00:00Z' })
const rows = (total: number) => (from: number, to: number): Page => ({ data: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, k) => row(from + k)), error: null })

async function get(kind: string) {
  const { GET } = await import('@/app/(app)/bank/export/route')
  return GET(new Request(`http://localhost/bank/export?kind=${kind}`))
}

describe('bank CSV export completeness', () => {
  beforeEach(() => { pageFor = rows(0) })

  it('exports every row across pages (1 001 → header + 1 001 lines)', async () => {
    pageFor = rows(1001)
    const res = await get('imports')
    expect(res.status).toBe(200)
    const lines = (await res.text()).trim().split(/\r?\n/)
    expect(lines).toHaveLength(1002)
    expect(lines[1001]).toContain('f1000.csv')
  })

  it('fails instead of exporting a partial file when a page read fails', async () => {
    pageFor = (from, to) => (from === 0 ? rows(5000)(from, to) : { data: null, error: { message: 'boom' } })
    await expect(get('imports')).rejects.toThrow()
  })

  it('fails instead of exporting a truncated file when the safety cap is reached', async () => {
    pageFor = rows(10_000_000) // more than the export's cap
    await expect(get('imports')).rejects.toThrow()
  })
})
