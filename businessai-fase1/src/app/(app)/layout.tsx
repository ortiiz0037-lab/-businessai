import Link from 'next/link'
import { signOut } from '@/app/actions/auth'

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link
            href="/dashboard"
            className="text-xl font-bold tracking-tight text-blue-700"
          >
            BusinessAI
          </Link>

          <nav className="flex items-center gap-2 overflow-x-auto">
            <Link
              href="/dashboard"
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
            >
              🏠 Inicio
            </Link>

            <Link
              href="/settings/company"
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
            >
              🏢 Mi empresa
            </Link>

            <Link
              href="/clients"
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
            >
              👥 Clientes
            </Link>

            <Link
              href="/documents"
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
            >
              📄 Documentos
            </Link>

            <Link
              href="/payments"
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-50"
            >
              💰 Pagos
            </Link>

            <form action={signOut}>
              <button
                type="submit"
                className="whitespace-nowrap rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                Cerrar sesión
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main>{children}</main>
    </div>
  )
}