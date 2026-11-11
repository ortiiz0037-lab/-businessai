/**
 * Phase C (team and CRM), app side. The rules themselves are enforced and
 * tested in PostgreSQL (supabase/tests/local 78_team, 79_crm); these tests
 * cover the app's validation, messages, email and totals.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  invitationEmail, invitationExpired, inviteUrl, parseInvite, roleLabel, sendInvitationEmail, teamAbilities, teamErrorCode, teamMessage, TOKEN_RE,
} from '@/lib/team'
import { clientSummary } from '@/lib/clients'

describe('invitation input', () => {
  it('normalizes the email and defaults to 7 days', () => {
    expect(parseInvite({ email: '  Ana@Example.COM ', role: 'member' })).toEqual({ ok: true, email: 'ana@example.com', role: 'member', days: 7 })
  })
  it('refuses a bad email, the owner role and out-of-range days', () => {
    expect(parseInvite({ email: 'nope', role: 'member' })).toEqual({ ok: false, error: 'invitation_email_invalid' })
    expect(parseInvite({ email: 'a@b.co', role: 'owner' })).toEqual({ ok: false, error: 'invitation_role_invalid' })
    expect(parseInvite({ email: 'a@b.co', role: 'admin', days: '31' })).toEqual({ ok: false, error: 'invitation_days_invalid' })
    expect(parseInvite({ email: 'a@b.co', role: 'admin', days: '2.5' })).toEqual({ ok: false, error: 'invitation_days_invalid' })
  })
})

describe('who sees which team controls (the database checks again)', () => {
  it('owner manages everything; admin invites members only; member nothing', () => {
    expect(teamAbilities('owner')).toEqual({ invite: true, inviteAdmins: true, manage: true, transfer: true })
    expect(teamAbilities('admin')).toEqual({ invite: true, inviteAdmins: false, manage: false, transfer: false })
    expect(teamAbilities('member')).toEqual({ invite: false, inviteAdmins: false, manage: false, transfer: false })
  })
})

describe('database errors → messages in both languages', () => {
  it('FORBIDDEN_ROLE is not mistaken for FORBIDDEN', () => {
    expect(teamErrorCode({ message: 'FORBIDDEN_ROLE' })).toBe('forbidden_role')
    expect(teamErrorCode({ message: 'FORBIDDEN' })).toBe('forbidden')
    expect(teamErrorCode({ message: 'INVITATION_EMAIL_MISMATCH' })).toBe('invitation_email_mismatch')
    expect(teamErrorCode({ code: 'PGRST202', message: 'Could not find the function public.create_invitation' })).toBe('unavailable')
    expect(teamErrorCode({ message: 'something else' })).toBe('save')
  })
  it('every code has Spanish and English text', () => {
    for (const code of ['forbidden_role', 'invitation_expired', 'member_is_owner', 'plan_limit_members', 'unavailable']) {
      expect(teamMessage(code, 'es')).not.toBe(teamMessage(code, 'en'))
      expect(teamMessage(code, 'en')).toMatch(/[a-z]/)
    }
    expect(roleLabel('admin', 'en')).toBe('Admin')
    expect(roleLabel('owner', 'es')).toBe('Propietario')
  })
})

describe('invitation link and email', () => {
  const token = 'a'.repeat(64)
  it('the link carries the token; tokens are 256-bit hex', () => {
    expect(inviteUrl('https://app.example.com', token)).toBe(`https://app.example.com/invite?token=${token}`)
    expect(TOKEN_RE.test(token)).toBe(true)
    expect(TOKEN_RE.test('A'.repeat(64))).toBe(false)
  })
  it('the email is in the inviter language and escapes the company name', () => {
    const es = invitationEmail({ company: 'Rivera <b>LLC</b>', role: 'member', url: 'https://x/invite?token=t', expiresAt: '2026-11-20T12:00:00Z', locale: 'es' })
    expect(es.subject).toBe('Invitación para unirte a Rivera <b>LLC</b> en BusinessAI')
    expect(es.html).toContain('Rivera &lt;b&gt;LLC&lt;/b&gt;')
    expect(es.html).not.toContain('<b>LLC</b>')
    expect(es.text).toContain('20 de noviembre de 2026')
    const en = invitationEmail({ company: 'Rivera', role: 'admin', url: 'https://x', expiresAt: '2026-11-20T12:00:00Z', locale: 'en' })
    expect(en.text).toContain('as admin')
  })
  it('without Resend configured nothing is sent (the inviter gets the link)', async () => {
    const fetchSpy = vi.fn()
    expect(await sendInvitationEmail('a@b.co', { subject: 's', text: 't', html: 'h' }, {}, fetchSpy as never)).toBe('not_configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('with Resend: one POST with the key in the header; failures are reported, never thrown', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await sendInvitationEmail('a@b.co', { subject: 's', text: 't', html: 'h' }, { RESEND_API_KEY: 'k', EMAIL_FROM: 'BusinessAI <no-reply@x.co>' }, ok as never)).toBe('sent')
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ['a@b.co'], subject: 's' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = vi.fn(async () => new Response('no', { status: 422 }))
    expect(await sendInvitationEmail('a@b.co', { subject: 's', text: 't', html: 'h' }, { RESEND_API_KEY: 'k', EMAIL_FROM: 'f' }, bad as never)).toBe('failed')
    const down = vi.fn(async () => { throw new Error('network') })
    expect(await sendInvitationEmail('a@b.co', { subject: 's', text: 't', html: 'h' }, { RESEND_API_KEY: 'k', EMAIL_FROM: 'f' }, down as never)).toBe('failed')
  })
  it('expiry', () => {
    expect(invitationExpired('2026-01-01T00:00:00Z', Date.parse('2026-01-02T00:00:00Z'))).toBe(true)
    expect(invitationExpired('2026-01-03T00:00:00Z', Date.parse('2026-01-02T00:00:00Z'))).toBe(false)
  })
})

describe('client totals', () => {
  it('billed = issued invoices (not drafts or voided); balance never negative', () => {
    const paid = new Map([['a', 40], ['b', 50], ['c', 999]])
    const s = clientSummary([
      { id: 'a', status: 'sent', total: 100 }, { id: 'b', status: 'paid', total: '50' },
      { id: 'c', status: 'cancelled', total: 999 }, { id: 'd', status: 'draft', total: 70 },
    ], paid)
    expect(s).toEqual({ billed: 150, paid: 90, balance: 60, issued: 2 })
  })
})
