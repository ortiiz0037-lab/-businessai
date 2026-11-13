'use server'
/**
 * Assistant server actions. Thin wrappers: every input is validated with zod
 * in src/lib/assistant/service.ts, every call runs with the user's session.
 * (Server actions also check the request origin; no API key ever reaches the
 * browser.)
 */
import { revalidatePath } from 'next/cache'
import { archiveConversation, assistantStatus, decideAction, listConversations, loadConversation, renameConversation, sendMessage } from '@/lib/assistant/service'

export async function assistantSend(input: { conversationId: string | null; text: string; screen: string | null }) {
  const r = await sendMessage(input)
  if (r.ok) revalidatePath('/assistant')
  return r
}
export async function assistantDecide(input: { actionId: string; decision: 'confirm' | 'cancel' }) {
  const r = await decideAction(input)
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
