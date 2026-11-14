import type { SupabaseClient } from '@supabase/supabase-js'
import type { StudioAccess } from '@/lib/studio/page'

export type Options = {
  clients: { id: string; name: string }[]
  documents: { id: string; label: string; type: string }[]
  employees: { id: string; name: string }[]
  vendors: { id: string; name: string }[]
}
/** The records a document can be built on, limited to what the user may read. */
export async function bindingOptions(supabase: SupabaseClient, companyId: string, access: StudioAccess): Promise<Options> {
  const [c, d, e, v] = await Promise.all([
    access.clients ? supabase.from('clients').select('id, name').eq('company_id', companyId).eq('status', 'active').order('name').limit(500) : Promise.resolve({ data: [] }),
    access.documents ? supabase.from('documents').select('id, document_type, document_number, status, total, client:clients(name)').eq('company_id', companyId)
      .in('document_type', ['quote', 'invoice', 'receipt', 'work_order']).order('created_at', { ascending: false }).limit(300) : Promise.resolve({ data: [] }),
    access.employees ? supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId).order('first_name').limit(500) : Promise.resolve({ data: [] }),
    access.vendors ? supabase.from('vendors').select('id, name').eq('company_id', companyId).order('name').limit(500) : Promise.resolve({ data: [] }),
  ])
  return {
    clients: (c.data ?? []) as { id: string; name: string }[],
    documents: ((d.data ?? []) as unknown as { id: string; document_type: string; document_number: string; status: string; total: number; client: { name: string } | null }[])
      .map((x) => ({ id: x.id, type: x.document_type, label: `${x.document_number} · ${x.client?.name ?? '—'} · ${x.status}` })),
    employees: ((e.data ?? []) as { id: string; first_name: string; last_name: string }[]).map((x) => ({ id: x.id, name: `${x.first_name} ${x.last_name}`.trim() })),
    vendors: (v.data ?? []) as { id: string; name: string }[],
  }
}
