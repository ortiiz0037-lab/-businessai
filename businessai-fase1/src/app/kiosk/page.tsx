import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { Brand } from '@/components/ui/brand'
import { HtmlLang } from '@/components/html-lang'
import { kioskMessage, KIOSK_COOKIE, localTime, punchLabel } from '@/lib/workforce/context'
import { kioskPunch } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }

/**
 * Shared tablet (PIN mode). The tablet is not signed in to any account; it
 * only holds its kiosk token (httpOnly cookie). It shows the company name,
 * the punch form and, after a punch, the first name and the time — never
 * anyone's hours, history or other employees.
 */
export default async function KioskPage({ searchParams }: { searchParams: Promise<{ status?: string; name?: string; kind?: string; at?: string; lang?: string }> }) {
  const params = await searchParams
  const locale = params.lang === 'en' || params.lang === 'es' ? params.lang : await getLocale()
  const tr = translator(locale)
  const token = (await cookies()).get(KIOSK_COOKIE)?.value ?? ''
  const supabase = await createClient()
  const { data } = /^[0-9a-f]{64}$/.test(token) ? await supabase.rpc('kiosk_info', { raw_token: token }) : { data: null }
  const info = Array.isArray(data) ? (data[0] as { company_name: string; kiosk_name: string; timezone: string } | undefined) : undefined
  const ok = params.status === 'ok' && params.name && params.kind && params.at
  const kinds = [['in', 'btn-accent'], ['break_start', 'btn-secondary'], ['break_end', 'btn-primary'], ['out', 'btn-danger']] as const

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-4 py-8">
      <HtmlLang locale={locale} />
      {/* Clear the confirmation after a few seconds: the next person sees nothing. */}
      {params.status && <meta httpEquiv="refresh" content="6;url=/kiosk" />}
      <header className="flex items-center justify-between">
        <Brand />
        {info && <span className="text-right text-xs text-muted">{info.company_name}<br />{info.kiosk_name}</span>}
      </header>
      {!info ? (
        <div className="card p-8 text-center">
          <h1 className="font-display text-2xl font-semibold text-fg">{tr('Tableta no activada', 'Tablet not activated')}</h1>
          <p className="mt-2 text-sm text-muted">{tr('Un administrador debe abrir aquí el enlace de activación (Personal → Reglas → Tabletas).', 'An admin must open the activation link here (Workforce → Rules → Tablets).')}</p>
        </div>
      ) : (
        <>
          {ok ? (
            <div role="status" className="alert-success p-6 text-center text-lg">
              <strong>{params.name}</strong> · {punchLabel(params.kind!, locale)} · {localTime(params.at!, info.timezone, locale)}
            </div>
          ) : params.status ? (
            <div role="alert" className="alert-danger p-5 text-center">{kioskMessage(params.status, locale)}</div>
          ) : null}
          <form action={kioskPunch} className="card space-y-4 p-6" autoComplete="off">
            <h1 className="font-display text-2xl font-semibold text-fg">{tr('Reloj ponchador', 'Time clock')}</h1>
            <label className="field-label">{tr('Número de empleado', 'Employee number')}
              <input name="number" required inputMode="numeric" maxLength={30} autoComplete="off" className="field mt-2 text-2xl tracking-widest" />
            </label>
            <label className="field-label">PIN
              <input name="pin" type="password" required inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="off" className="field mt-2 text-2xl tracking-widest" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              {kinds.map(([k, cls]) => (
                <button key={k} type="submit" name="kind" value={k} className={`${cls} py-5 text-base`}>{punchLabel(k, locale)}</button>
              ))}
            </div>
            <p className="text-xs text-muted">{tr('La hora la registra el sistema. Esta pantalla no muestra datos de nadie.', 'The system records the time. This screen shows nobody\'s data.')}</p>
          </form>
        </>
      )}
    </main>
  )
}
