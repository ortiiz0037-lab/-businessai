# Nómina (Payroll) — migración 0034

> **No es asesoría legal ni tributaria.** BusinessAI **no calcula impuestos ni retenciones** (ni de Puerto Rico ni federales de EE. UU.).
> El neto que muestra es *bruto − deducciones configuradas por la empresa*. Antes de pagar, un profesional debe calcular las retenciones aplicables.
> Nada se paga desde BusinessAI: "pagado" solo **registra** el pago en la contabilidad. No hay conexión con bancos.

Rutas: `/payroll` (nóminas), `/payroll/runs/[id]` (vista previa, ajustes, aprobación), `/payroll/employees` (compensación),
`/payroll/reports` (informes), `/payroll/settings` (conceptos, cuentas, licencias, impuestos). El empleado ve sus recibos en `/clock`.

## Fuentes únicas (sin datos paralelos)

| Dato | Fuente | Cómo |
|---|---|---|
| Personas | `public.employees` (Workforce) | Una línea por empleado de la frecuencia de la nómina (incluye bajas con horas en el periodo). |
| Horas | Ponches de Workforce | La app calcula regulares / extra con las reglas de Workforce (`buildReport`, `lib/workforce/hours.ts`); la base de datos **verifica** que regulares + extra = minutos de las sesiones cerradas (`wf_worked_minutes`, mismo algoritmo `start_day` / `split_midnight`). Si no cuadra → `PAYROLL_HOURS_MISMATCH`. Una sesión abierta bloquea la línea. |
| Licencias | Licencias aprobadas de Workforce | Solo los tipos marcados como pagados en la configuración (ninguno por defecto), por el tiempo programado, a la tarifa regular. |
| Contabilidad | Libro mayor existente (`ledger_post`) | Ningún libro paralelo; cada asiento es balanceado, numerado y respeta los cierres de periodo. |
| Recibos | Motor de Document Studio (`layout()` + `buildPdf()`) | PDF generado al vuelo; no se guardan copias. |

## Compensación

- Historial **solo de inserción** (`employee_compensation`): tarifa por hora o salario anual, frecuencia (semanal, cada dos semanas, quincenal, mensual), fecha efectiva, motivo, quién y cuándo.
- Se usa la compensación vigente **al cierre del periodo** (la fecha efectiva más reciente ≤ cierre; empate → la registrada después). **No hay prorrateo** dentro del periodo.
- Un cambio con fecha dentro de un periodo ya aprobado se rechaza (usar una nómina de corrección).
- Exento / no exento: un asalariado **no exento** con horas extra necesita una tarifa de horas extra **explícita**; el sistema nunca la deriva. Sin ella la línea queda bloqueada.
- 0034 copia `employees.hourly_rate` existentes al historial (frecuencia cada dos semanas, motivo "migración").
- Privacidad: `payroll.view` (propietario y administradores) y cada empleado su propio historial. Los miembros no ven nada.

## Cálculo (céntimos exactos)

Todo en **céntimos enteros** (`bigint`); cada componente se redondea **una sola vez**, mitad lejos de cero (`payroll_round`, igual en `lib/payroll/core.ts`).

| Componente | Fórmula |
|---|---|
| Regular (por hora) | minutos regulares × tarifa / 60 |
| Extra | minutos extra × tarifa × multiplicador de Workforce / 60 (asalariado no exento: tarifa explícita) |
| Licencia pagada | minutos programados × tarifa / 60 |
| Salario | salario anual / periodos por año (52, 26, 24, 12) |
| Conceptos fijos | monto por periodo (bonificaciones, comisiones, deducciones) |
| Deducción % | bruto × % (en puntos básicos) |
| Bruto | regular + extra + licencia + salario + otros ingresos |
| Neto | bruto − deducciones (nunca negativo: bloquea la línea) |

Las identidades bruto/neto también son `CHECK` en `payroll_lines`. Ejemplo verificado en el E2E: 16:00 h × $15.25 = $244.00; 2:30 h extra × 1.5 = $57.1875 → $57.19; bono $50.00; bruto $351.19; 2.5 % = $8.77975 → $8.78; neto $342.41.

## Ciclo de vida

`draft` → (preparar / vista previa / ajustes) → `approved` → `paid` → `reversed`; un borrador se puede `discarded`.

