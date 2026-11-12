# BusinessAI Finance — Contabilidad de doble entrada (entrega 2, migración 0023)

**Estado:** borrador local. La migración `0023_ledger.sql` **no está aplicada en
ningún entorno** (Staging ni Production). Marca `STAGING-GATE`.

## Modelo

| Tabla | Qué guarda |
|---|---|
| `ledger_accounts` | Catálogo de cuentas: código, nombre (ES y EN opcional), tipo (activo, pasivo, patrimonio, ingreso, gasto), descripción, estado |
| `journal_entries` | Asientos: número consecutivo por empresa, fecha contable, descripción, referencia, origen, moneda, total, usuario, reversión |
| `journal_lines` | Líneas: cuenta, débito **o** crédito en **centavos enteros (bigint)** |
| `accounting_periods` | Meses cerrados / reabiertos con quién, cuándo y por qué |
| `ledger_events` | Historial de solo-añadir: cuentas, asientos, reversiones, periodos, importaciones |
| `ledger_settings` | Moneda base (USD) y activación |

## Reglas que impone PostgreSQL (no solo la app)

* **Cuadre exacto:** suma de débitos = suma de créditos = total, mínimo dos
  líneas. Se comprueba al publicar y otra vez al confirmar la transacción
  (trigger diferido), aunque se escriba directamente con SQL o service role.
* **Inalterable:** ningún asiento ni línea se edita, borra o trunca; no se
  pueden añadir líneas a un asiento ya publicado. Solo el borrado completo
  de una empresa (cascada) los elimina.
* **Correcciones:** reversión documentada (asiento espejo con motivo que
  apunta al original; el original no cambia). Un asiento se revierte una sola
  vez; una reversión no se revierte. Los asientos que vienen de documentos se
  corrigen anulando el documento.
* **Periodos:** un mes cerrado rechaza cualquier asiento con fecha en él,
  incluidos los automáticos y los de mantenimiento. Cierran propietario y
  administradores (solo meses terminados); reabre solo el propietario, con
  motivo.
* **Cuentas:** las del sistema (efectivo, cuentas por cobrar, ingresos por
  ventas, impuesto por pagar, cuentas por pagar, capital, utilidades
  retenidas) se renombran pero no se borran, archivan ni cambian de tipo. Una
  cuenta con movimientos no se borra y conserva código y tipo; se archiva.
* **Sin punto flotante:** importes en centavos enteros en la base de datos y
  en la app (BigInt); los decimales escritos se convierten como texto.
* **Concurrencia:** publicaciones serializadas por empresa; numeración sin
  huecos; claves de idempotencia para asientos manuales y pagos.

## Asientos automáticos (base devengado)

| Evento | Asiento |
|---|---|
| Factura emitida (sale de borrador o se crea emitida) | Dr Cuentas por cobrar (total) / Cr Ingresos (total − impuesto) / Cr Impuesto por pagar (impuesto) |
| Pago recibido (parcial o total) | Dr Efectivo / Cr Cuentas por cobrar |
| Factura anulada | Reversión del asiento de la factura, con el motivo de la anulación |
| Borrador, cotización, otros documentos | Nada |
| Recibo | Nada: es la prueba de un pago que ya está en el libro |

Así se distinguen **efectivo recibido**, **ingresos reconocidos** y
**cuentas por cobrar**: el ingreso se reconoce una sola vez, al emitir.

**Documentos anteriores a la contabilidad:** no se registran solos (no se
inventa nada). «Importar historial» registra facturas emitidas, pagos y
anulaciones reales con sus fechas reales; se puede repetir sin duplicar. Un
pago sobre una factura antigua registra antes la factura.

## Roles

| Permiso | Propietario | Administrador | Miembro |
|---|---|---|---|
| `accounting.view` | ✓ | ✓ | — |
| `accounting.manage` (catálogo) | ✓ | ✓ | — |
| `accounting.post` (manuales, reversiones, importar) | ✓ | ✓ | — |
| `accounting.close` | ✓ | ✓ | — |
| `accounting.reopen` | ✓ | — | — |

Los miembros no ven la contabilidad, pero las facturas que emiten se
registran igual (los triggers corren como definidor).

## Pantallas (`/accounting`)

