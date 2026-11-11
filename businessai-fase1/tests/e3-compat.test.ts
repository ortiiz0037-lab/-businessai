// E3 (0014a_permissions) compatibility against the STAGING project, through
// the public API. TEST-ONLY, temporary data (prefix `e3-compat`), removed
// afterwards. The catalog itself (policies, function attributes) is checked
// read-only in SQL by supabase/inspect/verify_0014a.sql (staging:check).
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blocked, createFixture, opts, stagingEnv, type Actor, type Company } from './staging-helpers'

const enabled = stagingEnv.enabled
const fx = enabled ? createFixture('e3-compat') : (null as unknown as ReturnType<typeof createFixture>)

// The matrix declared by 0014a: owner = admin = all 18; member lacks these 5.
// 0015 (detected by its documents.void permission) adds documents.void for
// owner and admin, and takes billing.manage away from admin (owner decision).
const MEMBER_LACKS = ['billing.manage', 'clients.delete', 'company.branding.manage', 'company.settings.manage', 'documents.delete', 'documents.void']
const has0015 = (keys: string[]) => keys.includes('documents.void')
const adminLacks = (keys: string[]) => (has0015(keys) ? ['billing.manage'] : [])
const matrixRows = (keys: string[]) => (has0015(keys) ? 50 : 49)

let A: Company, B: Company, O: Actor, AD: Actor, M: Actor, OB: Actor
let clientId = ''
let keys: string[] = []

beforeAll(async () => {
  if (!enabled) return
  A = await fx.makeCompany('a')
  B = await fx.makeCompany('b')
  O = A.owner
  OB = B.owner
  AD = await fx.addMember(A, 'a-admin', 'admin')
  M = await fx.addMember(A, 'a-member', 'member')
  const c = await O.client.from('clients').insert({ company_id: A.id, name: `Cliente e3-compat ${fx.stamp}` }).select('id').single()
  if (c.error) throw c.error
  clientId = c.data.id
}, 120000)

afterAll(async () => {
  if (!enabled) return
  // Never leave a suspended membership behind (it would block the 0014a rollback).
  if (M) await fx.admin.from('memberships').update({ status: 'active' }).eq('user_id', M.id)
  await fx.cleanup()
}, 120000)

describe.skipIf(!enabled)('permission catalog', () => {
  it('authenticated users read the catalog and the matrix (0014a: 18 / 49; with 0015: 19 / 50)', async () => {
    const p = await M.client.from('permissions').select('key')
    expect(p.error).toBeNull()
    keys = (p.data ?? []).map((r) => r.key).sort()
    expect(keys).toHaveLength(has0015(keys) ? 19 : 18)
    const rp = await M.client.from('role_permissions').select('role, permission_key')
    expect(rp.error).toBeNull()
    const by = (role: string) => (rp.data ?? []).filter((r) => r.role === role).map((r) => r.permission_key).sort()
    expect(by('owner')).toEqual(keys)
    expect(by('admin')).toEqual(keys.filter((k) => !adminLacks(keys).includes(k)))
    expect(by('member')).toEqual(keys.filter((k) => !MEMBER_LACKS.includes(k)))
    expect(rp.data).toHaveLength(matrixRows(keys))
  })

  it('nobody but the service role writes the catalog; anon cannot read it', async () => {
    for (const u of [O, AD, M]) {
      expect((await u.client.from('role_permissions').insert({ role: 'member', permission_key: 'clients.delete' })).error).not.toBeNull()
      await u.client.from('role_permissions').delete().eq('role', 'member')
      expect((await u.client.from('permissions').insert({ key: 'x.y', module: 'x', description_es: 'x', description_en: 'x' })).error).not.toBeNull()
    }
    expect((await fx.admin.from('role_permissions').select('role')).data).toHaveLength(matrixRows(keys))
    const anon = createClient(stagingEnv.enabled ? stagingEnv.url : '', stagingEnv.enabled ? stagingEnv.anonKey : '', opts)
    expect((await anon.from('permissions').select('key')).data ?? []).toEqual([])
    expect((await anon.from('role_permissions').select('role')).data ?? []).toEqual([])
  })
})

