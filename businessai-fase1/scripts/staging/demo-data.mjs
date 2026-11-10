/**
 * Fictitious, clearly identified data for the "BusinessAI Demo (QA)" company
 * in STAGING. Pure and deterministic (seeded PRNG, dates relative to `now`),
 * so the same data feeds the staging seed (scripts/staging/demo-company.mjs)
 * and the local visual check of the dashboard.
 *
 * Identification: company "BusinessAI Demo (QA)"; every client name starts
 * with "Demo · "; document numbers start with "DEMO-"; every document's
 * metadata has { demo: true, source: "businessai-demo-qa" }; payment
 * references start with "DEMO-". Nothing here is real.
 */

export const DEMO_COMPANY_NAME = 'BusinessAI Demo (QA)'
export const DEMO_SOURCE = 'businessai-demo-qa'
export const DEMO_PREFIX = 'Demo · '

const CLIENTS = [
  ['Café Sol del Viejo San Juan', 'San Juan'], ['Taller Mecánico Norte', 'Bayamón'], ['Clínica Dental Brisas', 'Carolina'],
  ['Panadería La Esquina', 'Ponce'], ['Estudio Legal Rivera & Asoc.', 'Guaynabo'], ['Ferretería El Faro', 'Fajardo'],
  ['Hotel Playa Azul', 'Rincón'], ['Gimnasio Fuerza Total', 'Caguas'], ['Floristería Jardín Tropical', 'Mayagüez'],
  ['Contabilidad Pérez CPA', 'Humacao'], ['Restaurante Mar y Tierra', 'Arecibo'], ['Academia Arte y Música', 'Dorado'],
  ['Transporte Isla Express', 'Toa Baja'], ['Spa Serenidad', 'Cabo Rojo'],
]
const SERVICES = [
  ['Consultoría de procesos', 120], ['Mantenimiento mensual', 350], ['Diseño de marca', 900], ['Instalación de equipos', 640],
  ['Soporte técnico (hora)', 85], ['Auditoría de inventario', 480], ['Plan de marketing', 1250], ['Capacitación del personal', 560],
]

/** mulberry32: small seeded PRNG so the data is identical on every run. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (n, w = 4) => String(n).padStart(w, '0')
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (d, n) => new Date(d.getTime() + n * 86400000)
const money = (n) => Math.round(n * 100) / 100

/** Line items in the format the documents screen already parses (notes text). */
function notesFor(type, items, subtotal, tax, total) {
  return [
    type === 'quote' ? 'COTIZACIÓN — PARTIDAS' : 'FACTURA — PARTIDAS',
    ...items.map((it, i) => `${i + 1}. ${it.description} | Cantidad: ${it.quantity} | Precio unitario: $${it.unitPrice.toFixed(2)} | Importe: $${it.amount.toFixed(2)}`),
    `Subtotal: $${subtotal.toFixed(2)}`,
    'Descuento: $0.00',
    `Impuesto (11.5%): $${tax.toFixed(2)}`,
    `TOTAL: $${total.toFixed(2)}`,
    'Notas y condiciones: Documento de demostración (datos ficticios).',
  ].join('\n')
}

/**
 * @param {Date} now
 * @param {() => string} newId  id generator (crypto.randomUUID in the seed)
 */