Resumen (efectivo, ingresos, cuentas por cobrar, verificación de cuadre e
importación), libro diario (filtros, reversión), nuevo asiento manual, mayor
por cuenta (saldo inicial y acumulado), balance de comprobación (imprimible),
catálogo de cuentas, periodos e historial.

## Limitaciones conocidas

* Solo la moneda base (USD). Multimoneda: la columna `currency` ya existe;
  faltan importes en moneda base y tipo de cambio guardado como enteros.
* Sin estados financieros todavía (estado de resultados, balance general,
  flujo de efectivo) ni cierre anual a utilidades retenidas: entrega de
  informes.
* Fechas de pago y de anulación en la zona horaria de Puerto Rico (igual que
  `ba_today()` de 0015).
* Bajo REPEATABLE READ / SERIALIZABLE, un asiento que compite con el cierre de
  su mes falla con error de serialización (se reintenta); bajo READ COMMITTED
  (el de la API) recibe `PERIOD_CLOSED`.
* Si una factura antigua (anterior a la contabilidad) tiene fecha en un mes ya
  cerrado, registrar un pago sobre ella falla con `PERIOD_CLOSED` hasta que se
  importe el historial con el mes abierto.
* El módulo no tiene límite por plan (Basic/Pro/Premium lo tienen igual): es la
  base de los asientos de facturas.
* La interfaz se probó con tipos, lint, compilación y E2E público; no hay
  pruebas de navegador con sesión iniciada contra una base de datos real.

---

# Entrega 3 — Gastos, proveedores y cuentas por pagar (migración 0024)

**Estado:** borrador local, **no aplicada en ningún entorno**. Marca `STAGING-GATE`.

**El libro mayor sigue siendo el único libro.** Las facturas de proveedores son
documentos fuente; todo efecto contable es un asiento publicado con
`ledger_post` (0023), con unicidad por evento.

| Evento | Asiento |
|---|---|
| Gasto aprobado | Dr cuenta de cada categoría (gasto o activo) / Cr Cuentas por pagar — fecha del gasto |
| Pago (parcial o total) | Dr Cuentas por pagar / Cr Efectivo o Banco — fecha del pago |
| Pago anulado | Reversión del asiento del pago (motivo obligatorio) |
| Gasto aprobado anulado (sin pagos) | Reversión del asiento de aprobación |
| Borrador, pendiente, devuelto, anulado antes de aprobar | Nada |

## Estados

`borrador → pendiente de aprobación → aprobado ⇄ programado → parcialmente
pagado → pagado`; `anulado` desde borrador, pendiente, aprobado o programado
(con pagos: primero se anulan los pagos). Rechazar devuelve a borrador con
motivo. Desde el envío el contenido queda congelado para todos (también
para mantenimiento).

## Aprobación por rol y límites

* Propietario: siempre sin límite.
* Administradores: sin límite por defecto; configurable (límite o no aprueban).
* Miembros: no aprueban por defecto; configurable con un límite.
* Nadie, salvo el propietario, aprueba lo que registró o envió, a menos que
  la empresa lo permita (pensado para negocios de una persona).
* Los miembros registran gastos y proveedores y ven solo sus propios gastos.

## Protección contra duplicados

* Número de factura del proveedor único por proveedor (los anulados no cuentan).
* Clave de idempotencia por formulario de gasto y por pago.
* Aprobación, pago y anulación sobre la fila bloqueada del gasto; un asiento
  por evento en el libro.
* Recurrentes: un gasto por (plantilla, periodo); solo hasta hoy; como máximo
  36 periodos por plantilla y ejecución; se generan solo a petición.

## Adjuntos

Bucket privado `Finance-attachments`, ruta `<empresa>/<gasto>/<archivo>`,
PDF o imágenes de hasta 10 MB. La subida la hace el navegador con la sesión
del usuario; las políticas de storage exigen que el gasto sea de esa empresa y
visible para el usuario. Se abren con URL firmada de 60 segundos. Desde que el
gasto se envía, sus adjuntos no se pueden borrar (ni el registro ni el
archivo).

## Informes

Por categoría, proveedor y mes, de gastos aprobados no anulados, con la
conciliación: Cuentas por pagar del libro = saldo de los gastos aprobados, y
gasto registrado en el libro = total aprobado.

