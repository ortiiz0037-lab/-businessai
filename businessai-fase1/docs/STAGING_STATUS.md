# Staging y Preview — estado real y aislamiento (Entrega 15, 2026-11-14)

Auditoría basada en el repositorio y en los registros de GitHub Actions; el
detalle de configuración sigue en `STAGING_SETUP.md` y `ENVIRONMENTS.md`.

> **Estado:** Staging **no se declara listo**. Las pruebas reales del 2026-11-10
> demuestran que la Preview usaba Supabase **staging**. Pero esta sesión no tiene
> acceso a Vercel para releer hoy las variables de Preview, y a Staging le faltan
> las migraciones 0015–0035. Ver «Pendiente».

## 1. Arquitectura actual (verificada)

| | Production | Staging | Preview (rama `claude/businessai-platform-audit-vjjcoc`) |
|---|---|---|---|
| App | Vercel Production (`main`) | — | Vercel Preview, alias fijo `businessai-git-claude-businessai-platform-52cd8d-ortiiz0037-lab.vercel.app` |
| Supabase | `businessai-dev`, ref `rugqcumiuqrjbfwpuslm` (PRODUCTION) | `businessai-staging`, ref `wbfpvxptoujgvflljasc` | Staging (ver evidencia) |
| Esquema | Ver `RUNBOOK.md` (no tocado) | 0001–0011 + 0014a (sin 0015–0035) | El código de la rama espera hasta 0035 |
| Stripe | live (no configurado por este trabajo) | **test** | **test** |
| Acceso | público | — | **Vercel Authentication** (login de Vercel; se mantiene) |

