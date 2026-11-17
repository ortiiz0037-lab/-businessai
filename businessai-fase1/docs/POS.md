# Punto de venta e integraciones de cajas (S8)

> **S9:** la venta POS se verificó en la cadena completa de la plataforma (`supabase/tests/local/126_platform_flows.test.sql`):
> producto con código de barras → inventario inicial → venta escaneada (descuenta una vez, también al reenviarla) →
> devolución con su movimiento `customer_return` → asientos cuadrados; mercancía comprada y recibida vendida en el POS.
> Las rutas de máquina (`/api/pos/webhooks/*`, `/api/pos/bridge`, `/api/pos/recover`) rechazan entregas sin firma,
> token o secreto en la prueba pública de navegador. La prueba autenticada del navegador sigue sin ejecutarse
> (sin PostgREST en este entorno).

**Estado:** implementado y probado **en local** (base de datos de prueba y pruebas unitarias con
dobles controlados). La migración `0044_pos.sql` es un **borrador** (`STAGING-GATE: approval
required`): no está aplicada en Staging ni en Production. **Ninguna integración externa se ha
probado contra una cuenta real**: todas están verificadas con dobles locales construidos a partir de
la documentación de cada proveedor.

## 1. Arquitectura: un solo registro de ventas

```
 Caja BusinessAI ─┐                                   ┌─ inventario (S7: ba_private.inv_post)
 Square ──────────┤  adaptador → NormalizedSale  →    │
 Clover ──────────┤  (src/lib/pos/adapters/*)         ├─ libro mayor (0023: ledger_post)
 Shopify POS ─────┤                                   │
 Lightspeed X ────┤  firma del servidor (HMAC)  →  pos_sales / lines / payments / refunds
 CSV / reporte Z ─┤  validación en PostgreSQL         │
 Puente local ────┘  (ba_private.pos_ingest_one)      └─ caja y turno (pos_cash_movements)
```

| Pieza | Regla |
|---|---|
| `pos_sales`, `pos_sale_lines` | Importes **tal como se vendieron** (nombre, SKU, precio unitario, descuentos, tasa y monto del impuesto). Las columnas de importe son inmutables (trigger `pos_guard`), incluso para el dueño de la base de datos. Un cambio de precio del catálogo no altera ventas anteriores (probado). |
| Precio | En la caja de BusinessAI el **servidor** calcula todo desde el catálogo (`ba_private.pos_price`): bruto = round(cantidad × precio), descuento por línea (centavos o %), descuento a la venta repartido por residuo mayor, impuesto por línea = round(neto × tasa). La pantalla usa `src/lib/pos/pricing.ts`, espejo exacto (mismos carritos probados en SQL y en TypeScript). |
| Impuestos | Tasas configurables (`pos_tax_rates`, p. ej. IVU 11.5 %, IVU reducido, Exento); por producto (`pos_item_taxes`), si no la del catálogo (`catalog_items.tax_rate`), si no la tasa por defecto. BusinessAI no decide qué tributa: lo configura el negocio con su contador. |
| Pagos | Separados de la venta (`pos_payments`) con su ciclo: autorizado → capturado → devuelto / anulado, `pos_payment_events` (solo anexar), liquidación del procesador (`pos_settlements`) y depósito bancario (`bank_lines` de 0026, emparejado con `bank_match`). Sin datos de tarjeta: marca, últimos 4 y referencia. |
| Inventario | Cada línea con inventario sale **una vez** (`idem_key pos:<venta>:<línea>`); la caja nativa comprueba el **disponible** (en mano − reservado − comprometido) bajo el mismo bloqueo por clave de existencias que S7. Anulación = movimientos `correction` (uno por movimiento, `corrects_id` único). Devolución con reingreso = `customer_return`. |
| Contabilidad | Venta: Dr Efectivo (efectivo) / Dr «Fondos por depositar (punto de venta)» (otros métodos), Cr Ingresos, Cr IVU por pagar. Anulación: asiento espejo (`reverses_entry_id`). Devolución: inverso. Liquidación: Dr Banco + Dr Comisiones, Cr Fondos por depositar. Diferencia de caja revisada: Sobrantes y faltantes. Las cuentas 1050 / 6450 / 6460 se crean al primer uso con código libre. **No** se contabiliza el costo de ventas (misma decisión pendiente que S7). Un periodo cerrado nunca se reabre: el asiento va al día de hoy. |
| Seguridad | RLS en todas las tablas; escrituras solo por funciones `SECURITY DEFINER` con permisos y sucursal; tokens de proveedores cifrados (AES-256-GCM) en `ba_private`; webhooks y sincronizaciones firmados por el servidor (HMAC, marca de tiempo de 2 min, *nonce* de un solo uso); auditoría en `pos_events`. |

