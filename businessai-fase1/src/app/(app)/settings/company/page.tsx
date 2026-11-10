import CompanyBranding from '@/components/CompanyBranding'
import { getSignatureDisplayUrl } from '@/lib/branding-assets'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { activeCompanyRow } from '@/lib/active-company'

/** Texto opcional: vacío → null (la BD exige null o 2–160 caracteres en legal_name). */
function optionalText(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim()
  return value.length > 0 ? value : null
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function colorValue(formData: FormData, key: string, fallback: string): string {
  const value = String(formData.get(key) ?? '').trim()
  return HEX_COLOR.test(value) ? value : fallback
}

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

  if (companyName.length < 2 || companyName.length > 160) {
    redirect('/settings/company?error=missing_name')
  }

  const membership = await activeCompanyRow(supabase, user.id)

  if (!membership?.company_id) {
    redirect('/onboarding')
  }

  const companyId = membership.company_id

  const { error } = await supabase
    .from('company_profiles')
    .upsert(
      {
        company_id: companyId,
        legal_name: optionalText(formData, 'legal_name'),
        display_name: companyName,
        phone: optionalText(formData, 'phone'),
        email: optionalText(formData, 'email'),
        address: optionalText(formData, 'address'),
        city: optionalText(formData, 'city'),
        state: optionalText(formData, 'state') ?? 'Puerto Rico',
        postal_code: optionalText(formData, 'postal_code'),
        primary_color: colorValue(formData, 'primary_color', '#2563EB'),
        secondary_color: colorValue(formData, 'secondary_color', '#0F172A'),
        payment_info: optionalText(formData, 'payment_info'),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'company_id',
      },
    )

  if (error) {
    console.error('COMPANY_PROFILE_SAVE_ERROR', {
      code: error.code,
      message: error.message,
    })
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

  const membership = await activeCompanyRow(supabase, user.id)

  if (!membership?.company_id) {
    redirect('/onboarding')
  }

  const { data: profile } = await supabase
    .from('company_profiles')
    .select('*')
    .eq('company_id', membership.company_id)
    .maybeSingle()

  // Private signature → short-lived signed URL for this member's preview.
  const signatureDisplay = await getSignatureDisplayUrl(
    supabase,
    profile?.signature_url,
    membership.company_id
  )

  return (
    <div className="py-1">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <p className="eyebrow">
            BusinessAI
          </p>

          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink-950 sm:text-4xl">
            Configuración de la empresa
          </h1>

          <p className="mt-2 max-w-2xl text-stone-600">
            Configura la información que BusinessAI utilizará para crear
            cotizaciones, facturas, recibos, órdenes de trabajo y documentos
            profesionales con la identidad de tu empresa.
          </p>
        </div>

        {params.saved === 'true' && (
          <div className="alert-success mb-6 font-medium">
            ✓ Los cambios se guardaron correctamente.
          </div>
        )}

        {params.error === 'save_failed' && (
          <div className="alert-danger mb-6 font-medium">
            No pudimos guardar los cambios. Revisa los datos e inténtalo
            nuevamente.
          </div>
        )}

        {params.error === 'missing_name' && (
          <div className="alert-warning mb-6 font-medium">
            El nombre de la empresa es requerido (entre 2 y 160 caracteres).
          </div>
        )}

        <form action={saveCompanyProfile} className="space-y-6">
          <section className="card p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink-950">
                Información principal
              </h2>

              <p className="mt-1 text-sm text-stone-500">
                Estos datos aparecerán en tus documentos.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="field-label">
                  Nombre legal
                </label>

                <input
                  name="legal_name"
                  defaultValue={profile?.legal_name ?? ''}
                  placeholder="Ej. PR Medical Ride Services LLC"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Nombre comercial
                </label>

                <input
                  name="company_name"
                  required
                  defaultValue={profile?.display_name ?? ''}
                  placeholder="Ej. PR Medical Ride"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Teléfono
                </label>

                <input
                  name="phone"
                  type="tel"
                  defaultValue={profile?.phone ?? ''}
                  placeholder="(787) 000-0000"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Email
                </label>

                <input
                  name="email"
                  type="email"
                  defaultValue={profile?.email ?? user.email ?? ''}
                  placeholder="empresa@email.com"
                  className="field"
                />
              </div>
            </div>
          </section>

          <section className="card p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink-950">
                Dirección
              </h2>

              <p className="mt-1 text-sm text-stone-500">
                Información utilizada en tus documentos comerciales.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="field-label">
                  Dirección
                </label>

                <input
                  name="address"
                  defaultValue={profile?.address ?? ''}
                  placeholder="Calle, número, urbanización"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Ciudad
                </label>

                <input
                  name="city"
                  defaultValue={profile?.city ?? ''}
                  placeholder="Ponce"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Estado / territorio
                </label>

                <input
                  name="state"
                  defaultValue={profile?.state ?? 'Puerto Rico'}
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Código postal
                </label>

                <input
                  name="postal_code"
                  defaultValue={profile?.postal_code ?? ''}
                  placeholder="00730"
                  className="field"
                />
              </div>
            </div>
          </section>

          <section className="card p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink-950">
                Identidad visual
              </h2>

              <p className="mt-1 text-sm text-stone-500">
                Estos colores serán utilizados para darle identidad a tus
                documentos.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="field-label">
                  Color principal
                </label>

                <div className="flex gap-3">
                  <input
                    name="primary_color"
                    type="color"
                    defaultValue={profile?.primary_color ?? '#2563EB'}
                    className="h-12 w-16 cursor-pointer rounded-xl border border-stone-300 bg-white p-1 shadow-sm"
                  />

                  <input
                    defaultValue={profile?.primary_color ?? '#2563EB'}
                    readOnly
                    className="field flex-1 text-stone-600"
                  />
                </div>
              </div>

              <div>
                <label className="field-label">
                  Color secundario
                </label>

                <div className="flex gap-3">
                  <input
                    name="secondary_color"
                    type="color"
                    defaultValue={profile?.secondary_color ?? '#0F172A'}
                    className="h-12 w-16 cursor-pointer rounded-xl border border-stone-300 bg-white p-1 shadow-sm"
                  />

                  <input
                    defaultValue={profile?.secondary_color ?? '#0F172A'}
                    readOnly
                    className="field flex-1 text-stone-600"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="card p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink-950">
                Información de pago
              </h2>

              <p className="mt-1 text-sm text-stone-500">
                Información que puede aparecer en facturas y recibos.
              </p>
            </div>

            <textarea
              name="payment_info"
              defaultValue={profile?.payment_info ?? ''}
              rows={5}
              placeholder="Ej. Métodos de pago aceptados, instrucciones de ATH Móvil, cheque, transferencia bancaria, etc."
              className="field"
            />
          </section>

          
        <CompanyBranding
          companyId={membership.company_id}
          logoUrl={profile?.logo_url ?? null}
          signaturePreviewUrl={signatureDisplay?.url ?? null}
          signatureIsLegacyPublic={signatureDisplay?.legacyPublic ?? false}
        />

<div className="flex justify-end">
            <button
              type="submit"
              className="btn-gold btn-lg"
            >
              Guardar cambios
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}