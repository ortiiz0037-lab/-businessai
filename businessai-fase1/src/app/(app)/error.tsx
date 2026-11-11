'use client'
import { useEffect, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { clientLocale } from '@/components/html-lang'

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const [en, setEn] = useState(false)
  useEffect(() => { setEn(clientLocale() === 'en') }, [])
  return (
    <div role="alert" className="card mx-auto max-w-lg p-8 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-danger/10 text-red-400 ring-1 ring-inset ring-danger/30">
        <Icon name="alert" />
      </span>
      <h2 className="mt-5 font-display text-2xl font-semibold text-fg">{en ? 'Something went wrong' : 'Algo salió mal'}</h2>
      <p className="mt-2 text-sm text-muted">{en ? 'We could not load this page.' : 'No pudimos cargar esta página.'}</p>
      <button onClick={reset} className="btn-primary mt-6">{en ? 'Try again' : 'Reintentar'}</button>
    </div>
  )
}
