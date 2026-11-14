/**
 * Model router: explicit, deterministic rules (no model decides its own
 * routing).
 *   1. classify the request into a precision tier:
 *        P0 conversational (greetings, help with the interface)
 *        P1 light query (lists, searches, navigation)
 *        P2 precision (figures, finance, payroll / attendance, any action)
 *        P3 multi-step reasoning (analysis, comparisons, projections)
 *      Anything that may involve business figures goes to P2 at least.
 *   2. pick the primary model approved for that tier;
 *   3. fallbacks: only models approved for the tier with an EQUAL OR HIGHER
 *      rank (never silently cheaper / less capable);
 *   4. a tool that needs a higher tier than the model in use escalates the
 *      turn (see engine) — never the other way round.
 * Every decision carries a reason that is stored with the turn.
 */
import { TIER_RANK, type Tier } from '@/lib/intelligence/types'
import { MODELS, findModel, type ModelEntry } from '@/lib/intelligence/registry'
import { APPROVALS, type Approval } from '@/lib/intelligence/approvals'

export type RouteDecision = { tier: Tier; model: ModelEntry; fallbacks: ModelEntry[]; reason: string }
export type RouterConfig = { pinnedModel: string | null; enabled: boolean; policy?: 'provisional' | 'benchmark'; approvals?: Approval[] }

/**
 * Tiers a model is approved for. Provisional policy: the registry. Benchmark
 * policy: only tiers a person approved from a REAL benchmark run (approvals.ts);
 * a model without such an approval is not approved for any tier.
 */
export function tiersFor(m: ModelEntry, cfg: RouterConfig): Tier[] {
  if (cfg.policy !== 'benchmark') return m.tiers
  return (cfg.approvals ?? APPROVALS.approvals).find((a) => a.model === m.id)?.tiers ?? []
}

const P3 = /\b(analiz|analy[sz]|compar|proyecci|projection|forecast|estrategi|strategy|tendencia|trend|escenario|scenario|por qu[eé]|why|recomiend|recommend|plan de acci|action plan)/i
const P2 = /\b(factur|invoice|pag[oa]|payment|cobr|collect|deud|debt|owe|saldo|balance|gasto|expense|bill|presupuest|budget|ingres|revenue|income|utilidad|profit|p[eé]rdida|loss|impuesto|tax|n[oó]mina|payroll|asistencia|attendance|horas|hours|ponche|punch|empleado|employee|vencid|overdue|caja|cash|banco|bank|contab|account|estado de resultados|statement|cotizaci|quote|recibo|receipt|carta|letter|contrato|contract|borrador|draft|registr|record|cu[aá]nto|how much|how many|total|monto|amount|resumen|summary|overview|ventas|vend[ií]|sales|sold|\$|\d)/i
const P1 = /\b(cliente|client|proveedor|vendor|documento|document|busca|find|search|lista|list|muestra|show)/i

export function classify(text: string, screenArea: string | null): { tier: Tier; reason: string } {
  const t = text.normalize('NFC')
  if (P3.test(t) && (P2.test(t) || /finance|receivables|payables|accounting|bank/.test(screenArea ?? ''))) return { tier: 'P3', reason: 'analysis_with_business_data' }
  if (P2.test(t)) return { tier: 'P2', reason: 'business_figures_or_action' }
  if (screenArea && ['finance', 'receivables', 'payables', 'accounting', 'bank', 'payments', 'workforce'].includes(screenArea) && t.length > 12) return { tier: 'P2', reason: `financial_screen:${screenArea}` }
  if (P1.test(t) || t.length > 80) return { tier: 'P1', reason: 'light_query' }
  return { tier: 'P0', reason: 'conversational' }
}

/** Default primary model per tier (approved models only). */
const DEFAULT_PRIMARY: Record<Tier, string> = { P0: 'claude-haiku-5-5', P1: 'claude-sonnet-5-5', P2: 'claude-opus-5-5', P3: 'claude-opus-5-5' }

export function chainFor(tier: Tier, primary: ModelEntry, cfg: RouterConfig = { pinnedModel: null, enabled: true }): ModelEntry[] {
  return MODELS.filter((m) => m.id !== primary.id && m.provider === primary.provider && tiersFor(m, cfg).includes(tier) && m.rank >= primary.rank).sort((a, b) => a.rank - b.rank)
}

export function route(tier: Tier, cfg: RouterConfig, reason: string): RouteDecision | null {
  const effectiveTier: Tier = cfg.enabled ? tier : 'P2'
  const pinned = cfg.pinnedModel ? findModel(cfg.pinnedModel) : undefined
  let why = `${cfg.enabled ? reason : 'router_disabled'}${cfg.policy === 'benchmark' ? ';policy=benchmark' : ''}`
  let model: ModelEntry | undefined
  if (pinned && tiersFor(pinned, cfg).includes(effectiveTier)) { model = pinned; why += ';pinned' }
  else {
    const preferred = findModel(DEFAULT_PRIMARY[effectiveTier])
    model = preferred && tiersFor(preferred, cfg).includes(effectiveTier) ? preferred
      // benchmark policy: the least capable model approved for the tier (never an unapproved one)
      : MODELS.filter((m) => tiersFor(m, cfg).includes(effectiveTier)).sort((a, b) => a.rank - b.rank)[0]
    if (pinned) why += `;pin_not_approved_for_${effectiveTier}`
  }
  // no model approved for the tier: the request is refused, never served by a lower tier
  if (!model) return null
  return { tier: effectiveTier, model, fallbacks: chainFor(effectiveTier, model, cfg), reason: why }
}

export const tierAtLeast = (a: Tier, b: Tier) => TIER_RANK[a] >= TIER_RANK[b]
