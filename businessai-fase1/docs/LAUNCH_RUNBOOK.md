# Lanzamiento de BusinessAI: pasos pendientes (Production)

Cada paso marcado 🔒 requiere la autorización explícita del propietario. Nada de este documento se ha aplicado.
Orden recomendado: 0 → 1 → 2 → 3 → 4 → 5 → 6.

## 0. Reinspección de Production (solo lectura)

Vía normal: etiqueta `production:inspect` en el PR #1 (`.github/workflows/production-inspect.yml`).
Bloqueada mientras el job no reciba `PRODUCTION_DB_URL`: run #6 → `present: false`.

**Alternativa sin GitHub Actions.** Es el mismo script, con las mismas consultas de solo lectura y la misma salida
(solo PASS/FAIL y BLOCKER, sin conteos). La ejecuta el propietario en su equipo. El valor de la URL no sale de su
terminal ni queda en el historial.

Requisitos: `bash` 4 o superior (en macOS: `brew install bash`), `psql` (cliente PostgreSQL 15 o superior) y `python3`.

```bash
git clone https://github.com/ortiiz0037-lab/-businessai && cd -- -businessai
git checkout b113a8a && cd businessai-fase1
read -rs PRODUCTION_DB_URL && export PRODUCTION_DB_URL   # pegar la URL y pulsar Enter (no se muestra)
bash scripts/production/inspect.sh
unset PRODUCTION_DB_URL
```

- La URL debe ser la del *session pooler* (`postgres.rugqcumiuqrjbfwpuslm@…`) o `db.rugqcumiuqrjbfwpuslm.supabase.co`.
  Cualquier otra se rechaza antes de conectar.
- Cada sesión usa `default_transaction_read_only=on`. El script no escribe archivos ni sube nada.

## 1. Dominio de Production 🔒

Decisión del propietario: qué origen sirve la app. Puede ser `https://mybusinessai.site` o `https://app.mybusinessai.site`.

1. **Vercel → Project → Settings → Domains:** añadir el dominio al entorno **Production** y crear el registro DNS
   que indique Vercel.
2. **Vercel, `NEXT_PUBLIC_APP_URL` (solo Production):**
   ```bash
   VERCEL_TOKEN=… VERCEL_PROJECT_ID=prj_hk9DvqsNN5M2OJA2jqm1IHw2lqAW VERCEL_TEAM_ID=team_zY0NJlHyXWCFrO080or2mu5h \
   APP_URL=https://<dominio> node scripts/production/vercel-env.mjs                # plan: presencia de variables + cambio
   CONFIRM_PRODUCTION=vercel-production … node scripts/production/vercel-env.mjs --apply   # 🔒
   ```
   - El plan no escribe nada y no imprime valores, salvo `NEXT_PUBLIC_APP_URL`, que es pública.
   - `--apply` no despliega. El valor entra en vigor en el siguiente despliegue de Production (paso 6).
   - Nunca modifica entradas compartidas con Preview, de modo que Staging conserva `https://staging.mybusinessai.site`.

## 2. Supabase Production: URL de Auth 🔒

**Supabase → proyecto `rugqcumiuqrjbfwpuslm` → Authentication → URL Configuration**

| Campo | Valor |
|---|---|
| Site URL | `https://<dominio>` |
| Redirect URLs | `https://<dominio>/**` |

## 3. Correo de Auth en Production (Resend) 🔒

Los mismos cambios que pasaron en Staging (prueba real en iPhone, 12/12): SMTP de Resend y enlaces `token_hash`.

Remitente: `BusinessAI <no-reply@mail.mybusinessai.site>`. Ese dominio ya está verificado en Resend. Usar una clave
de Resend **distinta** de la de Staging.

```bash
SUPABASE_ACCESS_TOKEN=… EXPECTED_SITE_URL=https://<dominio> SENDER_DOMAIN=mail.mybusinessai.site \
  node scripts/production/auth-email.mjs                                   # plan: DNS, Site URL, cambios
RESEND_SMTP_KEY=… CONFIRM_PRODUCTION=rugqcumiuqrjbfwpuslm … node scripts/production/auth-email.mjs --apply   # 🔒
```

El script se niega a continuar en estos casos:
- el proyecto no es el de Production fijado;
- la Site URL de Production no es `https://<dominio>` (paso 2);
- falta algún registro DNS de Resend.

Solo escribe `smtp_*` y el cuerpo de las dos plantillas, y lo verifica leyendo la configuración de nuevo. No envía correos.

## 4. Variables de Vercel Production 🔒

`vercel-env.mjs` (plan) marca cada una como PASS o MISSING. Sin valores:

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Proyecto `rugqcumiuqrjbfwpuslm` |
| `SUPABASE_SERVICE_ROLE_KEY` | Production (secreta) |
| `NEXT_PUBLIC_APP_URL` | `https://<dominio>` (paso 1) |
| `APP_ENV` | `production`. La app solo acepta entonces claves LIVE de Stripe (`src/lib/env.ts`). |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | LIVE (paso 5) |
| `RESEND_API_KEY` / `EMAIL_FROM` | Recordatorios de cobro, p. ej. `BusinessAI <no-reply@mail.mybusinessai.site>` |
| `ANTHROPIC_API_KEY`, `ASSISTANT_SERVER_KEYS` | Opcional: sin ellas el asistente queda cerrado (`docs/INTELLIGENCE.md`) |

## 5. Stripe LIVE 🔒

1. Activar la cuenta en Stripe (datos de empresa y cuenta bancaria).
2. Crear un producto y un precio mensual por plan, en modo LIVE, con estos *lookup keys*:
   - `businessai_basic_monthly`
   - `businessai_pro_monthly`
   - `businessai_premium_monthly`

   Los importes los decide el propietario. Configurar también el **Customer Portal** como en test: cambiar tarjeta,
   cambiar de plan, historial de facturas y cancelar al final del periodo. `scripts/stripe-setup-test.mjs` rechaza
   claves LIVE a propósito; en LIVE se hace en el Dashboard o con una variante autorizada.
3. **Developers → Webhooks → Add endpoint:** `https://<dominio>/api/stripe/webhook`, con estos eventos:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`
   - `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`

   El *Signing secret* va a `STRIPE_WEBHOOK_SECRET` (Vercel Production).
4. **Settings → Billing → Manage failed payments:** igual que en test (`docs/BILLING.md` §2).

## 6. Migraciones y despliegue 🔒

Requisitos previos:
- paso 0 en PASS;
- prueba de copia de seguridad (`production:backup-proof`);
- decisión de gracia (`docs/PRODUCTION_GRACE_OPTIONS.md`).

Pasos:
1. Fase 1 (0005–0009), una migración por ejecución: `production:plan:<m>` → `production:migrate:<m>`.
2. Fase 2 (0010 en adelante) en una ventana de mantenimiento, con `PRODUCTION_PHASE2_DECISION`.
3. Merge del PR #1 y despliegue de Production en Vercel.
4. Prueba real de registro y recuperación con un buzón autorizado: un correo de cada tipo.

## Pendiente fuera de la plataforma

- Textos legales definitivos (términos, privacidad) y sus versiones en inglés.
- Correo de soporte visible en la app.
- Actualizar la descripción del PR #1.
- Revocar `SUPABASE_ACCESS_TOKEN` (repositorio) cuando terminen los pasos 2–3.
