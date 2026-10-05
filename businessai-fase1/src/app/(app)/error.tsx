'use client'
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="rounded-xl bg-white p-6 ring-1 ring-slate-200">
      <h2 className="font-semibold text-slate-900">Algo salió mal</h2>
      <p className="mt-1 text-sm text-slate-500">No pudimos cargar esta página.</p>
      <button onClick={reset} className="mt-4 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white">Reintentar</button>
    </div>
  )
}
