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
* Pantallas probadas en navegador con sesión contra una pila local (ver
  «Prueba en navegador con sesión»); no contra Supabase Auth real.

---

# Entrega 5 — Conciliación bancaria (migración 0026)

**Estado:** borrador local, **no aplicada en ningún entorno**. Marca `STAGING-GATE`.

## Auditoría previa y decisión de arquitectura

Antes de 0026 cada movimiento de dinero ya era una línea del libro mayor
sobre una cuenta de activo: cobros de clientes (0023, siempre 1000 Efectivo),
pagos a proveedores (0024, cuenta elegida: 1000 o 1010), gastos pagados
(los mismos pagos), transferencias y depósitos (asientos manuales).
**Decisión:** una cuenta bancaria se vincula a **una** cuenta de activo del
catálogo y la conciliación empareja los movimientos del estado con **esas
líneas del libro**. No hay segunda fuente de verdad: importar no crea
ingresos ni gastos; los únicos asientos nuevos son movimientos del banco que
faltan en los libros (comisiones, intereses, desconocidos, transferencias) y
ajustes autorizados, siempre balanceados y con `ledger_post` (respetan
periodos cerrados). Para que los cobros de clientes puedan ir a un banco se
añadió `payments.deposit_account_id` (opcional; sin él, 1000 Efectivo como
antes). 0026 reemplaza `ledger_post_payment` y el rollback restaura el
original exacto.

## Modelo

| Tabla | Contenido |
|---|---|
| `bank_accounts` | Nombre, banco, moneda (base, USD), últimos 4 dígitos, cuenta contable (activo; una cuenta bancaria activa por cuenta contable), activa/archivada. **Sin credenciales** (la migración verifica que no exista ninguna columna de ese tipo). |
| `bank_imports` | Archivo (nombre, SHA-256), mapeo, filas, nuevos, duplicados, fechas; revertible sin borrar. |
| `bank_lines` | Fecha, descripción, referencia, importe con signo en centavos, saldo, ID del banco, huella, fila original; estado pendiente / emparejado / excluido; conciliación. |
| `bank_match_groups` + `bank_match_items` | Grupo: N movimientos ↔ M líneas del libro con sumas idénticas. Una línea en un solo grupo activo. Deshacer deja el grupo como historial. |
| `bank_reconciliations` | Cuenta, periodo, saldos inicial y final del estado, cierre, ajuste, reapertura. |
| `bank_events` | Auditoría de solo-añadir. |

## Importación

* CSV de hasta 2 MB / 5000 filas; UTF-8 (con o sin BOM) o Windows-1252;
  delimitador `,` `;` o tabulador; asistente de columnas (fecha,
  descripción, referencia, importe con signo **o** débito/crédito, saldo, ID);
  formatos de fecha AAAA-MM-DD, MM/DD/AAAA, DD/MM/AAAA; decimales `1,234.56` o
  `1.234,56`; paréntesis y signo final como negativos; inversión de signo.
* Vista previa en el navegador con errores por línea, totales y duplicados;
  al confirmar el servidor vuelve a leer el archivo y la base valida cada fila
  (todo o nada).
* Duplicados: el mismo archivo (SHA-256) no se importa dos veces en la misma
  cuenta; el mismo movimiento (ID del banco o huella de fecha, importe,
  descripción, referencia y saldo) tampoco, aunque venga en otro archivo.
  Filas idénticas dentro de un archivo se omiten salvo que el usuario indique
  que son transacciones distintas.
* No se guarda el archivo original: se conservan su SHA-256, el mapeo y cada
  fila original (`raw`), suficiente para la trazabilidad.

## Emparejamiento

* Sugerencias con confianza: 100 (importe, fecha y referencia), 95 (importe
  y fecha), 90 (importe y referencia en ±7 días), 50–80 (importe en ±7 días),
  60 (varias partidas del mismo día suman el importe), y detección de
  comisiones / desconocidos. Se marcan **ambiguas** cuando otra opción es
  igual de buena.
