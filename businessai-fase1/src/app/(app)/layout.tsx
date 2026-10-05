import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { signOut } from '@/app/actions/auth'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <span className="truncate font-semibold text-slate-900">{session.membership?.company?.name ?? 'BusinessAI'}</span>
          <form action={signOut}>
            <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">Cerrar sesión</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 sm:py-10">{children}</main>
    </div>
  )
}
