import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { libpqDecode, parseLibpqUri, probePsql, scriptPassesUriUntouched, staticChecks } from '../scripts/staging/db-url-diagnose.mjs'

// Placeholders only — not credentials.
const REF = 'stagingref123'
const OPTS = { stagingRef: REF, productionRef: 'prodref456' }
const GOOD = `postgresql://postgres.${REF}:Placeholder123@aws-0-us-east-2.pooler.supabase.com:5432/postgres`
type R = { level: string; text: string }
const fails = (u: string) => (staticChecks(u, OPTS) as R[]).filter((r) => r.level === 'FAIL').map((r) => r.text)
const all = (u: string) => (staticChecks(u, OPTS) as R[]).map((r) => `${r.level} ${r.text}`).join('\n')

describe('db-url-diagnose', () => {
  it('accepts a correct Session pooler URI', () => {
    expect(fails(GOOD)).toEqual([])
  })

  it('detects empty, placeholder, quotes and surrounding whitespace', () => {
    expect(fails('')).toEqual(['1. STAGING_DB_URL is empty'])
    expect(fails(GOOD.replace('Placeholder123', '[YOUR-PASSWORD]')).join()).toMatch(/placeholder is gone.*square brackets/)
    expect(fails(`"${GOOD}"`).join()).toMatch(/quotes/)
    expect(fails(`${GOOD}\n`).join()).toMatch(/leading\/trailing/)
  })

  it('checks user, host, port, database and the production ref', () => {
    expect(fails(GOOD.replace(`postgres.${REF}`, 'postgres')).join()).toMatch(/user is exactly/)
    expect(fails(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`).join()).toMatch(/pooler host/)
    expect(fails(GOOD.replace(':5432', ':6543')).join()).toMatch(/port 5432/)
    expect(fails(GOOD.replace(':5432/postgres', ':5432/other')).join()).toMatch(/database/)
    expect(fails(`${GOOD}?x=prodref456`).join()).toMatch(/production project ref/)
  })

  it('checks password whitespace and %-encoding like libpq', () => {
    expect(fails(GOOD.replace('Placeholder123', 'a b')).join()).toMatch(/spaces/)
    expect(fails(GOOD.replace('Placeholder123', 'bad%2')).join()).toMatch(/URL encoding/)
    expect(all(GOOD.replace('Placeholder123', 'p%41ss'))).toMatch(/WARN 3\. the password contains %XX/)
    expect(libpqDecode('p%41ss')).toBe('pAss')
    expect(libpqDecode('x%00')).toBeNull()
  })

  it('parses userinfo up to the first @ like libpq', () => {
    const p = parseLibpqUri('postgresql://u:pa?ss@h.example:5432/db?sslmode=require')
    expect(p.ok && p.raw).toEqual({ user: 'u', password: 'pa?ss', host: 'h.example', port: '5432', dbname: 'db' })
  })

  it('output never contains any part of the URI', () => {
    const secretish = GOOD.replace('Placeholder123', 'Zq9Secret')
    const text = all(secretish)
    for (const part of ['Zq9Secret', REF, 'aws-0-us-east-2', 'pooler.supabase.com:5432']) expect(text).not.toContain(part)
  })

  it('apply-migrations.sh passes the URI to psql untouched', () => {
    const src = readFileSync(new URL('../scripts/staging/apply-migrations.sh', import.meta.url), 'utf8')
    expect(scriptPassesUriUntouched(src)).toBe(true)
    expect(scriptPassesUriUntouched(src.replace('psql "$STAGING_DB_URL"', 'psql "${STAGING_DB_URL%%\\?*}"'))).toBe(false)
  })

  it('local probe: psql sends the full user and the decoded password', async () => {
    const r = (await probePsql(GOOD.replace('Placeholder123', 'p%41ss?x'), { stagingRef: REF })) as R[]
    expect(r.filter((x) => x.level !== 'PASS')).toEqual([])
  })
})

describe('db-url-diagnose probe with parameters', () => {
  it('keeps the database name when the URI has sslmode and the password has ?', async () => {
    const u = `postgresql://postgres.${REF}:a%41?b@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require&connect_timeout=5`
    const r = (await probePsql(u, { stagingRef: REF })) as R[]
    expect(r.filter((x) => x.level !== 'PASS')).toEqual([])
  })
})
