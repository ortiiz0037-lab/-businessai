import type { Tr } from '@/lib/i18n/t'
import type { Options } from '@/lib/studio/options'

/** Selects for the records a document is built on (only the ones the user may read are listed). */
export function BindingFields({ tr, options, value = {}, docTypes }: { tr: Tr; options: Options; value?: { client_id?: string | null; source_document_id?: string | null; employee_id?: string | null; vendor_id?: string | null }; docTypes?: string[] }) {
  const docs = docTypes ? options.documents.filter((d) => docTypes.includes(d.type)) : options.documents
  const typeName: Record<string, string> = { quote: tr('Cotización', 'Quote'), invoice: tr('Factura', 'Invoice'), receipt: tr('Recibo', 'Receipt'), work_order: tr('Orden de trabajo', 'Work order') }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm"><span className="field-label">{tr('Cliente', 'Client')}</span>
        <select name="client_id" defaultValue={value.client_id ?? ''} className="field"><option value="">—</option>{options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="text-sm"><span className="field-label">{tr('Documento comercial (cotización, factura…)', 'Business document (quote, invoice…)')}</span>
        <select name="source_document_id" defaultValue={value.source_document_id ?? ''} className="field"><option value="">—</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{typeName[d.type] ?? d.type} {d.label}</option>)}</select></label>
      {options.employees.length > 0 && <label className="text-sm"><span className="field-label">{tr('Empleado', 'Employee')}</span>
        <select name="employee_id" defaultValue={value.employee_id ?? ''} className="field"><option value="">—</option>{options.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>}
      {options.vendors.length > 0 && <label className="text-sm"><span className="field-label">{tr('Proveedor', 'Vendor')}</span>
        <select name="vendor_id" defaultValue={value.vendor_id ?? ''} className="field"><option value="">—</option>{options.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
    </div>
  )
}
