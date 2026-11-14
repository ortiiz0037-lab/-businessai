import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { updatePassword } from '@/app/actions/auth'
import { createClient } from '@/lib/supabase/server'
import { AUTH } from '@/lib/i18n/auth'
import { toLocale } from '@/lib/i18n/landing'

/**
 * New password. Reached from the reset email: /auth/confirm verifies the
 * link and opens a session, then redirects here. Without that session the
 * proxy sends the visitor to /login; this page also explains it.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const { lang } = await searchParams
  const locale = toLocale(lang)
  const t = AUTH[locale]
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const langHref = `/reset-password?lang=${locale === 'es' ? 'en' : 'es'}`
  return (
    <AuthCard title={t.reset.title} subtitle={t.reset.subtitle} copy={t} lang={locale} langHref={langHref}>
      {user ? (
        <ActionForm action={updatePassword} submitLabel={t.reset.submit}
          fields={[
            { name: 'password', label: t.reset.password, type: 'password', autoComplete: 'new-password' },
            { name: 'confirm', label: t.reset.confirm, type: 'password', autoComplete: 'new-password' },
          ]} />
      ) : (
        <div className="space-y-4">
          <p role="alert" className="alert-danger">{t.reset.expired}</p>
          <Link href={locale === 'en' ? '/forgot-password?lang=en' : '/forgot-password'} className="btn-primary w-full">{t.reset.requestNew}</Link>
        </div>
      )}
    </AuthCard>
  )
}