### Pagos y procesadores: seis pasos separados

1. **Venta** (`pos_sales`) · 2. **Autorización** y 3. **Captura** (`pos_payments.status` + `pos_payment_events`)
· 4. **Liquidación** del procesador (`pos_settlements`, `pos_settlement_record` firmado) · 5. **Depósito**
bancario (`bank_lines`) · 6. **Conciliación** (`pos_settlement_reconcile`: asiento + `bank_match`).

Stripe Connect (pagos de los clientes de las empresas) se mantiene **separado** de las suscripciones de
BusinessAI y **no** se implementó ni se activó: requiere decisión del propietario, cuenta Connect y
revisión legal. No se tocó Stripe TEST/LIVE.

La caja de BusinessAI acepta: efectivo (con cambio), ATH Móvil (con número de referencia), tarjeta en
una **terminal independiente** (se registra la referencia / autorización y los últimos 4; BusinessAI
no procesa la tarjeta), cheque, transferencia, otro. Un pago `card` integrado se rechaza
(`POS_PAYMENT_METHOD_INVALID / card_requires_terminal`): necesita procesador y terminal compatibles.

## 2. Funciones del POS nativo construidas

- **Pantalla de ventas** (`/pos/register`): escáner USB / Bluetooth HID, cámara (BarcodeDetector o
  ZXing), búsqueda por nombre, SKU y código de barras; carrito con variantes, cantidades (+/−, botones
  de 44 px o más), descuento por línea y a la venta, motivo y código de supervisor; cliente; cobro
  dividido con botones de efectivo rápido y cambio; total del servidor; enlace al recibo.
- **Recibo** imprimible / PDF (`/pos/sales/[id]`) con impuestos por tasa, pagos, cambio y devoluciones.
- **Historial** con filtros (`/pos/sales`); **anulación** controlada (solo durante el turno abierto,
  sin devoluciones, con aprobación); **devolución** parcial o total, con o sin reingreso al inventario.
- **Caja y turnos** (`/pos/shifts`): apertura con fondo inicial, entradas, salidas y retiros (con
  aprobación), arqueo ciego por denominación, cierre, diferencias **registradas tal cual** y revisadas
  por otra persona (el dueño puede revisar la suya), historial de cierres.
- **Aprobaciones**: `pos.approve` directo o un **código de supervisor** de 8 dígitos (un uso, ámbito
  descuento / devolución / anulación / salida de efectivo, límite de importe o %, caducidad, solo el
  hash se guarda, el emisor no puede usar su propio código, 5 fallos en 10 min bloquean al cajero).
- **Informes** (`/pos/reports`): diarios, por sucursal, por cajero, productos más vendidos,
  devoluciones, descuentos, impuestos, métodos de pago, comparación con el periodo anterior,
  diferencias de caja, ventas pendientes de sincronización, conciliación de liquidaciones con depósitos.
  Solo ventas confirmadas: las anuladas no cuentan, las devoluciones se restan, cada venta una vez.
- **Ajustes** (`/pos/settings`): límite de descuento, turno obligatorio, textos del recibo, tasas,
  tasa por producto, cajas, cajeros asignados por caja.
- **Integraciones** (`/pos/integrations`): conexiones, asignación de ubicaciones a sucursales y de
  productos externos al catálogo, importación CSV, cola de revisión y reintentos, historial de
  sincronizaciones, liquidaciones y conciliación, puente local, matriz de proveedores y de cajas.

## 3. Permisos (0044)

