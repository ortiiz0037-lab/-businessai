import Link from 'next/link'

/** BusinessAI monogram: black tile with a gold "B". */
export function BrandMark({ className = 'h-10 w-10 text-lg' }: { className?: string }) {
  return (
    <span className={`relative flex shrink-0 items-center justify-center rounded-xl bg-ink-950 font-display font-bold text-gold-300 shadow-[inset_0_0_0_1px_rgb(212_173_85/0.35),0_8px_20px_-10px_rgb(10_10_12/0.6)] ${className}`}>
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
        <span className={`block text-[17px] font-extrabold tracking-tight ${tone === 'light' ? 'text-white' : 'text-ink-950'}`}>
          Business<span className="text-gold-500">AI</span>
        </span>
        {subtitle && (
          <span className={`block text-[10px] font-semibold uppercase tracking-[0.24em] ${tone === 'light' ? 'text-white/45' : 'text-stone-400'}`}>
            {subtitle}
          </span>
        )}
      </span>
    </Link>
  )
}
