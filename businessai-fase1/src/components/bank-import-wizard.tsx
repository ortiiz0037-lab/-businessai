'use client'
import { useMemo, useState } from 'react'
import { decodeBytes, guessMapping, MAX_FILE_BYTES, normalize, parseCsv, validateMapping, type DateFormat, type DecimalSep, type Mapping } from '@/lib/finance/bank-csv'
import { formatCents } from '@/lib/finance/money'
import { importStatement } from '@/app/actions/bank'

type Copy = Record<string, string>
type Field = 'date' | 'description' | 'reference' | 'amount' | 'debit' | 'credit' | 'balance' | 'txnId'

/**
 * Statement import wizard: the file is read and previewed in the browser
 * (encoding, delimiter, column mapping, errors, duplicates, totals); on
 * confirmation the same file and mapping go to the server, which parses it
 * again and the database validates every row.
 */
export function BankImportWizard({ accounts, defaultAccount, copy, locale, today }: {
  accounts: { id: string; name: string }[]; defaultAccount: string; copy: Copy; locale: 'es' | 'en'; today: string
}) {
  const [table, setTable] = useState<string[][] | null>(null)
  const [meta, setMeta] = useState<{ name: string; size: number; encoding: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [map, setMap] = useState<Mapping>({ date: 0, description: 1, amount: 2, dateFormat: 'MDY', decimal: '.', skipRows: 0 })

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    setTable(null); setFileError(null)
    if (!file) return
    if (file.size > MAX_FILE_BYTES) { setFileError(copy.file_too_large); return }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { text, encoding } = decodeBytes(bytes)
    const t = parseCsv(text)
    if (t.length < 2) { setFileError(copy.import_invalid); return }
    const g = guessMapping(t[0])
    setMap({ date: g.date ?? 0, description: g.description ?? 1, reference: g.reference ?? null, amount: g.amount ?? (g.debit === undefined && g.credit === undefined ? 2 : null),
      debit: g.debit ?? null, credit: g.credit ?? null, balance: g.balance ?? null, txnId: g.txnId ?? null,
      dateFormat: t.slice(1, 20).some((r) => /^\d{4}-/.test((r[g.date ?? 0] ?? '').trim())) ? 'YMD' : locale === 'es' ? 'DMY' : 'MDY',
      decimal: t.slice(1, 20).some((r) => /\d,\d{2}$/.test((r[g.amount ?? g.debit ?? g.credit ?? 2] ?? '').trim())) ? ',' : '.', skipRows: 0 })
    setTable(t); setMeta({ name: file.name, size: file.size, encoding })
  }

  const headers = table ? (table[map.skipRows ?? 0] ?? []) : []
  const mappingError = table ? validateMapping(map, headers.length) : null
  const result = useMemo(() => (table && !mappingError ? normalize(table, map, { today }) : null), [table, map, mappingError, today])
  const set = (k: Field, v: string) => setMap((m) => ({ ...m, [k]: v === '' ? null : Number(v) }))
  const columnSelect = (k: Field, required = false) => (
    <label className="text-sm"><span className="field-label">{copy[`col_${k}`]}{required ? ' *' : ''}</span>
      <select value={map[k] === null || map[k] === undefined ? '' : String(map[k])} onChange={(e) => set(k, e.target.value)} className="field">
        <option value="">{copy.none}</option>
        {headers.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}
      </select></label>
  )
  const money = (c: bigint | string) => formatCents(c, locale)

  return (
    <form action={importStatement} className="space-y-6">
      <section className="card grid gap-4 p-5 sm:grid-cols-2">
        <label className="text-sm"><span className="field-label">{copy.account}</span>
          <select name="bank_account_id" defaultValue={defaultAccount} required className="field">{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="text-sm"><span className="field-label">{copy.file}</span>
          <input type="file" name="file" accept=".csv,text/csv,text/plain" required onChange={onFile} className="field" /></label>
        {fileError && <p role="alert" className="text-sm text-red-300 sm:col-span-2">{fileError}</p>}
        {meta && <p className="text-xs text-muted sm:col-span-2">{meta.name} · {Math.ceil(meta.size / 1024)} KB · {meta.encoding.toUpperCase()} · {copy.rows.replace('{n}', String(Math.max(0, (table?.length ?? 1) - 1 - (map.skipRows ?? 0))))}</p>}
      </section>

      {table && (
        <section className="card space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{copy.mapping}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {columnSelect('date', true)}{columnSelect('description', true)}{columnSelect('reference')}{columnSelect('txnId')}
            {columnSelect('amount')}{columnSelect('debit')}{columnSelect('credit')}{columnSelect('balance')}
            <label className="text-sm"><span className="field-label">{copy.date_format}</span>
              <select value={map.dateFormat} onChange={(e) => setMap((m) => ({ ...m, dateFormat: e.target.value as DateFormat }))} className="field">
                <option value="YMD">AAAA-MM-DD</option><option value="MDY">MM/DD/AAAA</option><option value="DMY">DD/MM/AAAA</option></select></label>
            <label className="text-sm"><span className="field-label">{copy.decimal}</span>
              <select value={map.decimal} onChange={(e) => setMap((m) => ({ ...m, decimal: e.target.value as DecimalSep }))} className="field">
                <option value=".">1,234.56</option><option value=",">1.234,56</option></select></label>
            <label className="text-sm"><span className="field-label">{copy.skip}</span>
              <input type="number" min={0} max={20} value={map.skipRows ?? 0} onChange={(e) => setMap((m) => ({ ...m, skipRows: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }))} className="field" /></label>
            <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={!!map.invertSign} onChange={(e) => setMap((m) => ({ ...m, invertSign: e.target.checked }))} /> {copy.invert}</label>
          </div>
          <p className="text-xs text-muted">{copy.amount_hint}</p>
          {mappingError && <p role="alert" className="text-sm text-red-300">{copy[mappingError] ?? mappingError}</p>}
        </section>
      )}

      {result && (
        <section className="card space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{copy.preview}</h2>
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <p>{copy.valid}: <span className="font-semibold text-fg">{result.rows.length}</span></p>
            <p>{copy.in}: <span className="font-semibold tabular-nums text-green-300">{money(result.totals.in)}</span></p>
            <p>{copy.out}: <span className="font-semibold tabular-nums text-fg">{money(result.totals.out)}</span></p>
            <p>{copy.period}: <span className="text-fg">{result.firstDate ?? '—'} → {result.lastDate ?? '—'}</span></p>
          </div>
          {result.errors.length > 0 && (
            <div role="alert" className="alert-danger space-y-1 p-3 text-sm"><p className="font-semibold">{copy.errors.replace('{n}', String(result.errors.length))}</p>
              <ul className="list-inside list-disc text-xs">{result.errors.slice(0, 10).map((e, i) => <li key={i}>{copy.line} {e.row}: {copy[e.code] ?? e.code}</li>)}</ul></div>
          )}
          {result.duplicatesInFile.length > 0 && (
            <div className="alert-warning space-y-2 p-3 text-sm"><p>{copy.dups.replace('{n}', String(result.duplicatesInFile.length)).replace('{lines}', result.duplicatesInFile.slice(0, 10).join(', '))}</p>
              <label className="flex items-center gap-2"><input type="checkbox" name="allow_identical" /> {copy.allow_identical}</label></div>
          )}
          <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">{copy.col_date}</th><th className="px-3 py-2">{copy.col_description}</th><th className="px-3 py-2">{copy.col_reference}</th><th className="px-3 py-2 text-right">{copy.col_amount}</th></tr></thead>
            <tbody className="divide-y divide-line/60">{result.rows.slice(0, 15).map((r, i) => (
              <tr key={i}><td className="px-3 py-1.5 text-muted">{r.date}</td><td className="px-3 py-1.5 text-fg">{r.description}</td><td className="px-3 py-1.5 text-muted">{r.reference ?? ''}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${r.amount_cents.startsWith('-') ? '' : 'text-green-300'}`}>{money(r.amount_cents)}</td></tr>))}</tbody>
          </table></div>
          <input type="hidden" name="mapping" value={JSON.stringify(map)} />
          <p className="text-xs text-muted">{copy.confirm_hint}</p>
          <button type="submit" disabled={result.errors.length > 0 || result.rows.length === 0} className="btn-primary disabled:opacity-50">{copy.confirm.replace('{n}', String(result.rows.length))}</button>
        </section>
      )}
    </form>
  )
}
