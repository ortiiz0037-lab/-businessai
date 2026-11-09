/**
 * Shared layout for the PRELIMINARY legal texts (/terminos, /privacidad).
 * Statements describe how the product works today; anything that is a legal
 * decision is marked with <Pending> for the owner's (and counsel's) review.
 */
export function LegalPage({ title, updated, intro, children }: {
  title: string; updated: string; intro: React.ReactNode; children: React.ReactNode
}) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <div role="note" className="alert-warning rounded-2xl p-5 leading-6">
        <p className="font-bold">Borrador preliminar para revisión</p>
        <p className="mt-1">
          Este texto todavía no es definitivo y no constituye asesoramiento legal. Los apartados marcados como
          «Pendiente» deben completarse y revisarse por el titular del servicio y su asesor legal antes de su publicación.
        </p>
      </div>
      <p className="eyebrow mt-12">BusinessAI</p>
      <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-ink-950 sm:text-5xl">{title}</h1>
      <p className="mt-2 text-sm text-stone-500">Última actualización: {updated}</p>
      <div className="mt-6 text-base leading-7 text-stone-700">{intro}</div>
      <div className="divider-gold mt-8 opacity-70" />
      <div className="mt-10 space-y-10">{children}</div>
    </main>
  )
}

export function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`s${n}`}>
      <h2 id={`s${n}`} className="flex items-baseline gap-3 font-display text-2xl font-semibold tracking-tight text-ink-950"><span className="text-base font-sans font-bold text-gold-600 tabular-nums">{String(n).padStart(2, '0')}</span>{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-stone-700">{children}</div>
    </section>
  )
}

export function Pending({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">
      [Pendiente: {children}]
    </span>
  )
}
