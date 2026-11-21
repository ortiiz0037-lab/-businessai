import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { Brand } from '@/components/ui/brand'
import { SubmitButton } from '@/components/submit-button'
import { activateKiosk } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }

/** Opened ONCE on the shared tablet with the link a manager created. */
export default async function KioskSetupPage({ searchParams }: { searchParams: Promise<{ token?: string; lang?: string }> }) {
  const { token = '', lang } = await searchParams
  const locale = lang === 'en' || lang === 'es' ? lang : await getLocale()
  const tr = translator(locale)
  const supabase = await createClient()
  const { data } = /^[0-9a-f]{64}$/.test(token) ? await supabase.rpc('kiosk_info', { raw_token: token }) : { data: null }
  const info = Array.isArray(data) ? (data[0] as { company_name: string; kiosk_name: string } | undefined) : undefined
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card w-full max-w-md space-y-5 p-8">
        <Brand />
        <h1 className="font-display text-2xl font-semibold text-fg">{tr('Activar tableta de ponches', 'Activate time clock tablet')}</h1>
        {info ? (
          <form action={activateKiosk} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <p className="text-sm text-muted">{tr(`Esta tableta quedará como «${info.kiosk_name}» de ${info.company_name}. No inicia sesión con ninguna cuenta: los empleados ponchan con su número y PIN.`,
              `This tablet becomes "${info.kiosk_name}" of ${info.company_name}. It signs in with no account: employees punch with their number and PIN.`)}</p>
            <SubmitButton pendingLabel="…">{tr('Activar esta tableta', 'Activate this tablet')}</SubmitButton>
          </form>
        ) : (
          <p className="alert-danger p-3 text-sm">{tr('El enlace no es válido o la tableta fue desactivada. Pide a un administrador un enlace nuevo.', 'The link is not valid or the tablet was deactivated. Ask an admin for a new link.')}</p>
        )}
      </div>
    </main>
  )
}
