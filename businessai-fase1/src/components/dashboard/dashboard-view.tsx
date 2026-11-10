/**
 * Executive dashboard (presentation only). Receives the metrics already
 * computed from the company's real rows (lib/dashboard/metrics.ts) and the
 * plan/subscription state; renders KPIs, chart, receivables, top clients,
 * activity and alerts in the user's language.
 */
import Link from 'next/link'
import type { DashboardMetrics } from '@/lib/dashboard/metrics'
import type { BillingState } from '@/lib/billing/state'
import { billingBanner } from '@/lib/billing/state'
import { usageNotice, type UsageRow } from '@/lib/billing/usage'
import { APP, formatters, intlTag, type AppCopy, type Locale } from '@/lib/i18n/app'
import { Icon, type IconName } from '@/components/ui/icon'
import { EmptyState } from '@/components/ui/page'
import { RevenueChart } from '@/components/dashboard/revenue-chart'


const CURRENCY = 'USD'
// Status colors (dataviz status palette), always shown with a label and amount.
const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' } as const

type Fmt = ReturnType<typeof formatters>
type Alert = { tone: 'info' | 'warning' | 'danger'; icon: IconName; text: string; href?: string; action?: string }

function buildAlerts(m: DashboardMetrics, t: AppCopy, f: Fmt, extra: Alert[]): Alert[] {
  const a = t.dashboard.alerts
  const list: Alert[] = [...extra]
  if (m.overdue.count > 0) list.push({ tone: 'danger', icon: 'alert', text: a.overdue(m.overdue.count, f.money(m.overdue.total)), href: '#overdue', action: a.overdueAction })
  if (m.dueSoon.count > 0) list.push({ tone: 'warning', icon: 'clock', text: a.dueSoon(m.dueSoon.count, f.money(m.dueSoon.total)), href: '#overdue', action: a.overdueAction })
  if (m.quotes.staleCount > 0) list.push({ tone: 'info', icon: 'file', text: a.staleQuotes(m.quotes.staleCount), href: '/documents', action: a.quotesAction })
  return list
}

