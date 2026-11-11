import CompanyBranding from '@/components/CompanyBranding'
import { getSignatureDisplayUrl } from '@/lib/branding-assets'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { activeCompanyRow } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'

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
  const locale = await getLocale()
  const tr = translator(locale)
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

          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            {tr('Configuración de la empresa', 'Company settings')}
          </h1>

          <p className="mt-2 max-w-2xl text-slate-400">
            {tr('Configura la información que BusinessAI utilizará para crear cotizaciones, facturas, recibos, órdenes de trabajo y documentos profesionales con la identidad de tu empresa.',
              'Set up the information BusinessAI uses to create quotes, invoices, receipts, work orders and professional documents with your company\'s identity.')}
          </p>
        </div>

        {params.saved === 'true' && (
          <div className="alert-success mb-6 font-medium">
            ✓ {tr('Los cambios se guardaron correctamente.', 'Changes saved.')}
          </div>
        )}

        {params.error === 'save_failed' && (
          <div className="alert-danger mb-6 font-medium">
            {tr('No pudimos guardar los cambios. Revisa los datos e inténtalo nuevamente.', 'We could not save the changes. Check the details and try again.')}
          </div>
        )}

        {params.error === 'missing_name' && (
          <div className="alert-warning mb-6 font-medium">
            {tr('El nombre de la empresa es requerido (entre 2 y 160 caracteres).', 'The company name is required (2 to 160 characters).')}
          </div>
        )}

        <form action={saveCompanyProfile} className="space-y-6">
          <section className="card p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                {tr('Información principal', 'Main information')}
              </h2>

              <p className="mt-1 text-sm text-muted">
                {tr('Estos datos aparecerán en tus documentos.', 'These details appear on your documents.')}
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="field-label">
                  {tr('Nombre legal', 'Legal name')}
                </label>

                <input
                  name="legal_name"
                  defaultValue={profile?.legal_name ?? ''}
                  placeholder={tr('Ej. PR Medical Ride Services LLC', 'e.g. PR Medical Ride Services LLC')}
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  {tr('Nombre comercial', 'Trade name')}
                </label>

                <input
                  name="company_name"
                  required
                  defaultValue={profile?.display_name ?? ''}
                  placeholder={tr('Ej. PR Medical Ride', 'e.g. PR Medical Ride')}
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  {tr('Teléfono', 'Phone')}
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
              <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                {tr('Dirección', 'Address')}
              </h2>

              <p className="mt-1 text-sm text-muted">
                {tr('Información utilizada en tus documentos comerciales.', 'Information used on your business documents.')}
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="field-label">
                  {tr('Dirección', 'Address')}
                </label>

                <input
                  name="address"
                  defaultValue={profile?.address ?? ''}
                  placeholder={tr('Calle, número, urbanización', 'Street, number, neighborhood')}
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  {tr('Ciudad', 'City')}
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
                  {tr('Estado / territorio', 'State / territory')}
                </label>

                <input
                  name="state"
                  defaultValue={profile?.state ?? 'Puerto Rico'}
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  {tr('Código postal', 'Postal code')}
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
              <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                {tr('Identidad visual', 'Visual identity')}
              </h2>

              <p className="mt-1 text-sm text-muted">
                {tr('Estos colores serán utilizados para darle identidad a tus documentos.', 'These colors give your documents their identity.')}
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="field-label">
                  {tr('Color principal', 'Primary color')}
                </label>

                <div className="flex gap-3">
                  <input
                    name="primary_color"
                    type="color"
                    defaultValue={profile?.primary_color ?? '#2563EB'}
                    className="h-12 w-16 cursor-pointer rounded-xl border border-line bg-card p-1 shadow-sm"
                  />

                  <input
                    defaultValue={profile?.primary_color ?? '#2563EB'}
                    readOnly
                    className="field flex-1 text-slate-400"
                  />
                </div>
              </div>

              <div>
                <label className="field-label">
                  {tr('Color secundario', 'Secondary color')}
                </label>

                <div className="flex gap-3">
                  <input
                    name="secondary_color"
                    type="color"
                    defaultValue={profile?.secondary_color ?? '#0F172A'}
                    className="h-12 w-16 cursor-pointer rounded-xl border border-line bg-card p-1 shadow-sm"
                  />

                  <input
                    defaultValue={profile?.secondary_color ?? '#0F172A'}
                    readOnly
                    className="field flex-1 text-slate-400"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="card p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                {tr('Información de pago', 'Payment information')}
              </h2>

              <p className="mt-1 text-sm text-muted">
                {tr('Información que puede aparecer en facturas y recibos.', 'Information that can appear on invoices and receipts.')}
              </p>
            </div>

            <textarea
              name="payment_info"
              defaultValue={profile?.payment_info ?? ''}
              rows={5}
              placeholder={tr('Ej. Métodos de pago aceptados, instrucciones de ATH Móvil, cheque, transferencia bancaria, etc.', 'e.g. Accepted payment methods, ATH Móvil instructions, check, bank transfer, etc.')}
              className="field"
            />
          </section>

          
        <CompanyBranding
          companyId={membership.company_id}
          logoUrl={profile?.logo_url ?? null}
          signaturePreviewUrl={signatureDisplay?.url ?? null}
          signatureIsLegacyPublic={signatureDisplay?.legacyPublic ?? false}
          locale={locale}
        />

<div className="flex justify-end">
            <button
              type="submit"
              className="btn-accent btn-lg"
            >
              {tr('Guardar cambios', 'Save changes')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}