export function buildDemoData(now, newId) {
  const rand = rng(20261110)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  // Noon UTC "today" keeps date-only fields stable in Puerto Rico (UTC−4).
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16))

  const clients = CLIENTS.map(([name, city], i) => ({
    id: newId(),
    name: `${DEMO_PREFIX}${name}`,
    business_name: `${DEMO_PREFIX}${name}`,
    email: `cliente${pad(i + 1, 2)}@demo.example.test`,
    city,
    state: 'Puerto Rico',
    status: 'active',
    notes: 'Cliente de demostración (datos ficticios).',
    // Two clients this month, the rest spread over the last year.
    created_at: addDays(today, i < 2 ? -i * 2 : -(30 + i * 24)).toISOString(),
  }))

  const documents = []
  const payments = []
  let inv = 0
  let quo = 0
  const lineItems = () => {
    const count = 1 + Math.floor(rand() * 3)
    return Array.from({ length: count }, () => {
      const [description, base] = pick(SERVICES)
      const quantity = 1 + Math.floor(rand() * 4)
      const unitPrice = money(base * (0.85 + rand() * 0.4))
      return { description, quantity, unitPrice, amount: money(quantity * unitPrice) }
    })
  }
  const makeDoc = (type, issue, client, status, dueDays) => {
    const items = lineItems()
    const subtotal = money(items.reduce((s, it) => s + it.amount, 0))
    const tax = money(subtotal * 0.115)
    const total = money(subtotal + tax)
    const number = type === 'invoice' ? `DEMO-INV-${pad(++inv)}` : `DEMO-COT-${pad(++quo)}`
    const doc = {
      id: newId(), client_id: client.id, document_type: type, document_number: number,
      title: `${type === 'invoice' ? 'Factura' : 'Cotización'} · ${items[0].description}`,
      status, issue_date: iso(issue), due_date: dueDays === null ? null : iso(addDays(issue, dueDays)),
      subtotal, tax, total, notes: notesFor(type, items, subtotal, tax, total),
      items: items.map((it) => ({ description: it.description, quantity: it.quantity, price: it.unitPrice, amount: it.amount })),
      metadata: { demo: true, source: DEMO_SOURCE },
      created_at: new Date(issue.getTime() + 3600000).toISOString(),
    }
    documents.push(doc)
    return doc
  }
  const pay = (doc, amount, when) => {
    payments.push({
      id: newId(), document_id: doc.id, amount: money(amount), payment_method: pick(['transfer', 'card', 'ath_movil', 'check', 'cash']),
      reference: `DEMO-${pad(payments.length + 1, 5)}`, paid_at: when.toISOString(), created_at: when.toISOString(),
    })
  }

  // 12 months of invoices: older ones mostly paid, recent ones open.
  for (let m = 11; m >= 0; m--) {
    const perMonth = 3 + Math.floor(rand() * 4)
    for (let k = 0; k < perMonth; k++) {
      const issue = addDays(today, -(m * 30 + Math.floor(rand() * 26) + (m === 0 ? 0 : 2)))
      if (issue > today) continue
      const client = pick(clients)
      const age = Math.round((today - issue) / 86400000)
      const doc = makeDoc('invoice', issue, client, 'sent', 30)
      const paidAt = addDays(issue, 4 + Math.floor(rand() * 20))
      if (age > 60 || (age > 25 && rand() < 0.7)) {
        if (paidAt <= today) { pay(doc, doc.total, paidAt); doc.status = 'paid' }
      } else if (age > 10 && rand() < 0.35 && paidAt <= today) {
        pay(doc, doc.total * 0.5, paidAt) // partially paid
      }
    }
  }
  // Collections this month: settle a few recent open invoices (dated before today).
  let settled = 0
  for (const doc of documents) {
    if (settled >= 3 || doc.status !== 'sent' || payments.some((p) => p.document_id === doc.id)) continue
    const age = Math.round((today - new Date(`${doc.issue_date}T16:00:00Z`)) / 86400000)
    if (age < 8 || age > 40) continue
    const when = addDays(today, -(1 + settled * 3))
    pay(doc, doc.total, when)
    doc.status = 'paid'
    settled++
  }

  // Guaranteed situations for the alerts.
  const lateA = makeDoc('invoice', addDays(today, -48), clients[2], 'sent', 30)   // 18 days overdue
  pay(lateA, lateA.total * 0.3, addDays(today, -20))
  makeDoc('invoice', addDays(today, -40), clients[5], 'overdue', 30)               // marked overdue
  makeDoc('invoice', addDays(today, -26), clients[7], 'sent', 30)                  // due in 4 days
  makeDoc('invoice', addDays(today, -1), clients[0], 'draft', 30)                  // draft: not counted
  makeDoc('invoice', addDays(today, -70), clients[9], 'cancelled', 30)             // cancelled: not counted

  // Quotes: open (2 of them stale), drafts.
  makeDoc('quote', addDays(today, -3), clients[1], 'sent', 15)
  makeDoc('quote', addDays(today, -9), clients[6], 'sent', 15)
  makeDoc('quote', addDays(today, -21), clients[11], 'sent', 15)
  makeDoc('quote', addDays(today, -33), clients[12], 'sent', 15)
  makeDoc('quote', addDays(today, -2), clients[4], 'draft', 15)

  return { companyName: DEMO_COMPANY_NAME, clients, documents, payments }
}
