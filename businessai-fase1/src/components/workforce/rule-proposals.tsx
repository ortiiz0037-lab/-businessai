import type { Tr } from '@/lib/i18n/t'
import { ruleKeyLabel, ruleValueLabel } from '@/lib/workforce/hr'
import { applyRuleChange, discardRuleChange } from '@/app/actions/workforce-hr'

export type Proposal = { id: string; scope: string; scope_id: string; changes: Record<string, unknown>; note: string | null; proposed_at: string; proposed_by: string | null; base_version: number }
export type Version = { id: number; scope: string; scope_id: string; version: number; rule_values: Record<string, unknown>; actor: string | null; created_at: string; change_id: string | null }

/**
 * Pending rule changes: what changes (current → proposed), and the explicit
 * Apply (with confirmation) or Discard. Nothing changes until applied.
 */
export function RuleProposals({ tr, locale, proposals, current, title, back, highlight, who, date }: {
  tr: Tr; locale: 'es' | 'en'; proposals: Proposal[]; current: (p: Proposal) => Record<string, unknown>; title: (p: Proposal) => string
  back: string; highlight?: string | null; who: (id: string | null) => string; date: (iso: string) => string
}) {
  if (!proposals.length) return null
  return (
    <section className="card border-electric/40 p-5" aria-labelledby="proposals-title" data-testid="rule-proposals">
      <h2 id="proposals-title" className="font-display text-lg font-semibold text-fg">{tr('Cambios de reglas pendientes de aplicar', 'Rule changes waiting to be applied')} <span className="badge-warning">{proposals.length}</span></h2>
      <p className="mt-1 text-sm text-muted">{tr('Nada cambia hasta que un administrador lo aplique. Al aplicar se crea una versión con quién y cuándo.', 'Nothing changes until an admin applies it. Applying creates a version with who and when.')}</p>
      <ul className="mt-3 space-y-3">
        {proposals.map((p) => {
          const cur = current(p)
          return (
            <li key={p.id} className={`rounded-xl border p-4 ${highlight === p.id ? 'border-electric/60 bg-brand/10' : 'border-line'}`}>
              <p className="font-semibold text-fg">{title(p)}</p>
              <p className="text-xs text-muted">{tr('Propuesto por', 'Proposed by')} {who(p.proposed_by)} · {date(p.proposed_at)}{p.note ? ` · “${p.note}”` : ''}</p>
              <table className="mt-2 w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1">{tr('Regla', 'Rule')}</th><th>{tr('Actual', 'Current')}</th><th>{tr('Propuesto', 'Proposed')}</th></tr></thead>
                <tbody>
                  {Object.entries(p.changes).map(([k, v]) => (
                    <tr key={k} className="border-t border-line">
                      <td className="py-1 pr-2">{ruleKeyLabel(k, locale)}</td>
                      <td className="pr-2 text-muted">{k in cur ? ruleValueLabel(k, cur[k], locale) : tr('heredado', 'inherited')}</td>
                      <td className="font-semibold text-fg">{ruleValueLabel(k, v, locale)}</td>
                    </tr>
                  ))}
                  {Object.keys(p.changes).length === 0 && <tr><td colSpan={3} className="py-1 text-muted">{tr('Quitar todas las excepciones (vuelve a heredar).', 'Remove every exception (inherit again).')}</td></tr>}
                </tbody>
              </table>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <form action={applyRuleChange} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
                  <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" name="confirm" required /> {tr('Confirmo aplicar estos valores', 'I confirm applying these values')}</label>
                  <button type="submit" className="btn-primary btn-sm">{tr('Aplicar cambio', 'Apply change')}</button>
                </form>
                <form action={discardRuleChange}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
                  <button type="submit" className="btn-secondary btn-sm">{tr('Descartar', 'Discard')}</button></form>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Version history of the rules (append-only). */
export function RuleVersions({ tr, locale, versions, title, who, date }: {
  tr: Tr; locale: 'es' | 'en'; versions: Version[]; title: (v: Version) => string; who: (id: string | null) => string; date: (iso: string) => string
}) {
  return (
    <details className="card p-5" data-testid="rule-versions">
      <summary className="cursor-pointer font-display text-lg font-semibold text-fg">{tr('Historial de versiones de reglas', 'Rule version history')} <span className="badge-neutral">{versions.length}</span></summary>
      {versions.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Todavía no hay cambios registrados.', 'No changes recorded yet.')}</p> : (
        <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto text-sm">
          {versions.map((v) => (
            <li key={v.id} className="rounded-lg border border-line p-3">
              <p className="font-semibold text-fg">{title(v)} · v{v.version}</p>
              <p className="text-xs text-muted">{date(v.created_at)} · {who(v.actor)}{v.change_id ? ` · ${tr('aplicado desde una propuesta', 'applied from a proposal')}` : ` · ${tr('cambio directo', 'direct change')}`}</p>
              <p className="mt-1 text-xs text-slate-300">
                {Object.entries((v.rule_values.overrides as Record<string, unknown> | undefined) ?? v.rule_values)
                  .filter(([k]) => k !== 'reason').map(([k, val]) => `${ruleKeyLabel(k, locale)}: ${ruleValueLabel(k, val, locale)}`).join(' · ') || tr('sin excepciones', 'no exceptions')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