* «Emparejar exactos» confirma solo coincidencias ≥ 95 inequívocas; las
  ambiguas y los grupos se confirman a mano.
* Emparejamiento manual múltiple (1:N, N:1); sumas exactamente iguales.
* Registrar un movimiento que no está en los libros: asiento balanceado entre
  la cuenta del banco y la contrapartida elegida (6500 Comisiones bancarias se
  crea al activar la banca), emparejado automáticamente.

## Conciliación

Diferencia = saldo final del estado + partidas en libros aún no en el banco −
movimientos del banco registrados en libros después del periodo − saldo en
libros al cierre. **Cierre** exige: continuidad con el cierre anterior, estado
completo (saldo inicial + movimientos = saldo final), ningún movimiento sin
emparejar y diferencia cero. Una diferencia restante solo se cierra con un
**ajuste autorizado por el propietario**, con motivo documentado y asiento
balanceado. Al cerrar se bloquean los movimientos y emparejamientos del
periodo; solo el propietario reabre la última, con motivo. Los saldos de una
conciliación abierta se corrigen con registro de los valores anteriores; las
conciliaciones nunca se borran.

## Roles

`bank.view`, `bank.manage`, `bank.reconcile` (propietario y administradores);
`bank.adjust` y `bank.reopen` (propietario). Registrar movimientos bancarios
en el libro requiere además `accounting.post`.

## Informes

Conciliaciones por cuenta y periodo, movimientos sin emparejar, diferencias
detectadas, historial de importaciones (con reversión), cierres, ajustes y
reaperturas; exportación CSV (conciliaciones, sin emparejar, movimientos,
importaciones, auditoría) con protección contra fórmulas en hojas de cálculo.

## Limitaciones conocidas

* Solo CSV (no OFX/QFX ni conexión bancaria directa: no se guardan
  credenciales).
* Solo la moneda base (USD); las tablas guardan la moneda para el futuro.
* Las sugerencias de grupo solo consideran partidas del mismo día (2–10).
* Pantallas probadas en navegador con sesión contra una pila local (ver
  «Prueba en navegador con sesión»); no contra Supabase Auth real.

# Entrega 6 — Estados financieros y presupuestos (migración 0027)

**Estado:** borrador local, **no aplicada en ningún entorno**. Marca `STAGING-GATE`.
Rollback: `supabase/rollback/0027_rollback.sql` (se niega si ya hay
presupuestos, eventos, supuestos o clasificaciones guardadas; deja la base
idéntica a 0026, verificado por huella).

## Auditoría previa (0023–0026)

* Todo el dinero ya está en el libro mayor (facturas, cobros, gastos, pagos,
  banco): los estados se calculan **solo** desde `journal_lines` de asientos
  contabilizados. No hay un segundo registro.
* El catálogo no distinguía corriente / no corriente, ni costos directos /
  gastos operacionales / otros: 0027 añade `ledger_accounts.statement_class`
  (opcional, validada por tipo) y una derivación automática por código.
* No hay cierre anual (asiento a 3100): el balance muestra
  “Resultados de ejercicios anteriores” y “Resultado del ejercicio”
  calculados, y lo indica como nota.
* No existe tabla de sucursales; sí `departments` (Personal). El libro no
  registra departamento, así que los presupuestos de departamento no tienen
  “real” por departamento (se marca `actual_available = false`).

## Clasificación (`fs_class`)

| Prioridad | Regla | Clase |
|---|---|---|
| 1 | `statement_class` elegida en el catálogo | la elegida |
| 2 | cuenta de sistema efectivo, código `10xx` o vinculada a un banco | Efectivo y bancos |
| 3 | activo `15xx–19xx` / resto | No corriente / corriente |
| 4 | pasivo `25xx–29xx` / resto | No corriente / corriente |
| 5 | capital: sistema utilidades retenidas / resto | Utilidades retenidas / capital |
| 6 | ingreso `45xx–49xx` / resto | Otros ingresos / operacionales |
| 7 | gasto `5xxx` / `8xxx` / `9xxx` / resto | Costos directos / otros gastos / impuesto / operacionales |

