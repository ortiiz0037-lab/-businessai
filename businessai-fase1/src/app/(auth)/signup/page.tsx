import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { signUp } from '@/app/actions/auth'
import { TRIAL_DAYS, catalogPlan, isPlanKey } from '@/lib/billing/catalog'
import { AUTH } from '@/lib/i18n/auth'
import { LANDING, toLocale } from '@/lib/i18n/landing'

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ plan?: string; lang?: string }> }) {
  const { plan, lang } = await searchParams
  const locale = toLocale(lang)
  const t = AUTH[locale]
  const chosen = isPlanKey(plan) ? catalogPlan(plan) : null
  const chosenName = chosen ? LANDING[locale].pricing.plans[chosen.plan].name : null
  const params = new URLSearchParams()
  if (chosen) params.set('plan', chosen.plan)
  params.set('lang', locale === 'es' ? 'en' : 'es')
  const langHref = `/signup${params.size ? `?${params}` : ''}`
  const login = locale === 'en' ? '/login?lang=en' : '/login'

  return (
    <AuthCard title={t.signup.title} subtitle={t.signup.subtitle} copy={t} lang={locale} langHref={langHref}
      footer={
        <div className="space-y-3">
          <p>{t.signup.haveAccount} <Link href={login} className="font-semibold text-fg underline decoration-blue-400 underline-offset-4">{t.signup.login}</Link></p>
          <p className="text-xs">
            {t.signup.legal[0]}<Link href="/terminos" className="underline">{t.signup.legal[1]}</Link>
            {t.signup.legal[2]}<Link href="/privacidad" className="underline">{t.signup.legal[3]}</Link>.
          </p>
        </div>
      }>
      {chosen && chosenName && (
        <div role="status" className="mb-6 flex items-start justify-between gap-3 rounded-2xl border border-electric/30 bg-electric/10 p-4 text-sm text-blue-200">
          <p>{t.signup.chosen(chosenName, TRIAL_DAYS)}</p>
          <Link href={locale === 'en' ? '/?lang=en#pricing' : '/precios'} className="shrink-0 font-semibold underline underline-offset-4">{t.signup.change}</Link>
        </div>
      )}
      <ActionForm action={signUp} submitLabel={t.signup.submit} variant="gold"
        hidden={chosen ? { plan: chosen.plan } : undefined}
        fields={[
          { name: 'fullName', label: t.signup.name, autoComplete: 'name' },
          { name: 'email', label: t.signup.email, type: 'email', autoComplete: 'email', placeholder: 'tu@empresa.com' },
          { name: 'password', label: t.signup.password, type: 'password', autoComplete: 'new-password' },
        ]} />
    </AuthCard>
  )
}
