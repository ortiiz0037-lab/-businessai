import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { Brand } from '@/components/ui/brand'
import { SubmitButton } from '@/components/submit-button'
import { wfMessage } from '@/lib/workforce/context'
import { claimEmployeeAccess } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
// The link carries a one-time secret: never send it to other sites.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }

/** Employee access link: sign in with the email the company registered, then link. */
export default async function EmployeeLinkPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string; lang?: string }> }) {
  const { token = '', error, lang } = await searchParams
  const locale = lang === 'en' || lang === 'es' ? lang : await getLocale()
  const tr = translator(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const valid = /^[0-9a-f]{64}$/.test(token)
  const here = `/clock/link?token=${encodeURIComponent(token)}`
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card w-full max-w-md space-y-5 p-7 sm:p-9">
        <Brand />
        <h1 className="font-display text-2xl font-semibold text-fg">{tr('Acceso al reloj ponchador', 'Time clock access')}</h1>
        {error && <p role="alert" className="alert-danger p-3 text-sm">{wfMessage(error, locale)}</p>}
        {!valid ? (
          <p className="text-sm text-muted">{tr('El enlace no es válido. Pide uno nuevo a tu supervisor.', 'The link is not valid. Ask your supervisor for a new one.')}</p>
        ) : user ? (
          <form action={claimEmployeeAccess} className="space-y-3">
            <input type="hidden" name="token" value={token} />
            <p className="text-sm text-muted">{tr(`Vas a vincular la cuenta ${user.email} a tu ficha de empleado. Debe ser el correo que registró tu empresa.`,
              `You are linking the account ${user.email} to your employee record. It must be the email your company registered.`)}</p>
            <SubmitButton pendingLabel={tr('Vinculando…', 'Linking…')}>{tr('Vincular y ponchar', 'Link and punch')}</SubmitButton>
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