describe.skipIf(!enabled)('has_permission()', () => {
  it('matches the matrix for owner, admin and member × every permission', async () => {
    const mismatches: string[] = []
    for (const [role, u] of [['owner', O], ['admin', AD], ['member', M]] as const) {
      for (const key of keys) {
        const { data, error } = await u.client.rpc('has_permission', { target: A.id, permission: key })
        const expected = role === 'owner' || (role === 'admin' ? !adminLacks(keys).includes(key) : !MEMBER_LACKS.includes(key))
        if (error || data !== expected) mismatches.push(`${role}:${key}=${error ? error.message : data}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('is false for another company, an unknown permission and no company; anon cannot call it', async () => {
    expect((await OB.client.rpc('has_permission', { target: A.id, permission: 'company.view' })).data).toBe(false)
    expect((await O.client.rpc('has_permission', { target: B.id, permission: 'company.view' })).data).toBe(false)
    expect((await O.client.rpc('has_permission', { target: A.id, permission: 'no.such.permission' })).data).toBe(false)
    expect((await O.client.rpc('has_permission', { target: null, permission: 'company.view' })).data).toBe(false)
    const anon = createClient(stagingEnv.enabled ? stagingEnv.url : '', stagingEnv.enabled ? stagingEnv.anonKey : '', opts)
    expect((await anon.rpc('has_permission', { target: A.id, permission: 'company.view' })).error).not.toBeNull()
  })
})

describe.skipIf(!enabled)('membership status', () => {
  it('new and existing memberships are active; create_company makes an active owner', async () => {
    const rows = (await fx.admin.from('memberships').select('user_id, role, status').eq('company_id', A.id)).data ?? []
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.status === 'active')).toBe(true)
    expect(rows.find((r) => r.user_id === O.id)?.role).toBe('owner')
  })

  it('a suspended member loses access to everything but its own membership row, and gets it back', async () => {
    const s = await fx.admin.from('memberships').update({ status: 'suspended' }).eq('company_id', A.id).eq('user_id', M.id).select('status')
    expect(s.data).toEqual([{ status: 'suspended' }])
    try {
      expect((await M.client.rpc('has_permission', { target: A.id, permission: 'company.view' })).data).toBe(false)
      for (const table of ['companies', 'clients', 'documents', 'payments', 'company_subscriptions'] as const) {
        const column = table === 'companies' ? 'id' : 'company_id'
        expect((await M.client.from(table).select(column).eq(column, A.id)).data ?? [], table).toEqual([])
      }
      expect((await M.client.from('clients').insert({ company_id: A.id, name: 'suspended' })).error).not.toBeNull()
      expect(blocked(await M.client.from('clients').update({ name: 'suspended' }).eq('id', clientId).select('id'))).toBe(true)
      const own = (await M.client.from('memberships').select('user_id, status').eq('company_id', A.id)).data ?? []
      expect(own).toEqual([{ user_id: M.id, status: 'suspended' }])
      // Others in the company are not affected.
      expect((await AD.client.from('clients').select('id').eq('id', clientId)).data).toHaveLength(1)
    } finally {
      await fx.admin.from('memberships').update({ status: 'active' }).eq('company_id', A.id).eq('user_id', M.id)
    }
    expect((await M.client.from('clients').select('id').eq('id', clientId)).data).toHaveLength(1)
    expect((await M.client.rpc('has_permission', { target: A.id, permission: 'company.view' })).data).toBe(true)
  })

  it('status only accepts active or suspended, and members cannot change their own status', async () => {
    const bad = await fx.admin.from('memberships').update({ status: 'paused' }).eq('company_id', A.id).eq('user_id', M.id)
    expect(bad.error).not.toBeNull()
    expect(blocked(await M.client.from('memberships').update({ status: 'suspended' }).eq('user_id', M.id).select('user_id'))).toBe(true)
    expect(blocked(await O.client.from('memberships').update({ status: 'suspended' }).eq('user_id', M.id).select('user_id'))).toBe(true)
  })
})

describe.skipIf(!enabled)('data integrity on staging (read-only)', () => {
  it('no membership outside this run is suspended or has an unknown role', async () => {
    const ours = [A.id, B.id]
    const suspended = (await fx.admin.from('memberships').select('company_id').neq('status', 'active')).data ?? []
    expect(suspended.filter((r) => !ours.includes(r.company_id))).toEqual([])
    const roles = (await fx.admin.from('memberships').select('role').not('role', 'in', '(owner,admin,member)')).data ?? []
    expect(roles).toEqual([])
  })

  it('the app reads stay compatible: billing state and usage for every role', async () => {
    for (const u of [O, AD, M]) {
      expect((await u.client.rpc('company_billing_state', { target: A.id })).error).toBeNull()
      expect((await u.client.rpc('company_usage', { target: A.id })).error).toBeNull()
    }
    expect((await OB.client.rpc('company_billing_state', { target: A.id })).data ?? []).toEqual([])
  })
})
