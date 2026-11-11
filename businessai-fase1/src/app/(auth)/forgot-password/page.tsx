import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { requestPasswordReset } from '@/app/actions/auth'
import { AUTH } from '@/lib/i18n/auth'
import { toLocale } from '@/lib/i18n/landing'

/** Public: request a password-reset email. */
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ lang?: string; error?: string }> }) {
  const { lang, error } = await searchParams
  const locale = toLocale(lang)
  const t = AUTH[locale]
  const langHref = `/forgot-password?lang=${locale === 'es' ? 'en' : 'es'}`
  return (
    <AuthCard title={t.forgot.title} subtitle={t.forgot.subtitle} copy={t} lang={locale} langHref={langHref}
      footer={<p><Link href={locale === 'en' ? '/login?lang=en' : '/login'} className="font-semibold text-fg underline decoration-blue-400 underline-offset-4">{t.forgot.back}</Link></p>}>
      {error === 'link' && <div role="alert" className="alert-danger mb-4 p-4 text-sm">{t.forgot.linkError}</div>}
      <ActionForm action={requestPasswordReset} submitLabel={t.forgot.submit}
        fields={[{ name: 'email', label: t.forgot.email, type: 'email', autoComplete: 'email', placeholder: 'tu@empresa.com' }]} />
    </AuthCard>
  )
}
