# Preparación para el lanzamiento (S9)

**Conclusión honesta:** BusinessAI **no está listo para producción todavía**. La lógica de la plataforma
(0001–0045) está implementada y probada **en local** de forma integral, pero faltan pruebas esenciales
que este entorno no permite: la prueba de navegador **con sesión** contra la pila local (necesita el binario
de PostgREST, cuya descarga no se permitió aquí), la aplicación de 0037–0045 en Staging (requiere su
autorización) y las integraciones con proveedores reales (credenciales).

## 1. Clasificación de funciones

| Función | Estado |
|---|---|
| Empresas, miembros, roles y permisos, sucursales, alcance por sucursal | 1 · Implementada y probada localmente |
| Clientes / CRM, catálogo, documentos (cotización → factura), Document Studio | 1 |
| Factura emitida con datos históricos (líneas, importes, cliente y emisor) | 1 (cliente/emisor desde 0045) |
| Libro mayor, estados financieros, presupuestos, cierres de periodo | 1 |
| Cuentas por cobrar y por pagar, pagos, anulaciones | 1 |
| Conciliación bancaria con estados importados (CSV) | 1 |
| Conexión bancaria automática (Plaid) | 2 · Pendiente de proveedor real |
| Recibos con OCR | 2 (sin OCR: captura manual = 1) |
| Inventario, compras, recepciones, transferencias, conteos, reposición | 1 |
| Punto de venta nativo (venta, cobro, cambio, devolución, anulación, turnos, arqueo, informes) | 1 |
| Escáner USB / Bluetooth HID y cámara | 1 en navegador simulado · 3 Pendiente de hardware (modelos físicos, cámara real) |
| Impresora de recibos térmica, cajón de dinero | 5 · No implementada (recibo por impresión del navegador = 1) |
| Integraciones Square, Clover, Shopify POS, Lightspeed X | 2 · Probadas solo con dobles |
| Lightspeed R, Toast, ATH Móvil Business API, tarjeta integrada, Stripe Connect | 5 · No implementadas |
| Cajas tradicionales por CSV y puente local (punto de entrada) | 1 · el agente por modelo: 3 |
| Workforce: empleados, horarios, ponche, quiosco, reglas, RR. HH. | 1 |
| Nómina (cálculo, aprobación, asientos, pago) | 1 · impuestos de nómina desactivados por diseño (decisión del contador) |
| Asistente BusinessAI | 2 · Pendiente de proveedor (clave de API); permisos, límites y confirmaciones = 1 |
| Planes Basic / Pro / Premium, límites, estados de la suscripción | 1 en la base de datos · 4 Pendiente de configuración remota (precios y webhook de Stripe en el entorno real) |
| Onboarding (10 pasos) | 1 (lista «Primeros pasos» con datos reales; moneda y zona horaria fijas: USD / hora de Puerto Rico) |
| Eliminación de cuenta (tiendas) | 1 (solicitud) · 4 (el operador la completa con la clave de servicio) |
| Aplicaciones iOS / Android | 4 · No creadas ni publicadas (requiere autorización, cuentas y equipos) |
| Migraciones 0037–0045 en Staging | 4 · Pendientes de autorización |

## 2. Pruebas verificadas (en este entorno, S9)

| Prueba | Resultado |
|---|---|
| `npm run test:db` (PostgreSQL 16 local, 52 escenarios: migraciones, rollbacks, RLS, carreras, flujos, límites de página) | **680 aprobadas, 0 fallidas** (escenarios 51 y 52 incluidos; `127_pagination` 16 aserciones) |
| Escenario 52: 29 suites de módulos actuales **juntas** sobre 0001–0045 | Todas en verde (CRM, Workforce, Nómina, Libro mayor, Gastos, Cobros, Banco, Estados, Studio, Catálogo, Asistente S4, Banca, Inventario, POS, planes, equipo…) |
| `126_platform_flows.test.sql` (flujos A–H y barrido multiempresa) | En verde |
| `vitest` (lógica de la app, incluido el render del POS, la paginación y la consulta periódica de proveedores) | 907 aprobadas, 51 omitidas (pruebas que requieren servicios externos) |
| `e2e/public.e2e.mjs` (navegador, sin sesión: protección de todas las rutas, rutas de máquina, idioma, iPhone / iPad en páginas públicas) | 156 aprobadas |
| TypeScript, ESLint | Sin errores (ESLint: 6 avisos preexistentes, ninguno nuevo) |
| `next build` (Next.js 16.4.5) | Correcto, sin aviso de seguridad |

