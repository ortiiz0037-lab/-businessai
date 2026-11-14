import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'
import type { Line } from '@/lib/finance/statement-layout'
import { compare, favourable } from '@/lib/finance/statements'
import { Delta } from '@/components/finance-nav'

/**
 * A statement as a table: each account links to its ledger (the accounting
 * source of the figure) for the same dates. On phones the comparison column
 * stays visible under the amount.
 */
export function StatementTable({ tr, lines, money, curLabel, baseLabel, ledgerFrom, ledgerTo }: {
  tr: Tr; lines: Line[]; money: (c: bigint) => string; curLabel: string; baseLabel: string | null; ledgerFrom: string; ledgerTo: string
}) {
  const hasBase = baseLabel !== null
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-4 py-2.5">{tr('Concepto', 'Line')}</th>
            <th scope="col" className="px-4 py-2.5 text-right">{curLabel}</th>
            {hasBase && <th scope="col" className="hidden px-4 py-2.5 text-right sm:table-cell">{baseLabel}</th>}
            {hasBase && <th scope="col" className="hidden px-4 py-2.5 text-right md:table-cell">{tr('Variación', 'Change')}</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            if (l.kind === 'heading') return (
              <tr key={i} className="border-t border-line/60"><th scope="rowgroup" colSpan={hasBase ? 4 : 2} className="bg-white/[0.02] px-4 pb-1 pt-3 text-left text-xs font-semibold uppercase tracking-wide text-blue-300">{l.label}</th></tr>
            )
            const cmp = l.base === null ? null : compare(l.current, l.base)
            const good = cmp && l.nature ? favourable(l.nature, cmp.diff) : null
            const strong = l.kind !== 'account'
            const label = l.accountId
              ? <Link href={`/accounting/ledger?account=${l.accountId}&from=${ledgerFrom}&to=${ledgerTo}`} className="hover:text-accent">{l.code ? <span className="mr-2 text-muted tabular-nums">{l.code}</span> : null}{l.label}</Link>
              : l.label
            return (
              <tr key={i} className={`${l.kind === 'grand' ? 'border-t-2 border-electric/40 bg-brand/10' : strong ? 'border-t border-line' : ''}`}>
                <th scope="row" className={`px-4 py-2 text-left ${strong ? 'font-semibold text-fg' : 'pl-6 font-normal text-slate-300'}`}>{label}</th>
                <td className={`px-4 py-2 text-right tabular-nums ${strong ? 'font-semibold text-fg' : 'text-slate-200'}`}>
                  {money(l.current)}
                  {cmp && <span className="block sm:hidden"><Delta tr={tr} pct={cmp.pct} good={good} diff={money(cmp.diff)} /></span>}
                </td>
                {hasBase && <td className="hidden px-4 py-2 text-right tabular-nums text-muted sm:table-cell">{l.base === null ? '—' : money(l.base)}</td>}
                {hasBase && <td className="hidden px-4 py-2 text-right md:table-cell">{cmp ? <Delta tr={tr} pct={cmp.pct} good={good} diff={money(cmp.diff)} /> : '—'}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
