import type { Tr } from '@/lib/i18n/t'
import type { Locale, formatters } from '@/lib/i18n/app'
import type { Member, Stage } from '@/lib/crm/page'
import { memberName } from '@/lib/crm/page'
import { stageName } from '@/lib/crm/core'

export type CrmEvent = { id: number; entity: string; action: string; changes: Record<string, unknown>; actor: string | null; created_at: string }

const ACTION: Record<string, [string, string]> = {
  created: ['Creado', 'Created'], updated: ['Modificado', 'Changed'], stage_changed: ['Cambio de etapa', 'Stage changed'], won: ['Ganada', 'Won'], lost: ['Perdida', 'Lost'],
  reopened: ['Reabierta', 'Reopened'], archived: ['Archivado', 'Archived'], restored: ['Restaurado', 'Restored'], linked: ['Documento asociado', 'Document linked'],
  unlinked: ['Documento desvinculado', 'Document unlinked'], quote_converted: ['Cotización convertida en factura', 'Quote converted to invoice'],
  completed: ['Actividad completada', 'Activity completed'], pending: ['Actividad reabierta', 'Activity reopened'], cancelled: ['Actividad cancelada', 'Activity cancelled'],
  tags_set: ['Etiquetas cambiadas', 'Tags changed'], shared_with_branch: ['Compartido con sucursal', 'Shared with branch'], unshared_from_branch: ['Ya no compartido con sucursal', 'No longer shared with branch'],
}
const ENTITY: Record<string, [string, string]> = {
  client: ['Cliente', 'Client'], contact: ['Contacto', 'Contact'], opportunity: ['Oportunidad', 'Opportunity'], activity: ['Actividad', 'Activity'], client_tag: ['Etiquetas', 'Tags'],
  document_link: ['Documento', 'Document'], conversion: ['Factura', 'Invoice'],
}
// fields that never need to be shown (identifiers and internals)
const HIDDEN = new Set(['id', 'company_id', 'client_id', 'opportunity_id', 'contact_id', 'version', 'idempotency_key', 'created_by', 'created_at', 'updated_at', 'stage_id', 'owner_id', 'assigned_to', 'branch_id', 'probability_manual'])

/** Readable audit trail: who, when, what changed (old → new). */
export function CrmHistory({ rows, members, locale, tr, f, stages }: { rows: CrmEvent[]; members: Member[]; locale: Locale; tr: Tr; f: ReturnType<typeof formatters>; stages?: Stage[] }) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-muted">{tr('Sin cambios registrados.', 'No recorded changes.')}</p>
  const pick = (m: Record<string, [string, string]>, k: string) => (m[k] ? m[k][locale === 'en' ? 1 : 0] : k)
  const stageKey = (k: unknown) => { const s = stages?.find((x) => x.key === k); return s ? stageName(s, locale) : String(k ?? '—') }
  return (
    <ol className="mt-2 space-y-2 text-sm" data-testid="crm-history">
      {rows.map((e) => {
        const ch = e.changes ?? {}
        const detail: string[] = []
        if (e.entity === 'opportunity' && 'from' in ch && 'to' in ch && typeof ch.from === 'string') detail.push(`${stageKey(ch.from)} → ${stageKey(ch.to)}${ch.reason ? ` (${String(ch.reason)})` : ''}`)
        else if (e.action === 'tags_set') detail.push(`${(ch.from as string[] | undefined)?.join(', ') || '—'} → ${(ch.to as string[] | undefined)?.join(', ') || '—'}`)
        else for (const [k, v] of Object.entries(ch)) {
          if (HIDDEN.has(k)) continue
          if (v && typeof v === 'object' && 'to' in (v as Record<string, unknown>)) {
            const x = v as { from: string | null; to: string | null }
            detail.push(`${k}: ${x.from ?? '—'} → ${x.to ?? '—'}`)
          } else if (v !== null && v !== '' && typeof v !== 'object') detail.push(`${k}: ${String(v)}`)
        }
        return (
          <li key={e.id} className="rounded-xl border border-line bg-elevated/40 px-3 py-2">
            <span className="font-semibold text-fg">{pick(ENTITY, e.entity)} · {pick(ACTION, e.action)}</span>
            <span className="ml-2 text-xs text-muted">{f.dateTime(e.created_at)} · {memberName(members, e.actor, tr('sistema', 'system'))}</span>
            {detail.length > 0 && <span className="block break-words text-xs text-slate-300">{detail.join(' · ')}</span>}
          </li>
        )
      })}
    </ol>
  )
}
