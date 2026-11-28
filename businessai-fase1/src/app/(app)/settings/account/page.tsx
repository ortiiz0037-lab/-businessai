import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { cancelAccountDeletion, requestAccountDeletion } from '@/app/actions/account'

export const dynamic = 'force-dynamic'

/** My account: start or cancel the deletion of the account (App Store / Google Play requirement). */
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const tr = translator(await getLocale())
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/account')
  const { data: req } = await supabase.from('account_deletion_requests').select('status, requested_at, sole_owner_of').eq('user_id', user.id).maybeSingle()
  const r = req as { status: string; requested_at: string; sole_owner_of: number } | null
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader eyebrow={tr('Configuración', 'Settings')} title={tr('Mi cuenta', 'My account')} description={user.email ?? ''} />
      {sp.done && <p role="status" className="alert-info">{sp.done === 'requested' ? tr('Solicitud registrada.', 'Request recorded.') : tr('Solicitud cancelada.', 'Request cancelled.')}</p>}
      {sp.error && <p role="alert" className="alert-danger">{sp.error === 'confirm' ? tr('Escribe ELIMINAR para confirmar.', 'Type DELETE to confirm.') : tr('No se pudo guardar. Inténtalo de nuevo.', 'Could not save. Try again.')}</p>}
      <section className="card space-y-4 p-6" data-testid="account-deletion">
        <h2 className="font-display text-lg font-semibold text-fg">{tr('Eliminar mi cuenta', 'Delete my account')}</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{tr('Se eliminan tu usuario y tu acceso a todas las empresas.', 'Your user and your access to every company are deleted.')}</li>
          <li>{tr('Los registros financieros de las empresas (facturas, pagos, nómina, contabilidad) no se borran: la ley exige conservarlos.', 'The companies’ financial records (invoices, payments, payroll, accounting) are not erased: the law requires keeping them.')}</li>
          <li>{tr('Si eres el único propietario de una empresa, transfiere la propiedad o cancela su suscripción antes.', 'If you are the only owner of a company, transfer ownership or cancel its subscription first.')}</li>
          <li>{tr('La solicitud se completa en un máximo de 30 días; puedes cancelarla mientras esté pendiente.', 'The request is completed within 30 days; you can cancel it while it is pending.')}</li>
        </ul>
        {r?.status === 'pending' ? (
          <div className="space-y-3">
            <p className="alert-warning">{tr('Tu solicitud está pendiente desde ', 'Your request is pending since ')}{r.requested_at.slice(0, 10)}.
              {r.sole_owner_of > 0 && ` ${tr(`Eres el único propietario de ${r.sole_owner_of} empresa(s): transfiérelas o ciérralas.`, `You are the only owner of ${r.sole_owner_of} company(ies): transfer or close them.`)}`}</p>
            <form action={cancelAccountDeletion}><button className="btn-secondary min-h-11">{tr('Cancelar la solicitud', 'Cancel the request')}</button></form>
          </div>
        ) : (
          <form action={requestAccountDeletion} className="space-y-3">
            <label className="block text-sm text-fg">{tr('Motivo (opcional)', 'Reason (optional)')}<textarea name="reason" maxLength={500} rows={2} className="field mt-1 w-full" /></label>
            <label className="block text-sm text-fg">{tr('Escribe ELIMINAR para confirmar', 'Type DELETE to confirm')}<input name="confirm" autoComplete="off" className="field mt-1 h-11 w-full" required /></label>
            <button className="btn-secondary min-h-11 border-red-400/40 text-red-200">{tr('Solicitar la eliminación de mi cuenta', 'Request deletion of my account')}</button>
          </form>
        )}
      </section>
    </div>
  )
}
