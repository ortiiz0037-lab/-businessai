#!/usr/bin/env node
/**
 * "BusinessAI Demo (QA)" — a demo company in STAGING with fictitious,
 * clearly identified data (scripts/staging/demo-data.mjs), so the dashboard
 * can be tried with content from an iPhone / iPad.
 *
 *   node scripts/staging/demo-company.mjs create   # (re)creates it
 *   node scripts/staging/demo-company.mjs remove   # deletes it completely
 *
 * Required: STAGING_PROJECT_REF, STAGING_SUPABASE_URL,
 *           STAGING_SUPABASE_SERVICE_ROLE_KEY, PINNED_STAGING_REF,
 *           PRODUCTION_PROJECT_REF (refused).
 * Optional: STAGING_DEMO_MEMBER_EMAIL — the staging account that gets access
 *           (as admin). Without it, the only staging account that is not a
 *           test account (@example.test) is used; with zero or several, none.
 *
 * Isolation and safety:
 *   * Staging only: the URL must be https://<pinned staging ref>.supabase.co
 *     and the production ref is refused.
 *   * The demo company belongs to a dedicated demo owner account
 *     (demo-owner@businessai-demo.example.test, random password never
 *     printed or stored). It is only ever found, refreshed or deleted by its
 *     exact name AND that owner: nothing else is read for deletion.
 *   * No Stripe call: the subscription row has fake ids (cus_demo_qa_…).
 *   * Emails are printed masked; keys are never printed.
 */
import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildDemoData, DEMO_COMPANY_NAME } from './demo-data.mjs'

export const DEMO_OWNER_EMAIL = 'demo-owner@businessai-demo.example.test'

const out = (msg) => console.log(msg)
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1) }

/** j***@g***.com — never the full address. */
export function maskEmail(email) {
  const [user = '', domain = ''] = String(email).split('@')
  const [host = '', ...rest] = domain.split('.')
  return `${user.charAt(0)}***@${host.charAt(0)}***.${rest.join('.') || '***'}`
}

/** Pure guard: returns an error message or null. */
export function checkTarget(env) {
  const ref = env.STAGING_PROJECT_REF ?? ''
  if (!ref || !env.STAGING_SUPABASE_URL || !env.STAGING_SUPABASE_SERVICE_ROLE_KEY) return 'missing staging environment'
  if (!env.PINNED_STAGING_REF || ref !== env.PINNED_STAGING_REF) return 'STAGING_PROJECT_REF is not the pinned staging project'
  if (!env.PRODUCTION_PROJECT_REF || ref === env.PRODUCTION_PROJECT_REF) return 'refusing the production project'
  if (env.STAGING_SUPABASE_URL.replace(/\/$/, '') !== `https://${ref}.supabase.co`) return 'STAGING_SUPABASE_URL is not the staging project'
  if ([env.STAGING_SUPABASE_URL].some((v) => v.includes(env.PRODUCTION_PROJECT_REF))) return 'a URL mentions the production project'
  return null
}

async function listAllUsers(admin) {
  const users = []
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) fail(`list users: ${error.message}`)
    users.push(...data.users)
    if (data.users.length < 200) break
  }
  return users
}

async function findDemo(admin) {
  const users = await listAllUsers(admin)
  const owner = users.find((u) => u.email === DEMO_OWNER_EMAIL) ?? null
  if (!owner) return { users, owner: null, companyIds: [] }
  const { data, error } = await admin.from('companies').select('id').eq('name', DEMO_COMPANY_NAME).eq('created_by', owner.id)
  if (error) fail(`find demo company: ${error.message}`)
  return { users, owner, companyIds: (data ?? []).map((c) => c.id) }
}

