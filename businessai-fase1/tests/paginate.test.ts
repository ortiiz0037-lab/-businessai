/** selectAll: reads past the API's 1 000-row cap, stops on a short page, reports errors and the safety cap. */
import { describe, expect, it } from 'vitest'
import { chunks, fetchAllPages as selectAll } from '@/lib/supabase/paged'

const table = Array.from({ length: 2345 }, (_, i) => ({ id: i }))
const api = (maxRows = 1000) => async (from: number, to: number) => ({ data: table.slice(from, Math.min(to + 1, from + maxRows)), error: null })

describe('selectAll', () => {
  it('reads every row although each request returns at most 1 000', async () => {
    const r = await selectAll(api())
    expect(r.rows).toHaveLength(2345); expect(r.rows[2344]).toEqual({ id: 2344 }); expect(r.truncated).toBe(false)
  })
  it('a single big limit would have stopped at 1 000 (the defect it fixes)', async () => {
    expect((await api()(0, 4999)).data).toHaveLength(1000)
  })
  it('exact multiple of the page size and empty tables', async () => {
    expect((await selectAll(async (f, t) => ({ data: table.slice(0, 2000).slice(f, t + 1), error: null }))).rows).toHaveLength(2000)
    expect((await selectAll(async () => ({ data: [], error: null }))).rows).toEqual([])
  })
  it('stops at the safety cap and says so; returns the error of a failed page', async () => {
    const r = await selectAll(api(), { max: 1500 })
    expect(r.rows).toHaveLength(1500); expect(r.truncated).toBe(true)
    const e = await selectAll(async (f) => (f === 1000 ? { data: null, error: { message: 'boom' } } : { data: table.slice(f, f + 1000), error: null }))
    expect(e.error?.message).toBe('boom'); expect(e.rows).toHaveLength(1000)
  })
  it('chunks', () => { expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]) })
})
