/**
 * What was researched about each provider and what BusinessAI really does with it (shown on the
 * integrations page; the same table is in docs/POS.md). "test_double" means the code is written
 * from the provider's documented API and payloads and verified against a local double — never
 * against a real account. Nothing here claims a working production integration.
 */
import type { ProviderId } from '@/lib/pos/types'

type L = { es: string; en: string }
export type ProviderFacts = {
  id: ProviderId | 'toast' | 'revel' | 'evertec'
  name: string
  api: L
  puertoRico: L
  auth: L
  webhooks: L
  reads: L           // products, sales, lines, payments, refunds, voids
  locations: L
  cost: L
  limits: L
  businessai: { status: 'adapter_test_double' | 'not_implemented' | 'file_import' | 'bridge'; note: L }
}

export const PROVIDERS: ProviderFacts[] = [
  { id: 'square', name: 'Square', api: { es: 'API REST pública (Orders, Catalog, Payments, Refunds, Payouts, Locations).', en: 'Public REST API (Orders, Catalog, Payments, Refunds, Payouts, Locations).' },
    puertoRico: { es: 'Por confirmar con Square: su disponibilidad comercial en Puerto Rico no se pudo verificar en la documentación consultada.', en: 'To confirm with Square: availability in Puerto Rico could not be verified in the documentation reviewed.' },
    auth: { es: 'OAuth 2.0 por comercio (permisos ORDERS_READ, ITEMS_READ, PAYMENTS_READ, MERCHANT_PROFILE_READ…); token de acceso con renovación.', en: 'OAuth 2.0 per merchant (ORDERS_READ, ITEMS_READ, PAYMENTS_READ, MERCHANT_PROFILE_READ… scopes); refreshable access token.' },
    webhooks: { es: 'Sí. Firma HMAC-SHA256 (base64) de URL + cuerpo en x-square-hmacsha256-signature; reintentos del proveedor.', en: 'Yes. HMAC-SHA256 (base64) of URL + body in x-square-hmacsha256-signature; provider retries.' },
    reads: { es: 'Órdenes con líneas, impuestos y descuentos; pagos (marca y últimos 4); devoluciones como órdenes de devolución; anulaciones (CANCELED).', en: 'Orders with lines, taxes and discounts; payments (brand and last 4); refunds as return orders; voids (CANCELED).' },
    locations: { es: 'Locations y dispositivos (source.name).', en: 'Locations and devices (source.name).' },
    cost: { es: 'API sin costo; comisiones de procesamiento según el plan del comercio.', en: 'API free; processing fees per the merchant plan.' },
    limits: { es: 'Propinas, cargos por servicio e impuestos incluidos no cuadran con el total y quedan en revisión.', en: 'Tips, service charges and inclusive taxes do not add up and go to review.' },
    businessai: { status: 'adapter_test_double', note: { es: 'OAuth, webhook firmado, lectura de órdenes y devoluciones, liquidaciones: implementado y probado con doble local.', en: 'OAuth, signed webhook, orders and returns, payouts: implemented and tested with a local double.' } } },
  { id: 'clover', name: 'Clover (Fiserv)', api: { es: 'REST v3 (orders, line items, payments, refunds, employees, devices).', en: 'REST v3 (orders, line items, payments, refunds, employees, devices).' },
    puertoRico: { es: 'Se ofrece a través de adquirentes de Fiserv; la disponibilidad en Puerto Rico depende del banco o adquirente: confirmar.', en: 'Offered through Fiserv acquirers; availability in Puerto Rico depends on the bank or acquirer: confirm.' },
    auth: { es: 'OAuth 2.0 de app del App Market (los tokens de comercio son solo para pruebas).', en: 'App Market OAuth 2.0 (merchant API tokens are for testing only).' },
    webhooks: { es: 'Sí, solo identificadores (O:<id>); autenticados con el código X-Clover-Auth; hay que pedir la orden después.', en: 'Yes, ids only (O:<id>); authenticated by the X-Clover-Auth code; the order must be fetched afterwards.' },
    reads: { es: 'Órdenes con líneas (cantidades en milésimas), pagos con impuesto, devoluciones por importe.', en: 'Orders with lines (thousandths), payments with tax, amount refunds.' },
    locations: { es: 'Un comercio = una ubicación; dispositivos.', en: 'One merchant = one location; devices.' },
    cost: { es: 'Publicar en App Market requiere aprobación de Clover.', en: 'Publishing on the App Market requires Clover approval.' },
    limits: { es: 'Impuesto por pago (se reparte entre líneas); las devoluciones sin líneas quedan en revisión.', en: 'Tax per payment (allocated to lines); refunds without lines go to review.' },
    businessai: { status: 'adapter_test_double', note: { es: 'Webhook, lectura de orden y normalización implementados y probados con doble local.', en: 'Webhook, order fetch and normalization implemented and tested with a local double.' } } },
  { id: 'shopify', name: 'Shopify POS', api: { es: 'Admin API (GraphQL; REST heredado) — las ventas POS son órdenes con source_name "pos".', en: 'Admin API (GraphQL; legacy REST) — POS sales are orders with source_name "pos".' },
    puertoRico: { es: 'Shopify Payments acepta comercios de EE. UU. y Puerto Rico (según su documentación de POS).', en: 'Shopify Payments accepts US and Puerto Rico merchants (per its POS documentation).' },
    auth: { es: 'OAuth de app (read_orders, read_products, read_locations).', en: 'App OAuth (read_orders, read_products, read_locations).' },
    webhooks: { es: 'Sí. X-Shopify-Hmac-Sha256 (base64) del cuerpo con el secreto de la app; X-Shopify-Webhook-Id único.', en: 'Yes. X-Shopify-Hmac-Sha256 (base64) of the body with the app secret; unique X-Shopify-Webhook-Id.' },
    reads: { es: 'El webhook trae la orden completa: líneas, impuestos, descuentos, transacciones y reembolsos.', en: 'The webhook carries the whole order: lines, taxes, discounts, transactions and refunds.' },
    locations: { es: 'location_id por orden.', en: 'location_id per order.' },
    cost: { es: 'Plan Shopify + POS Pro para varias tiendas.', en: 'Shopify plan + POS Pro for several stores.' },
    limits: { es: 'La consulta histórica por GraphQL no está implementada (solo webhooks).', en: 'Historical GraphQL reads are not implemented (webhooks only).' },
    businessai: { status: 'adapter_test_double', note: { es: 'Webhook firmado y normalización de órdenes POS probados con doble local.', en: 'Signed webhook and POS order normalization tested with a local double.' } } },
  { id: 'lightspeed_x', name: 'Lightspeed Retail (X-Series)', api: { es: 'API 2.0 (sales, products, outlets, registers).', en: 'API 2.0 (sales, products, outlets, registers).' },
    puertoRico: { es: 'Por confirmar con Lightspeed para Puerto Rico.', en: 'To confirm with Lightspeed for Puerto Rico.' },
    auth: { es: 'OAuth 2.0 por tienda (domain_prefix) o token personal.', en: 'OAuth 2.0 per store (domain_prefix) or personal token.' },
    webhooks: { es: 'Sí, firmados (X-Signature HMAC-SHA256) pero sin entrega garantizada: hace falta consultar también.', en: 'Yes, signed (X-Signature HMAC-SHA256) but delivery not guaranteed: polling is needed too.' },
    reads: { es: 'Ventas con líneas, impuestos y pagos; devoluciones como ventas con cantidades negativas.', en: 'Sales with lines, taxes and payments; returns as sales with negative quantities.' },
    locations: { es: 'Outlets y registers.', en: 'Outlets and registers.' },
    cost: { es: 'Requiere suscripción de Lightspeed.', en: 'Requires a Lightspeed subscription.' },
    limits: { es: 'Formato del webhook (form-encoded) y firma a verificar con una cuenta real.', en: 'Webhook format (form-encoded) and signature to verify with a real account.' },
    businessai: { status: 'adapter_test_double', note: { es: 'Firma, normalización de ventas y devoluciones probadas con doble local.', en: 'Signature, sale and return normalization tested with a local double.' } } },
  { id: 'lightspeed_r', name: 'Lightspeed Retail (R-Series)', api: { es: 'API REST distinta (Account/Sale).', en: 'A different REST API (Account/Sale).' },
    puertoRico: { es: 'Por confirmar.', en: 'To confirm.' }, auth: { es: 'OAuth 2.0.', en: 'OAuth 2.0.' }, webhooks: { es: 'Limitados; se recomienda consulta periódica.', en: 'Limited; periodic polling recommended.' },
    reads: { es: 'Ventas y líneas.', en: 'Sales and lines.' }, locations: { es: 'Shops.', en: 'Shops.' }, cost: { es: 'Suscripción.', en: 'Subscription.' },
    limits: { es: 'No implementado.', en: 'Not implemented.' }, businessai: { status: 'not_implemented', note: { es: 'Evaluado; usar exportación CSV mientras tanto.', en: 'Evaluated; use CSV export meanwhile.' } } },
  { id: 'toast', name: 'Toast', api: { es: 'API para socios (restaurantes).', en: 'Partner API (restaurants).' }, puertoRico: { es: 'Por confirmar.', en: 'To confirm.' },
    auth: { es: 'Acceso solo como socio aprobado.', en: 'Approved partners only.' }, webhooks: { es: 'Sí, para socios.', en: 'Yes, for partners.' }, reads: { es: 'Órdenes, pagos.', en: 'Orders, payments.' },
    locations: { es: 'Restaurantes.', en: 'Restaurants.' }, cost: { es: 'Programa de socios.', en: 'Partner program.' }, limits: { es: 'No implementado.', en: 'Not implemented.' },
    businessai: { status: 'not_implemented', note: { es: 'Requiere ser socio de Toast.', en: 'Requires Toast partnership.' } } },
  { id: 'evertec', name: 'Evertec / ATH Móvil Business', api: { es: 'ATH Móvil tiene botón de pago y API para comercios (ATH Business); terminales Evertec vía su red.', en: 'ATH Móvil has a payment button and a merchant API (ATH Business); Evertec terminals through its network.' },
    puertoRico: { es: 'Sí: es la red local de Puerto Rico.', en: 'Yes: it is Puerto Rico\'s local network.' }, auth: { es: 'Credenciales de comercio de ATH Business.', en: 'ATH Business merchant credentials.' },
    webhooks: { es: 'Por confirmar con Evertec.', en: 'To confirm with Evertec.' }, reads: { es: 'Pagos, no ventas con líneas.', en: 'Payments, not sales with lines.' },
    locations: { es: '—', en: '—' }, cost: { es: 'Contrato con Evertec.', en: 'Evertec contract.' }, limits: { es: 'Hoy el pago ATH Móvil se registra con su número de referencia.', en: 'Today an ATH Móvil payment is recorded with its reference number.' },
    businessai: { status: 'not_implemented', note: { es: 'Registro manual con referencia; integración pendiente de credenciales.', en: 'Manual record with reference; integration pending credentials.' } } },
  { id: 'csv', name: 'CSV / reportes Z', api: { es: 'Archivo exportado por la caja.', en: 'File exported by the register.' }, puertoRico: { es: 'Sí.', en: 'Yes.' }, auth: { es: 'Usuario con pos.manage.', en: 'User with pos.manage.' },
    webhooks: { es: 'No.', en: 'No.' }, reads: { es: 'Ventas por línea; sin pagos con tarjeta detallados.', en: 'Sales per line; no detailed card payments.' }, locations: { es: 'Columna ubicación.', en: 'Location column.' },
    cost: { es: '—', en: '—' }, limits: { es: 'Depende de la calidad del archivo.', en: 'Depends on the file quality.' },
    businessai: { status: 'file_import', note: { es: 'Implementado: importación validada, idempotente por archivo y por recibo.', en: 'Implemented: validated import, idempotent per file and receipt.' } } },
  { id: 'bridge', name: 'Puente local / Local bridge', api: { es: 'Agente junto a la caja que envía las ventas exportadas por HTTPS.', en: 'Agent next to the register that posts exported sales over HTTPS.' },
    puertoRico: { es: 'Sí.', en: 'Yes.' }, auth: { es: 'Token del puente (mostrado una vez, guardado como SHA-256).', en: 'Bridge token (shown once, stored as SHA-256).' },
    webhooks: { es: 'El agente empuja las ventas.', en: 'The agent pushes sales.' }, reads: { es: 'Lo que la caja exporte (archivo / puerto serie de impresión).', en: 'Whatever the register exports (file / print serial port).' },
    locations: { es: 'Configurado en el agente.', en: 'Configured in the agent.' }, cost: { es: '—', en: '—' }, limits: { es: 'El agente de cada modelo de caja no está incluido: el contrato HTTP sí.', en: 'Per-model agents are not included: the HTTP contract is.' },
    businessai: { status: 'bridge', note: { es: 'Implementado el punto de entrada autenticado; el agente es por modelo.', en: 'Authenticated endpoint implemented; the agent is per model.' } } },
]
