/**
 * Team (migration 0018): input checks, error messages (ES/EN), invitation
 * links and the invitation email. Every rule is enforced by the database
 * functions (create_invitation, accept_invitation, set_member_role, …);
 * this module only validates early and explains the answer.
 */
import type { Locale } from '@/lib/i18n/app'

export type TeamRole = 'owner' | 'admin' | 'member'
export const INVITE_ROLES = ['member', 'admin'] as const
export const TOKEN_RE = /^[0-9a-f]{64}$/
/** One-time display of an invitation link that could not be emailed. */
export const INVITE_LINK_COOKIE = 'ba_invite_link'
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function parseInvite(input: { email: string; role: string; days?: string }):
  { ok: true; email: string; role: 'member' | 'admin'; days: number } | { ok: false; error: string } {
  const email = input.email.trim().toLowerCase()
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'invitation_email_invalid' }
  if (!(INVITE_ROLES as readonly string[]).includes(input.role)) return { ok: false, error: 'invitation_role_invalid' }
  const days = input.days ? Number(input.days) : 7
  if (!Number.isInteger(days) || days < 1 || days > 30) return { ok: false, error: 'invitation_days_invalid' }
  return { ok: true, email, role: input.role as 'member' | 'admin', days }
}

/** What the caller may do on the team page (the database checks it again). */
export function teamAbilities(role: TeamRole | null) {
  return {
    invite: role === 'owner' || role === 'admin',
    inviteAdmins: role === 'owner',
    manage: role === 'owner',
    transfer: role === 'owner',
  }
}

const CODES = [
  'AUTH_REQUIRED', 'FORBIDDEN_ROLE', 'FORBIDDEN', 'INVITATION_ROLE_INVALID', 'INVITATION_EMAIL_INVALID', 'INVITATION_DAYS_INVALID',
  'INVITATION_ALREADY_MEMBER', 'INVITATION_LIMIT', 'INVITATION_NOT_FOUND', 'INVITATION_NOT_PENDING', 'INVITATION_INVALID',
  'INVITATION_REVOKED', 'INVITATION_USED', 'INVITATION_EXPIRED', 'INVITATION_EMAIL_MISMATCH', 'INVITATION_EMAIL_UNCONFIRMED',
  'MEMBER_ROLE_INVALID', 'MEMBER_STATUS_INVALID', 'MEMBER_NOT_FOUND', 'MEMBER_SELF', 'MEMBER_IS_OWNER', 'MEMBER_SUSPENDED',
  'PLAN_LIMIT_MEMBERS', 'BILLING_INACTIVE',
] as const

/** Database error → interface code (whole words; FORBIDDEN_ROLE before FORBIDDEN). */
export function teamErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const code of CODES) if (new RegExp(`\\b${code}\\b`).test(m)) return code.toLowerCase()
  if (error?.code === '42501') return 'forbidden'
  if (error?.code === 'PGRST202' || /could not find the function/i.test(m)) return 'unavailable'
  return 'save'
}

