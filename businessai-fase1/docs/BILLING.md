# Suscripciones con Stripe

## 1. Cómo funciona

**Modelo decidido:** prueba gratuita de **7 días con tarjeta de crédito o débito
obligatoria desde el registro**. Es una prueba de Stripe: no se cobra nada durante
la prueba, Stripe cobra automáticamente el plan elegido al terminar, y si el cliente
cancela antes no se realiza ningún cobro.

```
registro → crear empresa → /billing?welcome=1 (elegir plan)
  → condiciones visibles + casilla "Acepto" → Stripe Checkout (guarda la tarjeta, $0 hoy)
  → suscripción "trialing" 7 días → webhook → acceso
  → día 8: Stripe cobra el plan → "active"   (si falla → "past_due")
  → "Administrar suscripción" → Customer Portal (tarjeta, plan, cancelar)
```

| Pieza | Archivo |
|---|---|
| Catálogo, una prueba por empresa, estado y límites | `supabase/migrations/0010_billing.sql` |
| Condiciones y parámetros de Checkout | `src/lib/billing/checkout.ts` |
| Checkout | `src/app/api/stripe/checkout/route.ts` |
| Portal | `src/app/api/stripe/portal/route.ts` |
| Webhook | `src/app/api/stripe/webhook/route.ts`, `src/lib/billing/webhook.ts`, `sync.ts`, `store.ts` |
| Página de planes y aviso | `src/app/(app)/billing/page.tsx`, `src/app/(app)/layout.tsx` |
| Paso de registro | `src/app/actions/company.ts` (tras crear la empresa → `/billing?welcome=1`) |
| Entornos y claves | `src/lib/env.ts`, `docs/ENVIRONMENTS.md` |

### Lo que ve el cliente antes de confirmar
En cada plan de `/billing` (y repetido dentro de Stripe Checkout, sobre el botón de pago):

> **7 días gratis, luego $39.00 / mes**
> Hoy no se cobra nada. Tu tarjeta se guarda para la suscripción al plan Pro. Si no
> cancelas antes, el 15 de noviembre de 2026 se cobrarán $39.00 y, después, $39.00 cada
> mes automáticamente. Si cancelas durante la prueba no se realizará ningún cobro.
> Puedes cancelar en cualquier momento desde "Administrar suscripción".
>
> ☐ Acepto estas condiciones y el cobro automático el 15 de noviembre de 2026.

- El precio sale del precio real de Stripe (lookup key) y la fecha es hoy + 7 días.
- Sin marcar la casilla no se puede continuar; el servidor también lo comprueba.
- Checkout en español (`locale: 'es'`); Stripe muestra además su propio resumen
  ("7 días gratis", importe y fecha del primer cobro).
- Una empresa que ya usó su prueba ve "Hoy se cobrarán $X…" (sin prueba).

### Reglas
- **Tarjeta siempre obligatoria** (`payment_method_collection: 'always'`), también
  con $0 hoy. Si Stripe rechaza la tarjeta en Checkout, no se crea ninguna
  suscripción y la empresa sigue sin acceso para crear.
- **Una prueba por empresa**: `company_subscriptions.trial_consumed_at` se fija en la
  base de datos la primera vez que se guarda una suscripción con prueba y no se puede
  borrar. Cancelar y volver a suscribirse se cobra al momento.
- Red de seguridad: si una prueba terminara sin método de pago, Stripe **cancela** la
  suscripción en vez de crear una factura impagada
  (`trial_settings.end_behavior.missing_payment_method = 'cancel'`).
- Con suscripción, "Cambiar de plan" va al **Portal** (nunca una segunda suscripción).
- **Cancelar durante la prueba** (Portal, modo "al final del periodo"): la prueba
  sigue hasta su fecha, la suscripción termina ese día y **no se emite cobro**.

### Planes y límites
- **Límites** en `billing_plans` (editable con SQL; `NULL` = ilimitado). Propuesta inicial:

  | Plan | Clientes | Documentos/mes | Usuarios* |
  |---|---|---|---|
  | basic | 50 | 40 | 1 |
  | pro | 500 | 300 | 3 |
  | premium | ilimitado | ilimitado | 10 |

  *Usuarios: informativo; aún no hay invitaciones. Durante la prueba rigen los
  límites del plan elegido.
