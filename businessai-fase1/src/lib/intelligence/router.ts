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

export type RouteDecision = { tier: Tier; model: ModelEntry; fallbacks: ModelEntry[]; reason: string }
export type RouterConfig = { pinnedModel: string | null; enabled: boolean }

const P3 = /\b(analiz|analy[sz]|compar|proyecci|projection|forecast|estrategi|strategy|tendencia|trend|escenario|scenario|por qu[eé]|why|recomiend|recommend|plan de acci|action plan)/i
const P2 = /\b(factur|invoice|pag[oa]|payment|cobr|collect|deud|debt|owe|saldo|balance|gasto|expense|bill|presupuest|budget|ingres|revenue|income|utilidad|profit|p[eé]rdida|loss|impuesto|tax|n[oó]mina|payroll|asistencia|attendance|horas|hours|ponche|punch|empleado|employee|vencid|overdue|caja|cash|banco|bank|contab|account|estado de resultados|statement|cotizaci|quote|recibo|receipt|carta|letter|contrato|contract|borrador|draft|registr|record|cu[aá]nto|how much|how many|total|monto|amount|\$|\d)/i
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

export function chainFor(tier: Tier, primary: ModelEntry): ModelEntry[] {
  return MODELS.filter((m) => m.id !== primary.id && m.provider === primary.provider && m.tiers.includes(tier) && m.rank >= primary.rank).sort((a, b) => a.rank - b.rank)
}

export function route(tier: Tier, cfg: RouterConfig, reason: string): RouteDecision {
  const effectiveTier: Tier = cfg.enabled ? tier : 'P2'
  const pinned = cfg.pinnedModel ? findModel(cfg.pinnedModel) : undefined
  let model: ModelEntry
  let why = cfg.enabled ? reason : 'router_disabled'
  if (pinned && pinned.tiers.includes(effectiveTier)) { model = pinned; why += ';pinned' }
  else {
    model = findModel(DEFAULT_PRIMARY[effectiveTier])!
    if (pinned) why += `;pin_not_approved_for_${effectiveTier}`
  }
  return { tier: effectiveTier, model, fallbacks: chainFor(effectiveTier, model), reason: why }
}

export const tierAtLeast = (a: Tier, b: Tier) => TIER_RANK[a] >= TIER_RANK[b]
