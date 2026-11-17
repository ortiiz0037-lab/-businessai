import Link from 'next/link'
import { cookies } from 'next/headers'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { onboardingProgress, onboardingSteps } from '@/lib/onboarding'
import { hideOnboarding } from '@/app/actions/onboarding'
import type { Locale } from '@/lib/i18n/app'

export const ONBOARDING_COOKIE = 'ba_onboarding_hidden'

/** «Primeros pasos»: shown on the dashboard until every step is done or the user hides it. */
export async function OnboardingChecklist({ supabase, user, companyId, locale }: { supabase: SupabaseClient; user: User; companyId: string; locale: Locale }) {
  const jar = await cookies()
  if (jar.get(ONBOARDING_COOKIE)?.value === companyId) return null
  const count = (r: { count: number | null; error: unknown }) => (r.error ? 0 : r.count ?? 0)
  const [profile, branches, members, employees, invitations, sub] = await Promise.all([
    supabase.from('company_profiles').select('legal_name, display_name, phone, address').eq('company_id', companyId).maybeSingle(),
    supabase.from('branches').select('id', { count: 'exact', head: true }).eq('company_id', companyId).is('archived_at', null),
    supabase.from('memberships').select('user_id', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invitations').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('company_subscriptions').select('status').eq('company_id', companyId).maybeSingle(),
  ])
  const steps = onboardingSteps({ emailConfirmed: !!user.email_confirmed_at, profile: profile.data, branches: count(branches), members: count(members),
    employees: count(employees), invitations: count(invitations), subscriptionStatus: (sub.data as { status?: string } | null)?.status ?? null, localeChosen: !!jar.get('ba_locale') })
  const { done, total } = onboardingProgress(steps)
  if (done === total) return null
  const t = (es: string, en: string) => (locale === 'en' ? en : es)
  return (
    <section className="card mb-6 p-5 sm:p-6" aria-labelledby="onb-title" data-testid="onboarding">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 id="onb-title" className="font-display text-lg font-semibold text-fg">{t('Primeros pasos', 'Getting started')}</h2>
          <p className="text-sm text-muted">{t(`${done} de ${total} completados`, `${done} of ${total} done`)}</p></div>
        <form action={hideOnboarding}><input type="hidden" name="company" value={companyId} /><button className="btn-secondary btn-sm min-h-11">{t('Ocultar', 'Hide')}</button></form>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden="true"><div className="h-full rounded-full bg-electric" style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.key} className={`flex min-h-11 items-start gap-3 rounded-xl border px-3 py-2 text-sm ${s.done ? 'border-line/60 text-muted' : 'border-electric/40 text-fg'}`}>
            <span aria-hidden="true" className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${s.done ? 'bg-green-400/20 text-green-200' : 'bg-electric/20 text-blue-200'}`}>{s.done ? '✓' : i + 1}</span>
            <span className="min-w-0"><span className="sr-only">{s.done ? t('Hecho: ', 'Done: ') : t('Pendiente: ', 'To do: ')}</span>
              {s.href && !s.done ? <Link href={s.href} className="font-semibold text-accent hover:underline">{t(s.es, s.en)}</Link> : t(s.es, s.en)}
              {(s.hintEs || s.hintEn) && <span className="block text-xs text-muted">{t(s.hintEs ?? '', s.hintEn ?? '')}</span>}</span>
          </li>))}
      </ol>
    </section>
  )
}
