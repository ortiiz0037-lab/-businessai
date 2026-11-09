# Entornos: desarrollo, staging y producción

Objetivo: **ningún entorno que no sea producción puede tocar datos de producción
ni cobrar dinero real.** Cada entorno tiene su propio proyecto Supabase, su propio
modo de Stripe y sus propias variables.

| | Desarrollo | Staging | Producción |
|---|---|---|---|
| Dónde corre | `npm run dev` en tu equipo | Vercel **Preview** (todas las ramas y PRs) | Vercel **Production** (`main`) |
| Proyecto Supabase | `businessai-staging` (o Supabase local) | **`businessai-staging`** (nuevo) | `businessai-dev` (el actual, marcado PRODUCTION) |
| Stripe | modo **test** | modo **test** | modo **live** |
| `APP_ENV` | `development` | `staging` | `production` |
| Variables | `.env.local` (no se sube a git) | Vercel → Environment Variables → **Preview** | Vercel → Environment Variables → **Production** |

Barreras automáticas (`src/lib/env.ts`):
- Con `APP_ENV` distinto de `production`, una clave `sk_live_`/`rk_live_` se **rechaza**.
- Con `APP_ENV=production`, una clave `sk_test_` se **rechaza**.
- `NEXT_PUBLIC_APP_URL` debe ser `https` fuera de desarrollo.
- Fuera de producción, la app muestra una franja "Entorno: staging — pagos en modo test".

## Variables (solo nombres; los valores se configuran en cada entorno)

| Variable | Desarrollo | Staging (Preview) | Producción | Secreta |
|---|---|---|---|---|
| `APP_ENV` | `development` | `staging` | `production` | no |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | URL fija de staging | dominio de producción | no |
| `NEXT_PUBLIC_SUPABASE_URL` | staging | staging | producción | no |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | staging | staging | producción | no (pública) |
| `SUPABASE_SERVICE_ROLE_KEY` | staging | staging | producción | **sí** |
| `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_test_…` | `sk_live_…` | **sí** |
| `STRIPE_WEBHOOK_SECRET` | el de `stripe listen` | el del endpoint test de staging | el del endpoint live | **sí** |
| `RLS_TEST_PROJECT_REF` | ref de staging (solo tests) | — | — | no |

`STRIPE_PRICE_ID` ya no se usa: los precios se resuelven por *lookup key*
(`businessai_<plan>_monthly`) en el modo de Stripe de cada entorno.

En Vercel marca las secretas como **Sensitive** y asígnalas a un único entorno
(Preview **o** Production, nunca ambos).

## Crear el proyecto de staging (una vez)

> **Automatizado:** sigue `docs/STAGING_SETUP.md` (6 pasos desde el iPad; el resto lo
> hace el workflow **Staging** de GitHub Actions). Lo que sigue es el detalle manual
> equivalente, por si prefieres hacerlo a mano.

1. **Supabase → New project** `businessai-staging` (otra contraseña de BD; guárdala en tu gestor de contraseñas).
2. **Authentication → URL Configuration**
   - Site URL: la URL fija de staging (ver paso 6).
   - Redirect URLs: `https://<url-de-staging>/**` y, si quieres probar previews de PR,
     el patrón de previews de tu equipo en Vercel.
   - Email templates → Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`.
3. **SQL Editor**: ejecuta, en este orden, los archivos de `supabase/migrations/`:
   `0001` → `0002` → `0003` → `0004` → `0005` → `0007` → `0009` → `0006` → `0008` → `0010` → `0011` → `0014a`.
   (El orden autoritativo es `ORDER` en `scripts/staging/apply-migrations.sh`.)
   (`0008` no hace nada en staging.)
   Comprobado en local: con solo estos archivos se obtiene una base equivalente a
   producción tras las migraciones (escenario 16 de `npm run test:db`).
4. **Verificación**: `supabase/inspect/verify_after_migrations.sql` debe devolver
   `10,0,2,0,f,0,2,3,t,t,t,` (la última columna vacía: esa función solo existe en producción).
5. **Project Settings → API**: copia URL, publishable key y service role key a las
   variables **Preview** de Vercel (y a tu `.env.local`).
6. **Vercel → Domains**: asigna un dominio fijo (p. ej. `staging.<tu-dominio>`) a la rama
   `staging` (o a la que uses). El webhook de Stripe necesita una URL estable.
7. **Stripe (modo test)**: sigue `docs/BILLING.md` §2.

## Desarrollo local

```bash
cp .env.example .env.local   # rellena con valores de STAGING y APP_ENV=development
npm run dev
stripe listen --forward-to localhost:3000/api/stripe/webhook   # imprime un whsec_ → STRIPE_WEBHOOK_SECRET
```

## Pruebas

| Comando | Qué usa |
|---|---|
| `npm test` | Unitarias; sin red ni credenciales |
| `npm run test:db` | Postgres local desechable; nunca Supabase |
| `npm test` con `RLS_TEST_PROJECT_REF` | Supabase **staging** (crea y borra usuarios de prueba); se niega si el ref no coincide con la URL |

## Paso a producción (más adelante, con aprobación)

Seguir `supabase/RUNBOOK.md` para las migraciones de producción, crear en Stripe
**live** los mismos productos con los mismos lookup keys, un endpoint de webhook live
y configurar las variables **Production**. Nada de esto se ha hecho.
