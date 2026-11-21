# Preparación del lanzamiento — Entrega 15.1 (2026-11-14)

> **El lanzamiento NO está listo.** Staging está aislado y verificado, pero no
> tiene los módulos 0015–0035. Production no ha recibido ninguna de las
> migraciones de este trabajo ni la configuración de Stripe live. No hay
> monitoreo de errores. Detalle en §4.

## 1. Estado comprobado hoy

Comprobación de solo lectura `staging:check` sobre el PR #1: [Staging run #32](https://github.com/ortiiz0037-lab/-businessai/actions/runs/43566801577), commit `231237a`, éxito.

| # | Comprobación | Resultado | Evidencia (registro del run) |
|---|---|---|---|
| 1 | La Preview corresponde al último commit | ✅ | Estado Vercel de `231237a`: *Deployment has completed* (06:29 UTC). Última preview READY de la rama: 06:29:10, construida **después** de fijar las variables de Supabase de Preview (las `NEXT_PUBLIC_*` se incrustan al compilar) |
| 2 | La Preview usa solo Supabase Staging | ✅ | `Preview NEXT_PUBLIC_SUPABASE_URL → project wbfpvxptoujgvflljasc (targets: preview)` · `PASS Preview points to the STAGING project only` · Staging acepta la publishable y la service role de Preview · `RESULT: Preview isolated on staging` |
| 3 | Production conserva variables independientes | ✅ | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y `SUPABASE_SERVICE_ROLE_KEY`: «Preview has its own entry (not shared with Production)». El plan de `vercel-env` solo propone `update → preview` para las 7 variables; ninguna `split` ⇒ no hay entradas compartidas |
| 4 | Stripe en Preview usa TEST | ✅ (con matiz) | El workflow solo escribe en Preview el secreto `STRIPE_TEST_SECRET_KEY` y los scripts rechazan `sk_live_`. El plan de Stripe vio en el modo test los precios 1999 / 3999 / 5999 y el endpoint de webhook de staging. El 10-nov, la facturación de punta a punta con relojes de Stripe TEST pasó **a través de la Preview**. Vercel no deja leer el valor sensible: la prueba del modo es por comportamiento |
| 5 | Sin variables compartidas peligrosas | ✅ | Igual que el punto 3; además `SPLIT_SHARED=true` ya separó en su día las entradas comunes sin tocar Production |
| 6 | Entorno protegido | ✅ | `Preview without bypass: HTTP 302 → protected by Vercel Authentication`. El bypass solo funciona con el secreto. `/login` a través del bypass: 200 |
| 7 | Sin errores de despliegue | ✅ | Vercel: *Deployment has completed* · checks del PR en verde (`test`, Vercel) |

Además:

- **Staging:**
  - marca de entorno `staging`;
  - `verify_0014a: OK`;
  - Storage con solo las 5 políticas del repositorio;
  - registro abierto, con confirmación de email obligatoria;
  - 2 usuarios en Auth.
- **Pendientes en Staging:** «No pending migrations» y, en espera de aprobación, **0015 … 0035**.
- **Aviso no bloqueante:** la contraseña de `STAGING_DB_URL` contiene secuencias `%XX`. Solo es correcto si la contraseña real las tiene codificadas; las migraciones de staging conectaron bien, así que lo está.

## 2. Migraciones 0015–0035: validación (sin ejecutar nada remoto)

