'use server'
/**
 * Edit a client of the active company. The client is read and updated with
 * the user's session: RLS (clients.edit) decides; the company comes from the
 * client row itself and must be one of the user's memberships.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseClientInput } from '@/lib/clients'

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
  if (!parsed.ok) redirect(`/clients/${id}?error=${parsed.error}`)

  const { data, error } = await supabase
    .from('clients')
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', client.company_id)
    .select('id')
  if (error || !data?.length) {
    if (error) console.error('CLIENT_UPDATE_ERROR', { code: error.code, message: error.message })
    redirect(`/clients/${id}?error=${error?.code === '42501' || !data?.length ? 'forbidden' : 'save'}`)
  }
  revalidatePath('/clients')
  revalidatePath('/dashboard')
  redirect('/clients?success=updated')
}
