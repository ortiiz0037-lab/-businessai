# Panel ejecutivo (Entrega 1)

Todo lo que muestra el panel sale de los datos reales de la **empresa activa**,
leídos con la sesión del usuario a través de RLS (`has_permission`). No hay
valores de ejemplo: sin datos, el panel muestra un estado vacío.

Cálculo: `src/lib/dashboard/metrics.ts` (funciones puras, probadas en
`tests/dashboard-metrics.test.ts`). Presentación:
`src/components/dashboard/dashboard-view.tsx`.

## Definiciones

| Métrica | Cálculo |
|---|---|
| Factura | `document_type = 'invoice'` y estado distinto de `draft` y `cancelled` |
| Pagado de una factura | suma de los pagos registrados contra ella |
| Pendiente | `max(total − pagado, 0)`; 0 si la factura está marcada `paid` |
| Por cobrar | suma de lo pendiente de todas las facturas |
| Vencido | pendiente > 0 y (estado `overdue` o `due_date` anterior a hoy) |
| Vence en 7 días | pendiente > 0, no vencida, `due_date` en los próximos 7 días |
| Cobrado (mes) | pagos por fecha de pago (`paid_at`, si falta `created_at`) |
| Facturado (mes) | facturas por fecha de emisión (`issue_date`) |
| Variación | (mes actual − mes anterior) / mes anterior; sin dato si el mes anterior es 0 |
| Cotización abierta | `document_type = 'quote'` con estado `sent`; "sin respuesta" si se emitió hace más de 14 días |
| Clientes nuevos | clientes creados en el mes actual |
| Principales clientes | facturado en los últimos 12 meses, 5 mayores |
| Actividad | los 8 eventos más recientes: clientes, documentos y pagos creados |

Los meses se cuentan en la zona horaria de Puerto Rico (`America/Puerto_Rico`).
Moneda: USD.

## Alertas

- Facturas vencidas y facturas que vencen en 7 días (enlazan a cada factura).
- Cotizaciones enviadas hace más de 14 días sin respuesta.
- Límites del plan al 80 %, 90 % y 100 % (`company_usage`, migración 0011).
- Estado de la suscripción: prueba, pago pendiente o solo lectura (`company_billing_state`).

## Gráficos

- Facturado vs. cobrado, 12 meses: barras agrupadas, un solo eje. Paleta
  validada con el validador de dataviz sobre la superficie blanca de las
  tarjetas (azul `#2a78d6`, oro `#a67e2f`; contraste ≥ 3:1, separación para
  daltonismo). Leyenda, lectura al tocar o pasar el ratón y vista de tabla.
- Cuentas por cobrar: barra apilada (al día / vence en 7 días / vencido) con
  colores de estado, siempre acompañados de etiqueta e importe.

## Idioma y empresa activa

- Idioma: cookie `ba_locale` (selector ES/EN del menú, o `?lang=` desde la web
  pública); si no hay cookie, el idioma del navegador; si no, español.
- Empresa activa: cookie `ba_company`, validada en cada petición contra las
  membresías del usuario (`src/lib/active-company.ts`). Un valor manipulado
  vuelve a la primera empresa del usuario; nunca da acceso a otra.

## Pendiente (próximas entregas)

Las pantallas de clientes, documentos, pagos, empresa y plan siguen en español;
se traducen cuando se rehagan en las Entregas 2 y 3.
