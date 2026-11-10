'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { isActivePath } from '@/lib/nav'
import { Icon, type IconName } from '@/components/ui/icon'
import { Brand, BrandMark } from '@/components/ui/brand'
import type { ShellLabels as AppCopy, Locale } from '@/lib/i18n/app'
import type { MembershipOption } from '@/lib/active-company'

export type NavItem = { href: string; label: string; icon: IconName; primary?: boolean }

type Action = (formData: FormData) => Promise<void>
type ShellProps = {
  items: NavItem[]
  copy: AppCopy
  locale: Locale
  companies: MembershipOption[]
  activeCompanyId: string | null
  email: string | null
  signOut: () => Promise<void>
  setLocale: Action
  setActiveCompany: Action
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const active = isActivePath(pathname, item.href)
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex min-h-11 items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
                active
                  ? 'bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]'
                  : 'text-white/60 hover:bg-white/[0.04] hover:text-white'
              }`}
            >
              {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-gold-400" aria-hidden="true" />}
              <Icon name={item.icon} className={`h-[18px] w-[18px] ${active ? 'text-gold-300' : 'text-white/45 group-hover:text-white/80'}`} />
              <span>{item.label}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/** ES | EN switch. Keeps the user on the same page. */
function LanguageSwitch({ copy, locale, setLocale }: { copy: AppCopy; locale: Locale; setLocale: Action }) {
  const pathname = usePathname() ?? '/dashboard'
  return (
    <form action={setLocale} className="flex items-center justify-between gap-3">
      <input type="hidden" name="returnTo" value={pathname} />
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/40">
        <Icon name="globe" className="h-4 w-4" />{copy.shell.language}
      </span>
      <span className="flex rounded-lg bg-white/[0.06] p-0.5 ring-1 ring-inset ring-white/10" role="group" aria-label={copy.shell.language}>
        {(['es', 'en'] as const).map((l) => (
          <button key={l} type="submit" name="locale" value={l} aria-pressed={locale === l} lang={l}
            title={copy.shell.languageNames[l]}
            className={`min-h-9 min-w-11 rounded-md px-2.5 text-xs font-bold uppercase transition ${
              locale === l ? 'bg-gold-400 text-ink-950' : 'text-white/60 hover:text-white'
            }`}>
            {l}
          </button>
        ))}
      </span>
    </form>
  )
}

/** Active company; when the user belongs to several, a list to switch. */
function CompanyBlock({ copy, companies, activeCompanyId, email, setActiveCompany }: {
  copy: AppCopy; companies: MembershipOption[]; activeCompanyId: string | null; email: string | null; setActiveCompany: Action
}) {
  const [open, setOpen] = useState(false)
  const active = companies.find((c) => c.companyId === activeCompanyId) ?? null
  const name = active?.companyName ?? copy.shell.myCompany
  const many = companies.length > 1
  return (
    <div className="rounded-xl bg-white/[0.04]">
      <button type="button" disabled={!many} onClick={() => setOpen((v) => !v)} aria-expanded={many ? open : undefined}
        className="flex w-full items-center gap-3 rounded-xl p-3 text-left enabled:hover:bg-white/[0.04]">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold-400/15 text-sm font-bold text-gold-300 ring-1 ring-inset ring-gold-400/30">
          {(name || email || 'B').trim().charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{name}</span>
          <span className="block truncate text-xs text-white/45">
            {active ? copy.shell.roles[active.role] ?? active.role : email}
          </span>
        </span>
        {many && <Icon name="chevronRight" className={`h-4 w-4 shrink-0 text-white/40 transition ${open ? 'rotate-90' : ''}`} />}
      </button>
      {many && open && (
        <form action={setActiveCompany} className="border-t border-white/10 p-2">
          <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/35">{copy.shell.switchCompany}</p>
          <ul className="space-y-1">
            {companies.map((c) => {
              const current = c.companyId === activeCompanyId
              return (
                <li key={c.companyId}>
                  <button type="submit" name="companyId" value={c.companyId} disabled={current}
                    className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm ${
                      current ? 'bg-white/[0.06] text-white' : 'text-white/70 hover:bg-white/[0.06] hover:text-white'
                    }`}>
                    <span className="min-w-0 truncate">{c.companyName ?? copy.shell.myCompany}</span>
                    {current
                      ? <span className="shrink-0 text-[11px] font-semibold text-gold-300">{copy.shell.current}</span>
                      : <span className="shrink-0 text-[11px] text-white/40">{copy.shell.roles[c.role] ?? c.role}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </form>
      )}
    </div>
  )
}