La clase se edita en *Contabilidad → Catálogo → Editar*; la base de datos
rechaza una clase que no corresponde al tipo.

## Fórmulas

* **Estado de resultados:** utilidad bruta = ingresos operacionales − costos
  directos; resultado operacional = utilidad bruta − gastos operacionales;
  antes de impuestos = operacional + otros ingresos − otros gastos; neto =
  antes de impuestos − impuesto registrado. **No se calcula impuesto**: si no
  hay gasto de impuesto, se avisa que el neto es antes de impuestos.
* **Balance:** activos = pasivos + capital + resultados anteriores +
  resultado del ejercicio (año calendario). Se muestra la diferencia; si no
  es 0 el informe es provisional.
* **Flujo de efectivo (indirecto):** resultado neto + depreciación
  acumulada (solo si está registrada; nunca se estima) ± cambios en activos y
  pasivos corrientes = operación; activos no corrientes = inversión; pasivos
  no corrientes y capital = financiación. Se comprueba que el cambio neto sea
  igual a efectivo final − efectivo inicial.
* **Comparaciones:** mes / trimestre / año / personalizado contra el periodo
  anterior o el mismo periodo del año anterior. % = variación / |base|; con
  base 0 el % es “—” (sin división por cero).
* **Favorable:** ingresos y resultados arriba = favorable; gastos arriba =
  desfavorable (texto y flecha, no solo color).
* Todo en centavos enteros (`bigint` en SQL, `BigInt` en la app).

## Datos incompletos (`fs_data_quality`)

Un informe es **definitivo** solo si: hay asientos, no hay asientos
descuadrados, no hay facturas ni cobros anteriores a la contabilidad sin
importar, ningún efectivo es negativo, el balance cuadra y todos los meses del
rango están cerrados. Si no, se marca **Provisional** con cada motivo (también
en la exportación). Falta de asiento de saldos iniciales: nota informativa.

## Presupuestos

* Anual o mensual, por cuenta de ingreso/gasto o por categoría de gasto
  (real de categorías = facturas de proveedor aprobadas). Una categoría cuya
  cuenta también tiene línea no suma dos veces.
* Escenario base / conservador / optimista; departamento opcional.
* Flujo: **borrador → aprobado (propietario) → publicado (propietario)**;
  archivar con motivo. Un presupuesto no-borrador **no se modifica** (trigger
  `budget_guard`, también contra mantenimiento directo): se crea una **nueva
  versión** (copia en borrador; una sola por presupuesto). Publicar archiva el
  publicado anterior del mismo año/escenario/departamento (índice único).
* Notas y justificación por presupuesto y por línea; umbrales de alerta
  configurables (gasto ≥ atención / crítico % del año; ingreso < % de lo
  presupuestado a la fecha).
* Todo queda en `budget_events` (solo inserción): creación, cambios,
  relleno, aprobación, publicación, archivo, versiones y supuestos.
* **Presupuesto vs real:** presupuesto del año, a la fecha (meses
  completos + mes en curso prorrateado por días; anual prorrateado por días),
  real, variación en dinero y %, % consumido, proyección al cierre al ritmo
  actual, favorable y alerta.
* Concurrencia probada: dos “nueva versión” simultáneas → una sola; dos
  “publicar” → un solo publicado; editar mientras se aprueba → la edición
  falla con `BUDGET_LOCKED`. Los 12 meses de una línea se guardan en una
  sola transacción (`budget_set_lines`): si se aprueba a la vez, la línea
  entera se rechaza; nunca queda una línea a medias.

## Proyecciones (estimaciones)

Separadas en pantalla: **datos reales usados** (efectivo hoy, por cobrar,
por pagar, historial), **supuestos editables** (crecimiento anual, % de cobro,
ajustes conservador/optimista, meses; guardados en `fs_assumptions` con
auditoría) y **resultado estimado** por escenario. Ingresos/costos del mes:
presupuesto publicado base de toda la empresa si existe; si no, promedio de
los últimos 3 meses con actividad con crecimiento lineal. Cobros: facturas
abiertas por vencimiento (vencidas → primer mes) × % de cobro. Pagos:
facturas de proveedor aprobadas por vencimiento. Siempre rotulado como
estimación, nunca como resultado garantizado.

