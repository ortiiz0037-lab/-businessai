import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function saveCompanyProfile(formData: FormData) {
  'use server'

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const companyName = String(formData.get('company_name') ?? '').trim()

  if (!companyName) {
    redirect('/settings/company?error=missing_name')
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    redirect('/onboarding')
  }

  const companyId = membership.company_id

  const { error } = await supabase
    .from('company_profiles')
    .upsert(
      {
        company_id: companyId,
        legal_name: String(formData.get('legal_name') ?? '').trim(),
        display_name: companyName,
        phone: String(formData.get('phone') ?? '').trim(),
        email: String(formData.get('email') ?? '').trim(),
        address: String(formData.get('address') ?? '').trim(),
        city: String(formData.get('city') ?? '').trim(),
        state: String(formData.get('state') ?? 'Puerto Rico').trim(),
        postal_code: String(formData.get('postal_code') ?? '').trim(),
        primary_color:
          String(formData.get('primary_color') ?? '#2563EB').trim(),
        secondary_color:
          String(formData.get('secondary_color') ?? '#0F172A').trim(),
        payment_info: String(formData.get('payment_info') ?? '').trim(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'company_id',
      },
    )

  if (error) {
    console.error('Error guardando empresa:', error)
    redirect('/settings/company?error=save_failed')
  }

  redirect('/settings/company?saved=true')
}

export default async function CompanySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    redirect('/onboarding')
  }

  const { data: profile } = await supabase
    .from('company_profiles')
    .select('*')
    .eq('company_id', membership.company_id)
    .maybeSingle()

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <p className="text-sm font-semibold text-blue-600">
            BusinessAI
          </p>

          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            Configuración de la empresa
          </h1>

          <p className="mt-2 max-w-2xl text-slate-600">
            Configura la información que BusinessAI utilizará para crear
            cotizaciones, facturas, recibos, órdenes de trabajo y documentos
            profesionales con la identidad de tu empresa.
          </p>
        </div>

        {params.saved === 'true' && (
          <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            ✓ Los cambios se guardaron correctamente.
          </div>
        )}

        {params.error === 'save_failed' && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
            No pudimos guardar los cambios. Revisa los datos e inténtalo
            nuevamente.
          </div>
        )}

        {params.error === 'missing_name' && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            El nombre de la empresa es requerido.
          </div>
        )}

        <form action={saveCompanyProfile} className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6">
              <h2 className="text-lg font-bold text-slate-950">
                Información principal
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Estos datos aparecerán en tus documentos.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Nombre legal
                </label>

                <input
                  name="legal_name"
                  defaultValue={profile?.legal_name ?? ''}
                  placeholder="Ej. PR Medical Ride Services LLC"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Nombre comercial
                </label>

                <input
                  name="company_name"
                  required
                  defaultValue={profile?.display_name ?? ''}
                  placeholder="Ej. PR Medical Ride"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Teléfono
                </label>

                <input
                  name="phone"
                  type="tel"
                  defaultValue={profile?.phone ?? ''}
                  placeholder="(787) 000-0000"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Email
                </label>

                <input
                  name="email"
                  type="email"
                  defaultValue={profile?.email ?? user.email ?? ''}
                  placeholder="empresa@email.com"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6">
              <h2 className="text-lg font-bold text-slate-950">
                Dirección
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Información utilizada en tus documentos comerciales.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Dirección
                </label>

                <input
                  name="address"
                  defaultValue={profile?.address ?? ''}
                  placeholder="Calle, número, urbanización"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Ciudad
                </label>

                <input
                  name="city"
                  defaultValue={profile?.city ?? ''}
                  placeholder="Ponce"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Estado / territorio
                </label>

                <input
                  name="state"
                  defaultValue={profile?.state ?? 'Puerto Rico'}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Código postal
                </label>

                <input
                  name="postal_code"
                  defaultValue={profile?.postal_code ?? ''}
                  placeholder="00730"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6">
              <h2 className="text-lg font-bold text-slate-950">
                Identidad visual
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Estos colores serán utilizados para darle identidad a tus
                documentos.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Color principal
                </label>

                <div className="flex gap-3">
                  <input
                    name="primary_color"
                    type="color"
                    defaultValue={profile?.primary_color ?? '#2563EB'}
                    className="h-12 w-16 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
                  />

                  <input
                    defaultValue={profile?.primary_color ?? '#2563EB'}
                    readOnly
                    className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-slate-600"
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Color secundario
                </label>

                <div className="flex gap-3">
                  <input
                    name="secondary_color"
                    type="color"
                    defaultValue={profile?.secondary_color ?? '#0F172A'}
                    className="h-12 w-16 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
                  />

                  <input
                    defaultValue={profile?.secondary_color ?? '#0F172A'}
                    readOnly
                    className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-slate-600"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6">
              <h2 className="text-lg font-bold text-slate-950">
                Información de pago
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Información que puede aparecer en facturas y recibos.
              </p>
            </div>

            <textarea
              name="payment_info"
              defaultValue={profile?.payment_info ?? ''}
              rows={5}
              placeholder="Ej. Métodos de pago aceptados, instrucciones de ATH Móvil, cheque, transferencia bancaria, etc."
              className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </section>

          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-xl bg-slate-950 px-7 py-3.5 text-sm font-bold text-white shadow-lg transition hover:bg-slate-800"
            >
              Guardar cambios
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}