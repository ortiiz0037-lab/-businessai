# Staging en 6 pasos (desde el iPad)

Todo lo demás lo hace el workflow **Staging** de GitHub Actions:
migraciones → Stripe test → variables de Vercel (solo Preview) → prueba de humo →
prueba completa de facturación → pruebas RLS.

Las claves se guardan como **secretos de GitHub**: no pasan por el chat ni por el
código, y no aparecen en los registros.
Nada de esto toca producción: los scripts se niegan a usar claves *live* o el
proyecto Supabase de producción, y en Vercel solo escriben el entorno **Preview**.

URL de staging propuesta (el alias fijo de Vercel para la rama del PR):
`https://businessai-git-claude-businessai-platform-52cd8d-ortiiz0037-lab.vercel.app`

---

## 1. Supabase: crear el proyecto de staging
supabase.com → **New project**
- Nombre: `businessai-staging` · Región: la misma que producción · Plan Free.
- Contraseña de la base de datos: genera una y guárdala en tu gestor de contraseñas.

Cuando esté listo, anota:
| Dónde | Qué | Lo usarás como |
|---|---|---|
| Barra de direcciones: `…/project/<REF>` | el **ref** (≈20 letras) | variable `STAGING_PROJECT_REF` |
| Project Settings → API Keys | **Publishable key** | variable `STAGING_SUPABASE_PUBLISHABLE_KEY` |
| Project Settings → API Keys | **service_role / secret key** | secreto `STAGING_SUPABASE_SERVICE_ROLE_KEY` |
| Botón **Connect** → **Session pooler** → URI (pon tu contraseña en `[YOUR-PASSWORD]`) | cadena `postgresql://…pooler.supabase.com:5432/postgres` | secreto `STAGING_DB_URL` |

Anota también el **ref del proyecto de producción** (`businessai-dev`, en su URL):
variable `PRODUCTION_PROJECT_REF`. Solo sirve para que los scripts lo **rechacen**.

Luego, en el proyecto de **staging**: Authentication → **URL Configuration**
- Site URL: la URL de staging.
- Redirect URLs → Add: `<URL de staging>/**`

## 2. Stripe: clave de test
dashboard.stripe.com → activa **Test mode** (interruptor arriba) → Developers →
**API keys** → *Secret key* → Reveal → copia `sk_test_…` → secreto `STRIPE_TEST_SECRET_KEY`.
(Si aparece `sk_live_…`, no estás en Test mode.)

## 3. Vercel: token y acceso para Stripe
vercel.com → avatar → **Account Settings → Tokens** → Create
- Scope: el equipo `ortiiz0037-lab` · Expiration: **1 day** (basta para configurar).
- Copia → secreto `VERCEL_TOKEN`.

Proyecto **businessai** → Settings → **Deployment Protection**
(tu proyecto tiene *Vercel Authentication* con *Standard Protection*: **se mantiene
activada**; producción no se ve afectada):
- Sección **Protection Bypass for Automation** → **Add Secret** (o *Create*) → copia el
  valor → GitHub, secreto **`VERCEL_AUTOMATION_BYPASS_SECRET`**.
- Para qué sirve: solo deja pasar a quien envíe ese secreto (el workflow por cabecera,
  Stripe dentro de la URL de su webhook). Todos los demás siguen viendo el login de
  Vercel. Se puede revocar en la misma pantalla en cualquier momento.
- El workflow lo comprueba en el paso 0 (también en `staging:check`) y se detiene
  si la preview está protegida y el secreto falta o Vercel lo rechaza.

Opcional (para que el workflow redepliegue solo): Settings → **Git → Deploy Hooks**
→ nombre `staging`, rama `claude/businessai-platform-audit-vjjcoc` → Create → copia
la URL → secreto `VERCEL_DEPLOY_HOOK_URL`. Sin él, pulsa **Redeploy** en la última
preview de esa rama tras el paso 5.

## 4. GitHub: guardar secretos y variables
github.com/ortiiz0037-lab/-businessai → **Settings → Secrets and variables → Actions**

Pestaña **Secrets** → New repository secret (uno por uno):
`STAGING_DB_URL`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_TEST_SECRET_KEY`,
`VERCEL_TOKEN`, y si los tienes `VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_DEPLOY_HOOK_URL`.

Pestaña **Variables** → New repository variable:
| Nombre | Valor |
|---|---|
| `STAGING_PROJECT_REF` | ref de staging |
| `PRODUCTION_PROJECT_REF` | ref de producción (para rechazarlo) |
| `STAGING_SUPABASE_PUBLISHABLE_KEY` | publishable key de staging |
| `STAGING_URL` | la URL de staging |
| `STAGING_PRICE_BASIC_CENTS` | precio mensual Básico en centavos (p. ej. `1900` = $19.00) — tu decisión |
| `STAGING_PRICE_PRO_CENTS` | precio mensual Pro en centavos |
| `STAGING_PRICE_PREMIUM_CENTS` | precio mensual Premium en centavos |

## 5. GitHub: comprobar y, después, autorizar
**5a. Comprobación (solo lectura).** PR #1 → **Labels** → crea y aplica `staging:check`.
El workflow verifica que estén todos los valores (solo nombres), conecta con
staging y aplica todas las protecciones contra producción, lista las migraciones
pendientes sin aplicarlas y muestra el plan de Stripe y de Vercel. **No escribe
nada en ningún servicio.** Revisa el resultado en Actions → Staging.

**5b. Ejecución (tu autorización).** Quita `staging:check` y aplica `staging:run`.
Eso aplica las migraciones en staging, prepara Stripe test, escribe las variables
Preview de Vercel y ejecuta las pruebas.
(El botón "Run workflow" solo aparece cuando el archivo esté en `main`; las
etiquetas funcionan ya, sin fusionar nada ni desplegar producción.)

Para volver a ejecutarlo: quita la etiqueta y vuelve a ponerla.

Si el paso 3 se detiene diciendo que hay variables compartidas *Production + Preview*
(lo normal si hoy las previews usan la base de producción): añade la variable
`STAGING_SPLIT_SHARED` = `true` y vuelve a poner la etiqueta. Preview pasará a tener
sus propios valores y **Production queda exactamente igual**.

Resultado esperado (≈10 min):
- `Staging database is up to date and verified.`
- Stripe: 3 precios, portal y endpoint de webhook de staging.
- Vercel: 7 variables **(preview)**.
- Prueba de humo: `6 passed`.
- Facturación: todas las comprobaciones en `PASS`:
  - prueba de 7 días sin cobro, cobro al día 8;
  - tarjeta que falla en el primer cobro → pago pendiente;
  - cancelación durante la prueba → ningún cobro;
  - tarjeta rechazada → sin suscripción;
  - webhooks procesados.

Los datos de prueba se borran solos.

Cuando termine, borra el `VERCEL_TOKEN` en Vercel (o deja que caduque).

## 6. Una prueba a mano (la única que necesita navegador)
En Safari, abre la URL de staging → Regístrate → crea la empresa → elige un plan →
lee las condiciones → marca "Acepto" → en Stripe Checkout usa la tarjeta
`4242 4242 4242 4242` (fecha futura, CVC cualquiera).
Debes volver a "Plan" con **Prueba gratuita** y la fecha del primer cobro. Repite con
`4000 0000 0000 0002` para ver el rechazo. Más casos: `docs/BILLING.md` §3.

---

Si un paso falla, el registro del workflow dice qué falta (solo nombres, nunca
valores) o qué se detuvo. Ningún paso a medias deja producción cambiada: cada
migración es una transacción, y los scripts comprueban dónde están antes de escribir.
