/**
 * Plan usage as returned by public.company_usage() (migration 0011).
 * The database decides levels and enforces limits; this module only reads
 * and words them. Levels: ok · warning (≥ 80 %) · upgrade (≥ 90 %) ·
 * blocked (100 %) · unlimited. Thresholds live in billing_config.
 */
export type UsageMetric = 'clients' | 'documents' | 'members'
export type UsageLevel = 'ok' | 'warning' | 'upgrade' | 'blocked' | 'unlimited'

export type UsageRow = {
  metric: UsageMetric
  used: number
  max_allowed: number | null
  percent: number | null
  level: UsageLevel
  resets_at: string | null
}

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { code?: string; message: string } | null
  }>
}

/** Usage of a company for the signed-in member; [] when unavailable (0011 not applied). */
export async function fetchUsage(supabase: RpcClient, companyId: string): Promise<UsageRow[]> {
  try {
    const { data, error } = await supabase.rpc('company_usage', { target: companyId })
    if (error || !Array.isArray(data)) {
      if (error && error.code !== '42883' && error.code !== 'PGRST202') {
        console.error('USAGE_ERROR', { code: error.code, message: error.message })
      }
      return []
    }
    return (data as UsageRow[]).map((r) => ({
      ...r,
      used: Number(r.used ?? 0),
      max_allowed: r.max_allowed === null ? null : Number(r.max_allowed),
      percent: r.percent === null ? null : Number(r.percent),
    }))
  } catch (error) {
    console.error('USAGE_ERROR', { message: error instanceof Error ? error.message : String(error) })
    return []
  }
}

const LABEL: Record<UsageMetric, string> = {
  clients: 'clientes',
  documents: 'documentos de este periodo',
  members: 'usuarios',
}

const RANK: Record<UsageLevel, number> = { unlimited: 0, ok: 0, warning: 1, upgrade: 2, blocked: 3 }

function resetText(row: UsageRow) {
  if (!row.resets_at) return ''
  const d = new Intl.DateTimeFormat('es-PR', { day: 'numeric', month: 'long', timeZone: 'America/Puerto_Rico' })
    .format(new Date(row.resets_at))
  return ` El contador se reinicia el ${d}.`
}

export type UsageNotice = {
  level: 'warning' | 'upgrade' | 'blocked'
  metric: UsageMetric
  text: string
  /** Offer the plan upgrade (90 % and 100 %). */
  offerUpgrade: boolean
}

/** Message for one metric, or null when below the first threshold. */
export function usageNotice(row: UsageRow | undefined): UsageNotice | null {
  if (!row || row.max_allowed === null) return null
  const what = LABEL[row.metric]
  const amount = `${row.used} de ${row.max_allowed} ${what}`
  switch (row.level) {
    case 'warning':
      return { level: 'warning', metric: row.metric, offerUpgrade: false,
               text: `Has usado el ${row.percent} % de tu plan: ${amount}.${resetText(row)}` }
    case 'upgrade':
      return { level: 'upgrade', metric: row.metric, offerUpgrade: true,
               text: `Estás cerca del límite (${row.percent} %): ${amount}. Mejora tu plan para no quedarte sin capacidad.${resetText(row)}` }
    case 'blocked':
      return { level: 'blocked', metric: row.metric, offerUpgrade: true,
               text: `Alcanzaste el límite de tu plan: ${amount}. No puedes crear más hasta mejorar el plan.${row.metric === 'documents' ? resetText(row) : ''} Tus datos no se modifican.` }
    default:
      return null
  }
}

/** The most severe notice across metrics (for the app-wide banner). */
export function strongestNotice(rows: UsageRow[]): UsageNotice | null {
  return rows
    .map(usageNotice)
    .filter((n): n is UsageNotice => n !== null)
    .sort((a, b) => RANK[b.level] - RANK[a.level])[0] ?? null
}

export function isBlocked(rows: UsageRow[], metric: UsageMetric): boolean {
  return rows.find((r) => r.metric === metric)?.level === 'blocked'
}