- **Preparar** recalcula todas las líneas; cualquier problema bloqueante (sin compensación, sesión abierta, horas que no cuadran, tarifa de extra faltante, neto negativo, reglas tributarias no disponibles) impide aprobar. Avisos no bloqueantes: `rate_changed_in_period` (la tarifa cambió dentro del periodo; se usa la del cierre) y `partial_period_review` (ingreso o baja dentro del periodo: revisar, no se prorratea).
- **Versión revisada**: cada ajuste incrementa `version`; aprobar exige `prepared_version = version = expected_version`. Así nunca se aprueba una vista previa obsoleta (la UI lo advierte).
- **Aprobar** (`payroll.approve`, solo propietario): bloquea la nómina y publica el asiento. Opción de **segundo aprobador**: quien preparó o cobra en la nómina no puede aprobarla.
- **Idempotencia**: crear usa una clave única; aprobar/pagar/revertir comprueban el estado con bloqueo de fila (pruebas de concurrencia en `105_payroll_race.sh`). Una sola nómina regular vigente por periodo y frecuencia.
- **Inmutable tras aprobar**: un trigger impide modificar líneas, conceptos o importes; no se puede escribir directamente en las tablas (solo funciones).
- **Correcciones**: nómina de corrección construida con ajustes, o reversión + nueva nómina. Todo queda en `payroll_events` (auditoría).

## Asientos contables

| Evento | Fuente | Débito | Crédito |
|---|---|---|---|
| Aprobación | `payroll` | 6100 Gasto de nómina (bruto) | 2200 Salarios por pagar (neto), 2210 Deducciones por pagar (deducciones) |
| Pago registrado | `payroll_payment` | 2200 | 1010 Banco |
| Reversión del pago | `payroll_payment_void` | espejo del pago | |
| Reversión | `payroll_void` | espejo de la aprobación | |

Las cuentas 2200/2210 se crean al crear la primera nómina; se pueden cambiar en la configuración. Los asientos originales nunca se borran.

## Impuestos — arquitectura, desactivada

`payroll_tax_rules` contiene marcadores **sin tasas** y en estado `disabled`: retención de contribución sobre ingresos de PR, otras aportaciones de PR, retención federal y contribuciones federales sobre nómina.
`payroll_prepare` se **niega** a correr (`PAYROLL_TAX_ENGINE_NOT_AVAILABLE`) si alguna regla estuviera aprobada antes de que exista un cálculo verificado.
Cada línea tiene `tax_status = 'not_calculated'`; la UI, los recibos y el CSV lo dicen explícitamente. No se inventaron tasas, topes ni obligaciones.

## Informes y recibos

- Por periodo y por empleado: horas, bruto, deducciones, neto, historial de pagos. CSV por nómina o por rango (`/api/payroll/export`), con la nota de impuestos no calculados.
- Recibo PDF (`/api/payroll/payslips/[lineId]`): solo nóminas aprobadas o pagadas; el propietario/administradores o el propio empleado; cualquier otro recibe 404.

## Permisos y plan

| Permiso | Roles |
|---|---|
| `payroll.view` | owner, admin |
| `payroll.manage` | owner, admin |
| `payroll.approve` | owner |

Función de plan `payroll` (Pro / Premium) vía `payroll_can`. Aislamiento por empresa con RLS.

## Pruebas

- SQL: `supabase/tests/local/104_payroll.test.sql` (importes calculados a mano, ciclo completo, permisos, bloqueos, asientos, rollback).
- Concurrencia: `105_payroll_race.sh` (aprobar, pagar, crear, preparar/aprobar simultáneos).
- Harness: escenario 40 en `supabase/tests/local/run.sh` (incluye regresión de Workforce/Finance y huella del rollback).
- Unitarias: `tests/payroll.test.ts`. E2E: `npm run test:e2e:payroll` (`e2e/payroll.auth.e2e.mjs`).

## Limitaciones conocidas / pendiente

- Sin cálculo de impuestos ni formularios (499R-2/W-2, 941, etc.): requiere reglas verificadas por un profesional y una aprobación registrada.
- Sin prorrateo de salario por cambios a mitad de periodo ni por ingreso/baja.
- Sin depósito directo ni pagos: el pago solo se registra.
- Sin acumulados anuales (YTD) en el recibo.
