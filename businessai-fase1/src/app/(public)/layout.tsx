import Link from 'next/link'
import { Brand } from '@/components/ui/brand'

/** Public pages (no session needed): pricing and legal texts. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/90 text-white backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <Brand href="/" tone="light" />
          <nav aria-label="Navegación pública" className="flex items-center gap-1 text-sm font-semibold sm:gap-2">
            <Link href="/precios" className="hidden rounded-lg px-3 py-2 text-white/65 hover:text-white sm:inline">Precios</Link>
            <Link href="/login" className="rounded-lg px-3 py-2 text-white/65 hover:text-white">Iniciar sesión</Link>
            <Link href="/signup" className="btn-gold btn-sm">Crear cuenta</Link>
          </nav>
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-9 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Brand href="/" />
          <div className="sm:text-right">
            <nav aria-label="Enlaces legales" className="flex flex-wrap gap-x-5 gap-y-2 sm:justify-end">
              <Link href="/precios" className="hover:text-ink-900">Precios</Link>
              <Link href="/terminos" className="hover:text-ink-900">Términos y condiciones</Link>
              <Link href="/privacidad" className="hover:text-ink-900">Política de privacidad</Link>
            </nav>
            <p className="mt-2 text-xs">© {new Date().getFullYear()} BusinessAI</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
