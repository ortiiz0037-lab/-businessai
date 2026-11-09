import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  MIDDLEWARE_NAMES, SUPABASE_NAMES, compareWithPreview, desiredSupabase, middlewareFailed, scanEnvNames, sha,
} from '../scripts/staging/preview-supabase.mjs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
// Placeholders shaped like Supabase keys — not credentials.
const ENV = {
  STAGING_PROJECT_REF: 'wbfpvxptoujgvflljasc',
  PRODUCTION_PROJECT_REF: 'rugqcumiuqrjbfwpuslm',
  STAGING_SUPABASE_URL: 'https://wbfpvxptoujgvflljasc.supabase.co',
  STAGING_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_placeholder',
  STAGING_SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_placeholder',
}
const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

describe('names come from the code', () => {
  it('finds exactly the variables the app reads, including the middleware ones', () => {
    const names = scanEnvNames(SRC)
    expect(names).toEqual([
      'APP_ENV', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL',
      'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY',
    ])
    expect(MIDDLEWARE_NAMES).toEqual(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'])
    for (const n of SUPABASE_NAMES) expect(names).toContain(n)
    expect(names).not.toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  })
})

describe('comparison with Vercel Preview (names only)', () => {
  it('reports missing names and Supabase-like names the code does not read', () => {
    const existing = [
      { id: '1', key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', target: ['preview'], gitBranch: null },
      { id: '2', key: 'SUPABASE_URL', target: ['preview', 'production'], gitBranch: null },
      { id: '3', key: 'NEXT_PUBLIC_SUPABASE_URL', target: ['production'], gitBranch: null },
    ]
    expect(compareWithPreview(existing, SUPABASE_NAMES)).toEqual({
      missing: SUPABASE_NAMES, present: [],
      nearMiss: ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_URL'], sharedWithProduction: [],
    })
  })
  it('reports present names and those shared with Production', () => {
    const existing = [
      { id: '1', key: 'NEXT_PUBLIC_SUPABASE_URL', target: ['production', 'preview'], gitBranch: null },
      { id: '2', key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', target: ['preview'], gitBranch: null },
      { id: '3', key: 'SUPABASE_SERVICE_ROLE_KEY', target: ['preview'], gitBranch: 'other' },
    ]
    const r = compareWithPreview(existing, SUPABASE_NAMES)
    expect(r.present).toEqual(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'])
    expect(r.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY'])
    expect(r.sharedWithProduction).toEqual(['NEXT_PUBLIC_SUPABASE_URL'])
  })
})

describe('staging values', () => {
  it('builds the 3 Supabase variables; service role is sensitive', () => {
    const d = desiredSupabase(ENV) as { key: string; value: string; type: string }[]
    expect(d.map((v) => [v.key, v.type])).toEqual([
      ['NEXT_PUBLIC_SUPABASE_URL', 'plain'], ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'plain'], ['SUPABASE_SERVICE_ROLE_KEY', 'sensitive'],
    ])
    expect(d[0].value).toBe('https://wbfpvxptoujgvflljasc.supabase.co')
  })
  it('refuses another project, production, bad formats and swapped keys', () => {
    expect(() => desiredSupabase({ ...ENV, STAGING_SUPABASE_URL: 'https://otherref.supabase.co' })).toThrow(/does not match/)
    expect(() => desiredSupabase({ ...ENV, PRODUCTION_PROJECT_REF: ENV.STAGING_PROJECT_REF })).toThrow(/PRODUCTION/)
    expect(() => desiredSupabase({ ...ENV, STAGING_SUPABASE_PUBLISHABLE_KEY: 'pk_x' })).toThrow(/format/)
    expect(() => desiredSupabase({ ...ENV, STAGING_SUPABASE_SERVICE_ROLE_KEY: ENV.STAGING_SUPABASE_PUBLISHABLE_KEY })).toThrow()
    expect(() => desiredSupabase({ ...ENV, STAGING_SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(/required/)
  })
  it('refuses legacy JWT keys of another project (e.g. production)', () => {
    expect(() => desiredSupabase({ ...ENV, STAGING_SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: 'rugqcumiuqrjbfwpuslm', role: 'service_role' }) }))
      .toThrow(/another project/)
    expect(() => desiredSupabase({ ...ENV, STAGING_SUPABASE_PUBLISHABLE_KEY: jwt({ ref: 'wbfpvxptoujgvflljasc', role: 'anon' }) }))
      .not.toThrow()
  })
  it('compares stored values by hash only', () => {
    expect(sha('a')).toHaveLength(64)
    expect(sha('a')).not.toContain('a'.repeat(2))
  })
})

describe('/login check', () => {
  it('detects the middleware failure seen in the Preview log', () => {
    expect(middlewareFailed(500, null, "Error: Your project's URL and Key are required to create a Supabase client!")).toBe(true)
    expect(middlewareFailed(500, 'MIDDLEWARE_INVOCATION_FAILED', '')).toBe(true)
    expect(middlewareFailed(200, null, '<html>Iniciar sesión</html>')).toBe(false)
  })
})
