import Link from 'next/link'
import { Brand } from '@/components/ui/brand'
import { Icon, type IconName } from '@/components/ui/icon'
import type { AuthCopy } from '@/lib/i18n/auth'

const POINT_ICONS: IconName[] = ['shield', 'lock', 'sparkle']

/**
 * Sign-in / sign-up screen: brand panel (desktop) + form column.
 * On iPhone/iPad the brand panel collapses into a dark header.
 */
export function AuthCard({ title, subtitle, children, footer, copy, langHref, lang = 'es' }: {
  title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode
  copy: AuthCopy; langHref: string; lang?: string
}) {
  return (
    <main lang={lang} className="min-h-screen bg-canvas lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* Brand panel */}
      <section className="card-dark relative flex flex-col rounded-none border-0 px-6 pb-10 pt-6 sm:px-10 lg:min-h-screen lg:px-14 lg:py-12">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgb(255_255_255)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(70%_60%_at_30%_30%,black,transparent)]" />
        <div className="relative flex items-center justify-between gap-4">
          <Brand href={lang === 'en' ? '/?lang=en' : '/'} tone="light" />
          <Link href={langHref} title={copy.switchLabel} aria-label={copy.switchLabel}
            className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-bold text-white/80 hover:bg-white/10 lg:hidden">
            {copy.switchTo}
          </Link>
        </div>

        <div className="relative mt-10 max-w-lg lg:mt-auto">
          <p className="font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl">
            {copy.panel.title}
          </p>
          <p className="mt-4 hidden text-base leading-7 text-white/60 sm:block">{copy.panel.subtitle}</p>
          <ul className="mt-10 hidden space-y-5 lg:block">
            {copy.panel.points.map((p, i) => (
              <li key={p.title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gold-400/30 bg-gold-400/10 text-gold-300">
                  <Icon name={POINT_ICONS[i % POINT_ICONS.length]} className="h-[18px] w-[18px]" />
                </span>
                <span>
                  <span className="block text-sm font-bold text-white">{p.title}</span>
                  <span className="mt-0.5 block text-sm text-white/55">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 hidden text-xs uppercase tracking-[0.22em] text-white/35 lg:block">{copy.panel.footer}</p>
      </section>

      {/* Form column */}
      <section className="relative flex flex-col px-5 pb-12 sm:px-10 lg:min-h-screen lg:px-16">
        <div className="hidden items-center justify-between py-8 lg:flex">
          <Link href={lang === 'en' ? '/?lang=en' : '/'} className="inline-flex items-center gap-2 text-sm font-semibold text-stone-500 hover:text-ink-950">
            <Icon name="arrowLeft" className="h-4 w-4" /> {copy.back}
          </Link>
          <Link href={langHref} title={copy.switchLabel} aria-label={copy.switchLabel}
            className="rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-bold text-ink-800 hover:bg-white">
            {copy.switchTo}
          </Link>
        </div>

        <div className="mx-auto -mt-6 w-full max-w-md lg:my-auto lg:pb-16">
          <div className="card p-7 shadow-lift sm:p-9 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 sm:text-[34px]">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] text-stone-500">{subtitle}</p>}
            <div className="divider-gold mt-6 opacity-60" />
            <div className="mt-7">{children}</div>
            {footer && <div className="mt-8 text-center text-sm text-stone-500">{footer}</div>}
          </div>
        </div>
      </section>
    </main>
  )
}