Flujos obligatorios: **A** (registro → empresa → primera factura), **B** (producto → venta POS → inventario),
**C** (compra → recepción → existencias → factura del proveedor sin duplicados), **D** (factura → pago →
movimiento bancario → conciliación) en `126_platform_flows.test.sql`; **E** (empleado → asistencia → nómina) en
`80_workforce`, `102_workforce_hr` y `104_payroll` sobre la pila completa (escenario 52); **F** (asistente con
permisos y confirmaciones) en `98`, `100`, `101`, `116` sobre la pila completa.

**Pruebas de navegador con sesión (16 suites, `e2e/*.auth.e2e.mjs`):** no pueden correr en este sandbox (sin
PostgREST; la política del entorno rechazó instalarlo). Se ejecutan en `.github/workflows/e2e-auth.yml`, que monta en el
runner de GitHub una pila **solo local** (PostgreSQL 16 con las migraciones 0001–0045 y datos de prueba, PostgREST 12.2.3,
sustituto local de Auth; sin secretos, sin Supabase / Stripe / Vercel). Ejecución 2 (commit `12a4968`, PR #1):
**16 / 16 suites en verde, 795 verificaciones aprobadas, 0 fallidas**.

| Suite | Resultado | Suite | Resultado |
|---|---|---|---|
| finance | 85 / 0 | finance-flows | 97 / 0 |
| studio | 50 / 0 | studio-branches | 26 / 0 |
| studio-finance | 29 / 0 | studio-advanced | 28 / 0 |
| catalog | 35 / 0 | assistant | 80 / 0 |
| assistant-s4 | 24 / 0 | banking | 56 / 0 |
| inventory | 72 / 0 | **pos (nueva)** | **38 / 0** |
| workforce | 53 / 0 | employee-link | 24 / 0 |
| payroll | 41 / 0 | crm | 57 / 0 |

La ejecución 1 falló en las 16 al iniciar sesión por un defecto del propio flujo de trabajo (compilaba con una URL de
Supabase de relleno, que Next.js incrusta en la compilación); corregido en `12a4968`, sin cambios en la app ni en las pruebas.
Las comprobaciones de iPhone 13 / iPad Mini son de tamaño de pantalla en Chromium, **no** de dispositivos físicos.
Tampoco: pruebas con hardware, cuentas reales de proveedores, ni nada en Staging / Production.

## 3. Problemas corregidos en S9

| # | Problema | Corrección |
|---|---|---|
| S9-1 | Una factura emitida mostraba el cliente y el emisor **actuales**: renombrar al cliente cambiaba facturas pasadas | 0045: instantánea al emitir (trigger), inmutable; la página del documento la usa |
| S9-2 | `document_deletion_audit` concedía INSERT / UPDATE / DELETE a `anon` y UPDATE / DELETE a usuarios (RLS los bloqueaba, pero un registro de auditoría debe ser solo de anotación) | 0045 revoca esos permisos |
| S9-3 | No había forma de iniciar la eliminación de la cuenta desde la app (requisito de App Store / Google Play) | 0045 + «Mi cuenta» + herramienta del operador |
| S9-4 | Next.js 16.4.3 afectado por un aviso (divulgación de parámetros con `unstable_cache` y `'use cache'`, ≥16.3.0 ≤16.4.4; la app no usa esas funciones) | Actualizado a 16.4.5 (primera versión corregida) con `eslint-config-next`; build, unit y E2E públicos en verde; `npm audit --omit=dev`: 0 vulnerabilidades |
| S9-5 | Tablas de estados financieros y propuestas de reglas sin desplazamiento horizontal en teléfonos | Envueltas con `overflow-x-auto` |
| S9-6 | Sin guía de primeros pasos tras crear la empresa | Lista «Primeros pasos» en el panel, derivada de datos reales |
| S9-8 | **Cifras incompletas sin aviso**: el API de Supabase devuelve como máximo 1 000 filas por petición; el panel (`limit(5000)` / `limit(10000)`), los totales de Gastos en Finanzas, las exportaciones CSV del banco y del inventario, el selector de clientes de facturas, los productos del inventario / POS y las funciones `ar_invoice_balances`, `ar_aging`, `ar_client_report`, `inventory_levels`, `inventory_replenishment_data`, `bank_open_journal_lines` y `ledger_account_activity` (Cobros, Finanzas, Asistente, Inventario, Banco, Libro mayor) se cortaban en 1 000 | Lectura completa por páginas con el ayudante existente `fetchAllPages` en todos esos lugares; el panel además lee solo lo necesario (facturas abiertas + 13 meses) y avisa si no pudo cargar todo |
| S9-9 | `fetchAllPages` decía «no truncado» cuando el límite de seguridad cortaba una página por la mitad | Corregido (compara con lo pedido); pruebas en `tests/paginate.test.ts` |
| S9-10 | Square: sin renovación del token ni consulta periódica (los webhooks no garantizan la entrega); Clover igual | 0045 + `PosSync.renewSquare / pollSquare / pollClover`; probado con dobles |
| S9-11 | Copias de seguridad de código versionadas (`page.tsx.before-*`, `page-completa.txt`) | Eliminadas (siguen en el historial de git) |
| S9-12 | **Eliminar un usuario fallaba** para casi todos: `payments.created_by` (NO ACTION) y `companies.created_by` (RESTRICT) referenciaban `auth.users`, y `payment_guard` impide cambiar un pago | 0045 retira esas dos claves foráneas; la columna conserva el id (seudónimo) de quien registró el pago o creó la empresa. Probado: el usuario se elimina, pagos, documentos, asientos y la empresa se conservan (`126` §J); rollback restaura las claves solo si no hubo eliminaciones |
| S9-13 | El libro mayor por cuenta se paginaba ordenado por `entry_id` (introducido en la ronda anterior): perdía el orden cronológico y el saldo corrido; aging y reportes de clientes perdían su orden | Se respeta el orden propio de cada función (+ desempate único donde no es total); probado en `127_pagination.test.sql` |
| S9-14 | Un resultado truncado por el tope de seguridad podía mostrarse como total completo | `complete()` convierte el truncado en error visible (error boundary). La exportación CSV de Bancos importaba la guardia sin usarla: ahora un error de lectura o un resultado truncado hace fallar la descarga en vez de entregar un archivo incompleto |
| S9-15 | Más lecturas cortadas en 1 000 filas: inicio de Bancos (todas las líneas), Cobros (clientes y pagos del mes), Gastos (facturas abiertas por suplidor, pagos, recurrentes), informe de nómina (líneas de todas las corridas), inventario (órdenes), movimientos, CRM; y listas `in(…)` de cientos de ids que exceden el largo de URL | Paginación completa y `allIn()` (lotes de 100 + páginas) |
| S9-16 | POS: el cursor comparaba fechas ISO como texto (`…00.123Z` < `…00Z`) y podía retroceder | Comparación por instante (`laterIso`) |
| S9-17 | POS: sin manejo de límites de uso (429 / 503) de los proveedores | `providerFetch`: espera `Retry-After` (tope 10 s), 2 reintentos; probado |
| S9-18 | Sin guardia automática de la secuencia de migraciones | `tests/migrations-sequence.test.ts` (rollback, borrador, orden, documentación, arnés, número siguiente) |
| S9-7 | La suite 96 del asistente se usaba como regresión de la pila completa aunque está atada a 0029 | Sustituida por suites vigentes (98, 100, 101, 116); 96 sigue en su escenario |

## 4. Seguridad multiempresa (verificada en `126_platform_flows.test.sql` §G)

- Otra empresa (propietario con todos los permisos en la suya) **no ve ninguna fila** de A en **todas** las
  tablas con `company_id` (más de 120 tablas recorridas automáticamente).
- Sin sesión no se lee ningún dato de empresa; ninguna tabla es escribible por `anon`.
- RLS activada en **todas** las tablas públicas; todas las funciones `SECURITY DEFINER` fijan `search_path`.
- `ba_private` (tokens cifrados, claves del servidor) cerrado a la API; ninguna función privada ejecutable por roles de la API.
- Libros (asientos, existencias, POS, asignaciones bancarias, nómina, suscripciones) no escribibles directamente.
- Solo el bucket del logo es público; firmas, adjuntos, documentos de RR. HH. y evidencias bancarias son privados.
- Alcance por sucursal: un miembro de Ponce no ve ni mueve existencias, ventas, cajas ni órdenes de San Juan.
- Las funciones rechazan o devuelven vacío para otra empresa; las operaciones importantes quedan auditadas.
- Webhooks: firma verificada sobre el cuerpo crudo antes de escribir; firmas del servidor con *nonce* de un solo uso.

## 5. Planes

Precios mensuales en el catálogo de la app: Basic 19.99, Pro 39.99, Premium 59.99 (Stripe usa las claves
`businessai_*_monthly`). Límites en la base de datos (0017) y comprobados: empleados 3 / 25 / 100, sucursales
1 / 3 / 10, nómina solo Pro y Premium, asientos de administrador 1 / 3 / 10 (los empleados no los consumen).
Un pago fallido (`past_due`) mantiene el acceso (gracia); una suscripción cancelada no añade empleados y
conserva los datos; el usuario no puede cambiar su propio plan (solo el webhook de Stripe). **No se modificó
Stripe**: precios, productos y webhook del entorno real deben configurarse y verificarse en Stripe TEST
antes del lanzamiento (`docs/BILLING.md`).

## 6. Integraciones que necesitan credenciales

Anthropic (asistente), Plaid (banca), Azure Document Intelligence (OCR, opcional), Square, Shopify, Clover,
Lightspeed X, Stripe (TEST / LIVE), correo transaccional (invitaciones). Ninguna está configurada en Vercel.

## 7. Funciones que requieren hardware

Escáneres USB / Bluetooth (modo HID), cámaras de iPhone / iPad, impresoras de recibos, cajas tradicionales
y su agente de puente, terminales de pago integradas (solo vía procesador), tabletas de quiosco.

## 8. Pendientes de Staging

Aplicar 0037–0045 en el orden y con el procedimiento de `docs/STAGING_STATUS.md` §8 (autorización por
migración); después, pruebas de humo en la Preview y la prueba de navegador con sesión contra Staging.

## 9. Riesgos de lanzamiento

1. Pruebas de navegador con sesión no repetidas tras S8 / S9 (POS nunca probado en navegador real).
2. 0037–0045 nunca aplicadas sobre los datos reales de Staging.
3. Stripe sin verificar de extremo a extremo en el entorno real (webhook, cambios de plan, fallos de pago).
4. Integraciones POS y bancarias solo con dobles.
5. El panel ya lee solo facturas abiertas y los últimos 13 meses, completo por páginas (S9-8); con volúmenes
   muy grandes (decenas de miles de documentos al año) convendrá agregarlo en la base de datos.
6. Moneda y zona horaria fijas (USD, Puerto Rico): no apto para clientes fuera de PR sin cambios.
7. Aplicaciones móviles no creadas; suscripciones en tiendas sin decidir.
8. ~~Archivos de respaldo de código~~ (eliminados en S9).

## 10. Requisitos para los primeros clientes

- [ ] Autorizar y aplicar 0037–0045 en Staging; ejecutar la prueba de navegador con sesión (todas las suites `*.auth.e2e.mjs`).
- [ ] Stripe TEST: precios con las claves `businessai_*_monthly`, webhook, prueba ciclo completo (alta, cambio, fallo, cancelación).
- [ ] Clave del asistente (si se ofrece) con límite de gasto del proveedor.
- [ ] Dominio, correo transaccional y textos legales revisados.
- [ ] Copia de seguridad y punto de restauración de Production; plan de soporte.
- [ ] Clientes iniciales en Puerto Rico, en USD, con equipos probados (escáner HID, iPad/iPhone recientes).
- [ ] Sin datos de demostración en Production.
