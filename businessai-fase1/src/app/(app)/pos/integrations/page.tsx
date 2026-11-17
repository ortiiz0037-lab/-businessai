import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { StateChip } from '@/components/bank-nav'
import { NoPosAccess, PosNav, Flash } from '@/components/pos/nav'
import { BridgeToken } from '@/components/pos/bridge-token'
import { createBridgeIntegration, disconnectIntegration, importSalesCsv, mapItem, mapLocation, reconcileSettlement, retrySyncEvent } from '@/app/actions/pos'
import { posBranches, posPage } from '@/lib/pos/page'
import { posMessage, posStatus, posTone, reviewReason } from '@/lib/pos/labels'
import { readPosConfig } from '@/lib/pos/config'
import { PROVIDERS } from '@/lib/pos/providers'
import { LEGACY_MATRIX, BRIDGE_CONTRACT } from '@/lib/pos/legacy'

export const dynamic = 'force-dynamic'

const DONE: Record<string, [string, string]> = { imported: ['Archivo importado.', 'File imported.'], import_already: ['Ese archivo ya se había importado: no se duplicó nada.', 'That file was already imported: nothing was duplicated.'],
  mapped: ['Asignación guardada.', 'Mapping saved.'], retry: ['Se reintentará.', 'It will be retried.'], disconnected: ['Integración desconectada.', 'Integration disconnected.'],
  bridge: ['Puente creado. Genera su token.', 'Bridge created. Generate its token.'], reconciled: ['Liquidación conciliada con el banco.', 'Payout reconciled with the bank.'], square: ['Square conectado.', 'Square connected.'] }