const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    auth_required: 'Inicia sesión para continuar.',
    forbidden: 'Tu rol no permite hacer esto.',
    forbidden_role: 'Solo el propietario puede invitar o gestionar administradores.',
    invitation_role_invalid: 'Elige el rol de la invitación.',
    invitation_email_invalid: 'Escribe un correo válido.',
    invitation_days_invalid: 'La invitación debe durar entre 1 y 30 días.',
    invitation_already_member: 'Esa persona ya es miembro de la empresa (activa o suspendida).',
    invitation_limit: 'Hay demasiadas invitaciones pendientes (máximo 50). Revoca alguna antes de invitar.',
    invitation_not_found: 'No encontramos esa invitación.',
    invitation_not_pending: 'Esa invitación ya no está pendiente.',
    invitation_invalid: 'El enlace de invitación no es válido.',
    invitation_revoked: 'Esta invitación fue revocada o reemplazada por otra más reciente.',
    invitation_used: 'Esta invitación ya se usó.',
    invitation_expired: 'Esta invitación expiró. Pide una nueva a quien te invitó.',
    invitation_email_mismatch: 'Esta invitación es para otro correo. Inicia sesión con la cuenta del correo invitado.',
    invitation_email_unconfirmed: 'Confirma el correo de tu cuenta antes de aceptar la invitación.',
    member_role_invalid: 'Ese rol no es válido.',
    member_status_invalid: 'Ese estado no es válido.',
    member_not_found: 'No encontramos a ese miembro en la empresa.',
    member_self: 'No puedes hacer esto sobre tu propia cuenta.',
    member_is_owner: 'El propietario no se puede modificar; primero transfiere la propiedad.',
    member_suspended: 'La propiedad solo se transfiere a un miembro activo.',
    plan_limit_members: 'Tu plan alcanzó el máximo de usuarios (contando invitaciones pendientes). Mejora el plan o revoca invitaciones.',
    billing_inactive: 'Necesitas una suscripción activa o una prueba para añadir miembros.',
    unavailable: 'La gestión de equipo todavía no está activada en esta base de datos.',
    confirm: 'Marca la casilla de confirmación.',
    save: 'No se pudo completar la acción. Inténtalo nuevamente.',
  },
  en: {
    auth_required: 'Sign in to continue.',
    forbidden: 'Your role cannot do this.',
    forbidden_role: 'Only the owner can invite or manage admins.',
    invitation_role_invalid: 'Choose the invitation role.',
    invitation_email_invalid: 'Enter a valid email.',
    invitation_days_invalid: 'The invitation must last between 1 and 30 days.',
    invitation_already_member: 'That person is already a member of the company (active or suspended).',
    invitation_limit: 'There are too many pending invitations (50 max). Revoke some before inviting.',
    invitation_not_found: 'We could not find that invitation.',
    invitation_not_pending: 'That invitation is no longer pending.',
    invitation_invalid: 'The invitation link is not valid.',
    invitation_revoked: 'This invitation was revoked or replaced by a newer one.',
    invitation_used: 'This invitation was already used.',
    invitation_expired: 'This invitation expired. Ask whoever invited you for a new one.',
    invitation_email_mismatch: 'This invitation is for another email. Sign in with the invited email\'s account.',
    invitation_email_unconfirmed: 'Confirm your account email before accepting the invitation.',
    member_role_invalid: 'That role is not valid.',
    member_status_invalid: 'That status is not valid.',
    member_not_found: 'We could not find that member in the company.',
    member_self: 'You cannot do this on your own account.',
    member_is_owner: 'The owner cannot be changed; transfer the ownership first.',
    member_suspended: 'Ownership can only go to an active member.',
    plan_limit_members: 'Your plan reached its user limit (pending invitations included). Upgrade or revoke invitations.',
    billing_inactive: 'You need an active subscription or trial to add members.',
    unavailable: 'Team management is not enabled in this database yet.',
    confirm: 'Tick the confirmation box.',
    save: 'The action could not be completed. Please try again.',
  },
}

export function teamMessage(code: string | undefined | null, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

export function roleLabel(role: string, locale: Locale): string {
  const es: Record<string, string> = { owner: 'Propietario', admin: 'Administrador', member: 'Miembro' }
  const en: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
  return (locale === 'en' ? en : es)[role] ?? role
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite?token=${encodeURIComponent(token)}`
}

/** Invitation email (subject, text, html) in the inviter's language. */
export function invitationEmail(input: { company: string; role: string; url: string; expiresAt: string; locale: Locale }) {
  const en = input.locale === 'en'
  const role = roleLabel(input.role, input.locale).toLowerCase()
  const date = new Intl.DateTimeFormat(en ? 'en-US' : 'es-PR', { dateStyle: 'long', timeZone: 'America/Puerto_Rico' }).format(new Date(input.expiresAt))
  const subject = en ? `Invitation to join ${input.company} on BusinessAI` : `Invitación para unirte a ${input.company} en BusinessAI`
  const text = en
    ? `You were invited to join ${input.company} on BusinessAI as ${role}.\n\nAccept the invitation (valid until ${date}):\n${input.url}\n\nSign in or create an account with this same email. If you were not expecting this invitation, ignore this email.`
    : `Te invitaron a unirte a ${input.company} en BusinessAI como ${role}.\n\nAcepta la invitación (válida hasta el ${date}):\n${input.url}\n\nInicia sesión o crea una cuenta con este mismo correo. Si no esperabas esta invitación, ignora este correo.`
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const html = `<div style="font-family:Arial,sans-serif;background:#05070d;color:#e5e7eb;padding:32px">
<h1 style="color:#fff;font-size:20px">${esc(subject)}</h1>
<p>${esc(text.split('\n\n')[0])}</p>
<p><a href="${esc(input.url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">${en ? 'Accept invitation' : 'Aceptar invitación'}</a></p>
<p style="color:#94a3b8;font-size:13px">${esc(text.split('\n\n')[2])}</p></div>`
  return { subject, text, html }
}

/**
 * Sends the invitation with Resend when RESEND_API_KEY and EMAIL_FROM are
 * set (server only). Without them nothing is sent and the caller shows the
 * link to the inviter to share it. Never throws; never logs the link.
 */
export async function sendInvitationEmail(
  to: string,
  mail: { subject: string; text: string; html: string },
  env: Record<string, string | undefined> = process.env,
  doFetch: typeof fetch = fetch,
): Promise<'sent' | 'not_configured' | 'failed'> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'not_configured'
  try {
    const res = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
    })
    if (!res.ok) console.error('INVITATION_EMAIL_FAILED', { status: res.status })
    return res.ok ? 'sent' : 'failed'
  } catch {
    console.error('INVITATION_EMAIL_FAILED', { status: 'network' })
    return 'failed'
  }
}

export function invitationExpired(expiresAt: string, now: number = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= now
}
