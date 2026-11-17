/**
 * Read every row of a query in pages (review finding M3): PostgREST caps a
 * response (1000 rows on Supabase), so a plain select can silently drop
 * rows. `page(from, to)` must apply a stable order. Stops at `max` rows.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  { size = 1000, max = 20000 }: { size?: number; max?: number } = {},
): Promise<{ rows: T[]; error: { message: string } | null; truncated: boolean }> {
  const rows: T[] = []
  for (let from = 0; from < max; from += size) {
    const { data, error } = await page(from, Math.min(from + size, max) - 1)
    if (error) return { rows, error, truncated: false }
    rows.push(...(data ?? []))
    // a page shorter than what was asked for is the last one (also when the cap cuts the page in two)
    if (!data || data.length < Math.min(size, max - from)) return { rows, error: null, truncated: false }
  }
  return { rows, error: null, truncated: true }
}

type PaymentsReader = {
  from: (table: 'payments') => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => {
        order: (column: string) => {
          range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
        }
      }
    }
  }
}

/** Sum of payments per document for a set of documents (all pages, 2 decimals). */
export async function paidByDocument(supabase: unknown, documentIds: string[]): Promise<Map<string, number>> {
  const client = supabase as PaymentsReader
  const paid = new Map<string, number>()
  for (let i = 0; i < documentIds.length; i += 100) {
    const ids = documentIds.slice(i, i + 100)
    const { rows, truncated } = await fetchAllPages((from, to) =>
      client.from('payments').select('id, document_id, amount').in('document_id', ids).order('id').range(from, to))
    if (truncated) throw new TruncatedResultError()
    for (const p of rows as { document_id: string; amount: number | string }[]) {
      paid.set(p.document_id, (paid.get(p.document_id) ?? 0) + Number(p.amount ?? 0))
    }
  }
  for (const [k, v] of paid) paid.set(k, Math.round(v * 100) / 100)
  return paid
}

/** splits ids for `.in()` filters (keeps the request URL short) */
export const chunks = <T,>(list: T[], n = 100): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))

export class TruncatedResultError extends Error {
  constructor() { super('RESULT_TRUNCATED: the result exceeds the safety cap; a partial total is never shown as complete') }
}
/**
 * For totals and exports: the rows as `{ data, error }`, or THROW when the safety cap cut the result
 * (the page's error boundary shows it) — an incomplete figure is never presented as complete.
 */
export function complete<T>(r: { rows: T[]; error: { message: string } | null; truncated: boolean }) {
  if (r.truncated) throw new TruncatedResultError()
  return { data: r.rows, error: r.error }
}

/**
 * Every row whose column is IN `ids`: ids in chunks of 100 (a long `in.(…)` list exceeds the URL limit
 * of the API) and each chunk read in pages. Throws when a chunk exceeds the safety cap (see `complete`).
 */
export async function allIn<T>(ids: string[], page: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const data: T[] = []
  for (const c of chunks([...new Set(ids)], 100)) {
    const r = complete(await fetchAllPages<T>((a, b) => page(c, a, b)))
    if (r.error) return { data, error: r.error }
    data.push(...r.data)
  }
  return { data, error: null as { message: string } | null }
}
