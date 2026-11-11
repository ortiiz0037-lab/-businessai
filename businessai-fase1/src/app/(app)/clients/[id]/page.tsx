import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { updateClient } from '@/app/actions/clients'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ERRORS: Record<string, string> = {
  missing_name: 'El nombre es obligatorio.',
  too_long: 'Uno de los campos es demasiado largo.',
  email: 'Escribe un correo válido o déjalo vacío.',
  status: 'Elige si el cliente está activo o inactivo.',
  forbidden: 'Tu rol no permite editar este cliente.',
  save: 'No se pudo guardar. Inténtalo nuevamente.',
}

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
      <Link href="/clients" className="text-sm font-semibold text-muted hover:text-fg">← Volver a Clientes</Link>

      <section className="card p-6 sm:p-8">
        <p className="eyebrow">Cliente</p>
        <h1 className="mt-1.5 font-display text-2xl font-semibold text-fg sm:text-3xl">Editar cliente</h1>
        <p className="mt-2 text-sm text-muted">Los cambios se verán en los documentos de este cliente al abrirlos o imprimirlos. Un cliente inactivo se conserva con todo su historial.</p>

        {query.error && (
          <div role="alert" className="alert-danger mt-5 p-4">{ERRORS[query.error] ?? ERRORS.save}</div>
        )}

        <form action={updateClient} className="mt-6 space-y-4">
          <input type="hidden" name="id" value={client.id} />
          {field('name', 'Nombre *', { required: true, maxLength: 160 })}
          {field('business_name', 'Empresa', { maxLength: 160 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {field('email', 'Correo', { type: 'email', maxLength: 160 })}
            {field('phone', 'Teléfono', { maxLength: 40 })}
          </div>
          {field('address', 'Dirección', { maxLength: 240 })}
          <div className="grid gap-4 sm:grid-cols-3">
            {field('city', 'Ciudad', { maxLength: 80 })}
            {field('state', 'Estado', { maxLength: 80 })}
            {field('postal_code', 'ZIP', { maxLength: 20 })}
          </div>
          <label className="field-label">Notas
            <textarea name="notes" rows={3} maxLength={2000} defaultValue={client.notes ?? ''} className="field mt-2 resize-none" />
          </label>
          <label className="field-label">Estado
            <select name="status" defaultValue={client.status === 'inactive' ? 'inactive' : 'active'} className="field mt-2">
              <option value="active">Activo</option>
              <option value="inactive">Inactivo (se conserva con su historial)</option>
            </select>
          </label>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Link href="/clients" className="btn-secondary">Cancelar</Link>
            <button type="submit" className="btn-primary">Guardar cambios</button>
          </div>
        </form>
      </section>
    </div>
  )
}