- **Precios** en Stripe, uno mensual por plan con lookup key
  `businessai_basic_monthly`, `businessai_pro_monthly`, `businessai_premium_monthly`.
- **Duración de la prueba**: `billing_config.trial_days` (7).

### Estados y acceso
| Estado | Cuándo | Crear clientes/documentos | Aviso |
|---|---|---|---|
| `none` | registrada pero sin Checkout completado | **no** | "Elige un plan para empezar tu prueba…" |
| `trialing` | prueba de 7 días en curso | sí | días restantes y primer cobro; o "cancelaste: no se cobrará" |
| `active` | pagando | sí | si se cancelará al final del periodo |
| `past_due` | cobro fallido, Stripe reintenta | sí (gracia) | actualizar tarjeta |
| `canceled` / `unpaid` / `incomplete*` / `paused` | terminada o sin pagar | **no** | solo lectura |

"Solo lectura" nunca impide ver, imprimir, cambiar el estado de facturas existentes ni
registrar pagos de clientes. Los límites se imponen en la base de datos (trigger).

### Webhook: seguridad y sincronización
- Firma `stripe-signature` verificada antes de nada (400 si falla). Ruta pública
  solo para esa URL exacta (`src/lib/supabase/proxy.ts`).
- **Idempotente**: cada evento se registra en `stripe_events`; una entrega repetida ya
  procesada responde 200 `duplicate` sin reprocesar; un fallo responde 500 y queda
  `failed` con el error para que Stripe reintente.
- **Independiente del orden**: cada evento vuelve a leer la suscripción actual en
  Stripe; el contenido del evento no se usa como fuente de verdad.
- Un evento tardío de una suscripción **antigua** ya cancelada no sobrescribe la actual;
  se rechaza una suscripción de un cliente de Stripe distinto al de la empresa.
- Fechas guardadas: inicio/fin de la prueba, inicio/fin del periodo, `cancel_at`,
  `canceled_at`, `ended_at`, último fallo de pago (y su mensaje).

## 2. Preparar Stripe en modo test (staging)

1. Stripe Dashboard → **Test mode**. Clave secreta de test → `STRIPE_SECRET_KEY`
   (Vercel Preview / `.env.local`).
2. Productos, precios y portal (importes en céntimos, los eliges tú):
   ```bash
   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-test.mjs --basic <c> --pro <c> --premium <c>
   ```
   El portal queda con: cambiar tarjeta, cambiar de plan, historial de facturas y
   **cancelar al final del periodo** (durante la prueba = al final de la prueba, sin cobro).
3. **Developers → Webhooks → Add endpoint** (test): `https://<staging>/api/stripe/webhook`
   con los eventos:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`,
   `customer.subscription.trial_will_end`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.payment_action_required`.
   *Signing secret* → `STRIPE_WEBHOOK_SECRET` (Preview).
4. **Settings → Billing → Subscriptions and emails**:
   - *Manage failed payments*: qué hacer cuando fallen todos los reintentos (cancelar o
     marcar impagada; ambos dejan la cuenta en solo lectura).
   - Opcional: activar el correo de "trial ending" (Stripe avisa al cliente antes del
     primer cobro).

## 3. Prueba completa en staging

Tarjetas de test (cualquier fecha futura y CVC):

| Tarjeta | Comportamiento |
|---|---|
| `4242 4242 4242 4242` | Se guarda y los cobros se aprueban |
| `4000 0000 0000 0002` | **Rechazada** al guardarla (Checkout muestra el error) |
| `4000 0000 0000 9995` | Rechazada por fondos insuficientes |
| `4000 0000 0000 0341` | Se guarda bien, pero **los cobros fallan** (sirve para el día 8) |
| `4000 0025 0000 3155` | Pide autenticación (3D Secure) |