Evidencia (registros de GitHub Actions, PR #1):
- **Staging run #30** (`staging:migrate`, 2026-11-10):
  - guarda con ref fijado `wbfpvxptoujgvflljasc`; el ref de producción se rechaza;
  - marca de entorno `staging`;
  - aplicadas 0001–0011 (2026-11-09) y 0014a (2026-11-10);
  - `verify_after_migrations: 10,0,2,0,f,0,2,3,t,t,t,`;
  - `verify_0014a: OK`;
  - en Storage solo las 5 políticas del repositorio.
- **Staging tests run #17** (`staging:test`, 2026-11-10), todo en verde:
  - guard (staging y Stripe test);
  - prueba de humo de la Preview;
  - facturación de punta a punta con Stripe TEST;
  - pruebas RLS contra staging;
  - 78 capturas reales de la Preview (iPhone, iPad, escritorio).

  Las capturas iniciaron sesión con un usuario temporal **creado en staging**: solo puede entrar si la Preview usa el Supabase de staging. Es la prueba más fuerte disponible de que la Preview no usaba producción ese día.
- **Despliegue Vercel de `7b49bf8`:** Ready (2026-11-13). Una petición sin sesión recibe `302 → vercel.com/sso-api`, es decir, Preview privada.

## 2. Arquitectura propuesta (sin cambios de esquema)

```
Production  ── app main ──────────► Supabase rugqcumiuqrjbfwpuslm · Stripe live · usuarios reales
Staging     ── (sin app propia) ──► Supabase wbfpvxptoujgvflljasc · Stripe test · usuarios ficticios
Preview     ── app de la rama ────► SOLO Supabase staging · SOLO Stripe test · Vercel Authentication
```

Reglas que ya impone el código (no hay que inventar nada):

- `src/lib/env.ts`:
  - fuera de `APP_ENV=production` rechaza claves `sk_live_` / `rk_live_`;
  - en producción rechaza `sk_test_`;
  - muestra la franja «Entorno: staging — pagos en modo test».
- Workflows: los refs de staging y de producción están **fijados en el archivo**.
  - `apply-migrations.sh` se niega si la URL o el usuario son de producción, si la base no tiene la marca `staging` o si tiene datos sin marcar.
  - `vercel-env.mjs` y `preview-supabase.mjs` escriben **solo** el destino `preview`, separan variables compartidas sin tocar Production y comprueban Production antes y después.
  - `staging-test.yml` exige `sk_test_`.
- Las migraciones 0015–0035 llevan `STAGING-GATE: approval required`: no se aplican sin aprobación explícita.

## 3. Variables por entorno (solo nombres)

| Variable | Production | Preview → Staging | Secreta |
|---|---|---|---|
| `APP_ENV` | `production` | `staging` | no |
| `NEXT_PUBLIC_APP_URL` | dominio oficial | URL fija de la Preview | no |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://rugqcumiuqrjbfwpuslm.supabase.co` | `https://wbfpvxptoujgvflljasc.supabase.co` | no |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | la de producción | la de staging | no (pública) |
| `SUPABASE_SERVICE_ROLE_KEY` | la de producción | la de staging | **sí** |
| `STRIPE_SECRET_KEY` | `sk_live_…` | `sk_test_…` | **sí** |
| `STRIPE_WEBHOOK_SECRET` | endpoint live | endpoint test de staging | **sí** |
| `ANTHROPIC_API_KEY` | si se activa el asistente | opcional (sin ella el asistente dice «no configurado») | **sí** |
| `ASSISTANT_SERVER_KEYS` | si se activa el asistente | opcional, con su clave registrada en **staging** | **sí** |
| `ASSISTANT_MODEL`, `ASSISTANT_ROUTER`, `ASSISTANT_TURN_DEADLINE_MS`, `ASSISTANT_DISABLED` | opcionales | opcionales | no |

**Regla:** cada variable secreta debe existir **dos veces**, una con destino `production` y otra con destino `preview`, y nunca como una sola entrada con ambos destinos.

Secretos y variables de GitHub que usan los workflows: ver `STAGING_SETUP.md` §4. Ninguno se copió ni se leyó en esta entrega.

## 4. Qué muestra la Preview con el esquema actual de Staging (probado en local)

Prueba: `e2e/staging-shape.e2e.mjs` (`npm run test:e2e:staging-shape`).
- **Base de datos:** se construye con `UNTIL=0014a_permissions SEED=seed-base.sql bash e2e/local-stack/db.sh`. Es una base local con **exactamente** las migraciones de staging y datos ficticios.
- **Cómo se recorre:** se entra como propietario de una empresa demo y se recorre cada ruta en tamaño iPhone. Resultado: **62/0**.

| Funciona hoy en Staging | Muestra «todavía no está activado en esta base de datos» |
|---|---|
| Landing, Login, Dashboard, Clientes y perfil, Documentos y detalle, Pagos, Mi empresa, Plan | Finance, Contabilidad, Por cobrar, Gastos, Bancos, Document Studio, Workforce, Payroll, CRM |
| | Asistente: «no está configurado en este servidor (falta ANTHROPIC_API_KEY)» |

En todas las rutas: sin errores 5xx, sin página de error, sin errores de consola y sin desbordamiento en iPhone. El aislamiento entre empresas está comprobado en pantalla y por API (RLS de 0014a): otra empresa no se ve, no se puede insertar en ella y un miembro no puede borrar clientes.

Errores corregidos gracias a esta prueba:
- **Payroll** decidía «disponible» con `has_permission`, que existe desde 0014a. En staging le decía al propietario «solo propietario y administradores». Ahora comprueba `payroll_runs`.
- **CRM** comprobaba la tabla con una petición HEAD, que no informa de error si la tabla falta. Ahora hace una lectura real.

## 5. Riesgos encontrados

1. **No se pudieron releer hoy las variables de Vercel Preview** (sin token ni red a `api.vercel.com`). La evidencia de que la Preview usa staging es del 2026-11-10. Cualquier cambio manual posterior en Vercel podría haberla cambiado.
   **Mitigación:** la etiqueta `staging:check` (solo lectura) lo comprueba: lista nombres y destinos, valida las claves contra staging y detecta variables compartidas con Production.
2. **`RUNBOOK.md` advertía** que, sin configuración, la Preview usa el **mismo** Supabase que producción. El workflow ya separó Preview (`STAGING_SPLIT_SHARED=true`), pero una variable nueva añadida a mano «para todos los entornos» volvería a compartirlo.
3. **Staging sin 0015–0035:** 10 módulos se ven como «no activado». Hoy no hay manera de aprobarlos por etiqueta: `APPROVED_DRAFTS` solo se pasa con *Run workflow*, que exige que el workflow esté en `main`. En esta entrega intenté añadir una etiqueta dedicada a staging. El control de permisos de la sesión lo bloqueó por tocar el mecanismo de aprobación, y lo dejé sin cambios: es decisión del propietario.
4. **El acceso a la Preview depende de Vercel Authentication:** el propietario entra con su cuenta de Vercel. No se debe desactivar.
5. Hay 5 copias de respaldo de páginas versionadas en git (`documents/[id]/page.tsx.before-*`). No contienen secretos; no se borraron.

## 6. Pendiente (lo hace el propietario; nada de esto lo ejecutó Claude)

1. **Comprobación sin escribir nada:** PR #1 → etiqueta `staging:check`. En Actions → Staging, debe confirmar:
   - `NEXT_PUBLIC_SUPABASE_URL` de Preview validada contra `wbfpvxptoujgvflljasc`;
   - ninguna variable compartida con Production;
   - `verify_0014a: OK`.
2. **Migraciones 0015–0035 en staging** (requiere su autorización explícita; elija una opción):
   - **a)** Autorice en el chat que se añada al workflow la etiqueta `staging:migrate-modules`, con la lista 0015–0035 fijada en el archivo y las mismas guardas que `staging:migrate`. Después aplique la etiqueta en el PR #1.
   - **b)** Desde su equipo, con `STAGING_DB_URL` de **staging**:
     `STAGING_PROJECT_REF=wbfpvxptoujgvflljasc PRODUCTION_PROJECT_REF=rugqcumiuqrjbfwpuslm EXPECT_STAGING_REF=wbfpvxptoujgvflljasc APPROVED_DRAFTS=<lista> bash scripts/staging/apply-migrations.sh`
     Antes, ejecútelo con `DRY_RUN=1`. El script se niega con cualquier proyecto que no sea staging. `<lista>`, en este orden: `0015_documents_lifecycle,0016_billing_hardening,0017_plan_features,0018_team,0019_crm,0020_workforce,0021_workforce_kiosk,0022_workforce_rules,0023_ledger,0024_payables,0025_receivables,0026_bank_reconciliation,0027_statements_budgets,0028_document_studio,0029_assistant,0030_intelligence_core,0031_intelligence_insights,0032_assistant_bank_summary,0033_workforce_hr,0034_payroll,0035_crm` (el mismo camino del script que prueba el harness local).
