# CRM — migración 0035

Ciclo de vida del cliente: prospecto → oportunidad → cotización → factura → cobro → seguimiento, **sobre las tablas que ya existían** (sin datos paralelos).
Rutas: `/crm` (resumen), `/crm/pipeline` (tablero), `/crm/opportunities` (+ `/[id]`), `/crm/activities` (agenda), `/crm/settings`; el perfil completo está en `/clients/[id]`.

## Revisión previa (estado antes de 0035)

| Ya existía (se reutiliza) | No existía (se crea) |
|---|---|
| `clients` (0002), archivo y bloqueo de borrado con historial + `client_events` (0019) | Contactos, etiquetas, pipeline, oportunidades, actividades |
| Permisos `clients.*`, `documents.*`, `receivables.*` (0014a, 0025) | Permisos `crm.*` y `branches.manage` |
| Documentos: numeración, ciclo de cotización enviada → aceptada / rechazada (0015) | Conversión cotización → factura |
| Asiento de la factura **al enviarla** (trigger 0023) | Sucursales: 0017 solo contaba una tabla `branches` inexistente |
| Saldos y antigüedad: `ar_invoice_balances`, `ar_aging` (0025) | Propuestas CRM del asistente |
| Document Studio (0028), asistente con propuestas confirmadas (0029/0030) | |

Riesgos evaluados:
- Cambiar la política de lectura de `clients` afecta documentos y finanzas. Por eso la restricción por sucursal es **opcional y está desactivada por defecto**: con la configuración inicial el comportamiento no cambia. Se volvieron a correr todas las suites de documentos, libro mayor, cuentas por cobrar, Studio, inteligencia, RR. HH. y nómina con 0035.
- Las propuestas del asistente tocan 0029/0030. El rollback restaura la función original y se niega a ejecutarse si existen propuestas CRM.
- La conversión no debe duplicar facturas. Se bloquea la fila de la cotización, se comprueba que no haya una factura vigente y se usa una clave de idempotencia.
- Observación sin cambios: hay 5 copias de respaldo de la página de documentos versionadas en git (`src/app/(app)/documents/[id]/page.tsx.before-*`, `.pre-audit-fix`). No se borraron porque esta entrega no lo autoriza.

## Modelo

- **Clientes y prospectos.** Una sola tabla, `clients`, con columnas nuevas:
  - `kind`: persona o empresa;
  - `legal_name`;
  - `tax_id` (opcional);
  - `lifecycle`: prospecto nuevo, prospecto, cliente o ex cliente;
  - `source`;
  - `owner_id`: responsable, que debe ser miembro activo;
  - `branch_id`.

  El estado activo / inactivo y el archivo siguen igual que en 0019. Un cliente archivado conserva sus documentos, pagos, asientos y oportunidades, pero no recibe documentos ni oportunidades nuevas.
- **Contactos** (`crm_contacts`): pertenecen a un cliente y solo uno puede ser el principal. Se archivan, no se borran.
- **Etiquetas** (`crm_tags`, `crm_client_tags`): un catálogo por empresa con nombres únicos sin distinguir mayúsculas y 6 colores.
- **Duplicados** (`crm_find_duplicates`): compara correo (minúsculas y sin espacios), teléfono (últimos 10 dígitos), identificación fiscal (sin signos) y nombre (nombre, nombre comercial o legal). Solo busca entre los clientes que el usuario puede ver. Al crear un cliente, la app muestra los candidatos y exige confirmar «Crear de todos modos».
- **Pipeline** (`crm_pipeline_stages`), configurable:
  - Etapas iniciales y probabilidades: Nuevo prospecto 10 %, Contactado 20 %, Calificado 40 %, Propuesta enviada 60 %, Negociación 80 %, Ganado 100 %, Perdido 0 %.
  - Se pueden cambiar nombres (ES/EN), orden y probabilidades, y añadir etapas abiertas (hasta 20 en total).
  - Ganado y Perdido son fijos.
  - No se puede desactivar una etapa que tenga oportunidades abiertas.
- **Oportunidades** (`crm_opportunities`):
  - Cliente o prospecto, contacto, nombre, descripción.
  - **Valor en centavos enteros**, probabilidad en puntos básicos (de la etapa o definida a mano).
  - Cierre estimado, responsable, origen, sucursal, motivo de pérdida (obligatorio al perder).
  - Versión para concurrencia; clave de idempotencia.
  - Al ganar, el prospecto pasa a cliente; con su primera oportunidad, un prospecto nuevo pasa a prospecto.
- **Valor ponderado**: Σ(valor × probabilidad) / 10 000, redondeado **una sola vez**, mitad lejos de cero. Se calcula igual en SQL (`crm_pipeline_summary`) y en TypeScript (`weightedCents`). Los totales salen de las filas que el usuario puede ver (RLS).
- **Actividades** (`crm_activities`):
  - Tipos: llamada, email registrado, reunión, tarea, nota, recordatorio.
  - Estado: pendiente, completada o cancelada. Las notas se guardan completadas.
  - Tareas y recordatorios exigen fecha. Responsable (miembro), dirección entrante / saliente, resultado.
  - Un seguimiento está **atrasado** si sigue pendiente y ya venció.
  - **Registrar un email no lo envía**: la interfaz lo dice en cada email registrado. No hay cron, notificaciones ni envíos.