## Pantallas (`/finance`)

Panel (KPIs que enlazan a su origen: estado de resultados, flujo,
`/receivables`, `/payables`, presupuesto; tendencia de 12 meses con enlace a
cada mes; alertas y oportunidades con enlace), Estado de resultados, Balance
general, Flujo de efectivo (cada cuenta enlaza a su mayor con las mismas
fechas), Presupuestos (lista paginada, crear, rellenar con reales),
Presupuesto (editor de líneas, flujo, vs real, versiones y comparación,
historial) y Proyecciones. Exportación `/finance/export` en **Excel (.xlsx)**
y **CSV**, con empresa, informe, periodo, moneda, fecha de generación y notas
de datos incompletos; **PDF** con *Imprimir / PDF* (la cabecera de informe se
imprime).

## Roles

| Permiso | Propietario | Admin | Miembro |
|---|---|---|---|
| Ver estados, presupuestos, proyecciones (`accounting.view`) | ✓ | ✓ | — |
| Crear / editar borradores, versiones, supuestos, archivar no publicados (`budgets.manage`) | ✓ | ✓ | — |
| Aprobar, publicar, archivar publicados (`budgets.approve`) | ✓ | — | — |

## Pruebas

`supabase/tests/local/92_statements.test.sql` (cifras calculadas a mano:
resultados, balance y ecuación contable en los 12 cierres de mes, flujo,
periodos vacíos, saldos iniciales faltantes, comparaciones, presupuestos y
versiones, aprobación/publicación, variaciones positivas y negativas, división
por cero, aislamiento entre empresas, permisos, integración con cuentas por
pagar, cascada), `93_budget_race.sh` (concurrencia) y
`tests/finance-statements.test.ts` (periodos, comparaciones, totales,
proyecciones y escenarios, alertas, maquetación, xlsx).

## Limitaciones conocidas

* No hay asiento de cierre anual; los resultados anteriores se calculan.
* Presupuestos de departamento sin real por departamento; no hay sucursales.
* El año fiscal es el año calendario.
* Proyección simple (promedio + crecimiento lineal); los ingresos/costos
  nuevos se suponen cobrados/pagados el mismo mes.
* PDF mediante la impresión del navegador (no se genera un PDF en servidor).
* Solo moneda base.
* Pantallas probadas en navegador con sesión contra una pila local
  (PostgreSQL + PostgREST 12.2.3); no contra Supabase Auth real (ver
  «Prueba en navegador con sesión»).

# Prueba en navegador con sesión (entregas 2–6)

`e2e/finance.auth.e2e.mjs` (`npm run test:e2e:finance`) recorre con
Playwright y **un usuario que inicia sesión con el formulario** las pantallas
de contabilidad, gastos, cuentas por cobrar, bancos y finanzas, contra una
pila **solo local**:

```
PostgreSQL local (e2e/local-stack/db.sh: shim + migraciones 0001–0027 + datos de prueba)
  └─ PostgREST 12.2.3 (127.0.0.1, rol authenticator, mismas políticas RLS)
       └─ e2e/local-stack/auth-stub.mjs (127.0.0.1: sustituto mínimo de Supabase Auth)
            └─ next start (127.0.0.1)  ←  Playwright (Chromium)
```

```bash
npm run build
PSQL="psql -h /ruta/socket -p 5432 -U postgres" bash e2e/local-stack/db.sh
PGRST_BIN=/ruta/postgrest PG_SOCKET=/ruta/socket PG_PORT=5432 npm run test:e2e:finance
```

**Seguridad del entorno de prueba**
* Todo escucha en `127.0.0.1`; la app solo recibe URLs locales. `db.sh`
  rechaza un `PSQL` que apunte a Supabase.
