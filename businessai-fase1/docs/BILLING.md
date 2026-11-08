# Suscripciones con Stripe

## 1. Cómo funciona

```
registro → empresa creada → prueba 7 días (sin tarjeta, la crea la BD)
        → /billing → "Suscribirme" → Stripe Checkout (tarjeta)
        → webhook → company_subscriptions (estado, plan, fechas)
        → acceso y límites: public.company_billing_state() + triggers
        → "Administrar suscripción" → Stripe Customer Portal (tarjeta, plan, cancelar)
```

| Pieza | Archivo |
|---|---|
| Catálogo, prueba, estado y límites | `supabase/migrations/0010_billing.sql` |
| Checkout | `src/app/api/stripe/checkout/route.ts`, `src/lib/billing/checkout.ts` |
| Portal | `src/app/api/stripe/portal/route.ts` |
| Webhook | `src/app/api/stripe/webhook/route.ts`, `src/lib/billing/webhook.ts`, `sync.ts`, `store.ts` |
| Página y aviso | `src/app/(app)/billing/page.tsx`, `src/app/(app)/layout.tsx` |
| Entornos y claves | `src/lib/env.ts`, `docs/ENVIRONMENTS.md` |

### Planes y precios
- **Límites** en la tabla `billing_plans` (editable con SQL; `NULL` = ilimitado).
  Valores iniciales (propuesta, cámbialos cuando decidas):

  | Plan | Clientes | Documentos/mes | Usuarios* |
  |---|---|---|---|
  | basic | 50 | 40 | 1 |
  | pro (y prueba) | 500 | 300 | 3 |
  | premium | ilimitado | ilimitado | 10 |

  *Usuarios: informativo; todavía no hay invitaciones.
- **Precios** en Stripe: un precio mensual por plan con lookup key
  `businessai_basic_monthly`, `businessai_pro_monthly`, `businessai_premium_monthly`.
  Test y live tienen sus propios precios; la app los busca por lookup key.
- **Prueba**: `billing_config.trial_days` (7) y `trial_plan` (pro).

### Estados y acceso
| Estado | Cuándo | Crear clientes/documentos | Aviso |
|---|---|---|---|
| `trialing` | prueba de la app vigente, o prueba de Stripe | sí | días restantes |
| `trial_expired` | prueba terminada sin suscripción | **no** | solo lectura |
| `active` | pagando | sí | si se cancelará al final del periodo |
| `past_due` | cobro fallido, Stripe reintenta | sí (gracia) | actualizar tarjeta |
| `canceled` / `unpaid` / `incomplete*` / `paused` | terminada o sin pagar | **no** | solo lectura |
| `none` | empresa anterior a 0010 sin fila | **no** | solo lectura (ver `0010b`) |

"Solo lectura" nunca impide ver, imprimir, editar el estado de facturas existentes ni
registrar pagos de clientes: el negocio siempre puede cobrar lo ya emitido.
Los límites se imponen en la base de datos (trigger), no solo en la interfaz.

### Reglas de la prueba
- Una prueba por empresa, al crearla. Si se suscribe durante la prueba, Stripe
  **respeta los días restantes** (no cobra hasta el final), siempre que queden ≥ 48 h
  (requisito de Checkout); si quedan menos o ya terminó, se cobra al momento.
- Con suscripción activa, "Suscribirme"/"Cambiar de plan" lleva al **Portal**
  (nunca crea una segunda suscripción).

### Webhook: seguridad y sincronización
- Firma `stripe-signature` verificada antes de nada (400 si falla). Ruta pública solo
  para esa URL exacta (`src/lib/supabase/proxy.ts`).
- **Idempotente**: cada evento se registra en `stripe_events`; una entrega repetida ya
  procesada responde 200 sin reprocesar; un fallo responde 500 y queda `failed` con
  el error para que Stripe reintente.
- **Independiente del orden**: para cada evento se vuelve a leer la suscripción
  actual en Stripe; el contenido del evento no se usa como fuente de verdad.
- Un evento tardío de una suscripción **antigua** ya cancelada no sobrescribe la actual.
- Se rechaza una suscripción de un cliente de Stripe distinto al de la empresa.
- Fechas guardadas: inicio/fin del periodo (del item de la suscripción), inicio/fin de
  prueba, `cancel_at`, `canceled_at`, `ended_at`, último fallo de pago.

