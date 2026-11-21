import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkDomain, judgeDns, SMTP, smtpPatch } from '../scripts/staging/auth-smtp.mjs'

describe('staging Auth SMTP (Resend)', () => {
  it('sets only the smtp_* fields with Resend settings', () => {
    const p = smtpPatch({ domain: 'mail.mybusinessai.site', name: 'BusinessAI (Staging)', key: 're_x' })
    expect(p).toEqual({ smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: 're_x', smtp_admin_email: 'no-reply@mail.mybusinessai.site', smtp_sender_name: 'BusinessAI (Staging)' })
    expect(Object.keys(p).every((k) => k.startsWith('smtp_'))).toBe(true)
    expect(SMTP.host).toBe('smtp.resend.com')
  })
  it('only a subdomain of mybusinessai.site', () => {
    expect(checkDomain('mail.mybusinessai.site')).toBeNull()
    expect(checkDomain('mybusinessai.site')).toMatch(/subdomain/)
    expect(checkDomain('mail.example.com')).toMatch(/subdomain/)
    expect(checkDomain(undefined)).toMatch(/subdomain/)
  })
  it('refuses until DKIM, bounce MX and SPF are published', () => {
    const good = { dkim: [`p=${'A'.repeat(200)}`], mx: [{ exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }], spf: ['v=spf1 include:amazonses.com ~all'] }
    expect(judgeDns(good).every((d) => d.ok)).toBe(true)
    expect(judgeDns({ ...good, dkim: [] }).some((d) => !d.ok)).toBe(true)
    expect(judgeDns({ ...good, mx: [] }).some((d) => !d.ok)).toBe(true)
    expect(judgeDns({ ...good, spf: ['v=spf1 -all'] }).some((d) => !d.ok)).toBe(true)
    // Resend's current values (its own MTA) are accepted too
    expect(judgeDns({ ...good, mx: [{ exchange: 'feedback.forge.rmta.net', priority: 10 }], spf: ['v=spf1 ip4:52.3.252.119 ip4:199.249.231.0/24 ~all'] }).every((d) => d.ok)).toBe(true)
  })
  it('the workflow writes only with the apply label, staging pinned, key never printed', () => {
    const yml = readFileSync(new URL('../../.github/workflows/staging-auth-smtp.yml', import.meta.url), 'utf8')
    const src = readFileSync(new URL('../scripts/staging/auth-smtp.mjs', import.meta.url), 'utf8')
    expect(yml).toContain("MODE: ${{ github.event.label.name == 'staging:auth-smtp-apply' && 'apply' || 'plan' }}")
    expect(yml).toContain('PINNED_STAGING_REF: wbfpvxptoujgvflljasc')
    expect(yml).not.toMatch(/workflow_dispatch|push:/)
    expect(src).not.toMatch(/console\.log\([^\n]*(RESEND_SMTP_KEY|smtp_pass|\bkey\b\s*[,)])/)
  })
})
