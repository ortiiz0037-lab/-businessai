// Requiere la migración aplicada y SUPABASE_SERVICE_ROLE_KEY (solo para crear/borrar usuarios de prueba).
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)
const admin = hasEnv ? createClient(url, serviceKey!, opts) : (null as unknown as SupabaseClient)
const stamp = Date.now()
const password = `Test-passw0rd-${stamp}`

type U = { id: string; client: SupabaseClient; companyId: string }
async function makeUser(tag: string): Promise<U> {
  const email = `rls-${tag}-${stamp}@example.test`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const client = createClient(url, anonKey, opts)
  const { error: e2 } = await client.auth.signInWithPassword({ email, password })
  if (e2) throw e2
  const { data: companyId, error: e3 } = await client.rpc('create_company', { company_name: `Empresa ${tag} ${stamp}` })
  if (e3) throw e3
  return { id: data.user.id, client, companyId }
}
const blocked = (r: { error: unknown; data: unknown }) =>
  r.error !== null || (Array.isArray(r.data) ? r.data.length === 0 : r.data === null)

let A: U, B: U
beforeAll(async () => {
  if (!hasEnv) return
  A = await makeUser('a')
  B = await makeUser('b')
})
afterAll(async () => {
  if (!hasEnv) return
  await admin.from('companies').delete().in('id', [A?.companyId, B?.companyId].filter(Boolean))
  for (const u of [A, B]) if (u) await admin.auth.admin.deleteUser(u.id)
})

describe.skipIf(!hasEnv)('aislamiento entre empresas', () => {
  it('A solo ve su empresa', async () => {
    const { data } = await A.client.from('companies').select('id')
    expect(data?.map((c) => c.id)).toEqual([A.companyId])
  })
  it('A no puede leer la empresa de B por id', async () => {
    const r = await A.client.from('companies').select('*').eq('id', B.companyId)
    expect(r.data).toEqual([])
  })
  it('A no ve memberships de B', async () => {
    const r = await A.client.from('memberships').select('*').eq('company_id', B.companyId)
    expect(r.data).toEqual([])
  })
  it('A no puede modificar la empresa de B', async () => {
    const r = await A.client.from('companies').update({ name: 'HACKEADA' }).eq('id', B.companyId).select()
    expect(blocked(r)).toBe(true)
    const { data } = await admin.from('companies').select('name').eq('id', B.companyId).single()
    expect(data?.name).not.toBe('HACKEADA')
  })
  it('A no puede borrar la empresa de B', async () => {
    await A.client.from('companies').delete().eq('id', B.companyId)
    const { data } = await admin.from('companies').select('id').eq('id', B.companyId)
    expect(data).toHaveLength(1)
  })
  it('A no puede añadirse como miembro de B', async () => {
    const r = await A.client.from('memberships').insert({ company_id: B.companyId, user_id: A.id, role: 'owner' })
    expect(r.error).not.toBeNull()
  })
  it('A no puede cambiar roles en memberships', async () => {
    const r = await A.client.from('memberships').update({ role: 'member' }).eq('company_id', A.companyId).select()
    expect(blocked(r)).toBe(true)
  })
  it('nadie inserta empresas directamente', async () => {
    const r = await A.client.from('companies').insert({ name: 'Directa', created_by: A.id })
    expect(r.error).not.toBeNull()
  })
  it('create_company valida el nombre', async () => {
    const r = await A.client.rpc('create_company', { company_name: 'x' })
    expect(r.error).not.toBeNull()
  })
  it('anónimo no lee ni crea nada', async () => {
    const anon = createClient(url, anonKey, opts)
    expect((await anon.from('companies').select('*')).data ?? []).toEqual([])
    expect((await anon.rpc('create_company', { company_name: 'Anon Co' })).error).not.toBeNull()
  })
  it('A es owner de su empresa', async () => {
    const { data } = await A.client.from('memberships').select('role').eq('company_id', A.companyId).eq('user_id', A.id).single()
   expect(data?.role).toBe('owner')
  })
})