- **Documentos**:
  - `crm_opportunity_documents` asocia documentos existentes del mismo cliente.
  - `crm_convert_quote` convierte una cotización **aceptada** en una factura **borrador** con las mismas líneas, totales, idioma y cliente, mediante un insert normal en `documents`. Se aplican la numeración, los límites del plan y la regla de cliente archivado.
  - Solo puede haber una factura vigente por cotización (`crm_quote_conversions`); si se anula, la cotización se puede facturar otra vez.
  - **El libro mayor no se toca**: la factura se contabiliza solo cuando se envía por el flujo existente.
- **Finanzas**: el perfil del cliente **lee** `ar_invoice_balances` y `ar_aging`, que requieren `receivables.view`. El CRM no guarda saldos.
- **Auditoría** (`crm_events`):
  - Quién, cuándo y qué cambió, con los valores anteriores y nuevos (recortados a 300 caracteres), para clientes, contactos, etiquetas, etapas, oportunidades, actividades, vínculos, conversiones, sucursales y configuración.
  - Nadie la modifica por la API.
  - Su lectura sigue la visibilidad del registro.

## Sucursales (preparación)

- `branches`: código único por empresa, nombre, dirección, archivo. Usa el límite del plan ya existente (`assert_feature_available('branches')`): Pro 3, Premium 10, Basic 1.
- `branch_members`: qué miembros pertenecen a cada sucursal. `crm_client_branches`: clientes compartidos con otras sucursales.
- `crm_settings.branch_scoping` (desactivado por defecto): un miembro asignado a sucursales solo ve los clientes y oportunidades de sus sucursales. Propietario y administradores (`crm.view_all`) ven todo; también lo ve quien no tiene sucursal asignada. Los clientes sin sucursal son compartidos.
- `share_clients_across_branches` (activado por defecto): los clientes de otra sucursal se pueden **leer**, mientras que las oportunidades siguen separadas. Si se desactiva, el cliente se comparte uno por uno.
- Todavía no existe un módulo de sucursales completo (inventario, cajas, horarios). Este es el modelo mínimo que necesita el CRM.

## Permisos

| Permiso | Owner | Admin | Member |
|---|---|---|---|
| `crm.view` (ver CRM) | ✓ | ✓ | ✓ |
| `crm.manage` (crear y editar oportunidades, actividades, contactos, etiquetar) | ✓ | ✓ | ✓ |
| `crm.view_all` (ver todo, no solo lo propio) | ✓ | ✓ | — |
| `crm.configure` (pipeline, etiquetas, visibilidad, compartir clientes) | ✓ | ✓ | — |
| `branches.manage` | ✓ | ✓ | — |

- Un miembro ve las oportunidades que creó o tiene asignadas. Ve las actividades asignadas a él o creadas por él, las de sus oportunidades y las que están ligadas solo a un cliente que puede ver.
- Los permisos se evalúan **por empresa** (`has_permission(company_id, …)`): ser administrador de otra empresa no da acceso.
- Los empleados sin membresía (solo reloj) no ven nada del CRM.
- Ninguna tabla nueva admite escrituras directas, ni siquiera del propietario: todo pasa por funciones `SECURITY DEFINER` que verifican el permiso, la empresa, los vínculos (cliente, contacto, oportunidad y responsable de la misma empresa), la versión y la idempotencia.

## Asistente

- **Lecturas**, que pasan por RLS:
  - `get_crm_pipeline`: totales por etapa y valor ponderado;
  - `list_opportunities`;
  - `list_crm_followups`: atrasados y próximos.
- **Escritura**: `propose_crm_activity` solo **propone** una nota o tarea. Se guarda únicamente cuando el usuario pulsa Confirmar, mediante `crm_save_activity`, con el id de la acción como clave de idempotencia (sin duplicados al reintentar) y origen «asistente».
- Requisitos: `crm.view` para leer y `crm.manage` para proponer. Sin SQL; la empresa siempre sale de la sesión.

## Pruebas

| Prueba | Archivo | Qué cubre |
|---|---|---|
| SQL | `supabase/tests/local/106_crm.test.sql` (95 aserciones) | Permisos, campos CRM e historial, duplicados, contactos, etiquetas, pipeline y redondeo, visibilidad, etapas, actividades, conversión, cuentas por cobrar, cliente archivado, sucursales y alcance, asistente |
| Concurrencia | `107_crm_race.sh` | Conversión doble, creación con la misma clave, movimientos con la misma versión, actividad duplicada |
| Harness | Escenario 41 | Aplica y reaplica 0035, `verify_0014a`, regresiones (79, 74, 84, 88, 94, 98, 102, 104), rollback con huella idéntica y rechazo con datos |
| Unitarias | `tests/crm.test.ts` y `tests/assistant.test.ts` | Cálculos, mensajes y herramientas del asistente |
| E2E | `npm run test:e2e:crm` (`e2e/crm.auth.e2e.mjs`) | Flujo completo en navegador |

## Limitaciones conocidas

- No hay envío de emails, recordatorios automáticos, notificaciones ni sincronización de calendario: las actividades solo se registran.
- El tablero se mueve con un selector por tarjeta; no hay arrastrar y soltar.
- La detección de duplicados es exacta tras normalizar; no hay coincidencia aproximada (errores de escritura, acentos).
- No hay importación ni exportación masiva de clientes del CRM.
- Las sucursales son un modelo mínimo para el CRM; el módulo completo de sucursales está pendiente.
- Las conversiones solo parten de cotizaciones aceptadas; no hay facturación parcial de una cotización.
