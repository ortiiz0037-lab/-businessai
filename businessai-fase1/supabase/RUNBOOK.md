# Runbook · Respaldo, ejecución y recuperación (0005–0011 y 0014a)

Proyecto: **businessai-dev** (única rama, marcada **PRODUCTION**). Ningún paso de
este documento lo ejecuta Claude: lo ejecuta el propietario, en este orden.

> Vercel Preview usa, salvo que se haya configurado otra cosa, el **mismo**
> proyecto Supabase. Probar en Preview = escribir en datos de producción.
> Usa una empresa de prueba propia y bórrala al terminar.

## 0. Antes de empezar

- [ ] PR #1 revisado. Recomendado (no obligatorio) desplegar antes el código de la
      app: la versión actual de `main` también funciona con 0005, pero con 0006 un
      borrado bloqueado mostraría el mensaje genérico en vez de "tiene pagos".
- [ ] Ventana de poco tráfico. Cada migración tarda < 1 s; si una tabla está
      ocupada aborta a los 5 s (`lock_timeout`) sin cambiar nada y se reintenta.

## 1. Respaldo

| # | Qué | Cómo | Contiene datos de clientes |
|---|---|---|---|
| 1a | Copia de la plataforma | Dashboard → Database → Backups. Comprueba qué ofrece tu plan (copias diarias / PITR); en algunos planes no hay copias descargables. Anota la hora de la última copia. | Sí |
| 1b | Volcado lógico propio | En **tu** ordenador, con **tu** contraseña de BD (no se comparte): `supabase db dump --db-url "<cadena de conexión>" -f schema.sql`, otra vez con `--data-only -f data.sql`, y con `--role-only -f roles.sql` (confirma las opciones con `supabase db dump --help`). | `data.sql`: sí |
| 1c | Estado de seguridad | Ya guardado: la salida de la inspección + `supabase/rollback/*.sql`, que recrean exactamente las políticas y privilegios inspeccionados. | No |
| 1d | Archivos de Storage | No es necesario: 0007 cambia políticas, no archivos. | — |

Guarda `data.sql` cifrado y **fuera del repositorio**.

## 2. Comprobaciones previas (solo lectura)

- [ ] `inspect/inspect_migration_state.sql` → qué migraciones están aplicadas de
      verdad (§8). **Ninguna fila `PARTIAL — review`.**
- [ ] `inspect/inspect_0007_preview.sql` → fila `summary`: `dropped=11,
      guard_failures=0, kept_non_ba=0, ba=0, stop=0` (§3 paso 2).
- [ ] `inspect/inspect_storage_policies.sql` → exporta el resultado a CSV
      (columnas `qual` / `with_check`) y guárdalo con el respaldo (§10).
- [ ] `inspect/inspect_relationship_integrity.sql` → todo `0` en las 4 primeras
      columnas (ver §5). Si no, **para** y revisa antes de seguir.
- [ ] (Para 0008, opcional) `inspect/inspect_definer_functions.sql` → guarda el
      código de `can_edit_company_profile` para la revisión.

## 3. Ejecución — orden seguro y lista única de comprobaciones

Cada archivo se pega completo en SQL Editor → Run. Una transacción por archivo:
si falla, no cambió nada → lee el mensaje `BA000x` y **para**.
Después de cada paso ejecuta `inspect/verify_after_migrations.sql`: devuelve una
fila; compárala con la columna "verify" (orden de columnas: ba_table_policies,
old_table_policies, audit_policies, payment_edit_policies, payments_editable,
truncate_grants, logo_bucket_policies, signature_policies,
signatures_bucket_private, logo_types_limited, payments_fk_no_action,
anon_can_edit_fn; vacío = NULL).