function AccountPanel(props: ShellProps) {
  return (
    <div className="space-y-3 border-t border-white/10 p-4">
      <CompanyBlock copy={props.copy} companies={props.companies} activeCompanyId={props.activeCompanyId} email={props.email} setActiveCompany={props.setActiveCompany} />
      <div className="px-1"><LanguageSwitch copy={props.copy} locale={props.locale} setLocale={props.setLocale} /></div>
      {props.email && <p className="truncate px-1 text-xs text-white/40">{props.email}</p>}
      <form action={props.signOut}>
        <button type="submit" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white/60 transition hover:bg-white/[0.04] hover:text-white">
          <Icon name="logout" className="h-[18px] w-[18px]" />
          {props.copy.shell.signOut}
        </button>
      </form>
    </div>
  )
}

/** iPhone: fixed bottom tab bar with the main sections + "More" (opens the full menu). */
function BottomBar({ items, copy, onMore }: { items: NavItem[]; copy: AppCopy; onMore: () => void }) {
  const pathname = usePathname()
  const primary = items.filter((i) => i.primary).slice(0, 4)
  return (
    <nav aria-label={copy.nav.mainMenu}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <ul className="grid grid-cols-5">
        {primary.map((item) => {
          const active = isActivePath(pathname, item.href)
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-semibold ${active ? 'text-gold-300' : 'text-white/55'}`}>
                <Icon name={item.icon} className="h-5 w-5" />
                <span className="max-w-full truncate px-1">{item.label}</span>
              </Link>
            </li>
          )
        })}
        <li>
          <button type="button" onClick={onMore} className="flex min-h-14 w-full flex-col items-center justify-center gap-1 text-[11px] font-semibold text-white/55">
            <Icon name="menu" className="h-5 w-5" />
            <span>{copy.nav.more}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

/**
 * Application chrome.
 *   lg+ (desktop): fixed dark sidebar with navigation, company, language, account.
 *   md–lg (iPad):  top bar + slide-in menu.
 *   < md (iPhone): top bar + bottom tab bar; "More" opens the same menu.
 */
export function AppNav(props: ShellProps) {
  const { items, copy } = props
  // The menu remembers the page it was opened on: navigating closes it.
  const pathname = usePathname()
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  const open = openedAt !== null && openedAt === pathname
  const setOpen = (value: boolean) => setOpenedAt(value ? pathname : null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenedAt(null) }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [open])

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="relative hidden w-72 shrink-0 bg-ink-950 lg:block" aria-label={copy.nav.mainMenu}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_30%_at_0%_0%,rgb(195_154_60/0.16),transparent)]" aria-hidden="true" />
        <div className="sticky top-0 flex h-screen flex-col">
          <div className="relative px-6 pb-6 pt-7">
            <Brand href="/dashboard" tone="light" subtitle="Business workspace" />
          </div>
          <div className="divider-gold relative mx-auto w-[calc(100%-3rem)] opacity-40" />
          <nav className="relative flex-1 overflow-y-auto px-4 py-6">
            <p className="mb-3 px-3.5 text-[10px] font-bold uppercase tracking-[0.24em] text-white/30">{copy.nav.menu}</p>
            <NavLinks items={items} />
          </nav>
          <div className="relative"><AccountPanel {...props} /></div>
        </div>
      </aside>

      {/* iPhone / iPad top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-white/10 bg-ink-950 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white lg:hidden">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5" aria-label="BusinessAI">
          <BrandMark className="h-9 w-9 shrink-0 text-base" />
          <span className="truncate text-base font-extrabold tracking-tight">Business<span className="text-gold-400">AI</span></span>
        </Link>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="mobile-menu"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-white">
          <Icon name="menu" label={copy.nav.openMenu} />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={copy.nav.mainMenu} id="mobile-menu">
          <button type="button" className="absolute inset-0 bg-ink-950/60 backdrop-blur-sm" onClick={() => setOpen(false)} aria-label={copy.nav.closeMenu} />
          <div className="absolute inset-y-0 left-0 flex w-[min(21rem,88vw)] flex-col overflow-y-auto bg-ink-950 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl">
            <div className="flex items-center justify-between p-5">
              <Brand href="/dashboard" tone="light" />
              <button type="button" onClick={() => setOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/70 hover:bg-white/5">
                <Icon name="close" label={copy.nav.closeMenu} />
              </button>
            </div>
            <div className="divider-gold mx-auto w-[calc(100%-2.5rem)] opacity-40" />
            <nav className="flex-1 px-3 py-5"><NavLinks items={items} onNavigate={() => setOpen(false)} /></nav>
            <AccountPanel {...props} />
          </div>
        </div>
      )}

      <BottomBar items={items} copy={copy} onMore={() => setOpen(true)} />
    </>
  )
}
