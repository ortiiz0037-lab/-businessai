// Role permissions (owner / admin / member) against the STAGING project,
// through the public API with real sessions. TEST-ONLY, temporary data
// (prefix `e3-roles`, see tests/staging-helpers.ts), removed afterwards.
//
// Expected matrix = today's behaviour, unchanged by 0014a:
//   owner, admin : everything below;
//   member       : read, create and edit, record payments, write the deletion
//                  log — but NOT delete clients/documents, NOT change the
//                  company or its profile.
//   nobody       : modify or delete payments, change roles.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blocked, createFixture, stagingEnv, type Actor, type Company } from './staging-helpers'

const enabled = stagingEnv.enabled
const fx = enabled ? createFixture('e3-roles') : (null as unknown as ReturnType<typeof createFixture>)

let A: Company, B: Company, O: Actor, AD: Actor, M: Actor, OB: Actor
let seed: { clientId: string; documentId: string; paymentId: string }
const n = (tag: string) => `${tag}-${fx.stamp}`

beforeAll(async () => {
  if (!enabled) return
  A = await fx.makeCompany('a')
  B = await fx.makeCompany('b')
  O = A.owner
  OB = B.owner
  AD = await fx.addMember(A, 'a-admin', 'admin')
  M = await fx.addMember(A, 'a-member', 'member')
  const c = await O.client.from('clients').insert({ company_id: A.id, name: `Cliente ${n('seed')}` }).select('id').single()
  if (c.error) throw c.error
  const d = await O.client.from('documents').insert({
    company_id: A.id, client_id: c.data.id, document_type: 'invoice', document_number: n('SEED'),
    title: 'e3 roles', total: 100, subtotal: 100, tax: 0, status: 'sent',
  }).select('id').single()
  if (d.error) throw d.error
  const p = await O.client.from('payments').insert({
    company_id: A.id, document_id: d.data.id, amount: 100, payment_method: 'manual', created_by: O.id,
  }).select('id').single()
  if (p.error) throw p.error
  seed = { clientId: c.data.id, documentId: d.data.id, paymentId: p.data.id }
}, 120000)

afterAll(async () => {
  if (enabled) await fx.cleanup()
}, 120000)

const roles = () => [['owner', O], ['admin', AD], ['member', M]] as const