3. Después de migrar: etiqueta `staging:test` (humo, facturación test, RLS, capturas) y `staging:demo` (empresa demo ficticia).
4. **Asistente** (opcional): `ANTHROPIC_API_KEY` y `ASSISTANT_SERVER_KEYS` **solo** en el destino `preview`, con la clave de servidor registrada en staging (`docs/INTELLIGENCE.md`).
5. **Para ver la Preview en iPhone:** abra la URL fija, inicie sesión en Vercel con su cuenta y luego en BusinessAI con su **usuario de staging**, no el de producción.

## 7. Pendiente de estabilización (documentado; no bloquea el desarrollo)

1. **Rollback de 0033 — columnas sin comprobación:** `labor_jurisdictions.verified_on`
   / `verification_status` (proteger), `workforce_settings.overnight_attribution`
   (ya protegida indirectamente por `labor_rule_versions`; añadir comprobación
   explícita), `work_shifts.updated_at` / `updated_by` (el historial queda en
   `workforce_events`; propuesta: documentar sin bloquear).
2. **Etiqueta `staging:verify`:** volver a ejecutar en Staging, sin migrar, las
   comprobaciones de migraciones y `verify-0036.sh` (incluye la suite 102
   corregida, que aún no se ejecutó en Staging). Requiere autorizar el cambio
   del workflow y, aparte, su ejecución.
3. **Barrido de zonas horarias:** ejecutar `npm run test:db` con el servidor en
   `Pacific/Kiritimati` y `Etc/GMT+12` para detectar pruebas que dependan de la
   fecha UTC (como la de CRM corregida en `801d633`).
