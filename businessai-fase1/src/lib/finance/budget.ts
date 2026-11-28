/**
 * Budgets (migration 0027): labels, error messages and the monthly budget
 * used by projections. Budget rules (draft-only edits, approval, publication,
 * one published budget per year / scenario / department) live in PostgreSQL.
 */
import type { Locale } from '@/lib/i18n/app'

export type Budget = {
  id: string; company_id: string; name: string; fiscal_year: number; period_type: 'monthly' | 'annual'; scenario: 'base' | 'conservative' | 'optimistic'
  department_id: string | null; root_id: string; version: number; status: 'draft' | 'approved' | 'published' | 'archived'; notes: string | null
  expense_warn_pct: number; expense_crit_pct: number; revenue_warn_pct: number; revenue_crit_pct: number
  created_by: string | null; created_at: string; approved_by: string | null; approved_at: string | null; approval_note: string | null
  published_by: string | null; published_at: string | null; archived_by: string | null; archived_at: string | null; archive_reason: string | null
}
export type BudgetLine = { id: number; budget_id: string; account_id: string | null; category_id: string | null; month: number | null; amount_cents: number | string; note: string | null }
export type VsActual = {
  kind: 'account' | 'category'; account_id: string | null; category_id: string | null; label: string; label_en: string | null; line_type: 'revenue' | 'expense'
  budget_total_cents: number | string; budget_ytd_cents: number | string; actual_cents: number | string; variance_cents: number | string
  variance_pct: number | string | null; consumed_pct: number | string | null; projection_cents: number | string | null; favorable: boolean
  alert: 'ok' | 'warning' | 'critical'; in_total: boolean; actual_available: boolean
}

const L = (locale: Locale, es: Record<string, string>, en: Record<string, string>, k: string) => (locale === 'en' ? en : es)[k] ?? k

export const budgetStatusLabel = (s: string, locale: Locale) =>
  L(locale, { draft: 'Borrador', approved: 'Aprobado', published: 'Publicado', archived: 'Archivado' }, { draft: 'Draft', approved: 'Approved', published: 'Published', archived: 'Archived' }, s)
export const budgetStatusTone = (s: string) => ({ draft: 'badge-neutral', approved: 'badge-accent', published: 'badge-success', archived: 'badge-neutral' } as Record<string, string>)[s] ?? 'badge-neutral'
export const scenarioLabel = (s: string, locale: Locale) =>
  L(locale, { base: 'Base', conservative: 'Conservador', optimistic: 'Optimista' }, { base: 'Base', conservative: 'Conservative', optimistic: 'Optimistic' }, s)
export const alertLabel = (s: string, locale: Locale) =>
  L(locale, { ok: 'En rango', warning: 'Atención', critical: 'Crítico' }, { ok: 'On track', warning: 'Watch', critical: 'Critical' }, s)
export const budgetEventLabel = (s: string, locale: Locale) =>
  L(locale, { created: 'Creado', updated: 'Modificado', filled_from_actuals: 'Rellenado con datos reales', approved: 'Aprobado', published: 'Publicado', archived: 'Archivado',
    version_created: 'Nueva versión', assumptions_updated: 'Supuestos actualizados' },
    { created: 'Created', updated: 'Changed', filled_from_actuals: 'Filled from actuals', approved: 'Approved', published: 'Published', archived: 'Archived',
      version_created: 'New version', assumptions_updated: 'Assumptions updated' }, s)

const CODES = ['BUDGET_DRAFT_EXISTS', 'BUDGET_EMPTY', 'BUDGET_IMMUTABLE', 'BUDGET_LINE_INVALID', 'BUDGET_LOCKED', 'BUDGET_NOT_FOUND', 'BUDGET_TRANSITION',
  'DEPARTMENT_INVALID', 'AMOUNT_INVALID', 'REASON_REQUIRED', 'FORBIDDEN']

export function financeErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (/budgets_published_uidx/.test(m)) return 'budget_published_exists'
  if (/budgets_one_draft_uidx/.test(m)) return 'budget_draft_exists'
  if (error?.code === '23514') return 'invalid'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === '40001' || /could not serialize/.test(m)) return 'retry'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}

