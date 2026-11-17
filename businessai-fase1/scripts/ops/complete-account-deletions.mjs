#!/usr/bin/env node
/**
 * Operator tool (never run by the app): completes PENDING account deletion requests (0045).
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment of the operator's machine
 * (never committed, never pasted in chat). Dry run by default; pass --apply to delete.
 * A request whose user is still the ONLY owner of a company is skipped: the company must be
 * transferred or closed first. Business records stay (legal retention); memberships cascade.
 */
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(2) }
const apply = process.argv.includes('--apply')
const h = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }
const rows = await (await fetch(`${url}/rest/v1/account_deletion_requests?status=eq.pending&select=user_id,requested_at`, { headers: h })).json()
for (const r of rows) {
  const owned = await (await fetch(`${url}/rest/v1/memberships?user_id=eq.${r.user_id}&role=eq.owner&status=eq.active&select=company_id`, { headers: h })).json()
  let sole = 0
  for (const o of owned) {
    const others = await (await fetch(`${url}/rest/v1/memberships?company_id=eq.${o.company_id}&role=eq.owner&status=eq.active&user_id=neq.${r.user_id}&select=user_id`, { headers: h })).json()
    if (!others.length) sole++
  }
  if (sole) { console.log(`skip ${r.user_id}: sole owner of ${sole} company(ies)`); continue }
  if (!apply) { console.log(`would delete ${r.user_id} (requested ${r.requested_at})`); continue }
  const res = await fetch(`${url}/auth/v1/admin/users/${r.user_id}`, { method: 'DELETE', headers: h })
  console.log(`${res.ok ? 'deleted' : `FAILED ${res.status}`} ${r.user_id}`)
}
