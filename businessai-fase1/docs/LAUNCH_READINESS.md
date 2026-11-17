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
| `npm run test:db` (PostgreSQL 16 local, 52 escenarios: migraciones, rollbacks, RLS, carreras, flujos) | **678 aprobadas, 0 fallidas** (escenarios 51 y 52 incluidos) |
| Escenario 52: 29 suites de módulos actuales **juntas** sobre 0001–0045 | Todas en verde (CRM, Workforce, Nómina, Libro mayor, Gastos, Cobros, Banco, Estados, Studio, Catálogo, Asistente S4, Banca, Inventario, POS, planes, equipo…) |
| `126_platform_flows.test.sql` (flujos A–H y barrido multiempresa) | En verde |
| `vitest` (lógica de la app) | 873 aprobadas |
| `e2e/public.e2e.mjs` (navegador, sin sesión: protección de todas las rutas, rutas de máquina, idioma, iPhone / iPad en páginas públicas) | 156 aprobadas |
| TypeScript, ESLint | Sin errores |
| `next build` (Next.js 16.4.5) | Correcto, sin aviso de seguridad |

Flujos obligatorios: **A** (registro → empresa → primera factura), **B** (producto → venta POS → inventario),
**C** (compra → recepción → existencias → factura del proveedor sin duplicados), **D** (factura → pago →
movimiento bancario → conciliación) en `126_platform_flows.test.sql`; **E** (empleado → asistencia → nómina) en
`80_workforce`, `102_workforce_hr` y `104_payroll` sobre la pila completa (escenario 52); **F** (asistente con
permisos y confirmaciones) en `98`, `100`, `101`, `116` sobre la pila completa.

**No ejecutado y por qué:** las pruebas de navegador **con sesión** (`e2e/*.auth.e2e.mjs`, incluidas las de
iPhone / iPad de cada módulo) necesitan PostgREST local; su descarga fue rechazada por la política del entorno.
Se ejecutaron en entregas anteriores en otro entorno (ver cada documento de módulo); la del POS nunca.
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
5. El panel carga hasta 5 000 documentos y 10 000 pagos por empresa en una consulta: correcto para clientes
   pequeños, necesita agregación en la base de datos antes de clientes grandes.
6. Moneda y zona horaria fijas (USD, Puerto Rico): no apto para clientes fuera de PR sin cambios.
7. Aplicaciones móviles no creadas; suscripciones en tiendas sin decidir.
8. Archivos de respaldo `page.tsx.before-*` / `.pre-audit-fix` en `src/app/(app)/documents/[id]/` (no se
   compilan; conviene eliminarlos en una limpieza autorizada).

## 10. Requisitos para los primeros clientes

- [ ] Autorizar y aplicar 0037–0045 en Staging; ejecutar la prueba de navegador con sesión (todas las suites `*.auth.e2e.mjs`).
- [ ] Stripe TEST: precios con las claves `businessai_*_monthly`, webhook, prueba ciclo completo (alta, cambio, fallo, cancelación).
- [ ] Clave del asistente (si se ofrece) con límite de gasto del proveedor.
- [ ] Dominio, correo transaccional y textos legales revisados.
- [ ] Copia de seguridad y punto de restauración de Production; plan de soporte.
- [ ] Clientes iniciales en Puerto Rico, en USD, con equipos probados (escáner HID, iPad/iPhone recientes).
- [ ] Sin datos de demostración en Production.
