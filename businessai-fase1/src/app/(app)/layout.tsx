import Link from 'next/link'
import { signOut } from '@/app/actions/auth'
import { setActiveCompany, setLocale } from '@/app/actions/preferences'
import { createClient } from '@/lib/supabase/server'
import { listMemberships, pickMembership, COMPANY_COOKIE, type MembershipOption } from '@/lib/active-company'
import { billingBanner, fetchBillingState } from '@/lib/billing/state'
import { fetchUsage, strongestNotice } from '@/lib/billing/usage'
import { getAppEnv } from '@/lib/env'
import { APP, shellLabels, type Locale } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { cookies } from 'next/headers'
import { AppNav, type NavItem } from '@/components/app-nav'
import { Icon } from '@/components/ui/icon'

const BANNER_STYLE = {
  info: 'alert-info',
  warning: 'alert-warning',
  danger: 'alert-danger',
} as const

function navigation(locale: Locale): NavItem[] {
  const t = APP[locale].nav
  return [
    { href: '/dashboard', label: t.dashboard, icon: 'home', primary: true },
    { href: '/clients', label: t.clients, icon: 'users', primary: true },
    { href: '/documents', label: t.documents, icon: 'file', primary: true },
    { href: '/payments', label: t.payments, icon: 'wallet', primary: true },
    { href: '/settings/company', label: t.company, icon: 'building' },
    { href: '/billing', label: t.plan, icon: 'crown' },
  ]
}

type Banner = { tone: 'info' | 'warning' | 'danger'; text: string } | null

/** Trial / payment banner, environment badge and the account shown in the menu. Never throws. */
async function loadChrome(locale: Locale) {
  let env = 'development'
  try { env = getAppEnv() } catch { /* invalid APP_ENV: shown as development */ }
  const empty = { env, banner: null as Banner, companies: [] as MembershipOption[], activeCompanyId: null as string | null, email: null as string | null }
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return empty
    const [companies, jar] = await Promise.all([listMemberships(supabase, user.id), cookies()])
    const active = pickMembership(companies, jar.get(COMPANY_COOKIE)?.value)
    const base = { ...empty, email: user.email ?? null, companies, activeCompanyId: active?.companyId ?? null }
    if (!active) return base
    const banner = billingBanner(await fetchBillingState(supabase, active.companyId), new Date(), locale)
    if (banner) return { ...base, banner }
    // Subscription fine: show the most important usage warning (80 % / 90 % / 100 %).
    const notice = strongestNotice(await fetchUsage(supabase, active.companyId), locale)
    return {
      ...base,
      banner: notice ? { tone: notice.level === 'warning' ? 'warning' as const : 'danger' as const, text: notice.text } : null,
    }
  } catch {
    return empty
  }
}

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const locale = await getLocale()
  const copy = APP[locale]
  const { env, banner, companies, activeCompanyId, email } = await loadChrome(locale)
  return (
    <div lang={locale} className="min-h-screen bg-canvas text-ink-900 lg:flex">
      <AppNav items={navigation(locale)} copy={shellLabels(copy)} locale={locale} companies={companies} activeCompanyId={activeCompanyId}
        email={email} signOut={signOut} setLocale={setLocale} setActiveCompany={setActiveCompany} />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {env !== 'production' && (
          <div className="border-b border-gold-200 bg-gold-50 px-4 py-1.5 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-gold-800">
            {copy.shell.env(env)}
          </div>
        )}

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-28 pt-6 sm:px-8 sm:pt-10 md:pb-10 lg:px-10 lg:py-12">
          {banner && (
            <div role="status" className={`mb-8 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${BANNER_STYLE[banner.tone]}`}>
              <span className="flex items-start gap-2.5">
                <Icon name={banner.tone === 'info' ? 'info' : 'alert'} className="mt-0.5 h-4 w-4 shrink-0" />
                {banner.text}
              </span>
              <Link href="/billing" className="shrink-0 font-semibold underline underline-offset-4">{copy.shell.seePlan}</Link>
            </div>
          )}
          {children}
        </main>

        <footer className="hidden border-t border-stone-200/80 md:block">
          <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-2 px-4 py-5 text-xs text-stone-400 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
            <p>© {new Date().getFullYear()} BusinessAI</p>
            <nav aria-label={copy.shell.legal} className="flex gap-4">
              <Link href="/terminos" className="hover:text-ink-900">{copy.shell.terms}</Link>
              <Link href="/privacidad" className="hover:text-ink-900">{copy.shell.privacy}</Link>
            </nav>
          </div>
        </footer>
      </div>
    </div>
  )
}