| Permiso | Roles | Para |
|---|---|---|
| `pos.view` | propietario, administrador, miembro | Ver ventas, turnos e informes (de sus sucursales). |
| `pos.sell` | propietario, administrador, miembro | Vender, abrir / cerrar su turno, entradas de efectivo, pedir devoluciones / anulaciones (con código). |
| `pos.approve` | propietario, administrador | Descuentos sobre el límite, anulaciones, devoluciones, salidas de efectivo, revisar diferencias, emitir códigos, aplicar inventario bloqueado. |
| `pos.manage` | propietario, administrador | Ajustes, impuestos, cajas, integraciones, importación, conciliación (más `bank.manage`). |

Matriz de permisos: 143 → 153 filas. Alcance por sucursal con `branch_members` (0035): un cajero
asignado a una sucursal no ve ni vende en otra; los aprobadores ven todas. Cajas con cajeros asignados.

## 4. Sincronización y webhooks

- Firma del proveedor verificada sobre el cuerpo **crudo** antes de nada (comparación en tiempo constante).
- `pos_webhook_record` (firmado por el servidor): idempotente por id de evento del proveedor.
- Ventas idempotentes por (integración, id externo); pagos únicos por (proveedor, id de pago).
- **Fuera de orden**: cada venta guarda `external_version`; una versión anterior llega como `stale` y no cambia nada.
- Una versión nueva solo puede añadir devoluciones (por su id externo) o anular (compensando).
- **Validación antes de tocar inventario**: ubicación asignada, productos asignados o hallados por código
  (no se adivina stock), totales que cuadran, pagos que suman el total, moneda USD, fecha razonable.
  Lo que falla queda `needs_review` con su motivo y **no escribe nada**.
- Errores inesperados: `failed` con reintento exponencial (2^n min, máx. 8 intentos → `dead`);
  `pos_sync_due` (firmado) los entrega al trabajo de recuperación (`/api/pos/recover`, `POS_CRON_SECRET`).
- Inventario no disponible en una venta externa: la venta se guarda (el dinero ya cambió de manos) con
  inventario **bloqueado**; un aprobador lo aplica cuando hay existencias. Nunca negativos.
- Historial en `pos_sync_runs` y `pos_sync_events`; reintento manual tras corregir una asignación.

## 5. Proveedores investigados

| Proveedor | API | Puerto Rico | Autenticación | Webhooks | Ventas, pagos, devoluciones | Estado en BusinessAI |
|---|---|---|---|---|---|---|
| **Square** | REST (Orders, Catalog, Payments, Refunds, Payouts, Locations) | **Por confirmar** con Square (no verificado en la documentación consultada) | OAuth 2.0 por comercio, permisos de solo lectura | Sí, HMAC-SHA256 base64 de URL + cuerpo (`x-square-hmacsha256-signature`) | Órdenes con líneas, impuestos, descuentos; pagos (marca, últimos 4); devoluciones como órdenes de devolución; anulaciones | Adaptador + OAuth + webhook + liquidaciones, **probado con doble local** |
| **Clover** (Fiserv) | REST v3 | Depende del adquirente / banco: **confirmar** | OAuth de app del App Market | Sí, solo ids; cabecera `X-Clover-Auth` (código de verificación) | Órdenes (cantidades en milésimas), pagos con impuesto, devoluciones | Adaptador, **probado con doble local** |
| **Shopify POS** | Admin API (GraphQL; REST heredado) | Shopify Payments admite EE. UU. y Puerto Rico | OAuth de app | Sí, `X-Shopify-Hmac-Sha256` del cuerpo | El webhook trae la orden completa | Webhook + normalización, **probado con doble local**; lectura histórica por GraphQL **no implementada** |
| **Lightspeed X-Series** | API 2.0 | **Confirmar** | OAuth 2.0 o token personal | Sí, firmados, sin entrega garantizada | Ventas, devoluciones (cantidades negativas) | Firma + normalización, **probado con doble local** |
| Lightspeed R-Series | API distinta | Confirmar | OAuth 2.0 | Limitados | Ventas | **No implementado** (usar CSV) |
| Toast | Solo socios | Confirmar | Programa de socios | Socios | Órdenes | **No implementado** |
| Evertec / ATH Móvil Business | Pagos, no ventas con líneas | Sí | Credenciales ATH Business | Confirmar | Pagos | **No implementado**: hoy ATH Móvil se registra con su referencia |