const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    budget_draft_exists: 'Ya existe un borrador de este presupuesto: edítalo en lugar de crear otra versión.',
    budget_empty: 'Un presupuesto sin líneas no se puede aprobar.',
    budget_immutable: 'Un presupuesto aprobado, publicado o archivado no se modifica: crea una nueva versión.',
    budget_locked: 'Solo los borradores se pueden editar: crea una nueva versión.',
    budget_line_invalid: 'Línea no válida: elige una cuenta de ingreso o gasto, o una categoría, y el mes que corresponda.',
    budget_not_found: 'Presupuesto no encontrado.',
    budget_transition: 'Ese cambio de estado no está permitido (borrador → aprobado → publicado).',
    budget_published_exists: 'Ya hay un presupuesto publicado para ese año y escenario.',
    department_invalid: 'El departamento no pertenece a esta empresa.',
    amount_invalid: 'Importe o porcentaje no válido.',
    reason_required: 'Indica un motivo (3 a 300 caracteres).',
    forbidden: 'No tienes permiso para esta acción.',
    invalid: 'Revisa los datos del formulario.',
    retry: 'Otra persona hizo un cambio al mismo tiempo. Inténtalo de nuevo.',
    unavailable: 'Los estados financieros todavía no están activados en esta base de datos.',
    save: 'No se pudo guardar. Inténtalo de nuevo.',
  },
  en: {
    budget_draft_exists: 'There is already a draft of this budget: edit it instead of creating another version.',
    budget_empty: 'A budget without lines cannot be approved.',
    budget_immutable: 'An approved, published or archived budget never changes: create a new version.',
    budget_locked: 'Only drafts can be edited: create a new version.',
    budget_line_invalid: 'Invalid line: choose a revenue or expense account, or a category, and the right month.',
    budget_not_found: 'Budget not found.',
    budget_transition: 'That status change is not allowed (draft → approved → published).',
    budget_published_exists: 'There is already a published budget for that year and scenario.',
    department_invalid: 'The department does not belong to this company.',
    amount_invalid: 'Invalid amount or percentage.',
    reason_required: 'Give a reason (3 to 300 characters).',
    forbidden: 'You do not have permission for this action.',
    invalid: 'Check the form data.',
    retry: 'Someone else made a change at the same time. Try again.',
    unavailable: 'Financial statements are not enabled in this database yet.',
    save: 'Could not save. Try again.',
  },
}
export function financeMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

/**
 * Revenue and costs per month ('YYYY-MM') of a budget. Annual lines are
 * spread evenly (the remainder goes to December so the year adds up).
 * Category lines are skipped when the budget also has a line for the
 * category's ledger account (same rule as budget_vs_actual: no double count).
 */
export function budgetMonths(year: number, lines: BudgetLine[], accountType: Map<string, string>, categoryAccount: Map<string, string>): Map<string, { revenue: bigint; costs: bigint }> {
  const out = new Map<string, { revenue: bigint; costs: bigint }>()
  for (let m = 1; m <= 12; m++) out.set(`${year}-${String(m).padStart(2, '0')}`, { revenue: 0n, costs: 0n })
  const accountLines = new Set(lines.filter((l) => l.account_id).map((l) => l.account_id!))
  for (const l of lines) {
    let kind: 'revenue' | 'costs'
    if (l.account_id) {
      const t = accountType.get(l.account_id)
      if (t !== 'revenue' && t !== 'expense') continue
      kind = t === 'revenue' ? 'revenue' : 'costs'
    } else {
      const acc = l.category_id ? categoryAccount.get(l.category_id) : undefined
      if (acc && accountLines.has(acc)) continue
      kind = 'costs'
    }
    const amt = BigInt(l.amount_cents)
    if (l.month) {
      out.get(`${year}-${String(l.month).padStart(2, '0')}`)![kind] += amt
    } else {
      const each = amt / 12n
      for (let m = 1; m <= 12; m++) out.get(`${year}-${String(m).padStart(2, '0')}`)![kind] += m === 12 ? amt - each * 11n : each
    }
  }
  return out
}
