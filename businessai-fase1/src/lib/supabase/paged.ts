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
    if (!data || data.length < size) return { rows, error: null, truncated: false }
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
    const { rows } = await fetchAllPages((from, to) =>
      client.from('payments').select('id, document_id, amount').in('document_id', ids).order('id').range(from, to))
    for (const p of rows as { document_id: string; amount: number | string }[]) {
      paid.set(p.document_id, (paid.get(p.document_id) ?? 0) + Number(p.amount ?? 0))
    }
  }
  for (const [k, v] of paid) paid.set(k, Math.round(v * 100) / 100)
  return paid
}
