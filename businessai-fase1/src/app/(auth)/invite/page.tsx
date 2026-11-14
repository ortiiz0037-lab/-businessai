import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { acceptInvitation } from '@/app/actions/team'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { roleLabel, teamMessage, TOKEN_RE } from '@/lib/team'
import { SubmitButton } from '@/components/submit-button'
import { Brand } from '@/components/ui/brand'

export const dynamic = 'force-dynamic'
// The link carries a secret token: never send it to other sites.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }

type Preview = { company_name: string; role: string; email_hint: string; status: 'valid' | 'expired' | 'used' | 'revoked' }

/** Public page of an invitation link: what it is, and how to accept it. */
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string; lang?: string }> }) {
  const { token = '', error, lang } = await searchParams
  const locale = lang === 'en' || lang === 'es' ? lang : await getLocale()
  const tr = translator(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let preview: Preview | null = null
  if (TOKEN_RE.test(token)) {
    const { data } = await supabase.rpc('invitation_preview', { raw_token: token })
    preview = Array.isArray(data) && data[0] ? (data[0] as Preview) : null
  }
  const here = `/invite?token=${encodeURIComponent(token)}`
  const statusText: Record<Preview['status'], string> = {
    valid: '',
    expired: tr('Esta invitación expiró. Pide una nueva a quien te invitó.', 'This invitation expired. Ask whoever invited you for a new one.'),
    used: tr('Esta invitación ya se usó.', 'This invitation was already used.'),
    revoked: tr('Esta invitación fue revocada o reemplazada por otra más reciente.', 'This invitation was revoked or replaced by a newer one.'),
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card w-full max-w-lg overflow-hidden">
        <div className="card-hero rounded-none border-0 px-7 py-8 shadow-none sm:px-9">
          <Brand />
          <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{tr('Invitación', 'Invitation')}</p>
          {preview ? (
            <>
              <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {tr(`Únete a ${preview.company_name}`, `Join ${preview.company_name}`)}
              </h1>
              <p className="mt-2 text-sm text-white/60">
                {tr('Rol', 'Role')}: <strong className="text-white">{roleLabel(preview.role, locale)}</strong> ·{' '}
                {tr('Para', 'For')} <strong className="text-white">{preview.email_hint}</strong>
              </p>
            </>
          ) : (
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">{tr('Enlace no válido', 'Invalid link')}</h1>
          )}
        </div>
        <div className="space-y-4 p-7 sm:p-9">
          {error && <div role="alert" className="alert-danger p-4 text-sm">{teamMessage(error, locale)}</div>}
          {!preview ? (
            <p className="text-sm text-muted">{tr('El enlace de invitación no es válido. Revisa que lo copiaste completo o pide uno nuevo.',
              'The invitation link is not valid. Check that you copied it completely or ask for a new one.')}</p>
          ) : preview.status !== 'valid' ? (
            <p role="status" className="alert-warning p-4 text-sm">{statusText[preview.status]}</p>
          ) : user ? (
            <form action={acceptInvitation} className="space-y-3">
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-muted">
                {tr(`Entraste como ${user.email}. La invitación solo funciona con la cuenta del correo invitado.`,
                  `You are signed in as ${user.email}. The invitation only works with the invited email's account.`)}
              </p>
              <SubmitButton pendingLabel={tr('Uniéndote…', 'Joining…')}>{tr('Aceptar invitación', 'Accept invitation')}</SubmitButton>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted">{tr('Inicia sesión o crea una cuenta con el correo invitado para aceptar.',
                'Sign in or create an account with the invited email to accept.')}</p>
              <Link className="btn-primary w-full" href={`/login?next=${encodeURIComponent(here)}${locale === 'en' ? '&lang=en' : ''}`}>{tr('Iniciar sesión', 'Sign in')}</Link>
              <Link className="btn-secondary w-full" href={`/signup?next=${encodeURIComponent(here)}${locale === 'en' ? '&lang=en' : ''}`}>{tr('Crear cuenta', 'Create account')}</Link>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