describe.skipIf(!enabled)('roles inside one company (owner, admin, member)', () => {
  it('every role reads the company, members, subscription and business rows', async () => {
    for (const [role, u] of roles()) {
      expect((await u.client.from('companies').select('id').eq('id', A.id)).data, role).toHaveLength(1)
      expect((await u.client.from('memberships').select('user_id').eq('company_id', A.id)).data, role).toHaveLength(3)
      expect((await u.client.from('company_subscriptions').select('company_id').eq('company_id', A.id)).data, role).toHaveLength(1)
      expect((await u.client.from('clients').select('id').eq('id', seed.clientId)).data, role).toHaveLength(1)
      expect((await u.client.from('documents').select('id').eq('id', seed.documentId)).data, role).toHaveLength(1)
      expect((await u.client.from('payments').select('id').eq('id', seed.paymentId)).data, role).toHaveLength(1)
    }
  })

  it('every role creates and edits clients and documents and records its own payments', async () => {
    for (const [role, u] of roles()) {
      const c = await u.client.from('clients').insert({ company_id: A.id, name: `C ${n(role)}` }).select('id').single()
      expect(c.error, role).toBeNull()
      const ce = await u.client.from('clients').update({ name: `C2 ${n(role)}` }).eq('id', c.data!.id).select('id')
      expect(ce.data, role).toHaveLength(1)
      const d = await u.client.from('documents').insert({
        company_id: A.id, client_id: c.data!.id, document_type: 'invoice', document_number: n(`R-${role}`),
        title: 'role', total: 10, subtotal: 10, tax: 0, status: 'draft',
      }).select('id').single()
      expect(d.error, role).toBeNull()
      const de = await u.client.from('documents').update({ title: `edited by ${role}` }).eq('id', d.data!.id).select('id')
      expect(de.data, role).toHaveLength(1)
      const p = await u.client.from('payments').insert({
        company_id: A.id, document_id: seed.documentId, amount: 1, payment_method: 'manual', created_by: u.id,
      })
      expect(p.error, role).toBeNull()
    }
  })

  it('only owner and admin delete clients and documents', async () => {
    for (const [role, u] of roles()) {
      const c = await O.client.from('clients').insert({ company_id: A.id, name: `Del ${n(role)}` }).select('id').single()
      const d = await O.client.from('documents').insert({
        company_id: A.id, document_type: 'quote', document_number: n(`DEL-${role}`),
        title: 'to delete', total: 1, subtotal: 1, tax: 0, status: 'draft',
      }).select('id').single()
      expect(c.error).toBeNull()
      expect(d.error).toBeNull()
      await u.client.from('documents').delete().eq('id', d.data!.id)
      await u.client.from('clients').delete().eq('id', c.data!.id)
      const docLeft = (await fx.admin.from('documents').select('id').eq('id', d.data!.id)).data ?? []
      const cliLeft = (await fx.admin.from('clients').select('id').eq('id', c.data!.id)).data ?? []
      const expectedLeft = role === 'member' ? 1 : 0
      expect(docLeft, `${role} document`).toHaveLength(expectedLeft)
      expect(cliLeft, `${role} client`).toHaveLength(expectedLeft)
    }
  })

  it('only owner and admin change the company and its profile', async () => {
    const before = (await fx.admin.from('companies').select('name').eq('id', A.id).single()).data!.name
    for (const [role, u] of roles()) {
      const r = await u.client.from('companies').update({ name: `${before} ${role}` }).eq('id', A.id).select('id')
      expect(blocked(r), role).toBe(role === 'member')
    }
    expect((await fx.admin.from('companies').select('name').eq('id', A.id).single()).data!.name).toBe(`${before} admin`)

    expect(blocked(await M.client.from('company_profiles').insert({ company_id: A.id, display_name: 'member' }).select('company_id'))).toBe(true)
    const ins = await O.client.from('company_profiles').insert({ company_id: A.id, display_name: 'owner' }).select('company_id')
    expect(ins.error).toBeNull()
    expect((await AD.client.from('company_profiles').update({ display_name: 'admin' }).eq('company_id', A.id).select('company_id')).data).toHaveLength(1)
    expect(blocked(await M.client.from('company_profiles').update({ display_name: 'member' }).eq('company_id', A.id).select('company_id'))).toBe(true)
    expect((await fx.admin.from('company_profiles').select('display_name').eq('company_id', A.id).single()).data!.display_name).toBe('admin')
    for (const [role, u] of roles()) {
      expect((await u.client.from('company_profiles').select('company_id').eq('company_id', A.id)).data, role).toHaveLength(1)
    }
  })

  it('no role modifies or deletes payments', async () => {
    for (const [role, u] of roles()) {
      await u.client.from('payments').update({ amount: 1 }).eq('id', seed.paymentId)
      await u.client.from('payments').delete().eq('id', seed.paymentId)
      const p = await fx.admin.from('payments').select('amount').eq('id', seed.paymentId).single()
      expect(Number(p.data?.amount), role).toBe(100)
    }
  })

  it('no role changes roles or adds itself to another company', async () => {
    for (const [role, u] of roles()) {
      expect(blocked(await u.client.from('memberships').update({ role: 'owner' }).eq('company_id', A.id).select('user_id')), role).toBe(true)
      expect((await u.client.from('memberships').insert({ company_id: B.id, user_id: u.id, role: 'member' })).error, role).not.toBeNull()
    }
    const rows = (await fx.admin.from('memberships').select('user_id, role').eq('company_id', A.id)).data ?? []
    expect(Object.fromEntries(rows.map((r) => [r.user_id, r.role]))).toEqual({ [O.id]: 'owner', [AD.id]: 'admin', [M.id]: 'member' })
  })

  it('every role writes the deletion log, only in its own name', async () => {
    for (const [role, u] of roles()) {
      const ok = await u.client.from('document_deletion_audit').insert({
        company_id: A.id, document_id: seed.documentId, reason: `e3 ${role}`, deleted_by: u.id,
      })
      expect(ok.error, role).toBeNull()
      const forged = await u.client.from('document_deletion_audit').insert({
        company_id: A.id, document_id: seed.documentId, reason: 'forged', deleted_by: OB.id,
      })
      expect(forged.error, role).not.toBeNull()
      expect((await u.client.from('document_deletion_audit').select('id').eq('company_id', A.id)).data!.length, role).toBeGreaterThan(0)
    }
  })
})

describe.skipIf(!enabled)('another company owner in company A', () => {
  it('reads nothing of A and cannot write into it', async () => {
    for (const table of ['companies', 'memberships', 'company_subscriptions', 'clients', 'documents', 'payments', 'company_profiles', 'document_deletion_audit'] as const) {
      const column = table === 'companies' ? 'id' : 'company_id'
      expect((await OB.client.from(table).select(column).eq(column, A.id)).data ?? [], table).toEqual([])
    }
    expect((await OB.client.from('clients').insert({ company_id: A.id, name: 'x' })).error).not.toBeNull()
    expect(blocked(await OB.client.from('clients').update({ name: 'HACKED' }).eq('id', seed.clientId).select('id'))).toBe(true)
    await OB.client.from('clients').delete().eq('id', seed.clientId)
    expect((await fx.admin.from('clients').select('id').eq('id', seed.clientId)).data).toHaveLength(1)
  })
})
