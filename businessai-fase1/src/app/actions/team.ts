'use server'
/**
 * Team actions. Each one calls a 0018 database function with the user's own
 * session: the database checks the permission (members.invite /
 * members.manage / owner), the company isolation and the plan limits.
 */
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { activeCompanyRow, COMPANY_COOKIE } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { resolveAppOrigin } from '@/lib/app-origin'
import { invitationEmail, inviteUrl, parseInvite, sendInvitationEmail, teamErrorCode, TOKEN_RE, INVITE_LINK_COOKIE } from '@/lib/team'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const back = (q: string) => redirect(`/settings/team?${q}`)

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/team')
  const member = await activeCompanyRow(supabase, user.id)
  if (!member?.company_id) redirect('/onboarding')
  return { supabase, user, companyId: member.company_id as string }
}

function done(q: string) {
  revalidatePath('/settings/team')
  back(q)
}

export async function inviteMember(formData: FormData) {
  const { supabase, companyId } = await context()
  const parsed = parseInvite({ email: String(formData.get('email') ?? ''), role: String(formData.get('role') ?? ''), days: String(formData.get('days') ?? '') })
  if (!parsed.ok) back(`error=${parsed.error}`)
  const input = parsed as Extract<typeof parsed, { ok: true }>
  const { data, error } = await supabase.rpc('create_invitation', {
    target: companyId, invite_email: input.email, invite_role: input.role, valid_days: input.days,
  })
  const row = Array.isArray(data) ? (data[0] as { token: string; expires_at: string } | undefined) : undefined
  if (error || !row || !TOKEN_RE.test(row.token)) back(`error=${teamErrorCode(error)}`)
  const created = row as { token: string; expires_at: string }

  const locale = await getLocale()
  const origin = resolveAppOrigin(process.env, (await headers()).get('host'))
  if (!origin) back('error=save&invited=origin')
  const url = inviteUrl(origin as string, created.token)
  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle()
  const mail = invitationEmail({ company: company?.name ?? 'BusinessAI', role: input.role, url, expiresAt: created.expires_at, locale })
  const sent = await sendInvitationEmail(input.email, mail)
  if (sent !== 'sent') {
    // Shown once on the team page so the inviter can share it; never in the URL.
    ;(await cookies()).set(INVITE_LINK_COOKIE, url, { httpOnly: true, secure: true, sameSite: 'lax', path: '/settings/team', maxAge: 600 })
  }
  done(`invited=${sent}`)
}

export async function revokeInvitation(formData: FormData) {
  const id = String(formData.get('invitation_id') ?? '')
  if (!UUID.test(id)) back('error=invitation_not_found')
  const { supabase } = await context()
  const { error } = await supabase.rpc('revoke_invitation', { invitation: id })
  if (error) back(`error=${teamErrorCode(error)}`)
  done('done=revoked')
}

async function memberAction(formData: FormData, fn: string, args: (target: string, user: string) => Record<string, unknown>, ok: string) {
  const memberId = String(formData.get('user_id') ?? '')
  if (!UUID.test(memberId)) back('error=member_not_found')
  const { supabase, companyId } = await context()
  const { error } = await supabase.rpc(fn, args(companyId, memberId))
  if (error) back(`error=${teamErrorCode(error)}`)
  done(`done=${ok}`)
}

export async function changeMemberRole(formData: FormData) {
  const role = String(formData.get('role') ?? '')
  await memberAction(formData, 'set_member_role', (target, user) => ({ target, member_user: user, new_role: role }), 'role')
}

export async function changeMemberStatus(formData: FormData) {
  const status = String(formData.get('status') ?? '')
  await memberAction(formData, 'set_member_status', (target, user) => ({ target, member_user: user, new_status: status }), status === 'suspended' ? 'suspended' : 'reactivated')
}

export async function removeMember(formData: FormData) {
  if (formData.get('confirm') !== 'yes') back('error=confirm')
  await memberAction(formData, 'remove_member', (target, user) => ({ target, member_user: user }), 'removed')
}

export async function transferOwnership(formData: FormData) {
  if (formData.get('confirm') !== 'yes') back('error=confirm')
  await memberAction(formData, 'transfer_ownership', (target, user) => ({ target, new_owner: user }), 'transferred')
}

export async function leaveCompany(formData: FormData) {
  if (formData.get('confirm') !== 'yes') back('error=confirm')
  const { supabase, companyId } = await context()
  const { error } = await supabase.rpc('leave_company', { target: companyId })
  if (error) back(`error=${teamErrorCode(error)}`)
  ;(await cookies()).delete(COMPANY_COOKIE)
  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

/** Accept from /invite: the database checks token, expiry, email and limits. */
export async function acceptInvitation(formData: FormData) {
  const token = String(formData.get('token') ?? '')
  const invitePath = `/invite?token=${encodeURIComponent(token)}`
  if (!TOKEN_RE.test(token)) redirect('/invite?error=invitation_invalid')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(invitePath)}`)
  const { data: companyId, error } = await supabase.rpc('accept_invitation', { raw_token: token })
  if (error || typeof companyId !== 'string') redirect(`${invitePath}&error=${teamErrorCode(error)}`)
  ;(await cookies()).set(COMPANY_COOKIE, companyId as string, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 24 * 365 })
  revalidatePath('/', 'layout')
  redirect('/dashboard?joined=1')
}
