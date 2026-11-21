'use server'
/**
 * Assistant server actions (the turn itself streams through
 * /api/assistant/stream). Thin wrappers: inputs are validated with zod in
 * src/lib/assistant/service.ts and every call runs with the user's session.
 */
import { revalidatePath } from 'next/cache'
import { archiveConversation, assistantStatus, decideAction, listConversations, loadConversation, renameConversation, retryAction } from '@/lib/assistant/service'

export async function assistantDecide(input: { actionId: string; decision: 'confirm' | 'cancel'; requestKey: string }) {
  const r = await decideAction(input)
  if (r.status === 'executed') revalidatePath('/studio')
  return r
}
export async function assistantRetry(input: { actionId: string }) {
  const r = await retryAction(input)
  if (r.status === 'executed') revalidatePath('/studio')
  return r
}
export async function assistantLoad(id: string) { return loadConversation(id) }
export async function assistantList(archived = false) { return listConversations(archived) }
export async function assistantState() { return assistantStatus() }
export async function assistantRename(input: { id: string; title: string }) {
  const r = await renameConversation(input); revalidatePath('/assistant'); return r
}
export async function assistantArchive(input: { id: string; archived: boolean }) {
  const r = await archiveConversation(input); revalidatePath('/assistant'); return r
}