## 2. Preparar Stripe en modo test (staging)

1. Stripe Dashboard → activa **Test mode**. Copia la clave secreta de test a
   `STRIPE_SECRET_KEY` (Preview / `.env.local`).
2. Productos, precios y portal (elige tú los importes, en céntimos):
   ```bash
   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-test.mjs --basic <c> --pro <c> --premium <c>
   ```
   (o créalos a mano con esos lookup keys y configura el portal: cambiar tarjeta,
   cancelar **al final del periodo**, cambiar de plan, historial de facturas).
3. **Developers → Webhooks → Add endpoint** (test): `https://<staging>/api/stripe/webhook`
   con los eventos:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`,
   `customer.subscription.trial_will_end`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.payment_action_required`.
   Copia el *signing secret* a `STRIPE_WEBHOOK_SECRET` (Preview).
4. **Settings → Billing → Subscriptions and emails → Manage failed payments**: elige
   qué hacer cuando fallen todos los reintentos (cancelar o marcar impagada). Ambos
   estados dejan la cuenta en solo lectura.

## 3. Prueba completa en staging

Tarjetas de test: `4242 4242 4242 4242` (aprobada), `4000 0000 0000 0341` (se guarda
pero los cobros fallan), `4000 0025 0000 3155` (pide autenticación). Cualquier fecha
futura y CVC.

| # | Paso | Resultado esperado |
|---|---|---|
| 1 | **Registro**: crear cuenta y empresa | Aviso "Prueba gratuita: quedan 7 días"; `/billing` → Estado "Prueba gratuita", plan Pro |
| 2 | Crear clientes y documentos | Funciona |
| 3 | **Suscripción durante la prueba**: Plan → Suscribirme (Básico) → tarjeta 4242 | Vuelve a `/billing?checkout=success`; en segundos: estado "Prueba gratuita" con fin = fin de la prueba original (no se cobra aún). En Stripe: suscripción `trialing` |
| 4 | **Pago**: terminar la prueba ya: `stripe subscriptions update <sub_id> -d trial_end=now` | Factura pagada; estado "Activa", fechas del periodo, límites de Básico |
| 5 | Límite: superar los clientes/documentos del plan (o bajar el límite en staging: `update billing_plans set max_clients = 1 where plan='basic'`) | Mensaje "Has alcanzado el máximo…" con enlace a planes |
| 6 | **Pago fallido**: Portal → cambiar tarjeta a 4000 0000 0000 0341; luego `stripe subscriptions update <sub_id> -d billing_cycle_anchor=now -d proration_behavior=none` | Estado "Pago pendiente", aviso de tarjeta; se puede seguir creando (gracia) |
| 7 | Recuperación: Portal → tarjeta 4242 → Stripe reintenta (o paga la factura desde el Dashboard) | Vuelve a "Activa"; aviso desaparece |
| 8 | **Cancelación**: Administrar suscripción → Cancelar | "Activa" + "se cancelará al final del periodo" con la fecha |
| 9 | **Expiración**: en el Dashboard, cancelar la suscripción **inmediatamente** (simula el fin del periodo) | Estado "Cancelada", **solo lectura**: no se pueden crear clientes/documentos; sí ver/imprimir/cobrar |
| 10 | Reactivar: Plan → Suscribirme | Nuevo Checkout (la prueba ya no se repite); vuelve a "Activa" |
| 11 | **Prueba que vence sin suscribirse** (otra empresa): en staging, `update company_subscriptions set app_trial_ends_at = now() - interval '1 minute' where company_id = '<id>'` | "Prueba finalizada", solo lectura |
| 12 | Webhook: Developers → Webhooks → endpoint → reenviar un evento ya entregado | 200 `duplicate: true`; nada cambia |

Para simular el tiempo real (renovaciones mensuales, fin de periodo) sin comandos:
Stripe → **Test clocks** → crear un reloj y un cliente en él; en staging, guarda ese
`cus_…` en `company_subscriptions.stripe_customer_id` de la empresa de prueba antes
del paso 3 (la app reutiliza el cliente guardado); después avanza el reloj.

Solo en **staging** se editan datos a mano (pasos 5 y 11). Nunca en producción.
