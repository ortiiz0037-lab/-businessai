import Link from 'next/link'

/** Public pages (no session needed): pricing and legal texts. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/precios" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-950 to-blue-700 text-base font-black text-white shadow-lg shadow-blue-950/20">
              B
            </span>
            <span className="text-lg font-extrabold tracking-tight text-slate-950">
              Business<span className="text-blue-600">AI</span>
            </span>
          </Link>
          <nav aria-label="Navegación pública" className="flex items-center gap-1 text-sm font-semibold sm:gap-2">
            <Link href="/precios" className="hidden rounded-xl px-3 py-2 text-slate-600 hover:text-slate-950 sm:inline">Precios</Link>
            <Link href="/login" className="rounded-xl px-3 py-2 text-slate-600 hover:text-slate-950">Iniciar sesión</Link>
            <Link href="/signup" className="rounded-xl bg-slate-950 px-4 py-2 text-white shadow-sm hover:bg-slate-800">Crear cuenta</Link>
          </nav>
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} BusinessAI</p>
          <nav aria-label="Enlaces legales" className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/precios" className="hover:text-slate-900">Precios</Link>
            <Link href="/terminos" className="hover:text-slate-900">Términos y condiciones</Link>
            <Link href="/privacidad" className="hover:text-slate-900">Política de privacidad</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