Costos: las API no cobran por sí mismas; cada proveedor exige su plan o suscripción y comisiones de
procesamiento. No se asume que todos permitan lo mismo: cada adaptador declara lo que hace.
Limitaciones conocidas de los adaptadores: propinas, cargos por servicio e impuestos incluidos en el
precio no cuadran con el total y van a revisión (no se inventan importes).

## 6. Cajas registradoras tradicionales: matriz de compatibilidad

| Tipo | Conexión | Datos | Cómo | Nivel |
|---|---|---|---|---|
| Electrónicas con USB / SD (p. ej. Casio SE-S / SE-G, Sharp XE / XA, Royal) | Memoria USB / SD | Reportes Z / X, diario electrónico | Importación CSV (convertir el texto del modelo si no es CSV) | Soportado |
| Con PC Link / software del fabricante | USB o RS-232 a una PC | Ventas por PLU / departamento | Puente local que vigila la carpeta de exportación | Con puente |
| Con puerto serie de impresora / journal | RS-232 | Texto del ticket | Puente con intérprete por modelo (**no incluido**) | Con puente |
| POS en PC / servidor local (Ethernet / LAN) | Red local | Ventas, líneas, pagos | Puente (lectura) o exportación CSV | Con puente |
| Sin exportación | — | Reporte Z impreso | Registro manual del cierre o migrar a la caja de BusinessAI | Manual |
| Terminales de pago / PIN pads | **No se conectan** | — | Solo por la integración oficial del procesador | No |

No se promete compatibilidad universal: cada modelo se comprueba con su manual o distribuidor. Nunca se
conecta BusinessAI a la ruta de pagos de una caja ni a una terminal (alcance PCI).

**Puente local**: contrato HTTP en `src/lib/pos/legacy.ts` (`POST /api/pos/bridge`, `Authorization:
Bearer bapos_…`). El token se muestra una vez y se guarda como SHA-256. El agente por modelo de caja
no está incluido; el punto de entrada sí (validado e idempotente como cualquier sincronización).

**CSV**: plantilla en `/api/pos/csv-template`; columnas en español o inglés, coma o punto y coma,
hora de Puerto Rico (UTC−4). Un archivo repetido se reconoce por su SHA-256; un recibo repetido es
`duplicate`. Las filas ilegibles se informan con su número de línea y el archivo no se importa.

## 7. Migración y rollback

- `supabase/migrations/0044_pos.sql` (borrador, `STAGING-GATE`), requiere 0023, 0030, 0035, 0042, 0043.
- Amplía dos restricciones existentes (sin borrar nada): `inventory_movements.source_type` (+ `pos_sale`,
  `pos_refund`, `pos_void`) y `journal_entries.source` (+ `pos_sale`, `pos_sale_void`, `pos_refund`,
  `pos_settlement`, `pos_cash_difference`).
- `supabase/rollback/0044_rollback.sql`: se niega sin cambiar nada mientras existan ventas, turnos, cajas,
  integraciones, tasas, ajustes, liquidaciones, eventos, códigos, asientos o movimientos del POS; sin
  datos, deja el catálogo **idéntico** a 0043 (huella comparada).

## 8. Pruebas

