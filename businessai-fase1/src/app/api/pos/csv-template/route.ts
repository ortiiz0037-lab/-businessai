import { CSV_TEMPLATE } from '@/lib/pos/csv'

/** The CSV template for traditional registers (no data, no session needed beyond the app). */
export function GET() {
  return new Response(CSV_TEMPLATE, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="plantilla-ventas-caja.csv"' } })
}