function Kpi({ label, value, hint, icon, tone = 'neutral', trend }: {
  label: string; value: string; hint?: string; icon: IconName; tone?: 'neutral' | 'gold' | 'danger'; trend?: number | null
}) {
  const toneClass = {
    neutral: 'bg-stone-100 text-ink-700',
    gold: 'bg-gold-50 text-gold-700 ring-1 ring-inset ring-gold-200',
    danger: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-100',
  }[tone]
  return (
    <div className="card flex min-w-0 flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-semibold leading-4 text-stone-500 sm:text-[13px]">{label}</span>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${toneClass}`}><Icon name={icon} className="h-4 w-4" /></span>
      </div>
      <p className="mt-3 break-words text-lg font-bold leading-tight tracking-tight text-ink-950 tabular-nums sm:text-2xl">{value}</p>
      {hint && (
        <p className="mt-1.5 flex items-start gap-1 text-xs leading-4 text-stone-500">
          {trend !== undefined && trend !== null && (
            <Icon name="arrowRight" className={`mt-0.5 h-3 w-3 shrink-0 ${trend >= 0 ? '-rotate-45 text-emerald-600' : 'rotate-45 text-red-600'}`} />
          )}
          <span>{hint}</span>
        </p>
      )}
    </div>
  )
}

function Card({ title, subtitle, children, action, id }: { title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="card min-w-0 scroll-mt-24 p-4 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink-950">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-stone-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function AlertsCard({ alerts, t }: { alerts: Alert[]; t: AppCopy }) {
  const tone = { info: 'alert-info', warning: 'alert-warning', danger: 'alert-danger' } as const
  return (
    <Card title={t.dashboard.alerts.title}>
      {alerts.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-100">
          <Icon name="check" className="h-4 w-4" />{t.dashboard.alerts.none}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {alerts.map((a, i) => (
            <li key={i} className={`flex flex-col gap-2 text-sm sm:flex-row sm:items-start sm:justify-between ${tone[a.tone]}`}>
              <span className="flex items-start gap-2"><Icon name={a.icon} className="mt-0.5 h-4 w-4 shrink-0" />{a.text}</span>
              {a.href && a.action && <Link href={a.href} className="shrink-0 font-semibold underline underline-offset-4">{a.action}</Link>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Receivables({ m, t, f }: { m: DashboardMetrics; t: AppCopy; f: Fmt }) {
  const r = t.dashboard.receivables
  const current = Math.max(m.receivable.total - m.overdue.total - m.dueSoon.total, 0)
  const parts = [
    { key: 'current', label: r.current, value: current, color: STATUS.good },
    { key: 'soon', label: r.dueSoon, value: m.dueSoon.total, color: STATUS.warning },
    { key: 'overdue', label: r.overdue, value: m.overdue.total, color: STATUS.critical },
  ]
  const total = m.receivable.total
  return (
    <Card id="overdue" title={r.title} subtitle={total > 0 ? f.money(total) : undefined}>
      {total <= 0 ? <p className="text-sm text-stone-500">{r.empty}</p> : (
        <>
          <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img"
            aria-label={parts.map((p) => `${p.label}: ${f.money(p.value)}`).join(' · ')}>
            {parts.filter((p) => p.value > 0).map((p) => (
              <span key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${f.money(p.value)}`} />
            ))}
          </div>
          <ul className="mt-4 grid grid-cols-3 gap-2 text-xs [&>li]:min-w-0">
            {parts.map((p) => (
              <li key={p.key} className="min-w-0">
                <span className="flex items-center gap-1.5 text-stone-500"><span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} /><span className="truncate">{p.label}</span></span>
                <span className="mt-0.5 block truncate font-semibold tabular-nums text-ink-950">{f.money(p.value)}</span>
              </li>
            ))}
          </ul>
          {m.overdue.items.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500">{t.dashboard.overdueList.title}</h3>
              <ul className="mt-2 divide-y divide-stone-100">
                {m.overdue.items.map((l) => (
                  <li key={l.id}>
                    <Link href={`/documents/${l.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2 hover:bg-stone-50">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-ink-950">{l.number ?? '—'} · {l.clientName ?? l.title ?? ''}</span>
                        <span className="block text-xs text-red-700">
                          {l.daysOverdue !== null ? t.dashboard.overdueList.days(l.daysOverdue) : t.dashboard.overdueList.flagged}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-ink-950">{f.money(l.outstanding)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function TopClients({ m, t, f }: { m: DashboardMetrics; t: AppCopy; f: Fmt }) {
  const max = Math.max(...m.topClients.map((c) => c.invoiced), 0)
  return (
    <Card title={t.dashboard.top.title} subtitle={t.dashboard.top.subtitle}>
      {m.topClients.length === 0 ? <p className="text-sm text-stone-500">{t.dashboard.top.empty}</p> : (
        <ul className="space-y-3">
          {m.topClients.map((c) => (
            <li key={c.id}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium text-ink-900">{c.name ?? t.dashboard.top.unknown}</span>
                <span className="shrink-0 font-semibold tabular-nums text-ink-950">{f.money(c.invoiced)}</span>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-stone-100">
                <div className="h-2 rounded-full" style={{ width: `${max ? Math.max((c.invoiced / max) * 100, 2) : 0}%`, background: '#2a78d6' }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ActivityFeed({ m, t, f }: { m: DashboardMetrics; t: AppCopy; f: Fmt }) {
  const a = t.dashboard.activity
  const item = (x: DashboardMetrics['activity'][number]) => {
    switch (x.kind) {
      case 'client': return { icon: 'users' as IconName, text: a.client(x.name ?? t.dashboard.top.unknown), href: '/clients' }
      case 'document': return { icon: 'file' as IconName, text: a.document(t.docType[x.type ?? ''] ?? x.type ?? '', x.number ?? ''), href: `/documents/${x.id}` }
      case 'payment': return { icon: 'wallet' as IconName, text: a.payment(f.money(x.amount), x.documentNumber), href: x.documentId ? `/documents/${x.documentId}` : '/payments' }
    }
  }
  return (
    <Card title={a.title} action={<Link href="/documents" className="shrink-0 text-xs font-semibold text-gold-700 underline underline-offset-4">{a.seeAll}</Link>}>
      {m.activity.length === 0 ? <p className="text-sm text-stone-500">{a.empty}</p> : (
        <ol className="divide-y divide-stone-100">
          {m.activity.map((x) => {
            const it = item(x)
            return (
              <li key={`${x.kind}-${x.id}`}>
                <Link href={it.href} className="flex min-h-12 items-center gap-3 py-2 hover:bg-stone-50">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-ink-700"><Icon name={it.icon} className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-900">{it.text}</span>
                    <span className="block text-xs text-stone-500">{f.dateTime(x.at)}</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}


export function DashboardView({ locale, m, companyName, firstName, billing, usage, now = new Date() }: {
  locale: Locale; m: DashboardMetrics; companyName: string | null; firstName: string | null
  billing: BillingState | null; usage: UsageRow[]; now?: Date
}) {
  const t = APP[locale]
  const f = formatters(locale, CURRENCY)
  const d = t.dashboard
  // Plan and subscription alerts (real state from the database).
  const extra: Alert[] = []
  const bill = billingBanner(billing, now, locale)
  if (bill && bill.tone !== 'info') extra.push({ tone: bill.tone, icon: 'card', text: bill.text, href: '/billing', action: d.alerts.payment })
  for (const row of usage) {
    const n = usageNotice(row, locale)
    if (n) extra.push({ tone: n.level === 'warning' ? 'warning' : 'danger', icon: 'chart', text: n.text, href: '/billing', action: d.alerts.upgrade })
  }
  const alerts = buildAlerts(m, t, f, extra)

  const trend = (pct: number | null) => (pct === null ? d.kpi.noPrevious : d.kpi.vsLast(f.pct(pct)))
  const points = m.months.map((p) => ({ ...p, label: f.month(p.key), longLabel: f.monthLong(p.key) }))
  const sum = (k: 'invoiced' | 'collected') => m.months.reduce((s, p) => s + p[k], 0)
  const hasSeries = m.months.some((p) => p.invoiced > 0 || p.collected > 0)

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">{d.eyebrow}</p>
          <h1 className="page-title mt-2 truncate">{d.greeting(firstName)}</h1>
          <p className="mt-1.5 text-sm text-stone-500">{d.subtitle(f.date(m.today))} · {companyName}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
          <Link href="/documents/new" className="btn-primary justify-center"><Icon name="filePlus" className="h-4 w-4" />{d.newDocument}</Link>
          <Link href="/clients" className="btn-secondary justify-center"><Icon name="users" className="h-4 w-4" />{d.newClient}</Link>
        </div>
      </div>

      {!m.hasData && (
        <div className="card">
          <EmptyState icon="chart" title={d.emptyTitle} description={d.emptyText}
            action={<Link href="/clients" className="btn-primary">{d.newClient}</Link>} />
        </div>
      )}

      {m.hasData && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 2xl:grid-cols-6">
          <Kpi label={d.kpi.collected} value={f.money(m.collected.current)} hint={trend(m.collected.changePct)} trend={m.collected.changePct} icon="wallet" tone="gold" />
          <Kpi label={d.kpi.invoiced} value={f.money(m.invoiced.current)} hint={trend(m.invoiced.changePct)} trend={m.invoiced.changePct} icon="receipt" />
          <Kpi label={d.kpi.receivable} value={f.money(m.receivable.total)} hint={d.kpi.invoicesOpen(m.receivable.count)} icon="clock" />
          <Kpi label={d.kpi.overdue} value={f.money(m.overdue.total)} hint={d.kpi.overdueCount(m.overdue.count)} icon="alert" tone={m.overdue.count > 0 ? 'danger' : 'neutral'} />
          <Kpi label={d.kpi.quotes} value={f.money(m.quotes.openTotal)} hint={d.kpi.quotesOpen(m.quotes.openCount)} icon="file" />
          <Kpi label={d.kpi.clients} value={f.integer(m.clients.total)} hint={d.kpi.newClients(m.clients.newThisMonth)} icon="users" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        {m.hasData && (
          <div className="min-w-0 lg:col-span-2">
            <Card title={d.chart.title} subtitle={d.chart.subtitle}>
              {hasSeries ? (
                <RevenueChart points={points} tag={intlTag(locale)} currency={CURRENCY}
                  labels={{ ...d.chart, summary: d.chart.summary(f.money(sum('invoiced')), f.money(sum('collected'))) }} />
              ) : <p className="text-sm text-stone-500">{d.chart.empty}</p>}
            </Card>
          </div>
        )}
        <div className={`min-w-0 ${m.hasData ? '' : 'lg:col-span-3'}`}><AlertsCard alerts={alerts} t={t} /></div>
      </div>

      {m.hasData && (
        <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 xl:grid-cols-3">
          <Receivables m={m} t={t} f={f} />
          <TopClients m={m} t={t} f={f} />
          <div className="min-w-0 md:col-span-2 xl:col-span-1"><ActivityFeed m={m} t={t} f={f} /></div>
        </div>
      )}
    </div>
  )
}
