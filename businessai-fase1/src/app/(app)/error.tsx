'use client'
import { Icon } from '@/components/ui/icon'

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="card mx-auto max-w-lg p-8 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-danger/10 text-red-400 ring-1 ring-inset ring-danger/30">
        <Icon name="alert" />
      </span>
      <h2 className="mt-5 font-display text-2xl font-semibold text-fg">Algo salió mal</h2>
      <p className="mt-2 text-sm text-muted">No pudimos cargar esta página.</p>
      <button onClick={reset} className="btn-primary mt-6">Reintentar</button>
    </div>
  )
}