async function removeDemo(admin) {
  const { owner, companyIds } = await findDemo(admin)
  for (const id of companyIds) {
    for (const table of ['payments', 'document_deletion_audit', 'documents', 'clients', 'company_profiles', 'company_subscriptions', 'memberships']) {
      const { error } = await admin.from(table).delete().eq('company_id', id)
      if (error) fail(`delete ${table}: ${error.message}`)
    }
    const { error } = await admin.from('companies').delete().eq('id', id).eq('name', DEMO_COMPANY_NAME)
    if (error) fail(`delete company: ${error.message}`)
  }
  if (owner) {
    const { error } = await admin.auth.admin.deleteUser(owner.id)
    if (error) fail(`delete demo owner: ${error.message}`)
  }
  out(`Removed: ${companyIds.length} demo company(ies)${owner ? ' and the demo owner account' : ''}.`)
}

async function insertAll(admin, table, rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from(table).insert(rows.slice(i, i + 200))
    if (error) fail(`insert ${table}: ${error.message}`)
  }
}

async function createDemo(admin, env) {
  await removeDemo(admin) // refresh: always start clean
  const { data: created, error: e1 } = await admin.auth.admin.createUser({
    email: DEMO_OWNER_EMAIL,
    password: randomBytes(24).toString('base64url'),
    email_confirm: true,
    user_metadata: { full_name: 'Demo QA', demo: true },
  })
  if (e1) fail(`create demo owner: ${e1.message}`)
  const ownerId = created.user.id

  const data = buildDemoData(new Date(), randomUUID)
  const companyId = randomUUID()
  const steps = [
    ['companies', [{ id: companyId, name: DEMO_COMPANY_NAME, created_by: ownerId }]],
    ['memberships', [{ company_id: companyId, user_id: ownerId, role: 'owner' }]],
    ['company_subscriptions', [{
      company_id: companyId, stripe_customer_id: `cus_demo_qa_${Date.now()}`, stripe_subscription_id: `sub_demo_qa_${Date.now()}`,
      plan: 'premium', status: 'active',
    }]],
    ['clients', data.clients.map((c) => ({ ...c, company_id: companyId }))],
    ['documents', data.documents.map((d) => ({ ...d, company_id: companyId, created_by: ownerId }))],
    ['payments', data.payments.map((p) => ({ ...p, company_id: companyId, created_by: ownerId }))],
  ]
  for (const [table, rows] of steps) await insertAll(admin, table, rows)
  out(`Created "${DEMO_COMPANY_NAME}": ${data.clients.length} clients, ${data.documents.length} documents, ${data.payments.length} payments (fictitious).`)

  // Give the tester access (admin of the demo company only).
  const { users } = await findDemo(admin)
  const real = users.filter((u) => u.email && !u.email.endsWith('@example.test') && !u.email.endsWith('.example.test'))
  const wanted = env.STAGING_DEMO_MEMBER_EMAIL
    ? real.filter((u) => u.email.toLowerCase() === env.STAGING_DEMO_MEMBER_EMAIL.toLowerCase())
    : real
  if (wanted.length !== 1) {
    out(`Access: ${wanted.length === 0 ? 'no' : 'several'} staging account(s) found — set STAGING_DEMO_MEMBER_EMAIL to choose one. The demo company exists but nobody was added.`)
    return
  }
  const { error: e2 } = await admin.from('memberships').insert({ company_id: companyId, user_id: wanted[0].id, role: 'admin' })
  if (e2) fail(`add tester: ${e2.message}`)
  out(`Access: ${maskEmail(wanted[0].email)} added as admin of the demo company. In the app: menu → company → "${DEMO_COMPANY_NAME}".`)
}

async function main() {
  const mode = process.argv[2]
  if (mode !== 'create' && mode !== 'remove') fail('usage: demo-company.mjs create|remove')
  const problem = checkTarget(process.env)
  if (problem) fail(problem)
  out(`Target: staging project ${process.env.STAGING_PROJECT_REF}; production ${process.env.PRODUCTION_PROJECT_REF} refused.`)
  const admin = createClient(process.env.STAGING_SUPABASE_URL, process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  if (mode === 'create') await createDemo(admin, process.env)
  else await removeDemo(admin)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
