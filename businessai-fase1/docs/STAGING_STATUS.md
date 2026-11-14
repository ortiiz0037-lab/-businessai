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
