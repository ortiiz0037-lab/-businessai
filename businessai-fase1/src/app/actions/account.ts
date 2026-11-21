'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

/** Starts the deletion of the signed-in account (0045). The request is completed by an operator with the service role. */
export async function requestAccountDeletion(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (String(formData.get('confirm') ?? '').trim().toUpperCase() !== 'ELIMINAR' && String(formData.get('confirm') ?? '').trim().toUpperCase() !== 'DELETE') redirect('/settings/account?error=confirm')
  const { error } = await supabase.rpc('account_deletion_request', { p_reason: String(formData.get('reason') ?? '').slice(0, 500) || null })
  if (error) redirect('/settings/account?error=save')
  revalidatePath('/settings/account'); redirect('/settings/account?done=requested')
}
export async function cancelAccountDeletion() {
  const supabase = await createClient()
  const { error } = await supabase.rpc('account_deletion_cancel')
  if (error) redirect('/settings/account?error=save')
  revalidatePath('/settings/account'); redirect('/settings/account?done=cancelled')
}