## Limitaciones conocidas

* Sin impuesto recuperable en compras (IVU pagado forma parte del gasto).
* Un gasto se paga desde Efectivo o cuentas de activo propias (Banco…); no hay
  conciliación bancaria todavía (entrega 6).
* Los recurrentes no se generan solos (no hay programador configurado).
* La subida de adjuntos y las pantallas no se probaron en un navegador con
  sesión contra un Supabase real; el aislamiento de storage se probó con las
  políticas en la base de datos local.
* Disponible en Basic, Pro y Premium sin límites por plan.

---

# Entrega 4 — Cuentas por cobrar y cobranza (migración 0025)

**Estado:** borrador local, **no aplicada en ningún entorno**. Marca `STAGING-GATE`.

**Sin registro paralelo.** Los saldos se calculan de las facturas y los pagos
(0015), y cuadran con la cuenta Cuentas por cobrar del libro mayor (0023);
el informe de antigüedad muestra esa conciliación. La cobranza solo añade
datos de seguimiento (estado, notas, promesas, recordatorios), sin importes
contables propios.

## Dinero

* Factura emitida: Dr Cuentas por cobrar / Cr Ingresos (+ impuesto). El
  ingreso se reconoce una sola vez, al emitir.
* Pago (parcial o total): Dr Efectivo / Cr Cuentas por cobrar.
* **Nuevo — anulación de pago** (cheque devuelto, error): el pago se conserva
  marcado como anulado (quién, cuándo, motivo), se publica una reversión
  (`payment_void`) y la factura pagada vuelve a emitida o vencida. Los pagos
  no se editan ni se borran (ni siquiera por mantenimiento).
* Nunca balances negativos: pagos y anulaciones de una factura se serializan
  sobre la fila bloqueada; un pago no supera el saldo; una anulación lo sube.
* Los pagos anulados dejan de contar en todo: saldo, estado pagada, recibos,
  integridad del libro. 0025 reemplaza esas sumas de 0015/0023; el rollback
  restaura el texto original exacto.

## Estados y antigüedad

Estado de cuentas por cobrar: emitida · parcialmente pagada · vencida ·
pagada. Antigüedad por días desde el vencimiento (o la emisión): 0–30 (incluye
lo que aún no vence), 31–60, 61–90, más de 90, a cualquier fecha de corte.

## Cobranza

* Estado de cobro por factura: sin gestión, contactado, promesa, en disputa,
  escalado, en pausa.
* Notas internas por factura o cliente (solo se añaden).
* Promesas de pago: pendiente → cumplida (automática cuando los pagos
  posteriores cubren el importe) / incumplida (pasa la fecha) / cancelada (con
  motivo).
* Recordatorios: días configurables respecto al vencimiento; «Actualizar
  seguimiento» prepara los de los últimos 7 días (uno por factura y día), sin
  inundar con atrasos; las facturas en disputa o en pausa no reciben; al pagar
  o anular una factura se cancelan. **Email preparado:** con `RESEND_API_KEY`
  y `EMAIL_FROM` en el servidor se envían; sin ellos quedan preparados y nada
  se marca como enviado. Se pueden registrar como «contactado por otro medio».

## Informes

* Antigüedad por cliente (imprimible), con filtro de clientes con vencidos.
* Por cliente y periodo: saldo inicial + facturado − cobrado + pagos anulados −
  facturas anuladas = saldo final (verificado en cada fila).
* Historial completo por cliente: facturas, pagos (incluidos anulados), notas,
  promesas y eventos.

## Roles

`receivables.view`, `receivables.manage` y `payments.void`: propietario y
administradores. Los miembros siguen registrando pagos (0015) pero no ven
la cobranza.

## Limitaciones conocidas

* Resend no está configurado: el envío real de email no se probó (solo con
  `fetch` simulado). La cola y los estados sí están probados en la base.
* No hay programador: los recordatorios y promesas se actualizan con el botón
  «Actualizar seguimiento» (o una llamada futura de un cron sin usuario).
* Fechas en hora de Puerto Rico.
* Pantallas no probadas en navegador con sesión contra un Supabase real.
