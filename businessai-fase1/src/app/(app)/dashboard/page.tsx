import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

const CARDS = ['Documentos', 'Clientes', 'Facturas pendientes', 'Facturas vencidas']

export default async function DashboardPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (!session.membership?.company) redirect('/onboarding')
  const name = (session.user.user_metadata?.full_name as string | undefined) ?? session.user.email
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Bienvenido, {name}</h1>
        <p className="mt-1 text-sm text-slate-500">Tu empresa</p>
        <p className="text-lg font-medium text-slate-900">{session.membership.company.name}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CARDS.map((title) => (
          <div key={title} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">{title}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-300">—</p>
            <span className="mt-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Próximamente</span>
          </div>
        ))}
      </div>
    </div>
  )
}
