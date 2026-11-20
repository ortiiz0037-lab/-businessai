import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkTarget, LINKS, planTemplate } from '../scripts/staging/auth-templates.mjs'

// Supabase's default "Reset password" template, plus some branding around it
const DEFAULT = '<h2>BusinessAI</h2><p>Follow this link to reset the password for your user:</p><p><a href="{{ .ConfirmationURL }}">Reset Password</a></p><footer>© BusinessAI</footer>'
const env = { STAGING_PROJECT_REF: 'wbfpvxptoujgvflljasc', PINNED_STAGING_REF: 'wbfpvxptoujgvflljasc', PRODUCTION_PROJECT_REF: 'rugqcumiuqrjbfwpuslm', EXPECTED_SITE_URL: 'https://staging.mybusinessai.site' }

describe('staging Auth email templates', () => {
  it('replaces only the link and keeps every other byte', () => {
    const p = planTemplate('recovery', DEFAULT)
    expect(p.op).toBe('update')
    expect(p.content).toBe(DEFAULT.replace('{{ .ConfirmationURL }}', LINKS.recovery))
    expect(p.content).toContain('<h2>BusinessAI</h2>')
    expect(p.content).toContain('© BusinessAI')
    expect(planTemplate('confirmation', '<a href="{{.ConfirmationURL}}">x</a> {{ .ConfirmationURL }}')).toMatchObject({ op: 'update', uses: 2 })
  })
  it('the links are the token_hash form the app verifies itself', () => {
    expect(LINKS.recovery).toBe('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password')
    expect(LINKS.confirmation).toBe('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding')
  })
  it('does nothing twice and never rewrites an unknown template', () => {
    expect(planTemplate('recovery', `<a href="${LINKS.recovery}">x</a>`).op).toBe('none')
    expect(planTemplate('recovery', '<a href="https://example.invalid">x</a>').op).toBe('blocked')
    expect(planTemplate('recovery', '').op).toBe('blocked')
  })
  it('staging only, and the Site URL must be the staging domain', () => {
    expect(checkTarget(env)).toBeNull()
    expect(checkTarget(env, 'https://staging.mybusinessai.site/')).toBeNull()
    expect(checkTarget(env, 'http://localhost:3000')).toMatch(/expected/)
    expect(checkTarget({ ...env, STAGING_PROJECT_REF: 'rugqcumiuqrjbfwpuslm', PINNED_STAGING_REF: 'rugqcumiuqrjbfwpuslm' })).toMatch(/production/)
    expect(checkTarget({ ...env, STAGING_PROJECT_REF: 'other' })).toMatch(/pinned/)
  })
  it('the workflow writes only with the apply label and sends only the two template fields', () => {
    const yml = readFileSync(new URL('../../.github/workflows/staging-auth-templates.yml', import.meta.url), 'utf8')
    const src = readFileSync(new URL('../scripts/staging/auth-templates.mjs', import.meta.url), 'utf8')
    expect(yml).toContain("MODE: ${{ github.event.label.name == 'staging:auth-templates-apply' && 'apply' || 'plan' }}")
    expect(yml).toContain('concurrency: staging')
    expect(yml).not.toMatch(/workflow_dispatch|push:/)
    expect(src).toContain("export const FIELDS = { confirmation: 'mailer_templates_confirmation_content', recovery: 'mailer_templates_recovery_content' }")
    expect(src).not.toMatch(/site_url\s*:/)
  })
})
