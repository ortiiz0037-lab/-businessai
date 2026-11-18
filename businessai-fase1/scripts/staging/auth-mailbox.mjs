/**
 * The authorised test mailbox for staging Auth email (repository secret STAGING_AUTH_TEST_EMAIL): a mailbox of
 * a member of the Supabase organisation, the only addresses Supabase's default email service delivers to.
 * Returns null for anything that is not a plain address or that uses a placeholder / reserved domain.
 */
export function parseMailbox(value) {
  const m = /^([^\s@+]+)(\+[^\s@]*)?@([^\s@]+\.[^\s@]+)$/.exec(String(value ?? '').trim())
  if (!m) return null
  if (/^(example\.(com|org|net)|.*\.(test|invalid|example|localhost))$/i.test(m[3])) return null
  return { local: m[1], domain: m[3], address: `${m[1]}@${m[3]}` }
}
