// RLS tests for clients, documents, payments and Company-assets storage,
// run against a real DEVELOPMENT Supabase project through the public API.
//
// Runs only when ALL of these are set in .env.local:
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
//   SUPABASE_SERVICE_ROLE_KEY (creates/deletes throw-away test users only),
//   RLS_TEST_PROJECT_REF = the dev project ref (the subdomain of the URL).
// The ref must match the URL, so the suite never runs against a project you
// did not name explicitly. It creates its own users/companies/rows and
// deletes them afterwards; it never reads or changes other data.
//
// Before migration 0005 is applied, failures here show the current gaps.
// Schema: as inspected on businessai-dev (documents.document_number and
// payments.document_id are NOT NULL; Company-assets has select + insert
// policies for owner/admin only, no update/delete).
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stagingEnv } from './staging-helpers'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const devRef = process.env.RLS_TEST_PROJECT_REF ?? ''
const urlRef = (() => {
  try { return new URL(url).hostname.split('.')[0] } catch { return '' }
})()
// Same decision as the other staging suites (also refuses the production ref).
const enabled = Boolean(url && anonKey && serviceKey && devRef && devRef === urlRef) && stagingEnv.enabled

const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = enabled ? createClient(url, serviceKey, opts) : (null as unknown as SupabaseClient)
const stamp = Date.now()
const password = `Test-passw0rd-${stamp}`
const BUCKET = 'Company-assets'

type U = { id: string; client: SupabaseClient; companyId: string }
type Rows = { clientId: string; documentId: string; paymentId: string }

async function makeUser(tag: string): Promise<U> {
  const email = `rls-biz-${tag}-${stamp}@example.test`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const client = createClient(url, anonKey, opts)
  const { error: e2 } = await client.auth.signInWithPassword({ email, password })
  if (e2) throw e2
  const { data: companyId, error: e3 } = await client.rpc('create_company', { company_name: `Biz ${tag} ${stamp}` })
  if (e3) throw e3
  // With billing (0010) a company needs a subscription to create records:
  // store what the Stripe webhook would store after Checkout.
  const billing = await admin.from('billing_plans').select('plan').limit(1)
  if (!billing.error) {
    const { error: e4 } = await admin.from('company_subscriptions').insert({
      company_id: companyId, stripe_customer_id: `cus_rls_${tag}_${stamp}`,
      stripe_subscription_id: `sub_rls_${tag}_${stamp}`, plan: 'pro', status: 'active',
    })
    if (e4) throw e4
  }
  return { id: data.user.id, client, companyId }
}

// Created through RLS as the owner, exactly as the app does.
async function seed(u: U): Promise<Rows> {
  const c = await u.client.from('clients').insert({ company_id: u.companyId, name: `Cliente ${stamp}` }).select('id').single()
  if (c.error) throw c.error
  const d = await u.client.from('documents').insert({
    company_id: u.companyId, client_id: c.data.id, document_type: 'invoice',
    document_number: `RLS-${stamp}-${u.id.slice(0, 8)}`,
    title: 'RLS test', total: 100, subtotal: 100, tax: 0, status: 'sent',
  }).select('id').single()
  if (d.error) throw d.error
  const p = await u.client.from('payments').insert({
    company_id: u.companyId, document_id: d.data.id, amount: 100, payment_method: 'manual', created_by: u.id,
  }).select('id').single()
  if (p.error) throw p.error
  return { clientId: c.data.id, documentId: d.data.id, paymentId: p.data.id }
}

const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })

let A: U, B: U, rowsA: Rows, rowsB: Rows
beforeAll(async () => {
  if (!enabled) return
  A = await makeUser('a')
  B = await makeUser('b')
  rowsA = await seed(A)
  rowsB = await seed(B)
})

afterAll(async () => {
  if (!enabled) return
  for (const u of [A, B]) {
    if (!u) continue
    const { data: files } = await admin.storage.from(BUCKET).list(u.companyId)
    if (files?.length) await admin.storage.from(BUCKET).remove(files.map((f) => `${u.companyId}/${f.name}`))
    await admin.from('payments').delete().eq('company_id', u.companyId)
    await admin.from('documents').delete().eq('company_id', u.companyId)
    await admin.from('clients').delete().eq('company_id', u.companyId)
    await admin.from('company_subscriptions').delete().eq('company_id', u.companyId)
    await admin.from('companies').delete().eq('id', u.companyId)
    await admin.auth.admin.deleteUser(u.id)
  }
})

