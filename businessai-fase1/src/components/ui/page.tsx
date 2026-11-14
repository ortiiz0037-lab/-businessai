import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/components/ui/icon'

/** Standard header of an internal page: eyebrow, serif title, description and actions. */
export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title mt-2">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] leading-6 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  )
}

/** KPI tile. */
export function StatCard({ label, value, hint, icon, tone = 'neutral' }: {
  label: string; value: ReactNode; hint?: string; icon: IconName; tone?: 'neutral' | 'gold' | 'success' | 'warning'
}) {
  const toneClass = {
    neutral: 'bg-elevated text-slate-300',
    gold: 'bg-electric/10 text-blue-400 ring-1 ring-inset ring-electric/30',
    success: 'bg-success/10 text-green-300 ring-1 ring-inset ring-success/30',
    warning: 'bg-warning/10 text-amber-300 ring-1 ring-inset ring-warning/30',
  }[tone]
  return (
    <div className="card p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-muted sm:text-sm">{label}</span>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 sm:rounded-xl ${toneClass}`}>
          <Icon name={icon} className="h-4 w-4 sm:h-5 sm:w-5" />
        </span>
      </div>
      <p className="mt-4 text-xl font-bold tracking-tight text-fg tabular-nums sm:mt-5 sm:text-3xl">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted sm:mt-2">{hint}</p>}
    </div>
  )
}

/** Empty list / first-use state. */
export function EmptyState({ icon, title, description, action }: {
  icon: IconName; title: string; description?: string; action?: ReactNode
}) {
  return (
    <div className="px-6 py-16 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-electric/10 text-blue-400 ring-1 ring-inset ring-electric/30">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <h3 className="mt-5 text-base font-bold text-fg">{title}</h3>
      {description && <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