* La clave JWT y la contraseña de prueba se generan al azar en cada
  ejecución y no se guardan; el sustituto de Auth solo conoce los 4 usuarios
  de prueba, rechaza contraseñas incorrectas y JWT manipulados.
* PostgREST usa el rol `authenticator` (sin privilegios propios) que cambia a
  `anon` / `authenticated` según el JWT: las políticas RLS y los permisos de
  las funciones son los mismos que en Supabase.
* El binario de PostgREST no se incluye en el repositorio: se pasa por
  `PGRST_BIN`. Usado: `postgrest-v12.2.3-linux-static-x64.tar.xz` de las
  publicaciones oficiales de GitHub, SHA-256
  `9f71269e61ac3a940281e93ff415760f5957e430e475ba4c3889f3ede7d5527c`
  (el propietario del proyecto lo comparó con el digest que GitHub muestra
  para ese archivo; desde esta sesión no se pudo leer ese digest. Los
  mantenedores no publican checksums ni firmas propias: la etiqueta v12.2.3
  no está firmada y su flujo de publicación no genera checksums).
* Limitación: el sustituto de Auth no es Supabase Auth (no prueba registro,
  correo, recuperación de contraseña ni rotación real de tokens).

**Qué comprueba (85 verificaciones)**
* Inicio de sesión: contraseña incorrecta rechazada, ruta protegida sin
  sesión → `/login`, inicio de sesión con el formulario.
* 30 pantallas de las entregas 2–6 cargan con datos, sin error.
* Entrega 2: asiento manual balanceado desde el formulario; uno descuadrado
  rechazado; balanza de comprobación.
* Entrega 3: pagar una factura de proveedor desde su página (queda
  «Pagado») y su enlace a los asientos.
* Entrega 4: saldo vencido correcto (1,500.00 − 500.00 = 1,000.00), página
  de cobro de la factura y antigüedad de saldos.
* Entrega 5: cuenta bancaria vinculada a 1010, importación de CSV con el
  asistente, emparejamiento exacto del pago al proveedor.
* Entrega 6: estado de resultados (subtotales y enlaces al mayor), balance
  que cuadra, flujo que coincide con el efectivo, panel con alertas;
  presupuesto creado → línea de 12 meses → aprobado → bloqueado → publicado →
  presupuesto vs real → descarga .xlsx → nueva versión v2; exportación CSV
  y XLSX; proyecciones con supuestos guardados.
* Roles y aislamiento: el admin nunca ve «Aprobar»; un miembro no abre
  finanzas, contabilidad ni bancos ni exporta (403); otra empresa no abre el
  presupuesto (404) ni ve sus cuentas.
* iPhone 13 e iPad Mini: sin desplazamiento horizontal.
* Sin errores en el log del servidor, sin errores de consola ni respuestas
  HTTP ≥ 400 en el navegador, y la app solo usó endpoints de Auth que el
  sustituto implementa.

**Errores encontrados y corregidos**
* Los botones *Excel* / *CSV* de las páginas de finanzas eran `<Link>` de
  Next hacia una ruta de descarga (`/finance/export`): Next intentaba
  precargarla como página (404) y navegaba con un POST que la ruta rechaza
  (405). La descarga solo funcionaba por el mecanismo de respaldo y dejaba
  errores en la consola. Ahora son enlaces de descarga normales
  (`<a download>`), como en bancos.
* Los demás fallos de las primeras ejecuciones eran del propio test (leía la
  página antes de terminar el streaming, buscaba «Pagada» en vez de
  «Pagado», usaba fechas MM/DD con el formato DD/MM por defecto en español,
  y no esperaba a que cambiara la URL tras una acción); se corrigieron en el
  test, no en la app.

## Nómina (0034)

La nómina publica en este mismo libro mayor (fuentes `payroll`, `payroll_payment`, `payroll_void`, `payroll_payment_void`): gasto 6100 contra salarios por pagar 2200 y deducciones por pagar 2210; el pago registrado salda 2200 contra 1010. Ver [PAYROLL.md](PAYROLL.md).
