# Plan de migración de Production — documento de revisión (2026-11-18)

> **Solo revisión. Nada de este plan se ha ejecutado ni se ejecutará sin una autorización escrita
> por cada paso.** No se ha conectado a Production, no se ha leído ni escrito su base de datos, y
> ningún workflow del repositorio puede hacerlo hoy (todos rechazan el ref de Production por diseño).

Proyecto Production: `businessai-dev`, ref `rugqcumiuqrjbfwpuslm` (Supabase, PostgreSQL 17.11), app en
Vercel Production (`main`), usuarios y datos reales. Procedimientos detallados ya existentes que este plan
ordena y completa: `supabase/RUNBOOK.md` §1–§9 (respaldo, comprobaciones, 0005–0011, decisión de 0010) y §10
(rollbacks 0005–0045); `docs/STAGING_STATUS.md` §8 (procedimiento seguido en Staging).

## 1. Punto de partida

| | Production (inspección del 2026-11-08) | Staging (hoy) |
|---|---|---|
| Migraciones | 0001–0004 aplicadas; **0005–0045 no** (39 archivos) | 0001–0045 (43 registradas) |
| Forma | Políticas antiguas (12 de tabla, 11 de Storage), `TRUNCATE` concedido, `can_edit_company_profile` ejecutable por `anon`, FK de pagos en cascada | Construida desde el repositorio |
| Registro de migraciones | No existe (`ba_meta` solo lo crea el flujo de Staging) | `ba_meta.applied_migrations` |
| Datos | Reales | De prueba |
| App | Código de `main` (anterior a PR #1) | PR #1 en la Preview |

**La inspección tiene 10 días.** Lo primero es repetirla (solo lectura, §4) y parar si algo difiere.

## 2. Evidencia disponible

- **Ensayo local del camino completo de Production** (escenario 53 de `supabase/tests/local/run.sh`, nuevo hoy):
  sobre la forma inspeccionada **con datos escritos por la app actual**, las 39 migraciones aplican en el orden
  `ORDER`; todas se detectan como aplicadas; `verify_0014a` OK; matriz de 153 filas; empresas, miembros,
  clientes, documentos, pagos, totales y numeración sin cambios; repetir la secuencia completa no cambia nada
  (reintento seguro); una empresa sin suscripción lee pero no crea (decisión §5.1); aislamiento; suites RLS
  (75) y de flujos de la plataforma (75) en verde. **14 / 0**.
- Staging: 0037–0045 aplicadas una a una con respaldo cifrado y restauración verificada tras cada una.
- Escenarios 8, 12, 13 y 21 (forma inspeccionada): orden seguro 0005–0008, compatibilidad de la app antigua y
  nueva en cada paso, rollbacks exactos, inspecciones de solo lectura.
- **Lo que no se ha probado**: una copia real de los datos de Production (volumen, filas atípicas) y la app de
  `main` (antigua) funcionando sobre 0010–0045 (ver riesgo R2).

## 3. Decisiones previas (del propietario, antes de cualquier ejecución)

1. **Empresas existentes sin suscripción** (`RUNBOOK.md` §9.0): con 0010 dejan de poder crear clientes y
   documentos (leen, editan, imprimen y registran pagos). Opciones: (a) aplicar 0010/0011 solo cuando Stripe LIVE
   y el alta estén listos y comunicados; (b) migración de datos revisada que les dé un periodo de gracia;
   (c) posponer 0010/0011. `inspect_0010_impact.sql` da los recuentos (sin nombres ni importes).
2. **Forma de ejecución** (§6): manual en el SQL Editor (procedimiento actual) o un flujo de Production nuevo con
   aprobación obligatoria. Recomendado: el flujo nuevo (39 archivos a mano es propenso a errores).
3. **Ventana de mantenimiento** y aviso a los usuarios actuales.
4. **Stripe LIVE**: productos y precios `businessai_{basic,pro,premium}_monthly`, webhook de Production,
   Customer Portal. Autorización independiente (no forma parte de este plan).
5. Variables de Vercel Production: `APP_ENV=production`, `NEXT_PUBLIC_APP_URL` (obligatoria), Supabase de
   Production, `STRIPE_*` LIVE, `SUPABASE_SERVICE_ROLE_KEY`; SMTP propio en Supabase Auth (§8).

## 4. Comprobaciones previas (solo lectura, en Production)

Todas existen en `supabase/inspect/` y se han probado sobre la forma inspeccionada (escenario 21). Guardar las
salidas (CSV) con el respaldo.

| Consulta | Resultado para seguir |
|---|---|
| `inspect_migration_state.sql` | `0001–0004 applied`, el resto `not applied`, **ninguna `PARTIAL — review`**, `staging bookkeeping` = `absent` |
| `inspect_security_baseline.sql` + comparación con `inspected_expectations.json` | Igual a la inspección del 2026-11-08 (si no, revisar antes de seguir) |
| `inspect_0007_preview.sql` | `dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0` |
| `inspect_relationship_integrity.sql` | `0` en las 4 primeras columnas |
| `inspect_storage_policies.sql` | Guardado (lo necesita el rollback de 0007) |
| `inspect_0010_impact.sql` | `plans_breaking_0010_fk = 0`; `BLOCKED_after_0010` cubierto por la decisión 3.1 |
| `inspect_definer_functions.sql` | Código de `can_edit_company_profile` guardado (0008) |
| `verify_after_migrations.sql` | Línea base `0,12,4,2,t,12,11,0,,,f,t` |

## 5. Respaldo y punto de restauración

1. Copia de la plataforma Supabase (o PITR) inmediatamente antes; anotar la hora.
2. Volcado lógico propio **cifrado**, con restauración real verificada tabla por tabla (como `backup.sh` en
   Staging). Hoy `backup.sh` rechaza Production a propósito: requiere una versión de Production autorizada
   (secretos `PRODUCTION_DB_URL` y una clave de cifrado distinta de la de Staging) o hacerlo en el equipo del
   propietario (`RUNBOOK.md` §1b).
3. **Ensayo con la copia**: restaurar el volcado en una base desechable y ejecutar la secuencia completa
   (como el escenario 53, pero con los datos reales). Es la única forma de descartar filas atípicas.
4. Respaldo de Storage: no necesario (las migraciones cambian políticas, no archivos).

## 6. Forma de ejecución

| | A. Manual (procedimiento actual) | B. Flujo `production-migrate` (recomendado, **no construido**) |
|---|---|---|
| Cómo | Pegar cada archivo en el SQL Editor | Una migración por ejecución, con el nombre exacto como entrada, igual que en Staging |
| Protección | Disciplina del operador | GitHub Environment `production` con **aprobación obligatoria del propietario**, ref fijado, ensayo (dry run) que debe listar exactamente esa migración, registro en `ba_meta.applied_migrations`, comprobaciones y respaldo cifrado tras cada paso |
| Riesgo | Pegar un archivo equivocado o a medias (cada archivo es una transacción: falla sin cambios) | Configuración inicial; requiere autorización para crearlo y los secretos |

## 7. Secuencia propuesta

El orden es el de `ORDER` en `scripts/staging/apply-migrations.sh` (el mismo usado en Staging y en el escenario 53).

**Fase 1 · Seguridad** (compatible con el código actual de `main`, escenario 12): `0005` → `0007` → `0009` →
`0006` → `0008`, con `verify_after_migrations.sql` tras cada paso (valores de `RUNBOOK.md` §3). Puede hacerse
antes y por separado.

**Fase 2 · Plataforma** (una ventana de mantenimiento): `0010` → `0011` → `0014a` → `0015` … `0045`, y a
continuación **desplegar el código de PR #1** (merge a `main`, autorización aparte). El código nuevo necesita el
esquema completo; el antiguo no se ha probado sobre 0010–0045 (R2), por eso migraciones y despliegue van en la
misma ventana, con la app en mantenimiento.

Tras cada migración: `inspect_migration_state.sql` (aplicada hasta ese paso, el resto no), comprobaciones del
paso (como `scripts/staging/verify-step.sh`: matriz 130 tras 0037–0038, 135 tras 0039–0042, 143 tras 0043, 153
tras 0044–0045; objetos creados; buckets privados), recuento de filas de negocio sin cambios. Al final:
`verify_0014a` OK y matriz de 153.

**Fase 3 · Verificación** (con la app nueva desplegada): prueba de humo con una empresa de prueba propia
(registro, confirmación de correo, empresa, factura, pago, suscripción LIVE con importe mínimo y reembolso si
se autoriza), revisión de registros de Vercel / Supabase y del webhook de Stripe.

## 8. Correo de autenticación en Production

Supabase solo envía correos a direcciones externas con **SMTP propio** (el servidor por defecto está limitado
al equipo del proyecto y a pocos envíos por hora). Antes de abrir el registro: configurar SMTP, la URL del sitio
y las URL de redirección permitidas (dominio de Production) en Auth, y las plantillas de confirmación y
recuperación con el enlace `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=…` (la app admite
también el enlace por defecto en el mismo navegador). La verificación equivalente en Staging está en
`scripts/staging/e2e-auth-email.mjs`.

## 9. Recuperación

| Situación | Acción |
|---|---|
| Una migración falla | Nada cambió (transacción). Guardar el mensaje `BA…`, parar, revisar. |
| La app falla tras una migración, sin datos nuevos todavía | Rollback de esa migración (`supabase/rollback/NNNN_rollback.sql`) y, si hace falta, las anteriores en orden inverso. Los rollbacks se niegan si sus tablas ya tienen datos (protección deliberada). |
| Falla tras el despliegue | Revertir el despliegue en Vercel (instantáneo); la base se queda. |
| Datos dañados o rollback imposible | Restaurar el respaldo del paso 5 (pérdida = lo escrito después del respaldo). |

## 10. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Empresas actuales sin suscripción quedan sin crear clientes / documentos (0010) | Decisión 3.1 antes de la fase 2; comunicación |
| R2 | El código antiguo de `main` no se ha probado sobre 0010–0045 | Misma ventana para migrar y desplegar; app en mantenimiento |
| R3 | Filas atípicas en los datos reales (no presentes en la forma inspeccionada) | Ensayo con una copia restaurada (5.3); cada migración aborta sin cambios si sus comprobaciones fallan |
| R4 | Tablas ocupadas | `lock_timeout` 5 s: aborta sin cambios y se reintenta |
| R5 | Correos de Auth no llegan | SMTP propio y prueba de humo antes de abrir el registro |
| R6 | Stripe LIVE mal configurado | Autorización y verificación propias, con el mismo flujo probado en TEST |

## 11. Autorizaciones necesarias (cada una por separado)

1. Repetir las inspecciones de solo lectura en Production (§4).
2. Respaldo de Production (plataforma + volcado cifrado) y, si se elige, construir la versión de Production de
   `backup.sh` con sus secretos.
3. Ensayo de la secuencia sobre una copia restaurada de Production (base desechable).
4. Forma de ejecución (§6) y, si es B, construir el flujo y su Environment con aprobación.
5. Fase 1, migración por migración.
6. Decisión 3.1 y fase 2, migración por migración, con la ventana y el despliegue de PR #1.
7. Stripe LIVE, SMTP y variables de Vercel Production.
