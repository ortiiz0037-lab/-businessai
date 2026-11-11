import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { updateClient } from '@/app/actions/clients'
import { getLocale } from '@/lib/i18n/server'
import { translator, type Tr } from '@/lib/i18n/t'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const errors = (tr: Tr): Record<string, string> => ({
  missing_name: tr('El nombre es obligatorio.', 'The name is required.'),
  too_long: tr('Uno de los campos es demasiado largo.', 'One of the fields is too long.'),
  email: tr('Escribe un correo válido o déjalo vacío.', 'Enter a valid email or leave it empty.'),
  status: tr('Elige si el cliente está activo o inactivo.', 'Choose whether the client is active or inactive.'),
  forbidden: tr('Tu rol no permite editar este cliente.', 'Your role cannot edit this client.'),
  save: tr('No se pudo guardar. Inténtalo nuevamente.', 'It could not be saved. Please try again.'),
})

type Client = {
  id: string; company_id: string; name: string; business_name: string | null; email: string | null; phone: string | null
  address: string | null; city: string | null; state: string | null; postal_code: string | null; notes: string | null; status: string
}

export default async function EditClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ error?: string }>
}) {
  const { id } = await params
  const query = (await searchParams) ?? {}
  if (!UUID.test(id)) redirect('/clients?error=not_found')
  const tr = translator(await getLocale())
  const ERRORS = errors(tr)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data } = await supabase
    .from('clients')
    .select('id, company_id, name, business_name, email, phone, address, city, state, postal_code, notes, status')
    .eq('id', id)
    .maybeSingle()
  if (!data) redirect('/clients?error=not_found')
  const { data: member } = await supabase
    .from('memberships').select('company_id').eq('user_id', user.id).eq('company_id', data.company_id).maybeSingle()
  if (!member) redirect('/clients?error=not_found')
  const client = data as Client

  const field = (name: keyof Client, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field-label">{label}
      <input name={name} defaultValue={(client[name] as string | null) ?? ''} className="field mt-2" {...props} />
    </label>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href={`/clients/${client.id}`} className="text-sm font-semibold text-muted hover:text-fg">{tr('← Volver al cliente', '← Back to the client')}</Link>

      <section className="card p-6 sm:p-8">
        <p className="eyebrow">{tr('Cliente', 'Client')}</p>
        <h1 className="mt-1.5 font-display text-2xl font-semibold text-fg sm:text-3xl">{tr('Editar cliente', 'Edit client')}</h1>
        <p className="mt-2 text-sm text-muted">{tr('Los cambios se verán en los documentos de este cliente al abrirlos o imprimirlos. Un cliente inactivo se conserva con todo su historial.', 'Changes show on this client\'s documents when they are opened or printed. An inactive client is kept with its full history.')}</p>

        {query.error && (
          <div role="alert" className="alert-danger mt-5 p-4">{ERRORS[query.error] ?? ERRORS.save}</div>
        )}

        <form action={updateClient} className="mt-6 space-y-4">
          <input type="hidden" name="id" value={client.id} />
          {field('name', tr('Nombre *', 'Name *'), { required: true, maxLength: 160 })}
          {field('business_name', tr('Empresa', 'Company'), { maxLength: 160 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {field('email', tr('Correo', 'Email'), { type: 'email', maxLength: 160 })}
            {field('phone', tr('Teléfono', 'Phone'), { maxLength: 40 })}
          </div>
          {field('address', tr('Dirección', 'Address'), { maxLength: 240 })}
          <div className="grid gap-4 sm:grid-cols-3">
            {field('city', tr('Ciudad', 'City'), { maxLength: 80 })}
            {field('state', tr('Estado', 'State'), { maxLength: 80 })}
            {field('postal_code', 'ZIP', { maxLength: 20 })}
          </div>
          <label className="field-label">{tr('Notas', 'Notes')}
            <textarea name="notes" rows={3} maxLength={2000} defaultValue={client.notes ?? ''} className="field mt-2 resize-none" />
          </label>
          <label className="field-label">{tr('Estado', 'Status')}
            <select name="status" defaultValue={client.status === 'inactive' ? 'inactive' : 'active'} className="field mt-2">
              <option value="active">{tr('Activo', 'Active')}</option>
              <option value="inactive">{tr('Inactivo (se conserva con su historial)', 'Inactive (kept with its history)')}</option>
            </select>
          </label>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Link href={`/clients/${client.id}`} className="btn-secondary">{tr('Cancelar', 'Cancel')}</Link>
            <button type="submit" className="btn-primary">{tr('Guardar cambios', 'Save changes')}</button>
          </div>
        </form>
      </section>
    </div>
  )
}
