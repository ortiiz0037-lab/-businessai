'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActivePath } from '@/lib/nav'

export type NavItem = { href: string; label: string; icon: string }

/** Main menu: highlights the current section. */
export function AppNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Menú principal"
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-slate-200/80 bg-slate-50/80 p-1.5">
      {items.map((item) => {
        const active = isActivePath(pathname, item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 sm:px-4 ${
              active
                ? 'bg-slate-950 text-white shadow-md shadow-slate-950/15'
                : 'text-slate-500 hover:bg-white hover:text-slate-950 hover:shadow-sm'
            }`}
          >
            <span className="text-base" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
