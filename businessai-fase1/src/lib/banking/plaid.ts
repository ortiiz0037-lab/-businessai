/**
 * Plaid adapter (SERVER ONLY), plain REST over fetch. The customer's bank
 * credentials are entered ONLY in Plaid Link (Plaid's own interface); this
 * server receives a public token, exchanges it for an access token and keeps
 * it encrypted. Errors are reduced to Plaid's error code: no secret, token or
 * account number is ever logged or returned.
 *
 * Endpoints used: /link/token/create, /item/public_token/exchange, /accounts/get,
 * /institutions/get_by_id, /transactions/sync, /item/remove,
 * /webhook_verification_key/get and, in sandbox / the local double only,
 * /sandbox/public_token/create.
 */
export type PlaidSettings = { clientId: string; secret: string; baseURL: string; countryCodes: string[]; webhookURL: string | null; environment: string }

export class PlaidError extends Error {
  constructor(readonly code: string, readonly type: string, readonly status: number) { super(code) }
}

export type PlaidAccount = { account_id: string; name: string; official_name?: string | null; mask: string | null; type: string | null; subtype: string | null
  balances?: { iso_currency_code?: string | null } }
export type PlaidTxn = { transaction_id: string; account_id: string; amount: number; iso_currency_code: string | null; unofficial_currency_code?: string | null
  date: string; authorized_date?: string | null; name: string | null; merchant_name?: string | null; pending: boolean
  payment_meta?: { reference_number?: string | null } | null; check_number?: string | null }
export type SyncPage = { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[]; next_cursor: string; has_more: boolean }

export class PlaidClient {
  constructor(private readonly s: PlaidSettings, private readonly fetcher: typeof fetch = fetch) {}

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await this.fetcher(`${this.s.baseURL}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'Plaid-Version': '2020-09-14' },
        body: JSON.stringify({ client_id: this.s.clientId, secret: this.s.secret, ...body }), signal: AbortSignal.timeout(30000),
      })
    } catch {
      throw new PlaidError('PROVIDER_UNREACHABLE', 'NETWORK', 0)
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !data) {
      const code = typeof data?.error_code === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.error_code) ? data.error_code : `HTTP_${res.status}`
      const type = typeof data?.error_type === 'string' && /^[A-Z0-9_]{1,40}$/.test(data.error_type) ? data.error_type : 'API_ERROR'
      throw new PlaidError(code, type, res.status)
    }
    return data as T
  }

  linkToken(input: { userId: string; language: 'es' | 'en'; accessToken?: string }) {
    return this.call<{ link_token: string; expiration: string }>('/link/token/create', {
      client_name: 'BusinessAI', language: input.language, country_codes: this.s.countryCodes, user: { client_user_id: input.userId },
      ...(input.accessToken ? { access_token: input.accessToken } : { products: ['transactions'], transactions: { days_requested: 90 } }),
      ...(this.s.webhookURL ? { webhook: this.s.webhookURL } : {}),
    })
  }
  exchange(publicToken: string) {
    return this.call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken })
  }
  accounts(accessToken: string) {
    return this.call<{ accounts: PlaidAccount[]; item: { item_id: string; institution_id?: string | null } }>('/accounts/get', { access_token: accessToken })
  }
  async institutionName(institutionId: string): Promise<string | null> {
    try {
      const r = await this.call<{ institution: { name: string } }>('/institutions/get_by_id', { institution_id: institutionId, country_codes: this.s.countryCodes })
      return r.institution?.name ?? null
    } catch { return null }
  }
  syncPage(accessToken: string, cursor: string | null) {
    return this.call<SyncPage>('/transactions/sync', { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 })
  }
  remove(accessToken: string) {
    return this.call<{ request_id: string }>('/item/remove', { access_token: accessToken })
  }
  verificationKey(keyId: string) {
    return this.call<{ key: JsonWebKey & { kid: string; alg: string; expired_at: number | null } }>('/webhook_verification_key/get', { key_id: keyId })
  }
  /** Sandbox and the local test double only: a public token without the Link interface. */
  sandboxPublicToken(institutionId = 'ins_109508') {
    if (this.s.environment === 'production') throw new PlaidError('NOT_ALLOWED_IN_PRODUCTION', 'INVALID_REQUEST', 400)
    return this.call<{ public_token: string }>('/sandbox/public_token/create', {
      institution_id: institutionId, initial_products: ['transactions'], ...(this.s.webhookURL ? { options: { webhook: this.s.webhookURL } } : {}),
    })
  }
}

/** Plaid amounts are positive when money LEAVES the account; BusinessAI stores money in as positive cents. */
export function toBankRow(t: PlaidTxn) {
  const cents = -Math.round(t.amount * 100)
  const reference = t.payment_meta?.reference_number || t.check_number || null
  return {
    date: t.date, amount_cents: String(cents), description: (t.merchant_name || t.name || '—').slice(0, 500),
    reference: reference ? String(reference).slice(0, 120) : null, bank_txn_id: t.transaction_id,
    raw: { provider: 'plaid', name: t.name ?? null, merchant: t.merchant_name ?? null, currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null, authorized_date: t.authorized_date ?? null },
  }
}

/** The item-level conditions that need the customer to reconnect (Link update mode). */
export const RECONNECT_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'USER_PERMISSION_REVOKED', 'ACCESS_NOT_GRANTED', 'INVALID_CREDENTIALS', 'INSUFFICIENT_CREDENTIALS'])
