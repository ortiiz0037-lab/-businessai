import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { signIn } from '@/app/actions/auth'
import { safeNext } from '@/lib/validators'
import { AUTH } from '@/lib/i18n/auth'
import { toLocale } from '@/lib/i18n/landing'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; lang?: string }> }) {
  const { next, error, lang } = await searchParams
  const locale = toLocale(lang)
  const t = AUTH[locale]
  const withLang = (href: string) => (locale === 'en' ? `${href}${href.includes('?') ? '&' : '?'}lang=en` : href)
  const params = new URLSearchParams()
  if (next) params.set('next', next)
  params.set('lang', locale === 'es' ? 'en' : 'es')
  const langHref = `/login${params.size ? `?${params}` : ''}`

  return (
    <AuthCard title={t.login.title} subtitle={t.login.subtitle} copy={t} lang={locale} langHref={langHref}
      footer={
        <div className="space-y-3">
          <p>{t.login.noAccount} <Link href={withLang('/signup')} className="font-semibold text-fg underline decoration-blue-400 underline-offset-4">{t.login.signup}</Link></p>
          <p className="text-xs"><Link href={locale === 'en' ? '/?lang=en#pricing' : '/precios'} className="hover:text-fg">{t.login.pricing}</Link></p>
        </div>
      }>
      {error === 'confirm' && (
        <p role="alert" className="alert-danger mb-5">{t.login.confirmError}</p>
      )}
      <ActionForm action={signIn} submitLabel={t.login.submit} hidden={{ next: safeNext(next) }}
        fields={[
          { name: 'email', label: t.login.email, type: 'email', autoComplete: 'email', placeholder: 'tu@empresa.com' },
          { name: 'password', label: t.login.password, type: 'password', autoComplete: 'current-password' },
        ]} />
    </AuthCard>
  )
}
