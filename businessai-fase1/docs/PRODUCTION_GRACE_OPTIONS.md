# Empresas existentes sin suscripción — opciones antes de la fase 2 (decisión del propietario)

> Documento de decisión. **Nada de esto se ha ejecutado.** La fase 2 de `docs/PRODUCTION_MIGRATION_PLAN.md`
> (0010 en adelante) no puede empezar sin esta decisión: `scripts/production/migrate.sh` rechaza cualquier
> migración de la fase 2 si la variable `PRODUCTION_PHASE2_DECISION` del Environment `production` no es `a` o `b`.

## Qué cambia 0010 para las empresas que ya existen

- 0010 añade triggers `BEFORE INSERT` en `clients` y `documents`: crear un cliente o un documento exige una
  suscripción de Stripe en estado `trialing`, `active` o `past_due`, y dentro de los límites del plan
  (Básico 50 clientes / 40 documentos al mes / 1 usuario; Pro 500 / 300 / 3; Premium sin límite / sin límite / 10).
  0011 hace lo mismo con los miembros nuevos.
- Una empresa **sin suscripción** sigue pudiendo **leer, editar, imprimir y registrar pagos**. **No se borra ni
  se modifica ningún dato** (ensayado: escenario 53 y `scripts/production/rehearse-local.sh`, sumas de contenido
  idénticas). Lo único que pierde es **crear** clientes, documentos y miembros (`BILLING_INACTIVE`).
- Para suscribirse en Production hace falta **Stripe LIVE** (productos, precios, webhook, Checkout), que no está
  configurado y tiene su propia autorización.
- Cada empresa tiene **una** prueba de 7 días con tarjeta (`trial_consumed_at` vacío en las existentes: la
  conservan).
- **Cuántas empresas afecta**: lo da `inspect_0010_impact.sql` en la reinspección de solo lectura
  (`production:inspect`). Para no publicar cifras del negocio en un repositorio público, esos recuentos quedan en
  el paquete **cifrado** de la reinspección; usted los descifra con su clave (`openssl enc -d -aes-256-cbc -pbkdf2
  -iter 600000 -in …enc -out inspeccion.tar`).

## Opciones

| | **(a) Aplicar con Stripe LIVE listo y aviso previo** | **(b) Periodo de gracia para las existentes** | **(c) Posponer la fase 2** |
|---|---|---|---|
| Qué pasa al aplicar | Las empresas sin suscripción dejan de crear hasta suscribirse (prueba de 7 días con tarjeta, sin cobro si cancelan) | Siguen creando con límites de un plan elegido (p. ej. Pro) hasta una fecha; después, las reglas normales | Nada cambia para los usuarios |
| Código nuevo | Ninguno | **Una migración nueva revisada** (p. ej. `0046_legacy_grace`): tabla de concesiones por empresa con fecha de fin y plan, y `company_billing_state` que la tenga en cuenta. Más un aviso en la app («gracia hasta …, suscríbete») y sus pruebas | Ninguno |
| Pruebas antes | Las existentes (Stripe TEST 25/25, ensayo de Production) | Ensayo local y en Staging de la nueva migración y de su rollback; caducidad automática probada; que una suscripción real sustituya a la gracia | — |
| Stripe LIVE | Obligatorio **antes** de aplicar 0010 | Obligatorio **antes de que acabe** la gracia | No hace falta todavía |
| Despliegue de PR #1 | En la misma ventana | En la misma ventana | **No es posible**: PR #1 necesita el esquema completo (0010–0045) y 0011+ dependen de 0010 |
| Riesgo técnico | Bajo (camino probado) | Medio (código nuevo en el control de acceso; debe caducar sin intervención) | Ninguno nuevo; la app actual sigue igual |
| Consecuencia de negocio | Fricción inmediata: piden tarjeta; posible abandono; hace falta comunicar con antelación y soporte | Sin fricción al cambiar; más tiempo para comunicar; ingresos aplazados; hay que comunicar el fin de la gracia | El lanzamiento comercial (planes, límites, módulos nuevos) se retrasa; solo puede ir la fase 1 (seguridad) |
| Valor de `PRODUCTION_PHASE2_DECISION` | `a` | `b` (el script además exige que exista la migración de gracia revisada) | No se crea: la fase 2 no se ejecuta |

Variante de (b): concesión **sin fecha de fin** para las empresas piloto (plan gratuito permanente). Mismo
mecanismo; renuncia a ingresos de esas empresas y conviene limitarla a una lista explícita.

## Recomendación

- **(a)** si las empresas actuales son pocas y de confianza (pilotos): se les avisa, se activa Stripe LIVE y en la
  misma ventana se aplican 0010–0045 y se despliega PR #1. Es el camino ya probado y no añade código al control de
  acceso.
- **(b)** si hay usuarios reales que dependen de crear documentos a diario y no conviene pedirles tarjeta de
  inmediato. Supone preparar, revisar y ensayar una migración nueva antes de la ventana.
- **(c)** solo si el lanzamiento puede esperar; mientras tanto la fase 1 (seguridad) puede aplicarse sola.

La decisión depende del número y del tipo de empresas existentes: conviene tomarla después de la reinspección.
