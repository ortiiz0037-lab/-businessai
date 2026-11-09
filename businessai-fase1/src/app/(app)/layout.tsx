import Link from 'next/link'
import { signOut } from '@/app/actions/auth'
import { createClient } from '@/lib/supabase/server'
import { getUserCompany } from '@/lib/billing/company'
import { billingBanner, fetchBillingState } from '@/lib/billing/state'
import { fetchUsage, strongestNotice } from '@/lib/billing/usage'
import { getAppEnv } from '@/lib/env'
import { AppNav, type NavItem } from '@/components/app-nav'
import { Icon } from '@/components/ui/icon'

const navigation: NavItem[] = [
  { href: '/dashboard', label: 'Inicio', icon: 'home' },
  { href: '/clients', label: 'Clientes', icon: 'users' },
  { href: '/documents', label: 'Documentos', icon: 'file' },
  { href: '/payments', label: 'Pagos', icon: 'wallet' },
  { href: '/settings/company', label: 'Mi empresa', icon: 'building' },
  { href: '/billing', label: 'Plan', icon: 'crown' },
]

const BANNER_STYLE = {
  info: 'alert-info',
  warning: 'alert-warning',
  danger: 'alert-danger',
} as const

/** Trial / payment banner, non-production badge and the account shown in the menu. Never throws. */
async function loadChrome() {
  let env = 'development'
  try { env = getAppEnv() } catch { /* invalid APP_ENV: shown as development */ }
  const empty = { env, banner: null, companyName: null as string | null, email: null as string | null }
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return empty
    const company = await getUserCompany(supabase, user)
    const base = { ...empty, email: user.email ?? null, companyName: company?.companyName ?? null }
    if (!company) return base
    const banner = billingBanner(await fetchBillingState(supabase, company.companyId))
    if (banner) return { ...base, banner }
    // Subscription fine: show the most important usage warning (80 % / 90 % / 100 %).
    const notice = strongestNotice(await fetchUsage(supabase, company.companyId))
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
  const { env, banner, companyName, email } = await loadChrome()
  return (
    <div className="min-h-screen bg-canvas text-ink-900 lg:flex">
      <AppNav items={navigation} companyName={companyName} email={email} signOut={signOut} />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {env !== 'production' && (
          <div className="border-b border-gold-200 bg-gold-50 px-4 py-1.5 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-gold-800">
            Entorno: {env} — pagos en modo test
          </div>
        )}

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-7 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
          {banner && (
            <div role="status" className={`mb-8 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${BANNER_STYLE[banner.tone]}`}>
              <span className="flex items-start gap-2.5">
                <Icon name={banner.tone === 'info' ? 'info' : 'alert'} className="mt-0.5 h-4 w-4 shrink-0" />
                {banner.text}
              </span>
              <Link href="/billing" className="shrink-0 font-semibold underline underline-offset-4">Ver plan</Link>
            </div>
          )}
          {children}
        </main>

        <footer className="border-t border-stone-200/80">
          <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-2 px-4 py-5 text-xs text-stone-400 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
            <p>© {new Date().getFullYear()} BusinessAI</p>
            <nav aria-label="Enlaces legales" className="flex gap-4">
              <Link href="/terminos" className="hover:text-ink-900">Términos</Link>
              <Link href="/privacidad" className="hover:text-ink-900">Privacidad</Link>
            </nav>
          </div>
        </footer>
      </div>
    </div>
  )
}