| Paso | Acción | verify esperado | Pruebas en la app (empresa de prueba) | Si falla |
|---|---|---|---|---|
| 0 | **Línea base** (antes de nada) | `0,12,4,2,t,12,11,0,,,f,t` | — | Si difiere, la BD cambió desde la inspección: **no sigas**; vuelve a inspeccionar |
| 1 | `0005_security_baseline.sql` | `10,0,2,0,f,0,11,0,,,f,t` | Login · Clientes: listar, buscar, crear · Documentos: crear factura y carta, abrir, "Marcar como enviada", "Marcar como pagada" · Pagos: aparece el pago y su enlace abre la factura · Borrar la carta (sin pagos) · Mi empresa: guardar con nombre legal vacío | `rollback/0005_rollback.sql` |
| 2 | `0007_storage_company_assets.sql` — **antes**: `inspect_0007_preview.sql` sin `STOP` y con `dropped=11`; **después**: aviso `BA0007: 11 storage policies dropped` | `10,0,2,0,f,0,2,0,,,f,t` | Mi empresa: subir logo PNG → se ve en un documento | `rollback/0007_rollback.sql` (ver §10: no recrea las 9 políticas sin efecto) |
| 3 | `0009_private_signatures.sql` | `10,0,2,0,f,0,2,3,t,t,f,t` | (código antiguo) subir logo PNG sigue funcionando · subir un SVG como logo → Storage lo rechaza | `rollback/0009_rollback.sql` |
| 4 | **Desplegar el código de PR #1** (merge → producción en Vercel) | igual que el paso 3 | §6.1 y §6.2: firma privada (URL `/object/sign/…`, `/object/public/…` falla, caduca a los 5 min), documentos e impresión con logo y firma | Revertir el despliegue en Vercel (la BD no cambia) |
| 5 | `0006_payments_document_fk.sql` | `10,0,2,0,f,0,2,3,t,t,t,t` | Borrar una factura **con** pago → "tiene pagos registrados"; el pago sigue en Pagos · borrar un documento sin pagos funciona | `rollback/0006_rollback.sql` |
| 6 | `0008_definer_function_grants.sql` | `10,0,2,0,f,0,2,3,t,t,t,f` | Repetir rápidamente el paso 1 | `rollback/0008_rollback.sql` |
| 7 | Firmas antiguas | — | §6.3: re-subir la firma y borrar `signature-*` de `Company-assets` | — |

Dependencias (verificadas en local):
- **Ninguna dependencia técnica entre las migraciones**: cada una se aplica sola
  sobre el estado inspeccionado, y el orden inverso da el mismo estado final.
- 0005, 0007 y 0009 usan `is_company_member` / `has_company_role` (0001).
  0007 y 0009 crean la misma función auxiliar `storage_company_id`.
- **El código de PR #1 necesita 0009** para subir firmas nuevas (antes: aviso
  "no configurado"; logos y firmas existentes siguen funcionando).
- **0006 es una decisión de negocio**: con el código antiguo de `main`, un borrado
  bloqueado muestra un mensaje genérico; con PR #1, el mensaje específico. Por eso
  va después del despliegue.
- Matriz de compatibilidad (20 operaciones de la app, código nuevo y antiguo, en
  cada paso): `tests/local/app_compat_expected.txt`. Únicos cambios: borrar un
  documento con pagos (borra los pagos hasta 0006; bloqueado desde 0006) y subir
  la firma privada (falla hasta 0009).

## 4. Recuperación

| Síntoma | Acción | Impacto en datos |
|---|---|---|
| Una migración da error | Nada que hacer: se revirtió sola. Guarda el mensaje. | Ninguno |
| La app falla tras un paso | Ejecuta el rollback de ese paso; si hace falta, los anteriores en orden inverso: 0008 → 0006 → (revertir despliegue) → 0009 → 0007 → 0005 | Ninguno: solo políticas, privilegios, la FK y límites de buckets |
| Datos dañados (no esperado: ninguna migración toca filas) | Restaurar desde 1a (copia/PITR) o importar `data.sql` en un proyecto nuevo y comparar antes de tocar producción | Según la copia |

Notas de los rollbacks:
- `0005_rollback.sql` devuelve exactamente las políticas y privilegios
  inspeccionados — **incluidos sus huecos**. Es solo para emergencias.
  No restaura `ALTER DEFAULT PRIVILEGES` (no estaba en la inspección).
- `0007_rollback.sql` restaura las 2 políticas de Storage que funcionaban; las 9
  que apuntaban a `company-assets`/`COMPANY-ASSETS` no se recrean (no tenían efecto).
- `0009_rollback.sql` quita las políticas de firmas y la limitación de tipos de
  `Company-assets`, pero **no borra** el bucket `Company-signatures` (puede tener
  firmas; sin políticas solo `service_role` puede acceder).
- `0007_rollback.sql` funciona también si 0009 sigue aplicado (conserva la
  función auxiliar que 0009 usa).
- Probado en local: tras cada rollback, en orden inverso, la base es idéntica a
  la de antes de esa migración (salvo las dos diferencias documentadas arriba).

## 5. Datos existentes que podrían mezclar empresas

`inspect/inspect_relationship_integrity.sql` (un solo SELECT, devuelve recuentos):

