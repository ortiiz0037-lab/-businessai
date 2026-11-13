/**
 * System templates (read-only, versioned with the app; one per kind, in
 * Spanish and English). A company customises its own copy (studio_templates)
 * and never changes these. Every figure comes from merge fields or data
 * blocks: templates contain no invented amounts or names.
 */
import type { Locale } from '@/lib/i18n/app'
import type { Block, DocContent, Kind, PageSettings } from '@/lib/studio/model'

export type SystemTemplate = { key: string; kind: Kind; name: string; description: string; content: DocContent; page: PageSettings }

const companyBlock = (): Block => ({ type: 'paragraph', text: '**{{company.legal_name}}**\n{{company.address}}, {{company.city}}\n{{company.phone}} · {{company.email}}', size: 9.5 })
const clientBlock = (es: boolean): Block => ({ type: 'fields', rows: es
  ? [['Cliente', '{{client.name}}'], ['Empresa', '{{client.business_name}}'], ['Dirección', '{{client.address}}, {{client.city}}'], ['Correo', '{{client.email}}']]
  : [['Client', '{{client.name}}'], ['Company', '{{client.business_name}}'], ['Address', '{{client.address}}, {{client.city}}'], ['E-mail', '{{client.email}}']] })

export function systemTemplates(locale: Locale): SystemTemplate[] {
  const es = locale !== 'en'
  const t = (key: string, kind: Kind, name: string, description: string, blocks: Block[], page: PageSettings = {}): SystemTemplate => ({ key, kind, name, description, content: { v: 1, blocks }, page })
  return [
    t('business_letter', 'letter', es ? 'Carta empresarial' : 'Business letter', es ? 'Carta formal con remitente, destinatario y firma.' : 'Formal letter with sender, recipient and signature.', [
      companyBlock(), { type: 'spacer', size: 6 },
      { type: 'paragraph', text: '{{today}}', align: 'right' },
      { type: 'paragraph', text: '{{client.name}}\n{{client.business_name}}\n{{client.address}}, {{client.city}}' },
      { type: 'spacer', size: 4 },
      { type: 'paragraph', text: es ? '**Asunto:** ' : '**Subject:** ' },
      { type: 'paragraph', text: es ? 'Estimado/a {{client.name}}:' : 'Dear {{client.name}},' },
      { type: 'paragraph', text: es ? 'Escriba aquí el cuerpo de la carta.' : 'Write the body of the letter here.', align: 'justify' },
      { type: 'paragraph', text: es ? 'Atentamente,' : 'Sincerely,' },
      { type: 'signature', withImage: true },
    ], { font: 'serif' }),
    t('quote_classic', 'quote', es ? 'Cotización' : 'Quote', es ? 'Toma las líneas, impuestos y total de la cotización vinculada.' : 'Takes lines, tax and total from the linked quote.', [
      { type: 'heading', level: 1, text: es ? 'Cotización {{document.number}}' : 'Quote {{document.number}}' },
      { type: 'fields', rows: es ? [['Fecha', '{{document.issue_date}}'], ['Válida hasta', '{{document.due_date}}']] : [['Date', '{{document.issue_date}}'], ['Valid until', '{{document.due_date}}']] },
      clientBlock(es), { type: 'items' }, { type: 'totals' },
      { type: 'heading', level: 3, text: es ? 'Condiciones' : 'Terms' },
      { type: 'paragraph', text: es ? 'Escriba aquí las condiciones de la cotización.' : 'Write the quote terms here.', size: 9.5 },
      { type: 'signature', label: es ? 'Aceptado por el cliente' : 'Accepted by the client' },
    ]),
    t('invoice_classic', 'invoice', es ? 'Factura' : 'Invoice', es ? 'Diseño de la factura vinculada: líneas, impuestos, pagos y balance reales.' : 'Layout of the linked invoice: real lines, tax, payments and balance.', [
      { type: 'heading', level: 1, text: es ? 'Factura {{document.number}}' : 'Invoice {{document.number}}' },
      { type: 'fields', rows: es ? [['Fecha', '{{document.issue_date}}'], ['Vencimiento', '{{document.due_date}}']] : [['Date', '{{document.issue_date}}'], ['Due date', '{{document.due_date}}']] },
      clientBlock(es), { type: 'items' }, { type: 'totals' },
      { type: 'heading', level: 3, text: es ? 'Cómo pagar' : 'How to pay' },
      { type: 'paragraph', text: '{{company.payment_info}}', size: 9.5 },
    ]),
    t('receipt_classic', 'receipt', es ? 'Recibo' : 'Receipt', es ? 'Recibo de los pagos registrados de la factura vinculada.' : 'Receipt of the payments recorded on the linked invoice.', [
      { type: 'heading', level: 1, text: es ? 'Recibo de pago' : 'Payment receipt' },
      { type: 'paragraph', text: es ? 'Recibimos de **{{client.name}}** los pagos detallados a continuación, aplicados a la factura **{{document.number}}**.' : 'We received from **{{client.name}}** the payments below, applied to invoice **{{document.number}}**.' },
      { type: 'payments' }, { type: 'totals' },
      { type: 'signature', label: es ? 'Recibido por' : 'Received by', withImage: true },
    ]),
    t('work_order', 'work_order', es ? 'Orden de trabajo' : 'Work order', es ? 'Trabajo a realizar, responsables y conformidad del cliente.' : 'Work to be done, people in charge and client sign-off.', [
      { type: 'heading', level: 1, text: es ? 'Orden de trabajo {{doc.number}}' : 'Work order {{doc.number}}' },
      clientBlock(es),
      { type: 'fields', rows: es ? [['Fecha', '{{today}}'], ['Lugar', ''], ['Responsable', '']] : [['Date', '{{today}}'], ['Location', ''], ['In charge', '']] },
      { type: 'heading', level: 3, text: es ? 'Trabajo a realizar' : 'Work to be done' },
      { type: 'table', header: true, widths: [60, 20, 20], rows: es ? [['Tarea', 'Fecha', 'Estado'], ['', '', '']] : [['Task', 'Date', 'Status'], ['', '', '']] },
      { type: 'heading', level: 3, text: es ? 'Observaciones' : 'Notes' }, { type: 'paragraph', text: '' },
      { type: 'signature', label: es ? 'Conformidad del cliente' : 'Client sign-off' },
    ]),
    t('purchase_order', 'purchase_order', es ? 'Orden de compra' : 'Purchase order', es ? 'Pedido a un proveedor. No crea una factura ni un gasto: se registran en Gastos.' : 'Order to a vendor. It creates no bill or expense: those are recorded in Expenses.', [
      { type: 'heading', level: 1, text: es ? 'Orden de compra {{doc.number}}' : 'Purchase order {{doc.number}}' },
      { type: 'fields', rows: es ? [['Proveedor', '{{vendor.name}}'], ['Identificación fiscal', '{{vendor.tax_id}}'], ['Dirección', '{{vendor.address}}'], ['Fecha', '{{today}}']]
        : [['Vendor', '{{vendor.name}}'], ['Tax ID', '{{vendor.tax_id}}'], ['Address', '{{vendor.address}}'], ['Date', '{{today}}']] },
      { type: 'table', header: true, widths: [50, 12, 19, 19], rows: es ? [['Artículo', 'Cant.', 'Precio', 'Importe'], ['', '', '', '']] : [['Item', 'Qty', 'Price', 'Amount'], ['', '', '', '']] },
      { type: 'paragraph', text: es ? 'Entregar en: {{company.address}}, {{company.city}}' : 'Deliver to: {{company.address}}, {{company.city}}' },
      { type: 'signature', label: es ? 'Autorizado por' : 'Authorised by', withImage: true },
    ]),
    t('service_contract', 'contract', es ? 'Contrato de servicios' : 'Service agreement', es ? 'Estructura de contrato con partes, cláusulas y firmas. Revíselo con su asesor legal.' : 'Agreement structure with parties, clauses and signatures. Review it with your legal adviser.', [
      { type: 'heading', level: 1, text: es ? 'Contrato de servicios' : 'Service agreement', align: 'center' },
      { type: 'paragraph', text: es ? 'En {{company.city}}, a {{today}}, comparecen **{{company.legal_name}}** («el Proveedor») y **{{client.name}}** («el Cliente»), que acuerdan lo siguiente:'
        : 'In {{company.city}}, on {{today}}, **{{company.legal_name}}** ("the Provider") and **{{client.name}}** ("the Client") agree as follows:', align: 'justify' },
      { type: 'heading', level: 3, text: es ? '1. Objeto' : '1. Purpose' }, { type: 'paragraph', text: '', align: 'justify' },
      { type: 'heading', level: 3, text: es ? '2. Precio y forma de pago' : '2. Price and payment' }, { type: 'paragraph', text: '', align: 'justify' },
      { type: 'heading', level: 3, text: es ? '3. Duración' : '3. Term' }, { type: 'paragraph', text: '', align: 'justify' },
      { type: 'heading', level: 3, text: es ? '4. Confidencialidad' : '4. Confidentiality' }, { type: 'paragraph', text: '', align: 'justify' },
      { type: 'spacer', size: 8 },
      { type: 'table', header: false, rows: [[es ? '__Por el Proveedor__' : '__For the Provider__', es ? '__Por el Cliente__' : '__For the Client__']] },
      { type: 'signature', label: '{{company.legal_name}}' }, { type: 'signature', label: '{{client.name}}' },
    ], { font: 'serif' }),
    t('business_report', 'report', es ? 'Informe empresarial' : 'Business report', es ? 'Portada, resumen, secciones y tabla.' : 'Cover, summary, sections and a table.', [
      { type: 'image', asset: 'logo', width: 30, align: 'left' },
      { type: 'heading', level: 1, text: es ? 'Informe' : 'Report' },
      { type: 'paragraph', text: '{{company.legal_name}} · {{today}}', size: 9.5 },
      { type: 'divider' },
      { type: 'heading', level: 2, text: es ? 'Resumen ejecutivo' : 'Executive summary' }, { type: 'paragraph', text: '', align: 'justify' },
      { type: 'heading', level: 2, text: es ? 'Resultados' : 'Results' },
      { type: 'table', header: true, rows: es ? [['Indicador', 'Valor', 'Comentario'], ['', '', '']] : [['Indicator', 'Value', 'Comment'], ['', '', '']] },
      { type: 'heading', level: 2, text: es ? 'Conclusiones' : 'Conclusions' }, { type: 'paragraph', text: '', align: 'justify' },
    ]),
    t('account_statement', 'account_statement', es ? 'Estado de cuenta' : 'Account statement', es ? 'Facturas abiertas del cliente vinculado, tomadas de Cuentas por cobrar.' : 'Open invoices of the linked client, taken from Receivables.', [
      { type: 'heading', level: 1, text: es ? 'Estado de cuenta' : 'Account statement' },
      { type: 'fields', rows: es ? [['Cliente', '{{client.name}}'], ['Fecha', '{{today}}']] : [['Client', '{{client.name}}'], ['Date', '{{today}}']] },
      { type: 'statement' },
      { type: 'paragraph', text: es ? 'Si ya realizó el pago, ignore este aviso. Datos de pago: {{company.payment_info}}' : 'If you have already paid, please disregard this notice. Payment details: {{company.payment_info}}', size: 9.5 },
    ]),
    t('certificate', 'certificate', es ? 'Certificado' : 'Certificate', es ? 'Certificado de empleo o de participación, con firma y sello.' : 'Employment or participation certificate, with signature and stamp.', [
      { type: 'spacer', size: 20 },
      { type: 'heading', level: 1, text: es ? 'Certificado' : 'Certificate', align: 'center' },
      { type: 'spacer', size: 8 },
      { type: 'paragraph', text: es ? '**{{company.legal_name}}** certifica que **{{employee.full_name}}** trabaja en la empresa desde el {{employee.hire_date}}, ocupando el puesto de {{employee.position}}.'
        : '**{{company.legal_name}}** certifies that **{{employee.full_name}}** has worked for the company since {{employee.hire_date}} as {{employee.position}}.', align: 'center', size: 13 },
      { type: 'spacer', size: 8 },
      { type: 'paragraph', text: es ? 'Se expide a solicitud del interesado en {{company.city}}, el {{today}}.' : 'Issued at the request of the person concerned in {{company.city}}, on {{today}}.', align: 'center' },
      { type: 'spacer', size: 14 },
      { type: 'signature', align: 'center', withImage: true }, { type: 'stamp', align: 'center' },
    ], { font: 'serif', orientation: 'landscape' }),
  ]
}
export const systemTemplate = (key: string, locale: Locale) => systemTemplates(locale).find((t) => t.key === key) ?? null
