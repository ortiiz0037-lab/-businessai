import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { INVITE_LINK_COOKIE, invitationExpired, roleLabel, teamAbilities, teamMessage, type TeamRole } from '@/lib/team'
import { changeMemberRole, changeMemberStatus, inviteMember, leaveCompany, removeMember, revokeInvitation, transferOwnership } from '@/app/actions/team'

export const dynamic = 'force-dynamic'

type Member = { user_id: string; email: string | null; role: TeamRole; status: 'active' | 'suspended'; joined_at: string }
type Invitation = { id: string; email: string; role: string; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }
type TeamEvent = { id: number; action: string; target_email: string | null; role_from: string | null; role_to: string | null; created_at: string }

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string; invited?: string }> }) {
  const params = await searchParams
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/team')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const companyId = member.companyId
  const myRole = member.role as TeamRole
  const can = teamAbilities(myRole)

  const { data: membersData, error: membersError } = await supabase.rpc('company_members', { target: companyId })
  const unavailable = !!membersError
  const members = (membersData ?? []) as Member[]
  const [{ data: invitationsData }, { data: eventsData }] = can.invite && !unavailable
    ? await Promise.all([
        supabase.from('invitations').select('id, email, role, created_at, expires_at, accepted_at, revoked_at')
          .eq('company_id', companyId).is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false }).limit(50),
        supabase.from('team_events').select('id, action, target_email, role_from, role_to, created_at')
          .eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
      ])
    : [{ data: [] }, { data: [] }]
  const invitations = (invitationsData ?? []) as Invitation[]
  const events = (eventsData ?? []) as TeamEvent[]
  const inviteLink = (await cookies()).get(INVITE_LINK_COOKIE)?.value ?? null

  const doneText: Record<string, string> = {
    revoked: tr('Invitación revocada.', 'Invitation revoked.'),
    role: tr('Rol actualizado.', 'Role updated.'),
    suspended: tr('Miembro suspendido: ya no puede entrar a la empresa.', 'Member suspended: they can no longer access the company.'),
    reactivated: tr('Miembro reactivado.', 'Member reactivated.'),
    removed: tr('Miembro quitado de la empresa.', 'Member removed from the company.'),
    transferred: tr('Propiedad transferida. Ahora eres administrador.', 'Ownership transferred. You are now an admin.'),
  }
  const eventText = (e: TeamEvent) => {
    const who = e.target_email ?? tr('un miembro', 'a member')
    const role = (r: string | null) => (r ? roleLabel(r, locale).toLowerCase() : '')
    switch (e.action) {
      case 'invited': return tr(`Invitación a ${who} como ${role(e.role_to)}`, `${who} invited as ${role(e.role_to)}`)
      case 'invitation_revoked': return tr(`Invitación a ${who} revocada`, `Invitation to ${who} revoked`)
      case 'invitation_accepted': return tr(`${who} aceptó la invitación`, `${who} accepted the invitation`)
      case 'role_changed': return tr(`Rol cambiado de ${role(e.role_from)} a ${role(e.role_to)}`, `Role changed from ${role(e.role_from)} to ${role(e.role_to)}`)
      case 'suspended': return tr('Miembro suspendido', 'Member suspended')
      case 'reactivated': return tr('Miembro reactivado', 'Member reactivated')
      case 'removed': return tr('Miembro quitado', 'Member removed')
      case 'left': return tr('Un miembro salió de la empresa', 'A member left the company')
      case 'ownership_transferred': return tr('Propiedad transferida', 'Ownership transferred')
      default: return e.action
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader eyebrow={tr('Empresa', 'Company')} title={tr('Equipo', 'Team')}
        description={tr('Invita personas, asigna roles y controla quién puede entrar a la empresa.', 'Invite people, assign roles and control who can access the company.')} />

      {params.error && <div role="alert" className="alert-danger p-4">{teamMessage(params.error, locale)}</div>}
      {params.done && doneText[params.done] && <div role="status" className="alert-success p-4">{doneText[params.done]}</div>}
      {params.invited === 'sent' && <div role="status" className="alert-success p-4">{tr('Invitación enviada por correo.', 'Invitation sent by email.')}</div>}
      {params.invited && params.invited !== 'sent' && inviteLink && (
        <div role="status" className="alert-info space-y-2 p-4">
          <p>{params.invited === 'failed'
            ? tr('La invitación se creó, pero el correo no se pudo enviar. Comparte este enlace con la persona invitada:', 'The invitation was created but the email could not be sent. Share this link with the invited person:')
            : tr('La invitación se creó. El envío de correos no está configurado: comparte este enlace con la persona invitada:', 'The invitation was created. Email sending is not configured: share this link with the invited person:')}</p>
          <input readOnly value={inviteLink} aria-label={tr('Enlace de invitación', 'Invitation link')} className="field w-full font-mono text-xs" />
          <p className="text-xs text-muted">{tr('Solo funciona con la cuenta del correo invitado. Se muestra durante 10 minutos.', 'It only works with the invited email\'s account. Shown for 10 minutes.')}</p>
        </div>
      )}
      {unavailable && <div role="alert" className="alert-warning p-4">{teamMessage('unavailable', locale)}</div>}

      <section className="card overflow-hidden" aria-labelledby="members-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
          <h2 id="members-title" className="font-display text-xl font-semibold text-fg">{tr('Miembros', 'Members')}</h2>
          <span className="badge-neutral">{members.length}</span>
        </div>
        <ul className="divide-y divide-line">
          {members.map((m) => {
            const self = m.user_id === user.id
            const actionable = can.manage && !self && m.role !== 'owner'
            return (
              <li key={m.user_id} className="flex flex-col gap-3 px-5 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-fg">{m.email ?? tr('Usuario', 'User')} {self && <span className="text-xs text-muted">({tr('tú', 'you')})</span>}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className={m.role === 'owner' ? 'badge-accent' : 'badge-neutral'}>{roleLabel(m.role, locale)}</span>
                    {m.status === 'suspended' && <span className="badge-danger">{tr('Suspendido', 'Suspended')}</span>}
                    <span>{tr('Desde', 'Since')} {f.date(m.joined_at)}</span>
                  </p>
                </div>
                {actionable && (
                  <div className="flex flex-wrap gap-2">
                    <form action={changeMemberRole} className="flex gap-2">
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <select name="role" defaultValue={m.role} aria-label={tr('Rol', 'Role')} className="field py-2 text-sm">
                        <option value="member">{roleLabel('member', locale)}</option>
                        <option value="admin">{roleLabel('admin', locale)}</option>
                      </select>
                      <button type="submit" className="btn-secondary btn-sm">{tr('Cambiar', 'Change')}</button>
                    </form>
                    <form action={changeMemberStatus}>
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <input type="hidden" name="status" value={m.status === 'active' ? 'suspended' : 'active'} />
                      <button type="submit" className="btn-secondary btn-sm">{m.status === 'active' ? tr('Suspender', 'Suspend') : tr('Reactivar', 'Reactivate')}</button>
                    </form>
                    <details className="relative">
                      <summary className="btn-danger btn-sm cursor-pointer list-none">{tr('Quitar…', 'Remove…')}</summary>
                      <form action={removeMember} className="card absolute right-0 z-10 mt-2 w-64 space-y-2 p-3">
                        <input type="hidden" name="user_id" value={m.user_id} />
                        <label className="flex items-start gap-2 text-xs text-slate-300">
                          <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 h-4 w-4" />
                          {tr('Quitar a esta persona de la empresa. Sus documentos y pagos se conservan.', 'Remove this person from the company. Their documents and payments are kept.')}
                        </label>
                        <button type="submit" className="btn-danger btn-sm w-full">{tr('Quitar', 'Remove')}</button>
                      </form>
                    </details>
                    {can.transfer && m.status === 'active' && (
                      <details className="relative">
                        <summary className="btn-secondary btn-sm cursor-pointer list-none">{tr('Hacer propietario…', 'Make owner…')}</summary>
                        <form action={transferOwnership} className="card absolute right-0 z-10 mt-2 w-72 space-y-2 p-3">
                          <input type="hidden" name="user_id" value={m.user_id} />
                          <label className="flex items-start gap-2 text-xs text-slate-300">
                            <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 h-4 w-4" />
                            {tr('Transferir la propiedad, la suscripción y la gestión de roles. Pasarás a ser administrador.', 'Transfer ownership, the subscription and role management. You will become an admin.')}
                          </label>
                          <button type="submit" className="btn-danger btn-sm w-full">{tr('Transferir propiedad', 'Transfer ownership')}</button>
                        </form>
                      </details>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {can.invite && !unavailable && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="card p-5 sm:p-6" aria-labelledby="invite-title">
            <h2 id="invite-title" className="font-display text-xl font-semibold text-fg">{tr('Invitar a alguien', 'Invite someone')}</h2>
            <p className="mt-1 text-sm text-muted">{tr('La persona recibe un enlace seguro que solo funciona con su correo.', 'The person receives a secure link that only works with their email.')}</p>
            <form action={inviteMember} className="mt-5 space-y-4">
              <label className="field-label">{tr('Correo *', 'Email *')}
                <input name="email" type="email" required maxLength={254} autoComplete="off" className="field mt-2" placeholder="persona@empresa.com" />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="field-label">{tr('Rol', 'Role')}
                  <select name="role" defaultValue="member" className="field mt-2">
                    <option value="member">{roleLabel('member', locale)}</option>
                    {can.inviteAdmins && <option value="admin">{roleLabel('admin', locale)}</option>}
                  </select>
                </label>
                <label className="field-label">{tr('Válida por (días)', 'Valid for (days)')}
                  <input name="days" type="number" min={1} max={30} defaultValue={7} className="field mt-2" />
                </label>
              </div>
              <SubmitButton pendingLabel={tr('Invitando…', 'Inviting…')}>{tr('Enviar invitación', 'Send invitation')}</SubmitButton>
              <p className="text-xs text-muted">{tr('Los administradores gestionan clientes, documentos y pagos. Solo el propietario gestiona la suscripción y los roles.',
                'Admins manage clients, documents and payments. Only the owner manages the subscription and roles.')}</p>
            </form>
          </section>

          <section className="card p-5 sm:p-6" aria-labelledby="pending-title">
            <h2 id="pending-title" className="font-display text-xl font-semibold text-fg">{tr('Invitaciones pendientes', 'Pending invitations')}</h2>
            {invitations.length === 0 ? (
              <EmptyState icon="mail" title={tr('No hay invitaciones pendientes.', 'No pending invitations.')} />
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {invitations.map((i) => {
                  const expired = invitationExpired(i.expires_at)
                  return (
                    <li key={i.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-fg">{i.email}</p>
                        <p className="text-xs text-muted">
                          {roleLabel(i.role, locale)} · {expired ? <span className="text-danger">{tr('Expirada', 'Expired')}</span> : `${tr('Vence', 'Expires')} ${f.date(i.expires_at)}`}
                        </p>
                      </div>
                      {(i.role === 'member' || can.inviteAdmins) && (
                        <form action={revokeInvitation}>
                          <input type="hidden" name="invitation_id" value={i.id} />
                          <button type="submit" className="btn-secondary btn-sm w-full sm:w-auto">{tr('Revocar', 'Revoke')}</button>
                        </form>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      {can.invite && events.length > 0 && (
        <section className="card p-5 sm:p-6" aria-labelledby="history-title">
          <h2 id="history-title" className="font-display text-xl font-semibold text-fg">{tr('Historial del equipo', 'Team history')}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
                <span className="text-slate-300">{eventText(e)}</span>
                <span className="text-xs text-muted">{f.dateTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {myRole !== 'owner' && !unavailable && (
        <section className="card p-5 sm:p-6">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-fg">{tr('Salir de esta empresa', 'Leave this company')}</summary>
            <form action={leaveCompany} className="mt-3 space-y-3">
              <label className="flex items-start gap-2 text-sm text-slate-300">
                <input type="checkbox" name="confirm" value="yes" required className="mt-1 h-4 w-4" />
                {tr('Perderé el acceso a esta empresa. Solo el propietario puede volver a invitarme.', 'I will lose access to this company. Only the owner can invite me again.')}
              </label>
              <button type="submit" className="btn-danger btn-sm">{tr('Salir de la empresa', 'Leave company')}</button>
            </form>
          </details>
        </section>
      )}
    </div>
  )
}
