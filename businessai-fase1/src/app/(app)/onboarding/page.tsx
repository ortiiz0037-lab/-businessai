import { redirect } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { createCompany } from '@/app/actions/company'
import { getSession } from '@/lib/session'

export default async function OnboardingPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.membership) redirect('/dashboard')
  return (
    <div className="mx-auto max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
      <h1 className="text-xl font-semibold text-slate-900">Crea tu empresa</h1>
      <p className="mt-1 mb-6 text-sm text-slate-500">Podrás completar logo, colores y datos en el siguiente paso del producto.</p>
      <ActionForm action={createCompany} submitLabel="Crear empresa"
        fields={[{ name: 'name', label: 'Nombre de la empresa', autoComplete: 'organization' }]} />
    </div>
  )
}
