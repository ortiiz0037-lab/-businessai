'use server'
/**
 * Edit a client of the active company. The client is read and updated with
 * the user's session: RLS (clients.edit) decides; the company comes from the
 * client row itself and must be one of the user's memberships.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseClientInput, parseClientCrm } from '@/lib/clients'
import { crmErrorCode } from '@/lib/crm/core'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function updateClient(formData: FormData) {
  const id = String(formData.get('id') ?? '')
  if (!UUID.test(id)) redirect('/clients?error=not_found')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: client } = await supabase.from('clients').select('id, company_id').eq('id', id).maybeSingle()
  if (!client) redirect('/clients?error=not_found')
  const { data: member } = await supabase
    .from('memberships').select('company_id').eq('user_id', user.id).eq('company_id', client.company_id).maybeSingle()
  if (!member) redirect('/clients?error=not_found')

  const parsed = parseClientInput((key) => String(formData.get(key) ?? ''))
  if (!parsed.ok) redirect(`/clients/${id}/edit?error=${parsed.error}`)
  // CRM fields (0035) only when the form carries them
  const crm = formData.get('crm') === '1' ? parseClientCrm((key) => String(formData.get(key) ?? '')) : null
  if (crm && !crm.ok) redirect(`/clients/${id}/edit?error=${crm.error}`)

  const { data, error } = await supabase
    .from('clients')
    .update({ ...parsed.value, ...(crm?.ok ? crm.value : {}), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', client.company_id)
    .select('id')
  if (error || !data?.length) {
    if (error) console.error('CLIENT_UPDATE_ERROR', { code: error.code, message: error.message })
    const crmCode = error ? crmErrorCode(error) : 'forbidden'
    redirect(`/clients/${id}/edit?error=${error?.code === '42501' || !data?.length ? 'forbidden' : ['crm_owner_invalid', 'crm_branch_invalid', 'invalid'].includes(crmCode) ? crmCode : 'save'}`)
  }
  revalidatePath('/clients')
  revalidatePath('/dashboard')
  revalidatePath(`/clients/${id}`)
  redirect(`/clients/${id}?done=updated`)
}

/**
 * Archive / restore / delete (migration 0019). The database decides: only
 * clients.archive archives (and writes who and when); a client with
 * documents is never deleted (CLIENT_HAS_HISTORY); RLS limits everything to
 * the user's companies.
 */
async function clientRow(formData: FormData) {
  const id = String(formData.get('id') ?? '')
  if (!UUID.test(id)) redirect('/clients?error=not_found')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: client } = await supabase.from('clients').select('id, company_id').eq('id', id).maybeSingle()
  if (!client) redirect('/clients?error=not_found')
  return { supabase, id, companyId: client.company_id as string }
}

function clientErrorCode(error: { code?: string; message?: string } | null): string {
  const m = error?.message ?? ''
  for (const code of ['CLIENT_ARCHIVE_FORBIDDEN', 'CLIENT_HAS_HISTORY', 'COMPANY_IMMUTABLE']) if (m.includes(code)) return code.toLowerCase()
  if (error?.code === '42501') return 'forbidden'
  if (/archived_at/.test(m)) return 'unavailable'
  return 'save'
}

export async function setClientArchived(formData: FormData) {
  const { supabase, id, companyId } = await clientRow(formData)
  const archive = formData.get('archive') === 'yes'
  const { data, error } = await supabase.from('clients')
    .update({ archived_at: archive ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) redirect(`/clients/${id}?error=${error ? clientErrorCode(error) : 'forbidden'}`)
  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  redirect(`/clients/${id}?done=${archive ? 'archived' : 'restored'}`)
}

export async function deleteClient(formData: FormData) {
  if (formData.get('confirm') !== 'yes') redirect(`/clients/${String(formData.get('id') ?? '')}?error=confirm`)
  const { supabase, id, companyId } = await clientRow(formData)
  const { data, error } = await supabase.from('clients').delete().eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) redirect(`/clients/${id}?error=${error ? clientErrorCode(error) : 'forbidden'}`)
  revalidatePath('/clients')
  redirect('/clients?success=deleted')
}