describe.skipIf(!enabled)('business tables: tenant isolation', () => {
  it('A only sees its own clients, documents and payments', async () => {
    for (const [table, id] of [
      ['clients', rowsA.clientId], ['documents', rowsA.documentId], ['payments', rowsA.paymentId],
    ] as const) {
      const { data, error } = await A.client.from(table).select('id')
      expect(error).toBeNull()
      expect(data?.map((r) => r.id)).toEqual([id])
    }
  })

  it('A cannot read B rows by id', async () => {
    expect((await A.client.from('documents').select('id').eq('id', rowsB.documentId)).data).toEqual([])
    expect((await A.client.from('payments').select('id').eq('company_id', B.companyId)).data).toEqual([])
    expect((await A.client.from('clients').select('id').eq('id', rowsB.clientId)).data).toEqual([])
  })

  it('A cannot insert rows into B', async () => {
    expect((await A.client.from('clients').insert({ company_id: B.companyId, name: 'x' })).error).not.toBeNull()
    expect((await A.client.from('documents').insert({ company_id: B.companyId, document_type: 'invoice', document_number: `X-${stamp}` })).error).not.toBeNull()
    expect((await A.client.from('payments').insert({ company_id: B.companyId, document_id: rowsB.documentId, amount: 1, created_by: A.id })).error).not.toBeNull()
  })

  it('A cannot reference B rows from its own company', async () => {
    const doc = await A.client.from('documents').insert({ company_id: A.companyId, client_id: rowsB.clientId, document_type: 'invoice', document_number: `X2-${stamp}` })
    expect(doc.error).not.toBeNull()
    const pay = await A.client.from('payments').insert({ company_id: A.companyId, document_id: rowsB.documentId, amount: 1, created_by: A.id })
    expect(pay.error).not.toBeNull()
  })

  it('A cannot record a payment as another user', async () => {
    const r = await A.client.from('payments').insert({ company_id: A.companyId, document_id: rowsA.documentId, amount: 1, created_by: B.id })
    expect(r.error).not.toBeNull()
  })

  it('A cannot update or delete B rows', async () => {
    await A.client.from('documents').update({ total: 0 }).eq('id', rowsB.documentId)
    await A.client.from('clients').update({ name: 'HACKED' }).eq('id', rowsB.clientId)
    await A.client.from('documents').delete().eq('id', rowsB.documentId)
    const doc = await admin.from('documents').select('total').eq('id', rowsB.documentId).single()
    const cli = await admin.from('clients').select('name').eq('id', rowsB.clientId).single()
    expect(Number(doc.data?.total)).toBe(100)
    expect(cli.data?.name).not.toBe('HACKED')
  })

  it('A cannot move its own document to B', async () => {
    const r = await A.client.from('documents').update({ company_id: B.companyId }).eq('id', rowsA.documentId)
    expect(r.error).not.toBeNull()
  })

  it('payments are append-only for app users', async () => {
    await A.client.from('payments').update({ amount: 1 }).eq('id', rowsA.paymentId)
    await A.client.from('payments').delete().eq('id', rowsA.paymentId)
    const p = await admin.from('payments').select('amount').eq('id', rowsA.paymentId).single()
    expect(Number(p.data?.amount)).toBe(100)
  })

  it('anonymous users read nothing', async () => {
    const anon = createClient(url, anonKey, opts)
    for (const table of ['clients', 'documents', 'payments'] as const) {
      const r = await anon.from(table).select('id')
      expect(r.data ?? []).toEqual([])
    }
  })
})

describe.skipIf(!enabled)('Company-assets storage: company folders', () => {
  it('owner uploads into its own company folder (new path each time, as the app does)', async () => {
    const path = `${A.companyId}/logo-test-${stamp}.png`
    expect((await A.client.storage.from(BUCKET).upload(path, png, { upsert: true })).error).toBeNull()
  })

  it('A cannot upload into B, the bucket root or a non-company folder', async () => {
    for (const path of [`${B.companyId}/evil-${stamp}.png`, `root-${stamp}.png`, `not-a-uuid/x-${stamp}.png`]) {
      expect((await A.client.storage.from(BUCKET).upload(path, png)).error).not.toBeNull()
    }
  })

  it('A cannot list, overwrite or delete B assets', async () => {
    const path = `${B.companyId}/logo-b-${stamp}.png`
    expect((await B.client.storage.from(BUCKET).upload(path, png)).error).toBeNull()
    const listed = await A.client.storage.from(BUCKET).list(B.companyId)
    expect(listed.data ?? []).toEqual([])
    expect((await A.client.storage.from(BUCKET).upload(path, png, { upsert: true })).error).not.toBeNull()
    await A.client.storage.from(BUCKET).remove([path])
    const still = await admin.storage.from(BUCKET).list(B.companyId)
    expect(still.data?.some((f) => path.endsWith(f.name))).toBe(true)
  })

  it('anonymous users cannot upload', async () => {
    const anon = createClient(url, anonKey, opts)
    expect((await anon.storage.from(BUCKET).upload(`${A.companyId}/anon-${stamp}.png`, png)).error).not.toBeNull()
  })
})
