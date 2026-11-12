import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'
import type { Locale } from '@/lib/i18n/app'
import { categoryName, type Category, type Vendor } from '@/lib/finance/payables'
import { centsToInput } from '@/lib/finance/money'
import { saveBill } from '@/app/actions/payables'

const ROWS = 6
type Line = { category_id: string; description: string | null; amount_cents: number }
type Initial = { id?: string; vendor_id?: string; vendor_invoice_number?: string | null; bill_date?: string; due_date?: string | null; description?: string; notes?: string | null; lines?: Line[] }

/** Expense / vendor bill draft form (new or edit). The database saves bill and lines atomically. */
export function BillForm({ tr, locale, vendors, categories, today, initial, canApprove }: {
  tr: Tr; locale: Locale; vendors: Vendor[]; categories: Category[]; today: string; initial?: Initial; canApprove: boolean
}) {
  const lines = initial?.lines ?? []
  return (
    <form action={saveBill} className="card space-y-5 p-5">
      {initial?.id && <input type="hidden" name="id" value={initial.id} />}
      {!initial?.id && <input type="hidden" name="idempotency_key" value={randomUUID()} />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Proveedor', 'Vendor')}</span>
          <select name="vendor_id" required defaultValue={initial?.vendor_id ?? ''} className="field">
            <option value="" disabled>—</option>
            {vendors.filter((v) => v.status === 'active' || v.id === initial?.vendor_id).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select></label>
        <label className="text-sm"><span className="field-label">{tr('N.º de factura del proveedor', 'Vendor invoice no.')}</span>
          <input name="vendor_invoice_number" maxLength={60} defaultValue={initial?.vendor_invoice_number ?? ''} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Fecha del gasto', 'Expense date')}</span>
          <input type="date" name="bill_date" required defaultValue={initial?.bill_date ?? today} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Vence (opcional)', 'Due (optional)')}</span>
          <input type="date" name="due_date" defaultValue={initial?.due_date ?? ''} className="field" /></label>
        <label className="text-sm sm:col-span-2 lg:col-span-3"><span className="field-label">{tr('Descripción', 'Description')}</span>
          <input name="description" required maxLength={300} defaultValue={initial?.description ?? ''} className="field" /></label>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-fg">{tr('Líneas por categoría', 'Lines by category')}</legend>
        {Array.from({ length: ROWS }, (_, i) => {
          const l = lines[i]
          return (
            <div key={i} className="grid gap-2 rounded-xl border border-line/70 p-3 sm:grid-cols-[2fr_3fr_1fr] sm:border-0 sm:p-0">
              <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Categoría', 'Category')}</span>
                <select name={`category_${i}`} defaultValue={l?.category_id ?? ''} className="field">
                  <option value="">—</option>
                  {categories.filter((c) => c.status === 'active' || c.id === l?.category_id).map((c) => <option key={c.id} value={c.id}>{categoryName(c, locale)}</option>)}
                </select></label>
              <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Detalle', 'Detail')}</span>
                <input name={`line_description_${i}`} maxLength={300} defaultValue={l?.description ?? ''} className="field" /></label>
              <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Importe', 'Amount')}</span>
                <input name={`amount_${i}`} inputMode="decimal" pattern="[0-9.,]*" placeholder="0.00" defaultValue={l ? centsToInput(l.amount_cents) : ''} className="field text-right tabular-nums" /></label>
            </div>
          )
        })}
      </fieldset>
      <label className="block text-sm"><span className="field-label">{tr('Notas (opcional)', 'Notes (optional)')}</span>
        <textarea name="notes" maxLength={1000} rows={2} defaultValue={initial?.notes ?? ''} className="field" /></label>
      <p className="text-xs text-muted">{tr('Un borrador no afecta la contabilidad. Al aprobarse se registra en el libro mayor (gasto contra cuentas por pagar); al pagarse se reducen las cuentas por pagar.',
        'A draft does not affect accounting. When approved it is posted to the ledger (expense against accounts payable); when paid, accounts payable go down.')}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
        <Link href={initial?.id ? `/payables/${initial.id}` : '/payables'} className="btn-secondary">{tr('Cancelar', 'Cancel')}</Link>
        <button type="submit" name="intent" value="draft" className="btn-secondary">{tr('Guardar borrador', 'Save draft')}</button>
        <button type="submit" name="intent" value="submit" className="btn-secondary">{tr('Guardar y enviar a aprobación', 'Save and submit for approval')}</button>
        {canApprove && <button type="submit" name="intent" value="submit_approve" className="btn-primary">{tr('Guardar, enviar y aprobar', 'Save, submit and approve')}</button>}
      </div>
    </form>
  )
}