| Prueba | Resultado (local) |
|---|---|
| `supabase/tests/local/124_pos.test.sql` (escenario 51) | 139 aserciones: precios del servidor e impuestos, turnos, caja, aprobaciones y códigos (un uso, límite, bloqueo por fallos), inventario una vez por línea, reservas, anulaciones y devoluciones como compensaciones, libro mayor cuadrado, inmutabilidad, webhooks y sincronizaciones firmados, eventos duplicados y fuera de orden, validación antes del inventario, inventario bloqueado, reintentos, CSV, liquidación conciliada con el banco, informes, alcance por sucursal, aislamiento, borrado de empresa |
| `supabase/tests/local/125_pos_race.sh` | Dos cajeros venden las últimas unidades a la vez (una se rechaza, nunca negativo); doble envío de la misma venta; dos devoluciones simultáneas; el mismo pedido por webhook y por sincronización a la vez; dos turnos en la misma caja |
| Regresión con 0044 | `npm run test:db` completo: 644 aprobadas, 0 fallidas. Suites de Inventario (122), Banca (120), Catálogo (114), Libro mayor (84), Gastos (86), Studio cobros (112), Studio avanzado (118), Inteligencia (98), Resumen bancario del asistente (101), Asistente S4 (116). La suite 96 (asistente, etapa 0029) ya fallaba desde 0030 sin relación con S8 (`assistant_consume` cambió de permisos); no se usa como regresión de 0044 |
| `tests/pos.test.ts` (31) | Dinero exacto, carritos idénticos al SQL, firmas de webhooks (válida, alterada, clave incorrecta) de Square / Shopify / Clover / Lightspeed, normalización de órdenes, devoluciones y anulaciones, liquidaciones, CSV, firma del servidor byte a byte, cifrado de tokens, configuración cerrada por defecto, ruta completa del webhook con base de datos y API de Square falsas |

**Probado con dobles**: todas las integraciones externas, OAuth de Square, liquidaciones.
**Requiere hardware o credenciales reales**: cuentas de Square / Clover / Shopify / Lightspeed (sandbox
y producción), escáneres físicos, cámaras de dispositivos, impresora de recibos (hoy: impresión del
navegador), cajas tradicionales concretas y su agente de puente, terminales de pago integradas.
**Build de producción**: correcto (`next build`; el primer intento se detuvo con un aviso de seguridad de Next.js 16.4.3, sin relación con S8). **No ejecutado en este entorno**: la prueba de navegador autenticada (necesita el binario de PostgREST,
cuya descarga no estuvo permitida aquí).

## 9. Credenciales y configuración

Cerrado por defecto: sin estas variables la caja de BusinessAI y la importación CSV funcionan; las
integraciones no se ofrecen. Ninguna se ha configurado en Vercel.

| Variable | Para |
|---|---|
| `POS_SERVER_KEYS` | Firma de webhooks / sincronizaciones; registrar con `select public.pos_set_server_key('<id>', '<base64>')` |
| `POS_TOKEN_KEYS` | AES-256-GCM de los tokens de proveedores |
| `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_ENV`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | Square |
| `SHOPIFY_API_SECRET` | Shopify (firma de webhooks) |
| `CLOVER_WEBHOOK_AUTH_CODE`, `CLOVER_BASE_URL` | Clover |
| `LIGHTSPEED_CLIENT_SECRET` | Lightspeed X-Series |
| `POS_BRIDGE_ENABLED=1` | Puente local |
| `POS_CRON_SECRET` (≥ 32 caracteres) | Trabajo de recuperación `/api/pos/recover` |

URL de webhooks: `/api/pos/webhooks/{square|clover|shopify|lightspeed_x}`.

## 10. Limitaciones conocidas

- Integraciones externas no verificadas con cuentas reales; disponibilidad en Puerto Rico de Square,
  Clover y Lightspeed por confirmar con cada proveedor.
- Renovación automática del token de Square (refresh) no implementada: al caducar, la integración pasa a
  error y se reconecta.
- Shopify: sin lectura histórica (GraphQL); Clover y Lightspeed: sin consulta periódica programada.
- Propinas y cargos por servicio no se modelan (las ventas con ellos van a revisión).
- Tarjeta integrada, Stripe Connect y ATH Móvil Business API: no implementados (requieren contrato y credenciales).
- Costo de ventas no contabilizado (decisión del propietario, igual que S7).
- Sin modo fuera de línea en la caja (requiere conexión); sin cajón de dinero ni impresora térmica directos.
- Recibo por correo / SMS: no implementado (impresión / PDF del navegador).

## 11. Hoja de ruta

1. Aprobación de 0044 en Staging (tras 0043).
2. Cuentas sandbox de Square y Shopify; verificación real de webhooks y OAuth.
3. Consulta periódica (Square SearchOrders / Lightspeed) programada y renovación de tokens.
4. Terminal integrada mediante la API oficial del procesador elegido; Stripe Connect separado.
5. Agente de puente para los modelos de caja que usen los clientes.
6. Modo fuera de línea con cola local y la misma idempotencia.