| # | Paso | Resultado esperado |
|---|---|---|
| 1 | **Registro**: crear cuenta y empresa | Llega a `/billing?welcome=1`; estado "Sin plan"; crear clientes da el mensaje de plan |
| 2 | Ver condiciones de un plan | Precio, "7 días gratis", fecha del primer cobro = hoy + 7 y texto de cancelación. Sin marcar la casilla no deja continuar |
| 3 | **Tarjeta rechazada**: Empezar prueba → `4000 0000 0000 0002` (y luego `…9995`) | Checkout muestra el rechazo; si se sale, `/billing?checkout=cancelled`; sigue "Sin plan"; en Stripe no hay suscripción |
| 4 | **Prueba con tarjeta**: Empezar prueba → `4242…` | `/billing?checkout=success`; en segundos: "Prueba gratuita", primer cobro en 7 días; en Stripe: suscripción `trialing`, **factura de $0**, tarjeta guardada |
| 5 | Crear clientes y documentos | Funciona, con los límites del plan elegido |
| 6 | **Cobro al terminar la prueba**: `stripe subscriptions update <sub_id> -d trial_end=now` | Factura cobrada por el precio del plan; estado "Activa" y fechas del periodo |
| 7 | **Pago fallido al terminar la prueba** (otra empresa): prueba con `4000 0000 0000 0341` → `stripe subscriptions update <sub_id> -d trial_end=now` | Cobro rechazado; "Pago pendiente" y aviso de tarjeta; se puede seguir creando mientras Stripe reintenta |
| 8 | Recuperación: Portal → tarjeta `4242` (Stripe reintenta, o paga la factura en el Dashboard) | "Activa"; el aviso desaparece |
| 9 | **Cancelación durante la prueba** (otra empresa con prueba en curso): Administrar suscripción → Cancelar | Sigue "Prueba gratuita" con aviso "no se realizará ningún cobro"; en Stripe `cancel_at_period_end = true` |
| 10 | …y fin de esa prueba: `stripe subscriptions update <sub_id> -d trial_end=now` | La suscripción termina **sin factura cobrada**; estado "Cancelada", solo lectura |
| 11 | Volver a suscribirse esa empresa | Las condiciones dicen "ya usó su prueba… Hoy se cobrarán…"; se cobra al momento |
| 12 | **Autenticación requerida**: prueba con `4000 0025 0000 3155` → fin de prueba | "Pago pendiente" (motivo: autenticación); Stripe pide al cliente completarla |
| 13 | Cancelación de una suscripción activa | "Activa" + "se cancelará al final del periodo"; al llegar la fecha (o cancelando de inmediato en el Dashboard) → "Cancelada", solo lectura |
| 14 | **Eventos duplicados**: Developers → Webhooks → endpoint → reenviar un evento ya entregado (o `stripe events resend <evt_id>`) | Respuesta 200 `duplicate: true`; nada cambia en la base de datos |

Para simular el tiempo real (renovaciones mensuales, el día 8 sin comandos): Stripe →
**Test clocks** → crear un reloj y un cliente en él; en staging, guarda ese `cus_…` en
`company_subscriptions.stripe_customer_id` de la empresa de prueba antes del paso 4 (la
app reutiliza el cliente guardado); luego avanza el reloj.

Solo en **staging** se editan datos a mano. Nunca en producción.

## 4. Pruebas automatizadas

| Suite | Cubre |
|---|---|
| `tests/billing-webhook.test.ts` | Firmas reales de Stripe (falsificada/ausente → 400), prueba iniciada sin cobro, cobro al terminar, **tarjeta rechazada al terminar** (past_due + motivo), autenticación requerida, **cancelación durante la prueba sin cobro**, Checkout rechazado/expirado (no crea nada), **eventos duplicados**, reintentos tras error, eventos fuera de orden, cliente distinto |
| `tests/billing-sync.test.ts` | Condiciones mostradas (precio, fecha, cancelación), parámetros de Checkout (tarjeta obligatoria, `trial_period_days`, sin prueba si ya se usó), mapeo de suscripciones, avisos |
| `supabase/tests/local/50_billing.test.sql` | Sin Checkout no hay acceso; prueba → acceso; cancelación durante la prueba; **una prueba por empresa** (no se puede reiniciar); límites; pago fallido → gracia → impago → solo lectura; aislamiento entre empresas |