4. **Borradores retenidos para Staging:** 0036 (aplicada en Staging el
   2026-11-15, run #38), 0037 (Studio por sucursal, no aplicada), 0038
   (Studio · cobros y pagos, no aplicada; necesita 0037), 0039 (catálogo de
   productos y servicios, no aplicada), 0040 (asistente S4, no aplicada; necesita
   0038), 0041 (Document Studio avanzado, no aplicada; necesita 0040) y 0042
   (banca, pagos y recibos, no aplicada; necesita 0035 y 0030; añade el bucket
   privado `Banking-evidence`) y 0043 (inventario, no aplicada; necesita 0039; añade
   tres permisos, matriz 143) y 0044 (punto de venta, no aplicada; necesita 0043;
   añade cuatro permisos, matriz 153; no requiere ningún bucket ni variable para
   aplicarse): cada uno necesita autorización. Ninguna variable `POS_*` /
   `SQUARE_*` está configurada en Vercel.

## 8. Plan ordenado de migraciones 0037–0045 (S9) — NADA aplicado

Estado verificado en la rama: Staging tiene 0001–0036 (0036 aplicada el 2026-11-15, run #38);
**0037–0045 son borradores retenidos** (`STAGING-GATE`), sin aplicar en Staging ni en Production.
Production no tiene ninguna migración posterior a la base inspeccionada (ver `supabase/RUNBOOK.md`).

| Orden | Migración | Depende de | Objetos nuevos | Permisos (matriz) | Bucket | Rollback | Con datos |
|---|---|---|---|---|---|---|---|
| 1 | 0037_studio_branches | 0028, 0035 | `studio_documents.branch_id`, `studio_set_branch` | — | — | se niega si algún documento tiene sucursal | aditiva |
| 2 | 0038_studio_finance | 0037 | tipos de carta / comprobante, vínculos a Gastos | — | — | se niega si hay cartas, comprobantes o vínculos | aditiva |
| 3 | 0039_catalog | 0024, 0035 | `catalog_items`, `catalog_events` | +5 (135) | — | se niega si hay artículos | aditiva |
| 4 | 0040_assistant_finance | 0035, 0038 | tipos de propuesta del asistente | — | — | se niega si existen esas propuestas | aditiva |
| 5 | 0041_studio_advanced | 0040 | tipografías y edición asistida | — | — | se niega si se usan | aditiva |
| 6 | 0042_banking | 0024, 0026, 0030, 0035 | conexiones, sincronizaciones, depósitos, recibos | — | **Banking-evidence** (privado, 3 políticas) | se niega con datos o archivos | aditiva; `payments` gana columnas nullable |
| 7 | 0043_inventory | 0024, 0035, 0039 | inventario completo | +8 (143) | — | se niega con datos | aditiva; `catalog_items.cost_cents` nullable |
| 8 | 0044_pos | 0023, 0030, 0035, 0042, 0043 | punto de venta e integraciones | +10 (153) | — | se niega con datos | amplía dos restricciones de origen (sin borrar valores existentes) |
| 9 | 0045_platform_stabilization | 0003, 0015 (y 0044 para sus funciones POS) | instantánea al emitir, solicitudes de eliminación de cuenta, revocación de permisos sobrantes, retira las FK `payments.created_by` / `companies.created_by` (eliminar usuarios sin perder registros), renovación de tokens y lista de integraciones POS | — | — | se niega con solicitudes pendientes o usuarios ya eliminados; las instantáneas escritas se conservan | no reescribe filas existentes |

Recuento de la matriz `role_permissions`: 130 (hasta 0036) → 135 (0039) → 143 (0043) → 153 (0044); 0045 no añade permisos. `verify_0014a.sql`
calcula el esperado según lo aplicado.

**Compatibilidad entre versiones:** cada migración es aditiva y la aplicación detecta lo que falta
(probado con `staging-shape`: las pantallas de un módulo sin su migración muestran «no está activado»
en lugar de fallar). Desplegar el código de S9 sobre Staging con 0001–0036 es seguro: los módulos
0037+ quedan desactivados hasta aplicar su migración.

**Prueba local del plan completo:** `npm run test:db` aplica 0001…0045 en orden sobre una base vacía
(escenario 52), ejecuta 29 suites de módulos actuales juntas, la suite de flujos integrales y el
rollback de 0045 con huella idéntica. Cada borrador además tiene su escenario propio (45–52) con
aplicación doble (idempotencia), rollback con huella idéntica y rechazo del rollback con datos.

### Procedimiento para la prueba controlada en Staging (0037 → 0045) — requiere autorización aparte

Ensayado de principio a fin, en local, con el `apply-migrations.sh` **real** y los refs fijados reales:
`npm run staging:rehearse:next` (`scripts/staging/rehearse-0037-0045.sh`) → **71 aprobadas, 0 fallidas**.
Nada de esto se ha ejecutado en Staging.

**A. Antes (sin cambiar nada)**

1. Autorización escrita del propietario que nombre la migración exacta de **cada** ejecución
   (etiqueta `staging:migrate-0037`, luego `staging:migrate-0038`, …). Poner una etiqueta posterior antes de
   tiempo no aplica nada: el plan no coincide y la ejecución se detiene (ensayado y probado).
2. El commit a usar tiene CI y `e2e-auth.yml` en verde (hoy `b48246f`: CI #92 y E2E #4 en verde; las 16 suites
   con sesión 795 / 0 en `12a4968`), y `npm run test:db` + `npm run staging:rehearse:next` en verde con ese commit.
3. **Respaldo:** (1a) Supabase → Database → Backups: anotar hora de la última copia y si el plan ofrece PITR;
   (1b) volcado lógico propio en el equipo del propietario, fuera del repositorio y cifrado:
   `supabase db dump --db-url "<Staging>" -f schema.sql`, `--data-only -f data.sql`, `--role-only -f roles.sql`
   (`supabase/RUNBOOK.md` §1). La restauración de un volcado equivalente (`pg_dump -Fc` / `pg_restore`) se
   ensayó: catálogo y datos idénticos al estado 0036.
   **Automatizado:** `.github/workflows/staging-backup.yml` (se inicia al cambiar
   `scripts/staging/backup-request.txt`) ejecuta `scripts/staging/backup.sh` en solo lectura: guardas del
   proyecto, recuento `ba_meta.applied_migrations` = 34, `pg_dump -Fc` de `public`, `ba_meta`, `ba_private`,
   `auth` y `storage`, lectura del archivo, **restauración real** en un servidor desechable del runner con el
   mismo número de filas en cada tabla, y cifrado AES-256. El repositorio es **público**: el volcado solo se
   guarda cifrado (artefacto, 30 días) y solo si existe el secreto `STAGING_BACKUP_PASSPHRASE`.
   **Evidencia (run 44167042736, 2026-11-17 20:14 UTC, commit `2d5e966`):** servidor PostgreSQL 17, guardas y
   marca `staging` OK, `ba_meta.applied_migrations` = **34** (última `0036_workforce_access_check`), 154 tablas,
   989 filas (6 usuarios, 3 empresas); `staging-0036-20261117T201423Z.dump` 1 626 699 bytes, sha256
   `86fc51bc…aff87a`; `pg_restore --list` legible, 154 entradas de datos; restauración real con las **154 tablas
   con el mismo número de filas** y registro 34. No conservado (aún no existía el secreto de cifrado).
   **Copia conservada (run 44177356133, 2026-11-17 21:13 UTC, commit `e9e512e`):** secreto presente (sin mostrar su
   valor), 34 registradas, 154 tablas / 990 filas, restauración con las 154 tablas idénticas;
   `staging-0036-20261117T211305Z.dump` 1 626 726 bytes, sha256 `f1a218e7…490134`; cifrado AES-256-CBC (PBKDF2
   600 000) y descifrado con el mismo sha256; `staging-0036-20261117T211305Z.dump.enc` 1 626 752 bytes, sha256
   `d20edf2c…1c061c`; artefacto `staging-backup-encrypted` (id 14369963433, 1 628 920 bytes, caduca el
   2026-12-17). Descifrar: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in <archivo>.enc -out staging.dump`;
   restaurar: `pg_restore --no-owner --no-acl -d <base vacía> staging.dump`.
   Copia de la plataforma Supabase: no consultable desde aquí (requiere un token de cuenta, que también daría
   acceso a Production).
4. `staging:check` (solo lectura, `DRY_RUN=1 STATUS=1 VERIFY_0014A=1`). Salida esperada **exacta**:
   `No pending migrations.` · `Held (draft not approved …): 0037_studio_branches … 0045_platform_stabilization` ·
   34 filas `✓` · `verify_after_migrations: 10,0,2,0,f,0,2,3,t,t,t,` · `verify_0014a: OK`.
   Cualquier línea `~ <migración> changed since it was applied` o una migración ≤ 0036 en `Pending` = **parar**
   (ningún archivo 0001–0036 cambió desde el 2026-11-14; run #38 aplicó 0036 el 2026-11-15).

**B. Una migración por ejecución, en este orden** — etiqueta `staging:migrate-00NN` en el PR #1, una por
ejecución y solo con la autorización escrita de esa migración. Cada etiqueta fija su único borrador en
`staging.yml` (`SINGLE_DRAFT`; nunca del texto de la etiqueta), ejecuta solo migraciones (sin Stripe, Vercel,
usuarios ni pruebas), se detiene si el plan no es exactamente ese borrador con los posteriores retenidos, y
después ejecuta las comprobaciones de solo lectura de `scripts/staging/verify-step.sh` (ensayadas: 82 / 0).
**No usar** «Run workflow» manual: tiene Stripe, Vercel y pruebas activados por defecto.

| Paso | Etiqueta (borrador fijado) | Salida esperada del run | Matriz `role_permissions` | Comprobación adicional |
|---|---|---|---|---|
| 1 | `staging:migrate-0037` (0037_studio_branches) | `OK: dry run lists exactly 0037_studio_branches` · `→ applying 0037_studio_branches` · `up to date and verified` · `OK: 0037_studio_branches verified (read-only)` | 130 | — |
| 2 | `staging:migrate-0038` (0038_studio_finance) | ídem 0038 | 130 | — |
| 3 | `staging:migrate-0039` (0039_catalog) | ídem 0039 | 135 | — |
| 4 | `staging:migrate-0040` (0040_assistant_finance) | ídem 0040 | 135 | — |
| 5 | `staging:migrate-0041` (0041_studio_advanced) | ídem 0041 | 135 | — |
| 6 | `staging:migrate-0042` (0042_banking) | ídem 0042 | 135 | bucket `Banking-evidence` privado con 3 políticas |
| 7 | `staging:migrate-0043` (0043_inventory) | ídem 0043 | 143 | — |
| 8 | `staging:migrate-0044` (0044_pos) | ídem 0044 | 153 | ninguna variable `POS_*` / `SQUARE_*` todavía |
| 9 | `staging:migrate-0045` (0045_platform_stabilization) | ídem 0045 | 153 | `document_deletion_audit` sin escritura para `anon`; registro de permisos revocados presente |

**Registro de ejecución**

| Paso | Run | Resultado |
|---|---|---|
| 0037 | Staging #39 (44179025000), 2026-11-17 21:23 UTC, autorización escrita del propietario | Plan = exactamente 0037, resto retenido · `→ applying 0037_studio_branches` · `up to date and verified` · 35 registradas · `verify_0014a: OK` · estado: 0001–0037 applied, 0038–0045 not applied · matriz 130 · `branch_id` y `studio_set_branch` presentes · filas sin cambios (3 empresas, 63 documentos, 51 pagos). Stripe, Vercel y pruebas: omitidos |
| respaldo tras 0037 | Staging backup #3 (44179627627), 21:25 UTC | 35 registradas, 154 tablas restauradas idénticas, registro restaurado 35; `staging-0037-20261117T212551Z.dump` 1 630 604 bytes (sha256 `28436e6f…1854a7`); cifrado `.enc` 1 630 624 bytes (sha256 `4a5321a2…55d6e6`), descifrado verificado; artefacto 14371651440 hasta 2026-12-17 |
| 0038 (1.er intento) | Staging #40 (44182108772) | **Cancelado sin ningún job** por el grupo de concurrencia compartido a nivel de workflow (un run omitido de otro workflow lo canceló); nada aplicado. Corregido en `6fa1af2` (concurrencia en el job) |
| 0038 | Staging #41 (44182667023), 2026-11-17 21:44 UTC, autorización escrita del propietario (`0038_studio_finance`) | Plan = exactamente 0038, resto retenido · `→ applying 0038_studio_finance` · `up to date and verified` · 36 registradas · `verify_0014a: OK` · 0001–0038 applied, 0039–0045 not applied · matriz 130 · `bill_payment_id` y `studio_set_finance_link` presentes · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0038 | Staging backup #4 (44183166530), 21:46 UTC | 36 registradas, 154 tablas / 992 filas restauradas idénticas, registro restaurado 36; `staging-0038-20261117T214605Z.dump` 1 641 688 bytes (sha256 `174e4649…87e6f3b2`); cifrado `.enc` 1 641 712 bytes (sha256 `cc2203ef…313bc7f9`), descifrado verificado; artefacto 14373107458 hasta 2026-12-17 |
| 0039 | Staging #42 (44185801390), 2026-11-17 22:02 UTC, autorización escrita del propietario (`0039_catalog`) | Plan = exactamente 0039, resto retenido · `→ applying 0039_catalog` (solo avisos `does not exist, skipping` de primera aplicación) · `up to date and verified` · 37 registradas · `verify_0014a: OK` · 0001–0039 applied, 0040–0045 not applied · matriz **135** · `catalog_items` y `catalog_events` presentes · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0039 | Staging backup #5 (44186284059), 22:04 UTC | 37 registradas, 156 tablas / 1 000 filas restauradas idénticas, registro restaurado 37; `staging-0039-20261117T220435Z.dump` 1 659 991 bytes (sha256 `34e61172…a626979d`); cifrado `.enc` 1 660 016 bytes (sha256 `fcd1b5c8…bb1377f`), descifrado verificado; artefacto 14373374667 hasta 2026-12-17 |
| 0040 | Staging #43 (44186993190), 2026-11-17 22:10 UTC, autorización escrita del propietario (`0040_assistant_finance`) | Plan = exactamente 0040, resto retenido · `→ applying 0040_assistant_finance` · `up to date and verified` · 38 registradas · `verify_0014a: OK` · 0001–0040 applied (`assistant_actions_kind_check` admite `studio_payment_voucher`), 0041–0045 not applied · matriz 135 · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0040 | Staging backup #6 (44187467157), 22:11 UTC | 38 registradas, 156 tablas / 1 001 filas restauradas idénticas, registro restaurado 38; `staging-0040-20261117T221132Z.dump` 1 660 814 bytes (sha256 `3cd9ca82…96447674`); cifrado `.enc` 1 660 832 bytes (sha256 `340193a0…aae9f028`), descifrado verificado; artefacto 14374427878 hasta 2026-12-17 |
| 0041 | Staging #44 (44189458143), 2026-11-17 22:23 UTC, autorización escrita del propietario (`0041_studio_advanced`) | Plan = exactamente 0041, resto retenido · `→ applying 0041_studio_advanced` · `up to date and verified` · 39 registradas · `verify_0014a: OK` · 0001–0041 applied (tipografías de `studio_brand` y `studio_edit`), 0042–0045 not applied · matriz 135 · `studio_valid_page` presente · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0041 | Staging backup #7 (44189921839), 22:26 UTC | 39 registradas, 156 tablas / 1 002 filas restauradas idénticas, registro restaurado 39; `staging-0041-20261117T222614Z.dump` 1 661 543 bytes (sha256 `638dd13c…2b244d8ae5`); cifrado `.enc` 1 661 568 bytes (sha256 `e591b4d2…785cf329`), descifrado verificado; artefacto 14376067317 hasta 2026-12-17 |
| 0042 | Staging #45 (44193723839), 2026-11-17 22:51 UTC, autorización escrita del propietario (`0042_banking`) | Plan = exactamente 0042, resto retenido · `→ applying 0042_banking` (solo avisos `does not exist, skipping` de primera aplicación) · `up to date and verified` · 40 registradas · `verify_0014a: OK` · 0001–0042 applied, 0043–0045 not applied · matriz 135 · `bank_connections` y `receipt_captures` presentes · bucket **`Banking-evidence` privado con sus 3 políticas** (las 13 políticas de Storage anteriores sin cambios) · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0042 | Staging backup #8 (44194322530), 22:53 UTC | 40 registradas, 165 tablas / 1 005 filas restauradas idénticas, registro restaurado 40; `staging-0042-20261117T225351Z.dump` 1 758 369 bytes (sha256 `fafefdeb…f83f061d`); cifrado `.enc` 1 758 400 bytes (sha256 `1fad2804…372ed467`), descifrado verificado; artefacto 14378287797 hasta 2026-12-17 |
| 0043 | Staging #46 (44194898447), 2026-11-17 22:59 UTC, autorización escrita del propietario (`0043_inventory`) | Plan = exactamente 0043, resto retenido · `→ applying 0043_inventory` (solo avisos `does not exist, skipping` de primera aplicación) · `up to date and verified` · 41 registradas · `verify_0014a: OK` · 0001–0043 applied, 0044–0045 not applied · matriz 143 · `inventory_movements` y `purchase_orders` presentes · `Banking-evidence` privado con sus 3 políticas (las 16 políticas de Storage sin cambios) · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0043 | Staging backup #9 (44195500594), 23:01 UTC | 41 registradas, 189 tablas / 1 017 filas restauradas idénticas (+12 respecto de 1 005 = 3 permisos + 8 filas de matriz + 1 registro de migración; datos de negocio sin cambios), registro restaurado 41; `staging-0043-20261117T230114Z.dump` 1 988 343 bytes (sha256 `5432f43c…7bc9cfe`); cifrado `.enc` 1 988 368 bytes (sha256 `9791f437…a7202cde`), descifrado verificado; artefacto 14379111133 hasta 2026-12-17 |
| 0044 | Staging #47 (44196895351), 2026-11-17 23:12 UTC, autorización escrita del propietario (`0044_pos`) | Plan = exactamente 0044, 0045 retenida · `→ applying 0044_pos` (solo avisos `does not exist, skipping` de primera aplicación) · `up to date and verified` · 42 registradas · `verify_0014a: OK` · 0001–0044 applied, 0045 not applied · matriz 153 · `pos_sales`, `pos_shifts` y `pos_integrations` presentes · `Banking-evidence` privado con sus 3 políticas (las 16 políticas de Storage sin cambios) · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0044 | Staging backup #10 (44197409838), 23:14 UTC | 42 registradas, 215 tablas / 1 032 filas restauradas idénticas (+15 respecto de 1 017 = 4 permisos + 10 filas de matriz + 1 registro de migración; datos de negocio sin cambios), registro restaurado 42; `staging-0044-20261117T231336Z.dump` 2 255 942 bytes (sha256 `18cb922d…515eb353`); cifrado `.enc` 2 255 968 bytes (sha256 `6f969d6f…3a959244`), descifrado verificado; artefacto 14380610342 hasta 2026-12-17 |
| 0045 | Staging #48 (44214925217), 2026-11-18 01:21 UTC, autorización escrita del propietario (`0045_platform_stabilization`) | Plan = exactamente 0045 (última del plan) · `→ applying 0045_platform_stabilization` (solo avisos `does not exist, skipping` de primera aplicación) · `up to date and verified` · 43 registradas · `verify_0014a: OK` · 0001–0045 applied · matriz 153 · `account_deletion_requests` y `document_issue_snapshot` presentes · auditoría de bajas sin escritura para anon/authenticated · trigger de instantánea de emisión presente · registro de permisos de auditoría revocados presente (lo usa su rollback) · `Banking-evidence` privado con sus 3 políticas (las 16 políticas de Storage sin cambios) · filas sin cambios (3, 6, 20, 63, 51). Stripe, Vercel y pruebas omitidos |
| respaldo tras 0045 | Staging backup #11 (44215348011), 2026-11-18 01:23 UTC | 43 registradas, 217 tablas (+2: `account_deletion_requests`, `ba_private.s9_revoked_audit_grants`) / 1 038 filas restauradas idénticas (+6 respecto de 1 032: 1 registro de migración y las filas que 0045 escribe en su registro de permisos de auditoría revocados; datos de negocio sin cambios: 3, 6, 20, 63, 51), registro restaurado 43; `staging-0045-20261118T012309Z.dump` 2 269 608 bytes (sha256 `84517824…8659215b`); cifrado `.enc` 2 269 632 bytes (sha256 `847fb2d7…d8ca6466`), descifrado verificado; artefacto 14388750350 hasta 2026-12-18 |

**C. Después de cada paso (solo lectura)**

- `staging:check` con `EXPECT_NONE=1`: `verify_0014a: OK`, filas `✓` = 34 + número de paso, el resto sigue `Held`.
- `inspect_migration_state.sql`: la migración del paso = `applied`.
- Los datos existentes no cambian (empresas, clientes, documentos, membresías: mismos recuentos; ensayado).
- Al terminar los 9 pasos: prueba de humo en la Preview con usuarios de prueba de Staging (empresa, factura,
  venta POS, conteo) y aislamiento entre dos empresas de prueba.
- Variables de entorno (POS, banca) **solo después** de su migración, nunca antes (`docs/POS.md` §9, `docs/BANKING.md`).

**D. Si algo falla — plan de recuperación (decisión del propietario, nunca automática)**

1. **Parar.** La migración que falla no se registra (cada archivo es una transacción: un fallo no cambia nada).
2. **Recuperación A — rollback** (si ya se aplicó y no hay datos del módulo): ejecutar `supabase/rollback/NNNN_rollback.sql`
   en orden **inverso** (0045 → 0037, solo las aplicadas) y, en la misma sesión, borrar su fila de
   `ba_meta.applied_migrations`. Ensayado: las 9 en orden inverso dejan el catálogo **idéntico** al estado 0036,
   la matriz en 130 y 0037–0045 otra vez `Held`. Cada rollback se niega (sin cambiar nada) si su módulo ya tiene
   datos — ver `supabase/RUNBOOK.md` §10.
3. **Recuperación B — restaurar** la copia del punto A.3 (PITR o volcado) si un rollback se niega o hay daño de datos.
   Ensayado con `pg_dump -Fc` / `pg_restore`: catálogo, datos y registro (34) idénticos al estado 0036.
4. Registrar qué pasó, qué run y qué se restauró, antes de cualquier nuevo intento.

### Antes de la prueba en Staging (S9.2)

- Secuencia verificada automáticamente (`tests/migrations-sequence.test.ts`): números únicos, orden, rollback,
  borrador, documentación y arnés para cada migración; última 0045, siguiente libre 0046.
- Pruebas de navegador con sesión: correr `.github/workflows/e2e-auth.yml` (16 suites) en un pull request
  **antes** de pedir la autorización de Staging. Ejecución 2 (commit `12a4968`): 16 / 16 suites, 795 aprobadas, 0 fallidas.
- Variables nuevas solo de prueba local (dobles): `SHOPIFY_BASE_URL`, `LIGHTSPEED_BASE_URL` (rechazadas en producción).
