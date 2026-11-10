# Runbook · Respaldo, ejecución y recuperación (0005–0009, y R3 de 0014a)

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
| 2 | `0007_storage_company_assets.sql` | `10,0,2,0,f,0,2,0,,,f,t` | Mi empresa: subir logo PNG → se ve en un documento | `rollback/0007_rollback.sql` |
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

> Este documento cubre 0005–0009 y la comprobación R3 de 0014a. El orden y las
> pruebas de 0010, 0011 y 0014a en Production se prepararán por separado antes de
> su ejecución.
