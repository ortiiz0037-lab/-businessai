'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isActivePath } from '@/lib/nav'
import { Icon, type IconName } from '@/components/ui/icon'
import { Brand, BrandMark } from '@/components/ui/brand'
import type { ShellLabels as AppCopy, Locale } from '@/lib/i18n/app'
import type { MembershipOption } from '@/lib/active-company'

export type NavItem = { href: string; label: string; icon: IconName; primary?: boolean }
/** A real notice of the active company (subscription or plan usage), already worded. */
export type ShellNotice = { tone: 'info' | 'warning' | 'danger'; text: string; href: string }

type Action = (formData: FormData) => Promise<void>
type ShellProps = {
  items: NavItem[]
  copy: AppCopy
  locale: Locale
  companies: MembershipOption[]
  activeCompanyId: string | null
  email: string | null
  notices: ShellNotice[]
  signOut: () => Promise<void>
  setLocale: Action
  setActiveCompany: Action
}

/** Closes a popover on outside click / Escape. */
function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return { open, setOpen, ref }
}

const iconBtn = 'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-card/70 text-slate-300 transition hover:border-slate-500/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/80 active:translate-y-px'
const panel = 'absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(22rem,calc(100vw-2rem))] animate-fade-up rounded-2xl border border-line bg-elevated p-2 shadow-lift'

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
                  ? 'bg-gradient-to-r from-brand/25 to-brand/5 text-white shadow-[inset_0_0_0_1px_rgb(59_130_246/0.35)]'
                  : 'text-slate-400 hover:bg-white/[0.04] hover:text-fg'
              }`}
            >
              {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent shadow-[0_0_12px_rgb(34_211_238/0.8)]" aria-hidden="true" />}
              <Icon name={item.icon} className={`h-[18px] w-[18px] ${active ? 'text-accent' : 'text-slate-500 group-hover:text-slate-300'}`} />
              <span>{item.label}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/** ES | EN switch. Keeps the user on the same page. */
function LanguageSwitch({ copy, locale, setLocale, compact = false }: { copy: AppCopy; locale: Locale; setLocale: Action; compact?: boolean }) {
  const pathname = usePathname() ?? '/dashboard'
  return (
    <form action={setLocale} className="flex items-center gap-3">
      <input type="hidden" name="returnTo" value={pathname} />
      {!compact && (
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          <Icon name="globe" className="h-4 w-4" />{copy.shell.language}
        </span>
      )}
      <span className="flex rounded-xl border border-line bg-card/70 p-0.5" role="group" aria-label={copy.shell.language}>
        {(['es', 'en'] as const).map((l) => (
          <button key={l} type="submit" name="locale" value={l} aria-pressed={locale === l} lang={l}
            title={copy.shell.languageNames[l]}
            className={`min-h-9 min-w-10 rounded-[10px] px-2.5 text-xs font-bold uppercase transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/80 ${
              locale === l ? 'bg-brand text-white shadow-glow' : 'text-slate-400 hover:text-fg'
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
    <div className="rounded-xl border border-line/70 bg-card/60">
      <button type="button" disabled={!many} onClick={() => setOpen((v) => !v)} aria-expanded={many ? open : undefined}
        className="flex w-full items-center gap-3 rounded-xl p-3 text-left transition enabled:hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/80">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-electric/15 text-sm font-bold text-blue-300 ring-1 ring-inset ring-electric/30">
          {(name || email || 'B').trim().charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-fg">{name}</span>
          <span className="block truncate text-xs text-slate-500">
            {active ? copy.shell.roles[active.role] ?? active.role : email}
          </span>
        </span>
        {many && <Icon name="chevronDown" className={`h-4 w-4 shrink-0 text-slate-500 transition ${open ? 'rotate-180' : ''}`} />}
      </button>
      {many && open && (
        <form action={setActiveCompany} className="border-t border-line/70 p-2">
          <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{copy.shell.switchCompany}</p>
          <ul className="space-y-1">
            {companies.map((c) => {
              const current = c.companyId === activeCompanyId
              return (
                <li key={c.companyId}>
                  <button type="submit" name="companyId" value={c.companyId} disabled={current}
                    className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm transition ${
                      current ? 'bg-electric/10 text-fg' : 'text-slate-300 hover:bg-white/[0.05] hover:text-fg'
                    }`}>
                    <span className="min-w-0 truncate">{c.companyName ?? copy.shell.myCompany}</span>
                    {current
                      ? <span className="shrink-0 text-[11px] font-semibold text-accent">{copy.shell.current}</span>
                      : <span className="shrink-0 text-[11px] text-slate-500">{copy.shell.roles[c.role] ?? c.role}</span>}
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

type Command = { id: string; label: string; hint?: string; href: string; icon: IconName; group: 'pages' | 'actions' }

/** Search: jump to any section or start a quick action (keyboard: ⌘K / Ctrl+K, arrows, Enter). */
function CommandPalette({ items, copy, open, onClose }: { items: NavItem[]; copy: AppCopy; open: boolean; onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const q = copy.shell.top.quick
  const commands = useMemo<Command[]>(() => [
    ...items.map((i) => ({ id: i.href, label: i.label, href: i.href, icon: i.icon, group: 'pages' as const })),
    { id: 'invoice', label: q.invoice, href: '/documents/new?type=invoice', icon: 'receipt', group: 'actions' },
    { id: 'quote', label: q.quote, href: '/documents/new?type=quote', icon: 'clipboard', group: 'actions' },
    { id: 'receipt', label: q.receipt, href: '/documents/new?type=receipt', icon: 'wallet', group: 'actions' },
    { id: 'work', label: q.workOrder, href: '/documents/new?type=work_order', icon: 'settings', group: 'actions' },
    { id: 'client', label: q.client, href: '/clients#nuevo-cliente', icon: 'users', group: 'actions' },
    { id: 'payment', label: q.payment, hint: q.paymentHint, href: '/documents', icon: 'card', group: 'actions' },
  ], [items, q])
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const results = commands.filter((c) => norm(`${c.label} ${c.hint ?? ''}`).includes(norm(query.trim())))
  const go = (c: Command | undefined) => { if (!c) return; onClose(); router.push(c.href) }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[max(4.5rem,env(safe-area-inset-top))]" role="dialog" aria-modal="true" aria-label={copy.shell.top.search}>
      <button type="button" className="absolute inset-0 bg-app/70 backdrop-blur-sm" onClick={onClose} aria-label={copy.nav.closeMenu} />
      <div className="relative w-full max-w-xl animate-fade-up overflow-hidden rounded-2xl border border-line bg-elevated shadow-lift">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Icon name="search" className="h-5 w-5 shrink-0 text-slate-500" />
          <input autoFocus value={query} placeholder={copy.shell.top.searchPlaceholder} aria-label={copy.shell.top.search}
            onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
              if (e.key === 'Enter') { e.preventDefault(); go(results[index]) }
              if (e.key === 'Escape') onClose()
            }}
            className="h-14 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-slate-500" />
          <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 text-[11px] text-slate-500 sm:block">Esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">{copy.shell.top.noResults}</p>}
          {(['pages', 'actions'] as const).map((group) => {
            const list = results.filter((r) => r.group === group)
            if (list.length === 0) return null
            return (
              <div key={group} className="py-1">
                <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                  {group === 'pages' ? copy.shell.top.pages : copy.shell.top.actions}
                </p>
                <ul>
                  {list.map((c) => {
                    const i = results.indexOf(c)
                    return (
                      <li key={c.id}>
                        <button type="button" onClick={() => go(c)} onMouseEnter={() => setIndex(i)}
                          className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition ${i === index ? 'bg-brand/20 text-white' : 'text-slate-300'}`}>
                          <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${group === 'actions' ? 'bg-electric/15 text-blue-300' : 'bg-white/5 text-slate-400'}`}>
                            <Icon name={c.icon} className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{c.label}</span>
                          {c.hint && <span className="shrink-0 text-xs text-slate-500">{c.hint}</span>}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Notifications({ copy, notices }: { copy: AppCopy; notices: ShellNotice[] }) {
  const { open, setOpen, ref } = usePopover()
  const tone = { info: 'text-blue-300 bg-electric/10', warning: 'text-amber-300 bg-warning/10', danger: 'text-red-300 bg-danger/10' } as const
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true" className={iconBtn}
        aria-label={`${copy.shell.top.notifications}${notices.length ? ` (${notices.length})` : ''}`}>
        <Icon name="bell" className="h-[18px] w-[18px]" />
        {notices.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white ring-2 ring-app">
            {notices.length}
          </span>
        )}
      </button>
      {open && (
        <div className={panel} role="dialog" aria-label={copy.shell.top.notifications}>
          <p className="px-3 pb-2 pt-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">{copy.shell.top.notifications}</p>
          {notices.length === 0 ? <p className="px-3 pb-4 pt-1 text-sm text-muted">{copy.shell.top.noNotifications}</p> : (
            <ul className="space-y-1">
              {notices.map((n, i) => (
                <li key={i}>
                  <Link href={n.href} onClick={() => setOpen(false)} className="flex gap-3 rounded-xl p-3 text-sm text-slate-200 transition hover:bg-white/[0.04]">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone[n.tone]}`}>
                      <Icon name={n.tone === 'info' ? 'info' : 'alert'} className="h-4 w-4" />
                    </span>
                    <span className="leading-5">{n.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Profile({ copy, email, companies, activeCompanyId, signOut }: {
  copy: AppCopy; email: string | null; companies: MembershipOption[]; activeCompanyId: string | null; signOut: () => Promise<void>
}) {
  const { open, setOpen, ref } = usePopover()
  const active = companies.find((c) => c.companyId === activeCompanyId) ?? null
  const initial = (email ?? 'U').charAt(0).toUpperCase()
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true" aria-label={copy.shell.top.profile}
        className="flex h-10 items-center gap-2 rounded-xl border border-line bg-card/70 pl-1 pr-1 transition hover:border-slate-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/80 sm:pr-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-accent text-sm font-bold text-white">{initial}</span>
        <span className="hidden max-w-40 truncate text-sm font-semibold text-slate-200 xl:block">{active?.companyName ?? copy.shell.myCompany}</span>
        <Icon name="chevronDown" className="hidden h-4 w-4 text-slate-500 sm:block" />
      </button>
      {open && (
        <div className={panel} role="dialog" aria-label={copy.shell.top.profile}>
          <div className="px-3 pb-3 pt-2">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">{copy.shell.top.account}</p>
            {email && <p className="mt-1 truncate text-sm font-semibold text-fg">{email}</p>}
            {active && <p className="truncate text-xs text-muted">{active.companyName} · {copy.shell.roles[active.role] ?? active.role}</p>}
          </div>
          <div className="border-t border-line/70 pt-1">
            <Link href="/settings/company" onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-300 hover:bg-white/[0.04] hover:text-fg">
              <Icon name="building" className="h-4 w-4" />{copy.nav.company}
            </Link>
            <Link href="/billing" onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-300 hover:bg-white/[0.04] hover:text-fg">
              <Icon name="crown" className="h-4 w-4" />{copy.nav.plan}
            </Link>
            <form action={signOut}>
              <button type="submit" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm text-slate-300 hover:bg-white/[0.04] hover:text-fg">
                <Icon name="logout" className="h-4 w-4" />{copy.shell.signOut}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

/** iPhone: fixed bottom tab bar with the main sections + "More" (opens the full menu). */
function BottomBar({ items, copy, onMore }: { items: NavItem[]; copy: AppCopy; onMore: () => void }) {
  const pathname = usePathname()
  const primary = items.filter((i) => i.primary).slice(0, 4)
  return (
    <nav aria-label={copy.nav.mainMenu}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-app-2/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      <ul className="grid grid-cols-5">
        {primary.map((item) => {
          const active = isActivePath(pathname, item.href)
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition ${active ? 'text-accent' : 'text-slate-500 active:text-slate-300'}`}>
                <Icon name={item.icon} className="h-5 w-5" />
                <span className="max-w-full truncate px-1">{item.label}</span>
              </Link>
            </li>
          )
        })}
        <li>
          <button type="button" onClick={onMore} className="flex min-h-14 w-full flex-col items-center justify-center gap-1 text-[11px] font-semibold text-slate-500 active:text-slate-300">
            <Icon name="menu" className="h-5 w-5" />
            <span>{copy.nav.more}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

/** Top bar for every size: menu (< lg), search, notifications, language and profile. */
export function TopBar(props: ShellProps & { onMenu: () => void; onSearch: () => void }) {
  const { copy } = props
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-app/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
        <button type="button" onClick={props.onMenu} aria-controls="mobile-menu" className={`${iconBtn} lg:hidden`}>
          <Icon name="menu" label={copy.nav.openMenu} />
        </button>
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2 lg:hidden" aria-label="BusinessAI">
          <BrandMark className="h-9 w-9 shrink-0 text-base" />
          <span className="hidden whitespace-nowrap text-base font-extrabold tracking-tight text-fg sm:inline">Business<span className="bg-gradient-to-r from-electric to-accent bg-clip-text text-transparent">AI</span></span>
        </Link>
        <button type="button" onClick={props.onSearch}
          className="ml-auto hidden h-10 w-full max-w-md items-center gap-3 rounded-xl border border-line bg-card/70 px-3.5 text-left text-sm text-slate-500 transition hover:border-slate-500/70 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/80 md:flex lg:ml-0">
          <Icon name="search" className="h-4 w-4" />
          <span className="flex-1 truncate">{copy.shell.top.searchPlaceholder}</span>
          <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[11px]">⌘K</kbd>
        </button>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <button type="button" onClick={props.onSearch} className={`${iconBtn} md:hidden`} aria-label={copy.shell.top.search}>
            <Icon name="search" className="h-[18px] w-[18px]" />
          </button>
          <Notifications copy={copy} notices={props.notices} />
          <div className="hidden sm:block"><LanguageSwitch copy={copy} locale={props.locale} setLocale={props.setLocale} compact /></div>
          <Profile copy={copy} email={props.email} companies={props.companies} activeCompanyId={props.activeCompanyId} signOut={props.signOut} />
        </div>
      </div>
    </header>
  )
}

/**
 * Application chrome.
 *   lg+ (desktop): dark sidebar (navigation + company) and a top bar.
 *   md–lg (iPad):  top bar with menu button; slide-in menu.
 *   < md (iPhone): top bar + bottom tab bar; "More" opens the same menu.
 */
export function AppShell(props: ShellProps & { children: React.ReactNode }) {
  const { items, copy } = props
  // The menu remembers the page it was opened on: navigating closes it.
  const pathname = usePathname()
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  const open = openedAt !== null && openedAt === pathname
  const setOpen = (value: boolean) => setOpenedAt(value ? pathname : null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching(true) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenedAt(null) }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [open])

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="relative hidden w-72 shrink-0 border-r border-line/80 bg-app-2 lg:block" aria-label={copy.nav.mainMenu}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_30%_at_0%_0%,rgb(37_99_235/0.22),transparent)]" aria-hidden="true" />
        <div className="sticky top-0 flex h-screen flex-col">
          <div className="relative px-6 pb-6 pt-7">
            <Brand href="/dashboard" tone="light" subtitle="Business workspace" />
          </div>
          <div className="divider-glow relative mx-auto w-[calc(100%-3rem)] opacity-50" />
          <nav className="relative flex-1 overflow-y-auto px-4 py-6">
            <p className="mb-3 px-3.5 text-[10px] font-bold uppercase tracking-[0.24em] text-slate-500">{copy.nav.menu}</p>
            <NavLinks items={items} />
          </nav>
          <div className="relative border-t border-line/80 p-4">
            <CompanyBlock copy={copy} companies={props.companies} activeCompanyId={props.activeCompanyId} email={props.email} setActiveCompany={props.setActiveCompany} />
          </div>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <TopBar {...props} onMenu={() => setOpen(true)} onSearch={() => setSearching(true)} />
        {props.children}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={copy.nav.mainMenu} id="mobile-menu">
          <button type="button" className="absolute inset-0 bg-app/70 backdrop-blur-sm" onClick={() => setOpen(false)} aria-label={copy.nav.closeMenu} />
          <div className="absolute inset-y-0 left-0 flex w-[min(21rem,88vw)] animate-fade-up flex-col overflow-y-auto border-r border-line bg-app-2 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-lift">
            <div className="flex items-center justify-between p-5">
              <Brand href="/dashboard" tone="light" />
              <button type="button" onClick={() => setOpen(false)} className={iconBtn}>
                <Icon name="close" label={copy.nav.closeMenu} />
              </button>
            </div>
            <div className="divider-glow mx-auto w-[calc(100%-2.5rem)] opacity-50" />
            <nav className="flex-1 px-3 py-5"><NavLinks items={items} onNavigate={() => setOpen(false)} /></nav>
            <div className="space-y-4 border-t border-line/80 p-4">
              <CompanyBlock copy={copy} companies={props.companies} activeCompanyId={props.activeCompanyId} email={props.email} setActiveCompany={props.setActiveCompany} />
              <div className="sm:hidden"><LanguageSwitch copy={copy} locale={props.locale} setLocale={props.setLocale} /></div>
              <form action={props.signOut}>
                <button type="submit" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 text-sm font-semibold text-slate-400 transition hover:bg-white/[0.04] hover:text-fg">
                  <Icon name="logout" className="h-[18px] w-[18px]" />{copy.shell.signOut}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      <CommandPalette items={items} copy={copy} open={searching} onClose={() => setSearching(false)} />
      <BottomBar items={items} copy={copy} onMore={() => setOpen(true)} />
    </div>
  )
}
