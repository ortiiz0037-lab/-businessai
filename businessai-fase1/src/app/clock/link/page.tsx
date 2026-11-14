import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { Brand } from '@/components/ui/brand'
import { SubmitButton } from '@/components/submit-button'
import { wfMessage } from '@/lib/workforce/context'
import { claimEmployeeAccess } from '@/app/actions/workforce'
import { signOut } from '@/app/actions/auth'

export const dynamic = 'force-dynamic'
// The link carries a one-time secret: never send it to other sites.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }

type Check = { state: 'ok' | 'linked' | 'used' | 'invalid' | 'expired' | 'email_mismatch' | 'already_linked'; employee_name: string | null; company_name: string | null; expected_email: string | null }

/**
 * Employee access link: sign in with the email the company registered, then link.
 * The link is CHECKED before «Vincular y ponchar» is offered (employee_access_check,
 * read-only, 0036): a replaced, used or expired link, or the wrong signed-in
 * account, is explained here instead of failing at the click. Without 0036 the
 * check is unavailable and the page behaves as before (the claim still decides).
 */
export default async function EmployeeLinkPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string; lang?: string }> }) {
  const { token = '', error, lang } = await searchParams
  const locale = lang === 'en' || lang === 'es' ? lang : await getLocale()
  const tr = translator(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const valid = /^[0-9a-f]{64}$/.test(token)
  const here = `/clock/link?token=${encodeURIComponent(token)}`
  let check: Check | null = null
  if (user && valid) {
    const { data, error: checkError } = await supabase.rpc('employee_access_check', { raw_token: token })
    check = checkError ? null : ((data as Check[] | null)?.[0] ?? null)
  }
  const who = check?.employee_name ? (check.company_name ? `${check.employee_name} · ${check.company_name}` : check.employee_name) : null
  const switchAccount = (
    <form action={signOut}>
      <input type="hidden" name="next" value={here} />
      <button type="submit" className="btn-secondary w-full">{tr('Salir y entrar con otra cuenta', 'Sign out and use another account')}</button>
    </form>
  )
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card w-full max-w-md space-y-5 p-7 sm:p-9">
        <Brand />
        <h1 className="font-display text-2xl font-semibold text-fg">{tr('Acceso al reloj ponchador', 'Time clock access')}</h1>
        {error && <p role="alert" className="alert-danger p-3 text-sm">{wfMessage(error, locale)}</p>}
        {!valid ? (
          <p className="text-sm text-muted">{tr('El enlace no es válido. Pide uno nuevo a tu supervisor.', 'The link is not valid. Ask your supervisor for a new one.')}</p>
        ) : user && check?.state === 'linked' ? (
          <div className="space-y-3" data-testid="link-state" data-state="linked">
            <p className="text-sm text-muted">{tr(`Tu cuenta ${user.email} ya está vinculada a ${who ?? 'tu ficha de empleado'}. Este enlace ya se usó; no hace falta volver a usarlo.`,
              `Your account ${user.email} is already linked to ${who ?? 'your employee record'}. This link was already used; there is no need to use it again.`)}</p>
            <Link className="btn-primary w-full" href="/clock">{tr('Ir a mi reloj ponchador', 'Go to my time clock')}</Link>
          </div>
        ) : user && check && check.state !== 'ok' ? (
          <div className="space-y-3" data-testid="link-state" data-state={check.state}>
            <p role="alert" className="alert-danger p-3 text-sm">{
              check.state === 'invalid' ? tr('Este enlace ya no es válido: tu empresa creó uno más reciente o retiró el acceso. Pide a tu supervisor el último enlace.',
                'This link is no longer valid: your company created a newer one or removed the access. Ask your supervisor for the latest link.')
              : check.state === 'used' ? tr('Este enlace ya se usó con otra cuenta. Si fuiste tú, entra con esa cuenta; si no, pide un enlace nuevo a tu supervisor.',
                'This link was already used with another account. If it was you, sign in with that account; otherwise ask your supervisor for a new link.')
              : check.state === 'expired' ? tr('Este enlace expiró. Pide uno nuevo a tu supervisor.', 'This link expired. Ask your supervisor for a new one.')
              : check.state === 'email_mismatch' ? tr(`Este enlace es para ${check.expected_email ?? 'otro correo'}${who ? ` (${who})` : ''}. Iniciaste sesión como ${user.email}: sal y entra con el correo que registró tu empresa.`,
                `This link is for ${check.expected_email ?? 'another email'}${who ? ` (${who})` : ''}. You are signed in as ${user.email}: sign out and use the email your company registered.`)
              : tr(`Tu cuenta ${user.email} ya está vinculada a otro empleado${check.company_name ? ` de ${check.company_name}` : ''}.`,
                `Your account ${user.email} is already linked to another employee${check.company_name ? ` of ${check.company_name}` : ''}.`)
            }</p>
            {(check.state === 'email_mismatch' || check.state === 'used') && switchAccount}
          </div>
        ) : user ? (
          <form action={claimEmployeeAccess} className="space-y-3" data-testid="link-state" data-state={check ? 'ok' : 'unchecked'}>
            <input type="hidden" name="token" value={token} />
            <p className="text-sm text-muted">{who
              ? tr(`Vas a vincular la cuenta ${user.email} a la ficha de ${who}.`, `You are linking the account ${user.email} to the employee record of ${who}.`)
              : tr(`Vas a vincular la cuenta ${user.email} a tu ficha de empleado. Debe ser el correo que registró tu empresa.`,
                `You are linking the account ${user.email} to your employee record. It must be the email your company registered.`)}</p>
            <SubmitButton pendingLabel={tr('Vinculando…', 'Linking…')}>{tr('Vincular y ponchar', 'Link and punch')}</SubmitButton>
            {!check && error === 'access_email_mismatch' && switchAccount}
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">{tr('Inicia sesión o crea una cuenta con el correo que registró tu empresa.', 'Sign in or create an account with the email your company registered.')}</p>
            <Link className="btn-primary w-full" href={`/login?next=${encodeURIComponent(here)}`}>{tr('Iniciar sesión', 'Sign in')}</Link>
            <Link className="btn-secondary w-full" href={`/signup?next=${encodeURIComponent(here)}`}>{tr('Crear cuenta', 'Create account')}</Link>
          </div>
        )}
      </div>
    </main>
  )
}
