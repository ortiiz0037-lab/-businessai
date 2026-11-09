'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { isActivePath } from '@/lib/nav'
import { Icon, type IconName } from '@/components/ui/icon'
import { Brand, BrandMark } from '@/components/ui/brand'

export type NavItem = { href: string; label: string; icon: IconName }

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
              className={`group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
                active
                  ? 'bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]'
                  : 'text-white/55 hover:bg-white/[0.04] hover:text-white'
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

function SidebarFooter({ companyName, email, signOut }: { companyName: string | null; email: string | null; signOut: () => Promise<void> }) {
  return (
    <div className="border-t border-white/10 p-4">
      <div className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold-400/15 text-sm font-bold text-gold-300 ring-1 ring-inset ring-gold-400/30">
          {(companyName ?? email ?? 'B').trim().charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{companyName ?? 'Mi empresa'}</p>
          {email && <p className="truncate text-xs text-white/45">{email}</p>}
        </div>
      </div>
      <form action={signOut} className="mt-2">
        <button type="submit" className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white/55 transition hover:bg-white/[0.04] hover:text-white">
          <Icon name="logout" className="h-[18px] w-[18px]" />
          Cerrar sesión
        </button>
      </form>
    </div>
  )
}

/**
 * Application chrome: fixed dark sidebar on desktop (lg+); on iPhone/iPad a
 * top bar with a slide-in menu. The current section is highlighted.
 */
export function AppNav({ items, companyName, email, signOut }: {
  items: NavItem[]; companyName: string | null; email: string | null; signOut: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [open])

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="relative hidden w-72 shrink-0 bg-ink-950 lg:block" aria-label="Menú principal">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_30%_at_0%_0%,rgb(195_154_60/0.16),transparent)]" aria-hidden="true" />
        <div className="sticky top-0 flex h-screen flex-col">
        <div className="relative px-6 pb-6 pt-7">
          <Brand href="/dashboard" tone="light" subtitle="Business workspace" />
        </div>
        <div className="divider-gold relative mx-auto w-[calc(100%-3rem)] opacity-40" />
        <nav className="relative flex-1 overflow-y-auto px-4 py-6">
          <p className="mb-3 px-3.5 text-[10px] font-bold uppercase tracking-[0.24em] text-white/30">Menú</p>
          <NavLinks items={items} />
        </nav>
        <div className="relative"><SidebarFooter companyName={companyName} email={email} signOut={signOut} /></div>
        </div>
      </aside>

      {/* iPhone / iPad top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-white/10 bg-ink-950 px-4 py-3 text-white lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="BusinessAI">
          <BrandMark className="h-9 w-9 text-base" />
          <span className="text-base font-extrabold tracking-tight">Business<span className="text-gold-400">AI</span></span>
        </Link>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="mobile-menu"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-white">
          <Icon name="menu" label="Abrir menú" />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú principal" id="mobile-menu">
          <button type="button" className="absolute inset-0 bg-ink-950/60 backdrop-blur-sm" onClick={() => setOpen(false)} aria-label="Cerrar menú" />
          <div className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col bg-ink-950 shadow-2xl">
            <div className="flex items-center justify-between p-5">
              <Brand href="/dashboard" tone="light" />
              <button type="button" onClick={() => setOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-xl text-white/70 hover:bg-white/5">
                <Icon name="close" label="Cerrar menú" />
              </button>
            </div>
            <div className="divider-gold mx-auto w-[calc(100%-2.5rem)] opacity-40" />
            <nav className="flex-1 overflow-y-auto px-3 py-5"><NavLinks items={items} onNavigate={() => setOpen(false)} /></nav>
            <SidebarFooter companyName={companyName} email={email} signOut={signOut} />
          </div>
        </div>
      )}
    </>
  )
}
