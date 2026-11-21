/**
 * Traditional cash registers and legacy systems: what can be connected and how (shown on the
 * integrations page; the same matrix is in docs/POS.md). No universal compatibility is claimed:
 * every model must be checked with its manual / dealer. BusinessAI never connects to a payment
 * terminal or to the card path of a register (PCI scope): only to the sales data it exports.
 */
type L = { es: string; en: string }
export type LegacyRow = { family: L; connection: L; data: L; route: L; level: 'supported' | 'via_bridge' | 'manual' | 'not_supported' }

export const LEGACY_MATRIX: LegacyRow[] = [
  { family: { es: 'Cajas electrónicas con memoria USB / SD (p. ej. Casio SE-S / SE-G, Sharp XE / XA, Royal)', en: 'Electronic registers with USB / SD memory (e.g. Casio SE-S / SE-G, Sharp XE / XA, Royal)' },
    connection: { es: 'Memoria USB o tarjeta SD', en: 'USB stick or SD card' }, data: { es: 'Reportes Z / X y diario electrónico exportados (CSV o texto, según modelo)', en: 'Exported Z / X reports and electronic journal (CSV or text, per model)' },
    route: { es: 'Importación CSV (convertir el texto del modelo a la plantilla si no es CSV)', en: 'CSV import (convert the model text to the template when not CSV)' }, level: 'supported' },
  { family: { es: 'Cajas con PC Link / software del fabricante (p. ej. Sharp Server Utility, Casio PC Link)', en: 'Registers with PC Link / maker software (e.g. Sharp Server Utility, Casio PC Link)' },
    connection: { es: 'USB o RS-232 hacia una PC con el software del fabricante', en: 'USB or RS-232 to a PC with the maker software' }, data: { es: 'Ventas por PLU / departamento exportadas por el software', en: 'Sales per PLU / department exported by the software' },
    route: { es: 'Puente local que vigila la carpeta de exportación y envía a /api/pos/bridge', en: 'Local bridge watching the export folder and posting to /api/pos/bridge' }, level: 'via_bridge' },
  { family: { es: 'Cajas con puerto serie de impresora / journal (RS-232)', en: 'Registers with a printer / journal serial port (RS-232)' },
    connection: { es: 'RS-232 (cable null-modem / adaptador USB-serie) a un equipo con el puente', en: 'RS-232 (null-modem cable / USB-serial adapter) to a computer running the bridge' },
    data: { es: 'Texto del ticket impreso; requiere un intérprete por modelo', en: 'Printed ticket text; needs a per-model parser' }, route: { es: 'Puente local con intérprete del modelo (no incluido)', en: 'Local bridge with a model parser (not included)' }, level: 'via_bridge' },
  { family: { es: 'Sistemas POS en PC / servidor local con base de datos o exportación (Ethernet / LAN)', en: 'PC / on-premise POS with a database or export (Ethernet / LAN)' },
    connection: { es: 'Red local: exportación programada o lectura de solo lectura de su base de datos', en: 'Local network: scheduled export or read-only access to its database' },
    data: { es: 'Ventas, líneas y pagos según el sistema', en: 'Sales, lines and payments per system' }, route: { es: 'Puente local (lectura) → /api/pos/bridge; o exportación CSV', en: 'Local bridge (read) → /api/pos/bridge; or CSV export' }, level: 'via_bridge' },
  { family: { es: 'Cajas sin exportación (solo impresión de reporte Z)', en: 'Registers without export (printed Z report only)' },
    connection: { es: 'Ninguna', en: 'None' }, data: { es: 'Totales diarios en papel', en: 'Daily totals on paper' },
    route: { es: 'Registro manual del cierre diario o migrar a la caja de BusinessAI; sin inventario por producto', en: 'Manual daily close entry or move to the BusinessAI register; no per-product stock' }, level: 'manual' },
  { family: { es: 'Terminales de pago (tarjeta) y PIN pads', en: 'Payment terminals (card) and PIN pads' },
    connection: { es: 'No se conectan a BusinessAI', en: 'Not connected to BusinessAI' }, data: { es: '—', en: '—' },
    route: { es: 'Solo mediante la integración oficial del procesador (p. ej. Square Terminal API, Stripe Terminal) con un contrato del comercio', en: 'Only through the processor official integration (e.g. Square Terminal API, Stripe Terminal) under a merchant contract' }, level: 'not_supported' },
]

/** The bridge's HTTP contract (what a local agent sends). */
export const BRIDGE_CONTRACT = `POST /api/pos/bridge
Authorization: Bearer bapos_…   (token shown once in BusinessAI)
Content-Type: application/json
{ "sales": [ { "external_id": "CAJA-1:Z-0001", "version": "1", "state": "completed", "occurred_at": "2026-11-16T13:15:00Z",
  "location_id": "CAJA-1", "lines": [ { "external_line_id": "1", "sku": "4006381333931", "name": "Café", "qty": "2",
  "unit_price_cents": "1000", "tax_cents": "230" } ], "payments": [ { "method": "cash", "amount_cents": "2230" } ] } ] }`