**DRY_RUN real sobre Staging** (run #32, solo lectura):
- conecta a `wbfpvxptoujgvflljasc` y encuentra la marca `staging`;
- nada pendiente sin aprobación;
- retenidas las 21, de `0015_documents_lifecycle` a `0035_crm`;
- `DRY_RUN=1: nothing applied`.

**Ensayo local completo:** `npm run staging:rehearse` (`scripts/staging/rehearse-modules.sh`) resultó **20/0**. Usa el `apply-migrations.sh` **real** con los refs **reales** fijados, sobre una base local con la forma exacta de Staging (12 migraciones + marca + datos ficticios como los que dejan las pruebas).

- **Guardas.** Con cada una de estas condiciones el script se niega y no cambia nada:
  - el ref de producción aparece en la URL;
  - el ref fijado es otro;
  - la base tiene empresas y no tiene marca de staging (forma de Production);
  - el usuario no es `postgres.<ref de staging>`.
- **DRY_RUN con `APPROVED_DRAFTS`:**
  - `Pending:` lista exactamente 0015 … 0035, en orden;
  - huella del catálogo idéntica (nada escrito);
  - sin aprobación siguen retenidas.
- **Aplicación:**
  - las 21 se aplican en orden y queda «up to date and verified»;
  - la confirmación da 33 registradas y nada pendiente;
  - `verify_0014a: OK`;
  - 13 políticas de Storage: 5 del repositorio y 8 limitadas a su propio bucket (Finance-attachments, Studio-assets, HR-documents).
- **Datos existentes:**
  - empresas, clientes, documentos, pagos y membresías intactos;
  - el número de la factura antigua se conserva;
  - RLS: otra empresa no ve nada.
- **Rollbacks** en orden inverso (0035 → 0015) sobre la base migrada: los 21 se ejecutan y nunca borran documentos de negocio. Cada uno se niega solo si hay datos de su módulo (probado por separado en el harness, escenarios 22–41).

**Orden y dependencias:** el orden lo define `ORDER` en `scripts/staging/apply-migrations.sh`. Cada migración comprueba al inicio que existen sus prerrequisitos, por ejemplo `BA0035: migrations 0019, 0023, 0025 and 0030 must be applied first`. El harness local (493 comprobaciones) aplica la cadena completa y la reaplica.

**Qué podría fallar en el proyecto real** (no se reproduce en local):
- **Bloqueos:** `lock_timeout` de 5 s; con tráfico en Staging una migración se detiene sin cambios y basta repetir.
- **Extensiones:** `pgcrypto` / `gen_random_uuid` están disponibles en Supabase.
- **Usuarios de prueba:** los que ya existen en Staging no afectan, porque los datos se conservan (§2, datos existentes).

## 3. Plan de activación de todos los módulos en Staging

1. **Aprobación del propietario** para aplicar 0015–0035 en Staging (ver §5, A).
2. **Aplicar:** DRY_RUN con `APPROVED_DRAFTS`, luego aplicar y confirmar con `EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1`. La salida esperada coincide con el ensayo local: 33 registradas, `verify_0014a: OK`, 13 políticas de Storage.
3. **`staging:test`:** humo, facturación Stripe TEST, RLS (`tests/rls*.test.ts`) y capturas reales en iPhone, iPad y escritorio.
4. **`staging:demo`:** empresa ficticia «BusinessAI Demo (QA)» con clientes y documentos `DEMO-…`.
   - Los datos demo de Workforce, Payroll, CRM, Finance y Studio todavía **no existen** en `demo-data.mjs`.
   - Hay que crearlos desde la interfaz como propietario de la empresa demo, siguiendo los mismos pasos que los E2E locales (`e2e/*.auth.e2e.mjs`).
   - O ampliar `demo-data.mjs`; queda pendiente y necesita tu visto bueno.
5. **Recorrido manual en iPhone**, módulo por módulo, con la lista de §4 (25 min). Los módulos deben pasar de «no activado» a funcionar.
6. **Asistente (opcional en Staging):** `ANTHROPIC_API_KEY` y `ASSISTANT_SERVER_KEYS` **solo en Preview**, y registrar la clave de servidor en Staging (`docs/INTELLIGENCE.md`).

## 4. Bloqueos para el lanzamiento público

| Área | Estado | Bloqueo exacto |
|---|---|---|
| **Production: base de datos** | ❌ | No consta como aplicada ni verificada en `rugqcumiuqrjbfwpuslm` ninguna migración de este trabajo (0005–0035; `MIGRATIONS.md`: «Production: ninguna de estas migraciones se ha aplicado»). Hace falta ejecutar en el SQL Editor de Production `supabase/inspect/inspect_migration_state.sql` (solo lectura) y seguir `RUNBOOK.md` con respaldo previo. Sin esto, Production queda con el código nuevo sobre un esquema viejo |
| **Production: Stripe live** | ❌ | Productos y precios con las mismas *lookup keys*, Customer Portal y endpoint de webhook live. Variables `STRIPE_*` live solo en Production. No se ha hecho (no autorizado) |
| **Production: variables** | ❌ | `APP_ENV=production` y `NEXT_PUBLIC_APP_URL` (dominio; **obligatoria** para los correos de recuperación) solo en Production; revisar que no haya entradas compartidas con Preview |
| Registro y autenticación | ⚠️ | Probado en Staging (11-10). Falta en Production: Site URL y Redirect URLs del dominio, plantilla de confirmación (`/auth/confirm`) y remitente SMTP propio. El SMTP por defecto de Supabase tiene un límite bajo de correos por hora: **bloquea** el lanzamiento público |
| Recuperación de contraseña | ⚠️ | Rutas `forgot-password` / `reset-password` con E2E del enlace inválido. Falta una prueba real con correo en Staging y la configuración de Production (`NEXT_PUBLIC_APP_URL`, plantilla, SMTP) |
| Suscripciones Stripe TEST | ✅ en Staging | Facturación de punta a punta en verde (11-10): prueba de 7 días, fallo, cancelación, rechazo y webhooks. Repetir tras migrar 0015–0035, que incluye 0016 (*billing hardening*) |
| Límites Basic / Pro / Premium | ⚠️ | Usuarios y documentos (0011) ya activos en Staging. Empleados, sucursales y nómina por plan llegan con 0017 / 0020 / 0034 (sin aplicar). Hay que verificar cada límite en Staging después de migrar |
| Finance y contabilidad | ⚠️ | Locales: SQL y E2E en verde (85). Staging: «no activado» hasta 0023–0027 |
| CRM | ⚠️ | Local 57/0 y SQL 95/0. Staging: falta 0035 |
| Document Studio | ⚠️ | Local 51/0 y auditoría visual 76/0. Staging: falta 0028 |
| Workforce | ⚠️ | Local 53/0. Staging: faltan 0020–0022 y 0033 |
| Payroll | ⚠️ | Local 41/0; **sin cálculo de impuestos** (desactivado a propósito; debe decirse en la oferta). Staging: falta 0034 |
| BusinessAI Assistant | ⚠️ | Local 80/0 y benchmark al 100 %. Staging y Production: faltan 0029–0032, la clave del proveedor y la clave de servidor. Hay que decidir si se lanza con el asistente o sin él |
| Seguridad multiempresa | ✅ local / ⚠️ remoto | RLS en Staging probado (11-10) para la base. Los módulos nuevos solo están probados en local (harness 493/0, E2E de aislamiento). Repetir RLS en Staging tras migrar |
| Experiencia móvil | ⚠️ | Capturas reales de la Preview en iPhone y iPad (11-10, módulos base). Los módulos nuevos solo están probados en local (sin desbordamiento). Falta el recorrido real tras migrar |
| Errores y monitoreo | ❌ | **No hay monitoreo de errores**: ni Sentry ni equivalente, ni `instrumentation.ts`, ni alertas. Solo los registros de Vercel. Necesario al menos: captura de errores de servidor y cliente, alerta del webhook de Stripe y revisión de registros de funciones |
| Respaldo y recuperación de Production | ❌ | Confirmar el plan con PITR o respaldo diario antes de migrar Production (`RUNBOOK.md` §0) |
| Legal | ⚠️ | Páginas `términos` y `privacidad` existen. Requieren revisión legal, sobre todo nómina sin impuestos y datos de empleados |

## 5. Lo que necesita el propietario (comandos y aprobaciones)

- **A. Aprobar 0015–0035 en Staging.** Elija una opción:
  1. Autorizar en el chat que se añada al workflow una etiqueta `staging:migrate-modules`, con la lista fijada y las mismas guardas. Quedó pendiente por la regla «no modificar el mecanismo de aprobación».
  2. Ejecutarlo desde su equipo con el `STAGING_DB_URL` **de staging** (comando completo en `STAGING_STATUS.md` §6, opción b). Primero `DRY_RUN=1`; después sin él; luego `DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1`.
- **B.** Después: etiquetas `staging:test` y `staging:demo` en el PR #1. Antes de volver a usar `staging:check`, quite esa etiqueta (cada etiqueta se lanza al **añadirse**).
- **C. Production (aprobación separada, otro día):**
  - respaldo;
  - `inspect_migration_state.sql` (solo lectura) en Production, con el resultado compartido;
  - decisión sobre la ventana de migración.
- **D. Proveedores:**
  - SMTP propio en Supabase (Production y Staging);
  - herramienta de monitoreo (cuenta y DSN, que se configuran como secretos);
  - Stripe live: lo hace el propietario, nunca Claude con claves reales.

## 6. Plan para los próximos cuatro días

| Día | Trabajo | Quién | Criterio de salida |
|---|---|---|---|
| **1 (hoy)** | Aprobación A → migrar 0015–0035 en Staging → `staging:test` → `staging:demo` | Propietario aprueba; workflow / Claude verifica los registros | 33 migraciones, `verify_0014a: OK`, staging:test en verde |
| **1–2** | Recorrido real en iPhone, iPad y escritorio de los 9 módulos en Staging; corregir lo que aparezca. Datos demo de los módulos nuevos (desde la interfaz o ampliando `demo-data.mjs` si se aprueba). Monitoreo de errores en el código (solo se activa con su DSN) | Claude + propietario | Lista de §4 en verde para Staging; cero errores 5xx en los registros |
| **2** | SMTP propio; prueba real de registro, confirmación y recuperación de contraseña con correo en Staging. Decidir el alcance del lanzamiento (¿asistente sí o no? ¿nómina sin impuestos?) | Propietario | Correos recibidos y enlaces funcionando en iPhone |
| **3** | Production en seco: respaldo, `inspect_migration_state.sql`, plan de ventana; Stripe live (propietario) preparado pero sin activar; variables de Production revisadas sin compartir con Preview | Propietario (Claude prepara listas y comprobaciones de solo lectura) | Estado de Production conocido y respaldo confirmado |
| **4** | Ventana de Production con aprobación explícita: migraciones según `RUNBOOK.md` → verificación → despliegue → prueba de humo con cuenta real y pago real mínimo reembolsable (propietario) | Propietario aprueba cada paso | Lanzamiento solo si todas las filas ❌ de §4 están resueltas |

Si al final del día 2 Staging no tiene todos los módulos en verde, conviene reducir el alcance del lanzamiento antes que forzar Production.
