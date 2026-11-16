/**
 * Synchronization of a bank connection (SERVER ONLY): reads the signed
 * context (encrypted token, cursor, linked accounts), pulls the pages of
 * /transactions/sync and writes each page through the signed
 * bank_sync_apply (0042) together with its cursor, so an interrupted sync
 * resumes from the last page written and a repeated page inserts nothing
 * (the provider transaction id is the line fingerprint).
 * Pending transactions are not imported (they change or disappear); they
 * arrive again once posted.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankingConfig } from '@/lib/banking/config'
import { decryptToken } from '@/lib/banking/crypto'
import { PlaidClient, PlaidError, toBankRow, type PlaidTxn } from '@/lib/banking/plaid'
import { BankSigner } from '@/lib/banking/signer'

export type SyncTrigger = 'manual' | 'webhook' | 'initial'
export type SyncOutcome =
  | { ok: true; added: number; duplicates: number; removed: number; pages: number }
  | { ok: false; reason: 'not_configured' | 'not_found' | 'disconnected' | 'no_linked_accounts' | 'provider_error' | 'database_error'; code?: string }

type Ctx = { company_id: string; status: string; cursor: string | null; token_ciphertext: string | null; accounts: { provider_account_id: string; bank_account_id: string }[] }

const MAX_PAGES = 40

export function plaidFor(cfg: Extract<BankingConfig, { configured: true }>, fetcher?: typeof fetch) {
  return new PlaidClient({ clientId: cfg.clientId, secret: cfg.secret, baseURL: cfg.baseURL, countryCodes: cfg.countryCodes, webhookURL: cfg.webhookURL, environment: cfg.environment }, fetcher)
}

/** Groups a page into the per-account rows the database accepts (only linked accounts, no pending). */
export function pageToPayload(trigger: SyncTrigger, cursor: string, added: PlaidTxn[], removed: string[], links: Map<string, string>) {
  let pending = 0
  const byAccount = new Map<string, ReturnType<typeof toBankRow>[]>()
  for (const t of added) {
    if (t.pending) { pending++; continue }
    const account = links.get(t.account_id)
    if (!account) continue
    if (!Number.isFinite(t.amount) || Math.round(t.amount * 100) === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) continue
    const list = byAccount.get(account) ?? []
    list.push(toBankRow(t))
    byAccount.set(account, list)
  }
  return {
    trigger, status: 'succeeded', cursor, pending_skipped: pending, removed,
    accounts: [...byAccount.entries()].map(([bank_account_id, rows]) => ({ bank_account_id, rows })),
  }
}

export async function syncConnection(supabase: SupabaseClient, cfg: BankingConfig, connectionId: string, trigger: SyncTrigger, fetcher?: typeof fetch): Promise<SyncOutcome> {
  if (!cfg.configured) return { ok: false, reason: 'not_configured' }
  const signer = new BankSigner(cfg.serverKeys[0])
  const c = signer.context(connectionId)
  const { data, error } = await supabase.rpc('bank_sync_context', { connection: connectionId, key: c.key, ts: c.ts, nonce: c.nonce, mac: c.mac })
  if (error || !data) return { ok: false, reason: error?.message?.includes('NOT_FOUND') ? 'not_found' : 'database_error' }
  const ctx = data as Ctx
  if (ctx.status === 'disconnected' || !ctx.token_ciphertext) return { ok: false, reason: 'disconnected' }
  if (!ctx.accounts.length) return { ok: false, reason: 'no_linked_accounts' }
  const links = new Map(ctx.accounts.map((a) => [a.provider_account_id, a.bank_account_id]))
  let token: string
  try { token = decryptToken(ctx.token_ciphertext, cfg.tokenKeys) } catch { return { ok: false, reason: 'database_error', code: 'token' } }
  const plaid = plaidFor(cfg, fetcher)

  const apply = async (payload: Record<string, unknown>) => {
    const text = JSON.stringify(payload)
    const s = signer.apply(connectionId, text)
    const r = await supabase.rpc('bank_sync_apply', { connection: connectionId, payload: text, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    if (r.error) throw new Error('DB')
    return r.data as { added: number; duplicates: number; removed: number }
  }

  let cursor = ctx.cursor, pages = 0, added = 0, duplicates = 0, removed = 0, restarted = false
  try {
    for (;;) {
      let page
      try {
        page = await plaid.syncPage(token, cursor)
      } catch (e) {
        // the data changed while paging: start again from the last cursor written (once)
        if (e instanceof PlaidError && e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && !restarted) { restarted = true; continue }
        throw e
      }
      pages++
      const payload = pageToPayload(trigger, page.next_cursor, [...page.added, ...page.modified], page.removed.map((r) => r.transaction_id), links)
      const r = await apply(payload)
      added += r.added; duplicates += r.duplicates; removed += r.removed
      cursor = page.next_cursor
      if (!page.has_more || pages >= MAX_PAGES) break
    }
  } catch (e) {
    if (e instanceof PlaidError) {
      await apply({ trigger, status: 'failed', error_code: e.code }).catch(() => undefined)
      return { ok: false, reason: 'provider_error', code: e.code }
    }
    return { ok: false, reason: 'database_error' }
  }
  return { ok: true, added, duplicates, removed, pages }
}
