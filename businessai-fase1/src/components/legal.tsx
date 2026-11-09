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
      <div role="note" className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900">
        <p className="font-bold">Borrador preliminar para revisión</p>
        <p className="mt-1">
          Este texto todavía no es definitivo y no constituye asesoramiento legal. Los apartados marcados como
          «Pendiente» deben completarse y revisarse por el titular del servicio y su asesor legal antes de su publicación.
        </p>
      </div>
      <h1 className="mt-10 text-4xl font-black tracking-tight text-slate-950">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">Última actualización: {updated}</p>
      <div className="mt-6 text-base leading-7 text-slate-700">{intro}</div>
      <div className="mt-10 space-y-10">{children}</div>
    </main>
  )
}

export function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`s${n}`}>
      <h2 id={`s${n}`} className="text-xl font-extrabold tracking-tight text-slate-950">{n}. {title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-slate-700">{children}</div>
    </section>
  )
}

export function Pending({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900">
      [Pendiente: {children}]
    </span>
  )
}
