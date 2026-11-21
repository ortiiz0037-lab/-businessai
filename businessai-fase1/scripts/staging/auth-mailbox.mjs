/**
 * The authorised test mailbox for staging Auth email (repository secret STAGING_AUTH_TEST_EMAIL): a mailbox of
 * a member of the Supabase organisation, the only addresses Supabase's default email service delivers to.
 * Returns null for anything that is not a plain address or that uses a placeholder / reserved domain.
 */
export function parseMailbox(value) {
  const m = /^([^\s@+"'<>]+)(\+[^\s@"'<>]*)?@([^\s@"'<>]+\.[^\s@"'<>]+)$/.exec(String(value ?? '').trim())
  if (!m) return null
  if (/^(example\.(com|org|net)|.*\.(test|invalid|example|localhost))$/i.test(m[3])) return null
  return { local: m[1], domain: m[3], address: `${m[1]}@${m[3]}` }
}

/** Why a value was refused — shape only, never the value itself (this repository's logs are public). */
export function mailboxProblem(value) {
  if (value === undefined || value === null || value === '') return 'not set: no repository secret named STAGING_AUTH_TEST_EMAIL reached the job (check the exact name, and that it is under Settings → Secrets and variables → Actions → Repository secrets, not an environment, Codespaces or Dependabot secret)'
  const v = String(value)
  const shape = []
  if (/^\s|\s$/.test(v)) shape.push('spaces or a line break around it')
  if (/["'<>]/.test(v)) shape.push('quotes or < > (write only the address, e.g. name@domain)')
  if (/\s/.test(v.trim())) shape.push('spaces inside')
  if ((v.match(/@/g) ?? []).length !== 1) shape.push(`${(v.match(/@/g) ?? []).length} "@" signs (expected 1)`)
  if (parseMailbox(v) === null && shape.length === 0) shape.push('a placeholder or reserved domain (example.com, .test, .invalid…) or no domain dot')
  return parseMailbox(v) ? null : `set but not usable (${v.length} characters): ${shape.join('; ')}`
}
