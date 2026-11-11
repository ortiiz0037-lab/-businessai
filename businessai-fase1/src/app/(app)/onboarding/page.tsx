import { redirect } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { createCompany } from '@/app/actions/company'
import { getSession } from '@/lib/session'
import { Icon } from '@/components/ui/icon'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'

export default async function OnboardingPage({ searchParams }: { searchParams?: Promise<{ new?: string }> }) {
  const session = await getSession()
  if (!session) redirect('/login')
  const another = (await searchParams)?.new === '1'
  if (session.membership && !another) redirect('/dashboard')
  const tr = translator(await getLocale())
  return (
    <div className="mx-auto max-w-lg py-6 sm:py-12">
      <div className="card overflow-hidden">
        <div className="card-hero rounded-none border-0 px-7 py-8 shadow-none sm:px-9">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-electric/30 bg-brand/10 text-accent">
            <Icon name="building" />
          </span>
          <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{session.membership ? tr('Nueva empresa', 'New company') : tr('Paso 1 de 2', 'Step 1 of 2')}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">{session.membership ? tr('Crea otra empresa', 'Create another company') : tr('Crea tu empresa', 'Create your company')}</h1>
          <p className="mt-2 text-sm leading-6 text-white/60">
            {session.membership
              ? tr('Tendrá sus propios clientes, documentos, pagos, miembros y su propia suscripción. Podrás cambiar de empresa desde el menú.',
                  'It will have its own clients, documents, payments, members and subscription. You can switch companies from the menu.')
              : tr('Después elegirás tu plan. Podrás completar el logo, los datos y la firma en «Mi empresa».',
                  'Next you will choose your plan. You can add the logo, details and signature in "My company".')}
          </p>
        </div>
        <div className="p-7 sm:p-9">
          <ActionForm action={createCompany} submitLabel={tr('Crear empresa', 'Create company')} variant="gold"
            fields={[{ name: 'name', label: tr('Nombre de la empresa', 'Company name'), autoComplete: 'organization', placeholder: tr('Ej. Rivera Construction LLC', 'e.g. Rivera Construction LLC') }]} />
        </div>
      </div>
    </div>
  )
}
