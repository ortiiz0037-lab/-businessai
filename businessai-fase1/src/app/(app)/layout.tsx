import Link from 'next/link'
import { signOut } from '@/app/actions/auth'

const navigation = [
  { href: '/dashboard', label: 'Inicio', icon: '⌂' },
  { href: '/settings/company', label: 'Mi empresa', icon: '▦' },
  { href: '/clients', label: 'Clientes', icon: '♧' },
  { href: '/documents', label: 'Documentos', icon: '▤' },
  { href: '/payments', label: 'Pagos', icon: '$' },
]

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-900">
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 shadow-sm backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link
            href="/dashboard"
            className="flex shrink-0 items-center gap-3"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-950 to-blue-700 text-lg font-black text-white shadow-lg shadow-blue-950/20">
              B
            </span>

            <span>
              <span className="block text-lg font-extrabold tracking-tight text-slate-950">
                Business<span className="text-blue-600">AI</span>
              </span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Business workspace
              </span>
            </span>
          </Link>

          <nav className="flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-slate-200/80 bg-slate-50/80 p-1.5">
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 sm:px-4 ${
                  item.href === '/dashboard'
                    ? 'bg-slate-950 text-white shadow-md shadow-slate-950/15'
                    : 'text-slate-500 hover:bg-white hover:text-slate-950 hover:shadow-sm'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>

          <form action={signOut} className="shrink-0">
            <button
              type="submit"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 sm:px-4"
            >
              <span className="hidden sm:inline">Cerrar sesión</span>
              <span className="sm:hidden">Salir</span>
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto min-h-[calc(100vh-80px)] max-w-[1600px] px-4 py-7 sm:px-8 sm:py-10">
        {children}
      </main>

      <footer className="border-t border-slate-200/80 bg-white">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-2 px-5 py-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>
            © {new Date().getFullYear()} BusinessAI. Todos los derechos reservados.
          </p>
          <p className="font-medium tracking-wide">
            GESTIÓN EMPRESARIAL INTELIGENTE
          </p>
        </div>
      </footer>
    </div>
  )
}