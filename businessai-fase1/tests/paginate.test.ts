/**
 * Reads past the API's 1 000-row cap (fetchAllPages), at 999 / 1 000 / 1 001 rows and several pages;
 * the safety cap is reported, and `complete` turns it into an error instead of a partial total;
 * `allIn` chunks long id lists (URL limit) and pages each chunk.
 */
import { describe, expect, it } from 'vitest'
import { allIn, chunks, complete, fetchAllPages, TruncatedResultError } from '@/lib/supabase/paged'

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))
/** what PostgREST does: at most `maxRows` per request, whatever range is asked */
const api = (table: { id: number }[], maxRows = 1000) => async (from: number, to: number) => ({ data: table.slice(from, Math.min(to + 1, from + maxRows)), error: null })

describe('fetchAllPages at the page boundaries', () => {
  for (const n of [0, 1, 999, 1000, 1001, 2000, 2345]) {
    it(`${n} rows: all read, none repeated, not truncated`, async () => {
      const r = await fetchAllPages(api(rowsOf(n)))
      expect(r.rows).toHaveLength(n); expect(new Set(r.rows.map((x) => x.id)).size).toBe(n); expect(r.truncated).toBe(false)
    })
  }
  it('a single big limit would have stopped at 1 000 (the defect it fixes)', async () => {
    expect((await api(rowsOf(5000))(0, 4999)).data).toHaveLength(1000)
  })
  it('the safety cap is reported, also when it cuts a page in two', async () => {
    const a = await fetchAllPages(api(rowsOf(2345)), { max: 1500 })
    expect(a.rows).toHaveLength(1500); expect(a.truncated).toBe(true)
    const b = await fetchAllPages(api(rowsOf(2000)), { max: 2000 })
    expect(b.truncated).toBe(true)        // exactly at the cap: more rows may exist
    const c = await fetchAllPages(api(rowsOf(1999)), { max: 2000 })
    expect(c.truncated).toBe(false)
  })
  it('an error on a later page is returned with what was read', async () => {
    const e = await fetchAllPages(async (f) => (f === 1000 ? { data: null, error: { message: 'boom' } } : { data: rowsOf(2000).slice(f, f + 1000), error: null }))
    expect(e.error?.message).toBe('boom'); expect(e.rows).toHaveLength(1000)
  })
})

describe('complete: never a partial total presented as complete', () => {
  it('returns the rows, or throws when the cap was reached', async () => {
    expect(complete(await fetchAllPages(api(rowsOf(1001)))).data).toHaveLength(1001)
    const capped = await fetchAllPages(api(rowsOf(3000)), { max: 2000 })
    expect(() => complete(capped)).toThrow(TruncatedResultError)
  })
})

describe('allIn', () => {
  it('chunks 350 ids into 4 requests of ≤ 100 and pages each one', async () => {
    const ids = Array.from({ length: 350 }, (_, i) => `id-${i}`)
    const seen: number[] = []
    const r = await allIn(ids, async (c, from) => { if (from === 0) seen.push(c.length); return { data: from === 0 ? c.map((id) => ({ id })) : [], error: null } })
    expect(seen).toEqual([100, 100, 100, 50]); expect(r.data).toHaveLength(350); expect(r.error).toBeNull()
  })
  it('duplicates in the id list are asked once; an error stops and is returned', async () => {
    const r = await allIn(['a', 'a', 'b'], async (c) => ({ data: c.map((id) => ({ id })), error: null }))
    expect(r.data).toEqual([{ id: 'a' }, { id: 'b' }])
    const e = await allIn(['a'], async () => ({ data: null, error: { message: 'x' } }))
    expect(e.error?.message).toBe('x')
  })
  it('chunks', () => { expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]) })
})
