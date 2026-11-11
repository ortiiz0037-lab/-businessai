import { redirect } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { createCompany } from '@/app/actions/company'
import { getSession } from '@/lib/session'
import { Icon } from '@/components/ui/icon'

export default async function OnboardingPage({ searchParams }: { searchParams?: Promise<{ new?: string }> }) {
  const session = await getSession()
  if (!session) redirect('/login')
  const another = (await searchParams)?.new === '1'
  if (session.membership && !another) redirect('/dashboard')
  return (
    <div className="mx-auto max-w-lg py-6 sm:py-12">
      <div className="card overflow-hidden">
        <div className="card-hero rounded-none border-0 px-7 py-8 shadow-none sm:px-9">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-electric/30 bg-brand/10 text-accent">
            <Icon name="building" />
          </span>
          <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{session.membership ? 'Nueva empresa' : 'Paso 1 de 2'}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">{session.membership ? 'Crea otra empresa' : 'Crea tu empresa'}</h1>
          <p className="mt-2 text-sm leading-6 text-white/60">
            {session.membership
              ? 'Tendrá sus propios clientes, documentos, pagos, miembros y su propia suscripción. Podrás cambiar de empresa desde el menú.'
              : 'Después elegirás tu plan. Podrás completar el logo, los datos y la firma en «Mi empresa».'}
          </p>
        </div>
        <div className="p-7 sm:p-9">
          <ActionForm action={createCompany} submitLabel="Crear empresa" variant="gold"
            fields={[{ name: 'name', label: 'Nombre de la empresa', autoComplete: 'organization', placeholder: 'Ej. Rivera Construction LLC' }]} />
        </div>
      </div>
    </div>
  )
}
