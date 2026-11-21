import Link from 'next/link'

/** BusinessAI monogram: electric-blue tile with a white "B" and a cyan glow. */
export function BrandMark({ className = 'h-10 w-10 text-lg' }: { className?: string }) {
  return (
    <span className={`relative flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand via-electric to-accent font-display font-bold text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18),0_8px_22px_-8px_rgb(34_211_238/0.55)] ${className}`}>
      B
    </span>
  )
}

/** Monogram + wordmark. `tone="light"` for dark backgrounds. */
export function Brand({ href = '/', tone = 'dark', subtitle }: { href?: string; tone?: 'dark' | 'light'; subtitle?: string }) {
  return (
    <Link href={href} className="flex shrink-0 items-center gap-3" aria-label="BusinessAI">
      <BrandMark />
      <span className="leading-tight">
        <span className={`block text-[17px] font-extrabold tracking-tight ${tone === 'light' ? 'text-white' : 'text-fg'}`}>
          Business<span className="bg-gradient-to-r from-electric to-accent bg-clip-text text-transparent">AI</span>
        </span>
        {subtitle && (
          <span className={`block text-[10px] font-semibold uppercase tracking-[0.24em] ${tone === 'light' ? 'text-white/45' : 'text-slate-500'}`}>
            {subtitle}
          </span>
        )}
      </span>
    </Link>
  )
}