/** Connected systems, research matrix, CSV import, the review queue, settlements and the bridge. */
export default async function PosIntegrations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  const cfg = readPosConfig()
  const branches = access.manage ? await posBranches(supabase, companyId) : []
  const [{ data: ints }, { data: maps }, { data: events }, { data: runs }, { data: stl }, { data: items }, { data: lines }] = access.manage ? await Promise.all([
    supabase.from('pos_integrations').select('id, provider, environment, display_name, external_account_id, status, last_sync_at, error_code').eq('company_id', companyId).order('created_at'),
    supabase.from('pos_location_maps').select('integration_id, external_location_id, branch_id').eq('company_id', companyId),
    supabase.from('pos_sync_events').select('id, integration_id, provider, event_type, object_id, status, attempts, last_error, received_at').eq('company_id', companyId)
      .in('status', ['needs_review', 'failed', 'dead', 'received']).order('id', { ascending: false }).limit(50),
    supabase.from('pos_sync_runs').select('id, integration_id, trigger, status, received, created, updated, duplicates, stale, needs_review, failed, file_name, started_at').eq('company_id', companyId).order('started_at', { ascending: false }).limit(15),
    supabase.from('pos_settlements').select('id, provider_payout_id, payout_date, gross_cents, fees_cents, net_cents, status, bank_line_id').eq('company_id', companyId).order('payout_date', { ascending: false }).limit(20),
    supabase.from('catalog_items').select('id, code, name').eq('company_id', companyId).eq('status', 'active').order('name').limit(1000),
    access.bank ? supabase.from('bank_lines').select('id, txn_date, amount_cents, description').eq('company_id', companyId).eq('status', 'unmatched').gt('amount_cents', 0).order('txn_date', { ascending: false }).limit(200) : Promise.resolve({ data: [] }),
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }]
  const integrations = (ints ?? []) as { id: string; provider: string; environment: string; display_name: string; external_account_id: string | null; status: string; last_sync_at: string | null; error_code: string | null }[]
  const lm = (maps ?? []) as { integration_id: string; external_location_id: string; branch_id: string }[]
  const ev = (events ?? []) as { id: number; integration_id: string | null; provider: string; event_type: string | null; object_id: string | null; status: string; attempts: number; last_error: string | null; received_at: string }[]
  const rn = (runs ?? []) as { id: string; trigger: string; status: string; received: number; created: number; updated: number; duplicates: number; stale: number; needs_review: number; failed: number; file_name: string | null; started_at: string }[]
  const st = (stl ?? []) as { id: string; provider_payout_id: string; payout_date: string; gross_cents: number; fees_cents: number; net_cents: number; status: string; bank_line_id: string | null }[]
  const bl = (lines ?? []) as { id: string; txn_date: string; amount_cents: number; description: string }[]
  const L = (x: { es: string; en: string }) => x[locale]
  const back = '/pos/integrations'
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Punto de venta', 'Point of sale')} title={tr('Integraciones', 'Integrations')}
        description={tr('Cada sistema se conecta con su propio adaptador. Ninguna integración se presenta como funcional sin credenciales reales: hoy están probadas con dobles locales.',
          'Each system connects through its own adapter. No integration is presented as working without real credentials: today they are tested with local doubles.')} />
      <PosNav tr={tr} current="/pos/integrations" />
      <Flash done={sp.done && DONE[sp.done] ? `${tr(...DONE[sp.done])}${sp.counts ? ` (${sp.counts})` : ''}` : null} error={sp.error ? `${posMessage(sp.error, locale)}${sp.lines ? ` — ${sp.lines}` : ''}` : null} />
      {!access.manage ? <p className="alert-info">{tr('Solo quien administra el punto de venta ve las integraciones.', 'Only POS managers see integrations.')}</p> : (<>
        <section className="card space-y-3 p-5" data-testid="pos-connections">
          <h2 className="font-semibold text-fg">{tr('Conexiones', 'Connections')}</h2>
          {integrations.length === 0 && <p className="text-sm text-muted">{tr('Ninguna todavía.', 'None yet.')}</p>}
          {integrations.map((i) => (
            <div key={i.id} className="space-y-2 rounded-xl border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span><strong>{i.display_name}</strong> · {i.provider} · {i.environment}{i.environment === 'test_double' ? ` (${tr('doble de prueba', 'test double')})` : ''}</span>
                <span className="flex items-center gap-2"><StateChip tone={posTone(i.status)}>{posStatus(i.status, locale)}</StateChip>{i.last_sync_at && <span className="text-xs text-muted">{f.date(i.last_sync_at.slice(0, 10))}</span>}</span></div>
              <div className="flex flex-wrap gap-2 text-xs">{lm.filter((m) => m.integration_id === i.id).map((m) => <span key={m.external_location_id} className="rounded-full border border-line px-2 py-0.5">{m.external_location_id} → {branches.find((b) => b.id === m.branch_id)?.name}</span>)}</div>
              {i.status !== 'disconnected' && (<>
                <form action={mapLocation} className="flex flex-wrap gap-2"><input type="hidden" name="back" value={back} /><input type="hidden" name="integration_id" value={i.id} />
                  <input name="external_location" placeholder={tr('Ubicación externa (ID)', 'External location (ID)')} required className="field h-11 min-w-0 flex-1" />
                  <select name="branch_id" className="field h-11">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button className="btn-secondary btn-sm min-h-11">{tr('Asignar sucursal', 'Map branch')}</button></form>
                <form action={mapItem} className="flex flex-wrap gap-2"><input type="hidden" name="back" value={back} /><input type="hidden" name="integration_id" value={i.id} />
                  <input name="external_ref" placeholder={tr('Producto externo (ID)', 'External product (ID)')} required className="field h-11 min-w-0 flex-1" />
                  <select name="target" className="field h-11 min-w-0 flex-1">{((items ?? []) as { id: string; code: string; name: string }[]).map((x) => <option key={x.id} value={`${x.id}|`}>{x.name} ({x.code})</option>)}</select>
                  <button className="btn-secondary btn-sm min-h-11">{tr('Asignar producto', 'Map product')}</button></form>
                {i.provider === 'bridge' && <BridgeToken integration={i.id} locale={locale} />}
                <form action={disconnectIntegration}><input type="hidden" name="back" value={back} /><input type="hidden" name="integration_id" value={i.id} /><button className="text-xs text-red-200 underline">{tr('Desconectar (el historial se conserva)', 'Disconnect (history is kept)')}</button></form>
              </>)}
            </div>))}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {cfg.square.configured ? <Link href="/api/pos/oauth/square/start" className="btn-primary min-h-11" prefetch={false}>{tr('Conectar Square', 'Connect Square')}</Link>
              : <span className="text-xs text-muted">Square: {posMessage('not_configured', locale)}</span>}
            {cfg.bridge ? <form action={createBridgeIntegration} className="flex gap-2"><input type="hidden" name="back" value={back} /><input name="name" placeholder={tr('Nombre del puente', 'Bridge name')} className="field h-11" /><button className="btn-secondary min-h-11">{tr('Crear puente local', 'Create local bridge')}</button></form>
              : <span className="text-xs text-muted">{tr('Puente local', 'Local bridge')}: {posMessage('not_configured', locale)}</span>}
          </div>
        </section>

        <section className="card space-y-3 p-5" data-testid="pos-csv">
          <h2 className="font-semibold text-fg">{tr('Importar ventas de una caja tradicional (CSV)', 'Import sales from a traditional register (CSV)')}</h2>
          <p className="text-xs text-muted">{tr('Una fila por artículo vendido. Columnas: recibo, fecha, ubicacion, caja, cajero, codigo, descripcion, cantidad, precio, descuento, impuesto, pago. El mismo archivo o el mismo recibo nunca se importa dos veces; nada cambia el inventario hasta pasar las validaciones.',
            'One row per sold item. Columns: receipt, date, location, register, cashier, sku, name, qty, price, discount, tax, payment. The same file or receipt is never imported twice; nothing changes stock until it passes validation.')}</p>
          <form action={importSalesCsv} className="flex flex-wrap items-center gap-2"><input type="hidden" name="back" value={back} />
            <input type="file" name="file" accept=".csv,text/csv,text/plain" required className="text-sm" data-testid="csv-file" />
            <select name="integration_id" className="field h-11"><option value="">{tr('Archivos CSV (por defecto)', 'CSV files (default)')}</option>{integrations.filter((i) => i.provider === 'csv' || i.provider === 'bridge').map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}</select>
            <button className="btn-primary min-h-11">{tr('Importar', 'Import')}</button>
            <a href="/api/pos/csv-template" className="text-sm text-accent underline">{tr('Descargar plantilla', 'Download template')}</a></form>
        </section>

        <section className="card min-w-0 space-y-2 overflow-hidden p-5" data-testid="pos-review-queue">
          <h2 className="font-semibold text-fg">{tr('Ventas externas por revisar y reintentos', 'External sales to review and retries')}</h2>
          {ev.length === 0 ? <p className="text-sm text-muted">{tr('Nada pendiente.', 'Nothing pending.')}</p> : (
            <ul className="divide-y divide-line/50 text-sm">{ev.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="font-semibold">{e.provider}</span> · {e.object_id ?? '—'} <span className="text-xs text-muted">({e.event_type ?? ''}, {tr('intentos', 'attempts')} {e.attempts})</span>
                  <span className="block text-xs text-amber-200">{reviewReason(e.last_error, locale)}</span></span>
                <span className="flex items-center gap-2"><StateChip tone={posTone(e.status)}>{posStatus(e.status, locale)}</StateChip>
                  {['needs_review', 'failed', 'dead'].includes(e.status) && <form action={retrySyncEvent}><input type="hidden" name="back" value={back} /><input type="hidden" name="event_id" value={e.id} /><button className="btn-secondary btn-sm">{tr('Reintentar', 'Retry')}</button></form>}</span>
              </li>))}</ul>)}
          {rn.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-accent">{tr('Historial de sincronizaciones', 'Sync history')}</summary>
            <ul className="mt-2 space-y-1 text-xs text-muted">{rn.map((r) => <li key={r.id}>{f.date(r.started_at.slice(0, 10))} · {r.trigger}{r.file_name ? ` · ${r.file_name}` : ''} · {posStatus(r.status, locale)} · {tr('recibidas', 'received')} {r.received}, {tr('nuevas', 'new')} {r.created}, {tr('actualizadas', 'updated')} {r.updated}, {tr('duplicadas', 'duplicates')} {r.duplicates}, {tr('antiguas', 'stale')} {r.stale}, {tr('por revisar', 'to review')} {r.needs_review}, {tr('fallidas', 'failed')} {r.failed}</li>)}</ul></details>}
        </section>

        <section className="card min-w-0 space-y-2 p-5" data-testid="pos-settlements">
          <h2 className="font-semibold text-fg">{tr('Liquidaciones del procesador y depósitos', 'Processor payouts and deposits')}</h2>
          <p className="text-xs text-muted">{tr('Venta → autorización → captura → liquidación → depósito → conciliación: cada paso por separado. Al conciliar se registra la comisión y se empareja la línea del banco.',
            'Sale → authorisation → capture → payout → deposit → reconciliation: each step apart. Reconciling posts the fee and matches the bank line.')}</p>
          {st.length === 0 ? <p className="text-sm text-muted">{tr('Sin liquidaciones registradas.', 'No payouts recorded.')}</p> : st.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 py-2 text-sm">
              <span>{s.provider_payout_id} · {f.date(s.payout_date)} · {tr('bruto', 'gross')} {money(s.gross_cents)} − {tr('comisión', 'fee')} {money(s.fees_cents)} = <strong>{money(s.net_cents)}</strong></span>
              {s.bank_line_id ? <StateChip tone="ok">{tr('Conciliada', 'Reconciled')}</StateChip> : access.bank ? (
                <form action={reconcileSettlement} className="flex gap-2"><input type="hidden" name="back" value={back} /><input type="hidden" name="settlement_id" value={s.id} />
                  <select name="bank_line_id" className="field h-11">{bl.filter((l) => Number(l.amount_cents) === Number(s.net_cents)).map((l) => <option key={l.id} value={l.id}>{f.date(l.txn_date)} · {l.description}</option>)}</select>
                  <button className="btn-secondary btn-sm min-h-11">{tr('Conciliar', 'Reconcile')}</button></form>) : <StateChip tone="pending">{posStatus(s.status, locale)}</StateChip>}
            </div>))}
        </section>
      </>)}

      <section className="card min-w-0 overflow-hidden" data-testid="pos-providers">
        <h2 className="p-5 pb-0 font-semibold text-fg">{tr('Proveedores investigados', 'Providers researched')}</h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[900px] text-xs">
          <thead><tr className="border-b border-line text-left text-muted">{[tr('Proveedor', 'Provider'), 'API', 'Puerto Rico', tr('Autenticación', 'Auth'), 'Webhooks', tr('Datos', 'Data'), tr('Límites', 'Limits'), 'BusinessAI'].map((h) => <th key={h} className="p-2">{h}</th>)}</tr></thead>
          <tbody>{PROVIDERS.map((p) => <tr key={p.id} className="border-b border-line/40 align-top"><td className="p-2 font-semibold text-fg">{p.name}</td><td className="p-2">{L(p.api)}</td><td className="p-2">{L(p.puertoRico)}</td><td className="p-2">{L(p.auth)}</td>
            <td className="p-2">{L(p.webhooks)}</td><td className="p-2">{L(p.reads)}</td><td className="p-2">{L(p.limits)}</td><td className="p-2">{L(p.businessai.note)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="card min-w-0 overflow-hidden" data-testid="pos-legacy">
        <h2 className="p-5 pb-0 font-semibold text-fg">{tr('Cajas registradoras tradicionales: compatibilidad', 'Traditional registers: compatibility')}</h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[760px] text-xs"><thead><tr className="border-b border-line text-left text-muted">{[tr('Tipo', 'Type'), tr('Conexión', 'Connection'), tr('Datos', 'Data'), tr('Cómo', 'How'), tr('Nivel', 'Level')].map((h) => <th key={h} className="p-2">{h}</th>)}</tr></thead>
          <tbody>{LEGACY_MATRIX.map((r, i) => <tr key={i} className="border-b border-line/40 align-top"><td className="p-2 text-fg">{L(r.family)}</td><td className="p-2">{L(r.connection)}</td><td className="p-2">{L(r.data)}</td><td className="p-2">{L(r.route)}</td>
            <td className="p-2"><StateChip tone={r.level === 'supported' ? 'ok' : r.level === 'not_supported' ? 'issue' : 'pending'}>{{ supported: tr('Soportado', 'Supported'), via_bridge: tr('Con puente', 'Via bridge'), manual: tr('Manual', 'Manual'), not_supported: tr('No', 'No') }[r.level]}</StateChip></td></tr>)}</tbody></table></div>
        <details className="p-5 text-xs"><summary className="cursor-pointer text-accent">{tr('Contrato HTTP del puente local', 'Local bridge HTTP contract')}</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-elevated p-3">{BRIDGE_CONTRACT}</pre></details>
      </section>
    </div>
  )
}
