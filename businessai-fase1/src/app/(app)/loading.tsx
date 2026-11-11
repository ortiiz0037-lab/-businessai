export default function Loading() {
  return (
    <div className="animate-pulse space-y-8" aria-busy="true" aria-label="Cargando / Loading">
      <div className="h-40 rounded-3xl bg-app-2/90" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-32 rounded-2xl border border-line bg-card" />)}
      </div>
      <div className="h-72 rounded-2xl border border-line bg-card" />
    </div>
  )
}