| Columna | Significa | Si es > 0 |
|---|---|---|
| `documents_with_client_of_other_company` | Documento cuyo cliente es de otra empresa | Revisar antes de 0005: 0005 no lo corrige, y editar ese documento fallará |
| `payments_with_document_of_other_company` | Pago cuyo documento es de otra empresa | Revisar antes de 0005 |
| `payments_without_created_by` | Pago sin autor (permitido hoy) | Informativo: 0005 lo exige solo en pagos nuevos |
| `payments_by_non_member` | Pago registrado por alguien que no es miembro de esa empresa | Revisar |
| `paid_invoices_without_payment` | Factura "pagada" sin pago | Informativo (marcadas a mano o antes de existir Pagos) |
| `documents_with_payments` | Documentos que 0006 impedirá borrar | Informativo |

Si alguno de los dos primeros no es 0, el siguiente paso sería una consulta de
solo lectura que liste esas filas (ids) para decidir cada caso; no se corrige
nada automáticamente.

## 6. Firmas privadas — despliegue y verificación

Orden: **0009 aplicado → desplegar el código (PR #1) → re-subir firmas → retirar
las firmas antiguas del bucket público.**

### 6.1 Que la firma ya no es pública
1. Mi empresa → sube una firma (PNG/JPG/WEBP). Mensaje: "Firma guardada de forma privada".
2. En Supabase → Table Editor → `company_profiles`, la columna `signature_url`
   de tu empresa empieza por `private:Company-signatures/`.
3. Storage → `Company-signatures`: el bucket aparece como **privado** y el
   archivo está en la carpeta `<company_id>/`, con un nombre aleatorio.
4. Abre un documento, clic derecho en la firma → copiar dirección de la imagen.
   La URL contiene `/object/sign/Company-signatures/...?token=...`.
5. Pega esa URL en una ventana privada: se ve. Espera **más de 5 minutos** y
   recarga: debe fallar (token expirado).
6. Cambia en la URL `/object/sign/` por `/object/public/` y quita `?token=...`:
   debe fallar (el bucket no es público).
7. Desde una terminal sin sesión:
   `curl -s -o /dev/null -w "%{http_code}\n" "https://<proyecto>.supabase.co/storage/v1/object/public/Company-signatures/<company_id>/<archivo>"`
   → **400 o 404**, nunca 200.
8. Con un usuario de **otra** empresa, abrir el documento no es posible (RLS), y
   una URL firmada no se puede generar para la carpeta ajena.

### 6.2 Que la generación de documentos sigue funcionando
1. Abre una factura, una cotización, una carta y una orden de trabajo: se ven
   el logo arriba y la firma abajo ("Firma autorizada").
2. "Imprimir / Guardar PDF": el PDF incluye logo y firma (la imagen ya está
   cargada; el token solo debe ser válido al abrir la página).
3. Si se abre un documento con la página cargada hace más de 5 min y se
   imprime, la firma ya está en pantalla y se imprime igual; si no aparece,
   recarga la página.
4. Empresa sin firma: el documento se genera sin la sección de firma.
5. Logo: sube un logo nuevo → aparece en los documentos; un SVG o HTML se
   rechaza en el navegador ("Formato no permitido") y, tras 0009, también en
   Storage.

### 6.3 Firmas antiguas (subidas antes del cambio)
- Siguen mostrándose en los documentos, y en Mi empresa aparece el aviso
  "Tu firma actual … está en almacenamiento público".
- Hasta que se re-suba, **esa firma sigue siendo pública**.
- Tras re-subirla: Storage → `Company-assets` → carpeta de la empresa → borra los
  archivos `signature-*` (Dashboard; las políticas no permiten borrar desde la app).
  Comprueba con el `curl` de 6.1.7 (sobre `Company-assets`) que devuelve 400/404.

## 7. 0014a (permisos) — comprobación previa de Storage (R3)

`storage.objects` es una sola tabla para **todos** los buckets, y en PostgreSQL
las políticas permisivas se suman (OR). Una política que no sea del repositorio
y no esté limitada a otro bucket seguiría dando acceso a `Company-assets` o a
las firmas privadas de `Company-signatures` por fuera de `has_permission()`.

**0014a se detiene sin cambiar nada** si encuentra una así, y la nombra
(`BA0014a: storage.objects policies that could reach the company buckets…`).
La comprobación se repite justo antes del `commit`. **Ni 0014a ni ningún script
borra políticas para R3**: cada hallazgo lo revisa el propietario.

### 7.1 Antes de aplicar 0014a (solo lectura)

1. SQL Editor → pega `inspect/inspect_storage_policies.sql` → Run. Devuelve una
   fila por política de `storage.objects`:
   | verdict | Significado | ¿Bloquea 0014a? |
   |---|---|---|
   | `repository` | una de las 5 políticas `ba_` (0007/0009/0014a) | No |
   | `allowed: limited to bucket …` | limitada a otros buckets; 0014a la conserva igual y la lista en un aviso | No |
   | `block: mentions Company-assets or Company-signatures` | otra política sobre los buckets de la empresa (cualquier mayúscula/minúscula) | **Sí** |
   | `block: no condition …` | sin condición: vale para todos los buckets | **Sí** |
   | `block: not limited by bucket …` | `true`, `OR`, `<>`, `lower(bucket_id)`, `with check (true)`… | **Sí** |
2. Si 0007 y 0009 aún no están aplicadas, las 11 políticas antiguas de logos
   salen como `block`: es lo esperado, **0007 las elimina** (revisado en §3,
   paso 2). Vuelve a ejecutar la inspección después de 0009.
3. La regla es conservadora: lo que no puede demostrar limitado a otro bucket lo
   bloquea. Solo se acepta `bucket_id = '…'` (o `bucket_id = ANY (ARRAY[…])`)
   sola o como una de las condiciones unidas con `AND`, en cada `USING` y
   `WITH CHECK`.

### 7.2 Qué hacer con una fila `block`

Decide tú, política por política, con las columnas `qual` / `with_check`:

- **Pertenece a otra función de la app/otro bucket** → reescríbela para que
  empiece por `bucket_id = '<bucket>' AND …` (Dashboard → Storage → Policies) y
  vuelve a ejecutar la inspección.
- **Es antigua o de pruebas** → bórrala tú en el Dashboard tras confirmarlo
  (anota su definición antes: `qual` / `with_check`).
- **Debe mantenerse tal cual** → no apliques 0014a; habría que llevarla al
  repositorio en una migración nueva y revisarla.

Repite 7.1 hasta que no quede ninguna fila `block`. Solo entonces aplica 0014a.

### 7.3 Después de aplicar 0014a

- `inspect/verify_0014a.sql` → debe devolver `OK`. Además de la matriz y las
  funciones, ahora informa de cualquier política de `storage.objects` que se
  bloquearía (p. ej. añadida después en el Dashboard) y de cualquier política
  desconocida en las 8 tablas de empresa.
- En Staging lo hace `staging:check` (solo lectura), que además lista cada
  política de Storage con su veredicto (`storage_policy: …`).
- Rollback: `rollback/0014a_rollback.sql` (no toca las políticas de otros buckets).

> 0010 y 0011: §9. Estado real antes de decidir el orden: §8. Cobertura de
> rollbacks y respaldos: §10. Bucket público `Company-assets`: §11.

## 8. Estado real de las migraciones en Production (antes de decidir el orden)

En Production las migraciones se pegan a mano en el SQL Editor: **no existe**
`ba_meta.applied_migrations` (esa tabla solo la crea `staging:migrate`). El estado
se deduce de lo que cada migración deja en el catálogo.

1. SQL Editor → `inspect/inspect_migration_state.sql` → Run (solo lectura).
   Devuelve una fila por migración: `status` (`applied` · `not applied` ·
   `PARTIAL — review` · `n/a`), `evidence` (lo medido) y `applied_when` (la regla).
2. Resultado esperado según la inspección del 2026-11-08: `0001–0004` →
   `applied`; `0005` … `0014a` → `not applied`; `staging bookkeeping` → `absent`.
3. Cómo decidir:

   | Resultado | Qué hacer |
   |---|---|
   | Todo `not applied` (lo esperado) | Empezar en §3 paso 0 (línea base `0,12,4,2,t,12,11,0,,,f,t`) |
   | Algunas `applied` | Continuar desde la primera `not applied` del orden de §3/§9; `verify_after_migrations.sql` debe coincidir con la fila del último paso aplicado |
   | Cualquier `PARTIAL — review` | **Parar.** Alguien cambió el esquema a mano o una migración se aplicó a medias (no debería: cada archivo es una transacción). Revisar la columna `evidence` antes de nada |
   | `staging bookkeeping` = `present` | **Parar**: esa base es Staging, no Production |
   | `0008` = `n/a` | La función `can_edit_company_profile` no existe; 0008 no hace nada (es normal en Staging) |

4. Guarda la salida (CSV) junto al respaldo: es la foto del "antes".

Validación local (escenario 21 de `tests/local/run.sh`): sobre la forma
inspeccionada da todo `not applied`; tras el camino completo, todo `applied`;
con 0010 sola, `0010 applied` y `0011 not applied`; sin un trigger de 0010,
`PARTIAL — review`.

## 9. 0010 (facturación) y 0011 (límites de uso) en Production

### 9.0 Decisión previa obligatoria (negocio)

**0010 cambia el comportamiento para las empresas que ya existen.** Añade
triggers `BEFORE INSERT` en `clients` y `documents`: un usuario solo puede crear
clientes o documentos si su empresa tiene una suscripción de Stripe en estado
`trialing`, `active` o `past_due`, y dentro de los límites del plan
(Básico 50 clientes / 40 documentos al mes / 1 usuario; Pro 500 / 300 / 3;
Premium sin límite / sin límite / 10). 0011 aplica lo mismo a los miembros nuevos.

- **Una empresa sin suscripción de Stripe queda sin poder crear clientes ni
  documentos** (`BILLING_INACTIVE`). Puede seguir leyendo, editando, imprimiendo
  y registrando pagos: nada se borra ni se modifica.
- Para que una empresa pueda suscribirse en Production hace falta Stripe **LIVE**
  configurado (productos, precios, webhook, Checkout). Eso **no está hecho** y
  requiere una autorización independiente.
- Antes de autorizar 0010 hay que decidir qué pasa con las empresas que hoy no
  tienen suscripción. Opciones (ninguna está preparada; cada una necesita su
  propia revisión): **(a)** aplicar 0010/0011 solo cuando Stripe LIVE y el alta de
  suscripciones estén listos y comunicados; **(b)** dar a las empresas existentes
  una suscripción o un periodo de gracia mediante una migración de datos revisada;
  **(c)** posponer 0010/0011 (el código de la PR #1 funciona sin ellas, pero sin
  aplicar planes ni límites: riesgo R1).

### 9.1 Requisitos técnicos

- 0001–0004 aplicadas e `is_company_member(uuid)` presente (0010 aborta si no).
- 0011 exige 0010 (aborta si no).
- 0010 no depende de 0005–0009, pero el único orden probado de principio a fin
  sobre la forma de Production es `0005 → 0007 → 0009 → 0006 → 0008 → 0010 →
  0011 → 0014a → 0015 → 0016` (escenarios 18, 20, 21, 22 y 23). 0015 (ciclo de
  vida de documentos, pagos parciales, recibos; ver su cabecera) exige 0014a.
  La app de la Fase A funciona sin 0015 (numera con el formato anterior y no
  ofrece aceptar / rechazar cotizaciones) y sin 0016 (aplica la regla de una
  prueba por persona desde las suscripciones, sin la protección de
  concurrencia de `claim_trial`), pero las reglas de integridad de documentos
  y pagos solo quedan garantizadas por la base de datos con 0015 aplicada.

### 9.2 Comprobaciones previas (solo lectura)

1. `inspect/inspect_migration_state.sql`: 0010 y 0011 `not applied`; ninguna
   `PARTIAL — review` (§8).
2. `inspect/inspect_0010_impact.sql` (solo recuentos, sin nombres ni importes):

   | Columna | Significado | Condición para seguir |
   |---|---|---|
   | `companies` | empresas existentes | — |
   | `BLOCKED_after_0010` | no podrán crear clientes/documentos | **Debe estar cubierto por la decisión de 9.0** |
   | `blocked_no_stripe_subscription` / `blocked_by_status` | por qué | — |
   | `by_status`, `by_plan` | reparto actual | — |
   | `plans_breaking_0010_fk` | filas con un plan fuera de basic/pro/premium | **0** (si no, 0010 falla y no cambia nada) |
   | `at_client_limit`, `at_document_limit_this_month` | ya en el límite: no podrán crear más | Revisar |
   | `over_member_limit_0011`, `cannot_add_members_0011` | por encima / en el límite de usuarios | Revisar (los existentes se conservan) |

3. `inspect/verify_after_migrations.sql`: anota la fila; 0010/0011 no la cambian.

### 9.3 Respaldo

Igual que §1 (copia de la plataforma o PITR + volcado lógico). Además, el
rollback de 0010 **borra columnas y tablas** (ver §10): cualquier dato escrito en
ellas después de aplicar 0010 se pierde si se revierte.

### 9.4 Ejecución de 0010

1. SQL Editor → `migrations/0010_billing.sql` completo → Run. Una transacción;
   aborta a los 5 s si una tabla está ocupada; autocomprobación final. Si da
   error, no cambió nada: guarda el mensaje y para.
2. Comprobaciones (solo lectura):
   ```sql
   select plan, max_clients, max_documents_per_month, max_members
     from public.billing_plans order by sort_order;          -- 3 filas: basic 50/40/1, pro 500/300/3, premium -/-/10
   select trial_days from public.billing_config;             -- 7
   select tgname from pg_trigger where not tgisinternal and tgname like 'ba\_%' order by 1;
     -- ba_enforce_billing_clients, ba_enforce_billing_documents, ba_keep_trial_consumed
   select has_table_privilege('authenticated', 'public.company_subscriptions', 'INSERT,UPDATE,DELETE'), -- false
          has_function_privilege('anon', 'public.company_billing_state(uuid)', 'EXECUTE');          -- false
   ```
   `inspect_migration_state.sql` → `0010_billing` = `applied`.
3. Pruebas en la app (empresa de prueba propia, borrarla al terminar): con
   suscripción activa crea un cliente y un documento; sin suscripción aparece
   el bloqueo; leer, editar, imprimir y registrar un pago siguen funcionando.

### 9.5 Ejecución de 0011

1. SQL Editor → `migrations/0011_usage_limits.sql` → Run.
2. Comprobaciones (solo lectura):
   ```sql
   select usage_warning_percent, usage_upgrade_percent from public.billing_config;  -- 80, 90
   select has_function_privilege('anon', 'public.company_usage(uuid)', 'EXECUTE'),          -- false
          has_function_privilege('authenticated', 'public.company_usage_window(uuid)', 'EXECUTE'); -- false
   select count(*) from pg_trigger where not tgisinternal and tgname = 'ba_enforce_member_limit'; -- 1
   ```
   `inspect_migration_state.sql` → `0011_usage_limits` = `applied`.
3. Pruebas en la app: el panel muestra los avisos de uso al 80 / 90 / 100 %.

### 9.6 Si algo falla después

Revertir en orden inverso: `rollback/0011_rollback.sql` y luego
`rollback/0010_rollback.sql` (consecuencias en §10). Stripe conserva las
suscripciones: se pueden volver a sincronizar.

## 10. Cobertura de rollbacks y respaldos

| Paso | Rollback | Qué restaura exactamente | **No se restaura automáticamente** | Cómo cubrirlo |
|---|---|---|---|---|
| 0005 | `0005_rollback.sql` | Las 12 políticas antiguas y las 2 duplicadas de auditoría, con su texto inspeccionado; UPDATE/DELETE en pagos; TRUNCATE inspeccionado | `ALTER DEFAULT PRIVILEGES` (TRUNCATE en tablas futuras): no estaba en la inspección | Sin efecto en tablas existentes. Volcado de roles (§1b) |
| 0007 | `0007_rollback.sql` | Las 2 políticas que funcionaban (`company_assets_read` / `_upload`) | **Las 9 políticas sin efecto** (`company-assets` / `COMPANY-ASSETS`), incluidas las de nombre con caracteres invisibles | CSV de `inspect_storage_policies.sql` (`qual` / `with_check`) guardado antes: permite recrearlas a mano. No tenían efecto sobre el bucket real |
| 0009 | `0009_rollback.sql` | Quita las 3 políticas de firmas; `Company-assets` vuelve a admitir cualquier tipo (`allowed_mime_types = NULL`, lo inspeccionado) | **El bucket `Company-signatures` y sus archivos** (no se borra a propósito) | Sin políticas, solo `service_role` accede. Borrarlo (si está vacío) es un paso manual del Dashboard |
| 0006 | `0006_rollback.sql` | `ON DELETE CASCADE` exacto | — | — |
| 0008 | `0008_rollback.sql` | `EXECUTE` de `anon` en `can_edit_company_profile` | — | — |
| 0010 | `0010_rollback.sql` | Quita triggers, funciones, FK, tablas `billing_plans` / `billing_config` y las 9 columnas nuevas | **Datos escritos en esas columnas/tablas** tras aplicar (fechas de Stripe, `trial_consumed_at` = una prueba por empresa, cambios de límites). Los `revoke` sobre `company_subscriptions` no se deshacen, pero con los privilegios inspeccionados (authenticated: solo SELECT; TRUNCATE ya quitado por 0005) no cambian nada | Volcado de datos antes (§1b). Stripe conserva las suscripciones (re-sincronizables) |
| 0011 | `0011_rollback.sql` | Quita uso, límite de miembros, umbrales; restaura `company_billing_state` de 0010 | Cambios hechos a los umbrales | Volcado de datos |
| 0014a | `0014a_rollback.sql` | Catálogo idéntico al anterior (probado con huella del catálogo, incluso tras aplicar dos veces) | Se niega si hay membresías suspendidas o la tabla de invitaciones (E4) | No hay suspensiones hasta E4 |
| 0015 | `0015_rollback.sql` | Catálogo idéntico a 0014a cuando no hay historial (probado con huella). Con datos: documentos, números, estados, anulaciones, pagos y recibos **se conservan** (probado). Quita contadores, triggers, funciones, la clave de idempotencia y el estado `accepted`/`rejected` | **`document_events` se conserva si tiene historial** (a propósito: trazabilidad); se niega si hay cotizaciones `accepted`/`rejected`. Tras el rollback las reglas vuelven a depender de la app | Reaplicar 0015 reutiliza el historial y continúa la numeración (probado) |
| 0027 | `0027_rollback.sql` | Catálogo idéntico a 0026 (probado con huella) | Se niega si hay presupuestos, historial, supuestos o cuentas clasificadas | Exportar informes; los estados se recalculan, no se pierden |
| 0028 | `0028_rollback.sql` | Catálogo idéntico a 0027 (probado con huella); quita el bucket Studio-assets y los permisos `studio.*` | Se niega si hay documentos, plantillas, identidad, imágenes (filas o archivos) o historial de Document Studio | Exportar los PDF emitidos; los documentos comerciales no se tocan |
| 0029 | `0029_rollback.sql` | Catálogo idéntico a 0028 (probado con huella); quita los permisos `assistant.*` | Se niega si hay conversaciones, acciones, consumo o auditoría del asistente | Ninguna: los borradores creados con el asistente pertenecen a Document Studio |
| 0030 | `0030_rollback.sql` | Catálogo idéntico a 0029 (probado con huella); devuelve a `authenticated` las funciones de 0029 | Se niega si hay turnos, claves de servidor, costos registrados o acciones con los estados nuevos | Ninguna: los datos del asistente siguen en las tablas de 0029 |
| 0026 | `0026_rollback.sql` | Catálogo idéntico a 0025 (probado con huella; restaura `ledger_post_payment`) | Se niega si hay cuentas bancarias, movimientos, conciliaciones, asientos bancarios o cobros con cuenta de depósito | Exportar informes; no hay vuelta atrás con datos |
| 0025 | `0025_rollback.sql` | Catálogo idéntico a 0024 (probado con huella; restaura las funciones de 0015/0023) | Se niega si hay pagos anulados o registros de cobro (notas, promesas, recordatorios, estados) | Exportar informes; no hay vuelta atrás con datos |
| 0024 | `0024_rollback.sql` | Catálogo idéntico a 0023 (probado con huella; restaura la restricción de orígenes y el trigger de líneas) | Se niega si hay proveedores, facturas, recurrentes, asientos de proveedores o archivos adjuntos | Exportar informes; no hay vuelta atrás con datos |
| 0023 | `0023_rollback.sql` | Catálogo idéntico a 0022 (probado con huella) | Se niega si hay asientos, periodos o cuentas propias (los registros contables son evidencia) | Exportar informes; no hay vuelta atrás con asientos |
| 0022 | `0022_rollback.sql` | Catálogo idéntico a 0021 (probado con huella) | Se niega si hay alertas de comida o empleados asignados a grupos | Exportar informes; reasignar empleados a los valores de la empresa |
| 0021 | `0021_rollback.sql` | Catálogo idéntico a 0020 (probado con huella); restaura la cancelación de correcciones de 0020 | Se niega si hay ponches hechos en quiosco; quioscos y PIN se eliminan (son configuración) | Exportar antes los informes |
| 0020 | `0020_rollback.sql` | Catálogo idéntico a 0019 (probado con huella) sin datos de personal | **Se niega mientras existan empleados, ponches, correcciones, permisos o turnos** (son evidencia laboral): exportar primero | Exportar informes (CSV) y decidir qué conservar |
| 0019 | `0019_rollback.sql` | Catálogo idéntico (probado con huella, junto con 0018) | Se niega si hay clientes archivados o documentos con idioma elegido; `client_events` se conserva si tiene historial | Decidir antes esos datos |
| 0018 | `0018_rollback.sql` | Catálogo idéntico a 0017 (probado con huella); restaura el trigger de límite de miembros de 0011 | Se niega si hay invitaciones pendientes vigentes; las membresías aceptadas se conservan; `team_events` se conserva si tiene historial | Revocar invitaciones antes |
| 0017 | `0017_rollback.sql` | Catálogo idéntico a 0016 (probado con huella) | Se niega si existen las tablas de empleados o sucursales (fases posteriores) | Revertir primero esos módulos |
| 0016 | `0016_rollback.sql` | Catálogo idéntico a 0011 (probado con huella): `company_billing_state` de 0011 y `enforce_billing_limits` de 0010 | **`trial_claims`** (quién reclamó una prueba): tras el rollback la prueba vuelve a ser por empresa | Volcado de datos antes (§1b) |
| Despliegue | Revertir el despliegue en Vercel | Código anterior | — | La base de datos no cambia |

Respaldo (§1), puntos a tener en cuenta:
- **Ninguna migración mueve ni borra archivos de Storage**, y los volcados de base
  de datos no contienen archivos.
- Comprueba con `supabase db dump --help` qué esquemas incluye el volcado: los
  esquemas gestionados por Supabase (como `storage`) pueden quedar fuera. Por eso
  el CSV de `inspect_storage_policies.sql` es parte obligatoria del respaldo.
- La copia de la plataforma o PITR depende del plan: anota qué ofrece el tuyo y
  la hora de la última copia antes de empezar.

## 11. Bucket público `Company-assets` (decisión independiente)

**Situación (inspección + código):** bucket público, 5 MB, cualquier tipo de
archivo hasta 0009. Las políticas solo controlan **listar y subir** por la API
(owner/admin de su empresa; nadie lista sin sesión). **Descargar no pasa por
RLS**: cualquiera con la URL `/storage/v1/object/public/Company-assets/<ruta>`
obtiene el archivo. Ninguna migración cambia esto.

| Riesgo | Gravedad | Detalle |
|---|---|---|
| **Firmas antiguas públicas** | **Alta** | El código de `main` guarda la firma en este bucket público como `<empresa>/signature-<marca de tiempo>.<ext>`, y su URL va dentro de cada documento enviado. Quien reciba un documento puede reutilizar la imagen de la firma. 0009 + la PR #1 llevan las firmas **nuevas** a un bucket privado, pero las existentes siguen públicas hasta borrarlas (§6.3) |
| Archivos activos (HTML/SVG) | Media hasta 0009 | Sin límite de tipos, un owner/admin podría alojar HTML/SVG en el dominio de Storage del proyecto. 0009 limita a PNG/JPEG/WEBP |
| Logos | Baja | Son públicos por naturaleza: aparecen en los documentos que se envían a clientes |
| Rutas adivinables | Baja | `main` usa `<empresa>/<tipo>-<milisegundos>`; la PR #1 usa un UUID aleatorio. Listar sigue prohibido sin sesión |

Recuento de solo lectura (sin nombres de archivo):
```sql
select count(*) filter (where name ~ '/signature-') as firmas_publicas,
       count(*) filter (where name ~ '/logo-')      as logos,
       count(*)                                     as total
from storage.objects where bucket_id = 'Company-assets';
```

**Recomendación** (independiente de 0010/0011/0014a):
1. **Mantener `Company-assets` público solo para logos.** Hacerlo privado exigiría
   URLs firmadas en documentos, impresión, PDF y correos (caducan), un cambio de
   producto que hoy no compensa para imágenes que ya se muestran a clientes.
2. **Prioridad: retirar las firmas públicas.** Tras 0009 y el despliegue de la
   PR #1, cada empresa vuelve a subir su firma (queda en el bucket privado);
   después se borran los `signature-*` de `Company-assets` (§6.3). Borrar
   archivos es una acción aparte, con su propia autorización.
3. **Aplicar 0009** para limitar los tipos de archivo.
4. Revisar de nuevo si en el futuro los logos pasan a considerarse confidenciales.

## 12. Correo de recuperación de contraseña (hallazgo I10) — cambio pendiente fuera del repositorio

La app ya no construye enlaces a partir del encabezado `Host`: usa
`NEXT_PUBLIC_APP_URL` (obligatoria en Production; sin ella el correo no se
envía y se registra `PASSWORD_RESET_ORIGIN_MISSING`) o, en Preview, la URL que
da Vercel (`VERCEL_URL`).

El enlace por defecto de Supabase usa PKCE y solo funciona en el mismo
navegador donde se pidió. `/auth/confirm` ya acepta el formato `token_hash`,
que funciona en cualquier navegador. Para usarlo hay que cambiar la plantilla
**Reset password** en Supabase → Authentication → Email Templates (cambio en
un entorno remoto: requiere autorización; no se ha hecho):

```
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password">Crear una nueva contraseña</a>
```

Mientras no se cambie, un enlace abierto en otro navegador lleva a
`/forgot-password?error=link`, que explica cómo pedir uno nuevo.

## 13. Decisiones de negocio pendientes (documentadas, no inventadas)

| Tema | Qué hace hoy el sistema | Decisión pendiente |
|---|---|---|
| Número de empresas por persona (C3) | Sin límite; la prueba gratuita es **una por persona** (0016 + app) y cada empresa nueva paga desde el primer día | ¿Limitar cuántas empresas puede crear una cuenta? |
| Recibos y cuota mensual (I8) | 0016: los recibos **no** consumen la cuota (son consecuencia de un pago de una factura que ya contó); siguen exigiendo suscripción activa | Confirmar esta regla comercial antes de aplicar 0016 |
| Facturas con pagos | No se pueden anular (`DOCUMENT_HAS_PAYMENTS`) | Notas de crédito (Fase D) |
| Zona horaria | Numeración, fechas de pago y vencimientos usan `America/Puerto_Rico` (empresas existentes) | Zona por empresa cuando se elija en la configuración |
