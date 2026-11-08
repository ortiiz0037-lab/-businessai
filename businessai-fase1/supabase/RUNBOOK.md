# Runbook · Respaldo, ejecución y recuperación (0005–0009)

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

## 3. Ejecución — orden seguro

Cada archivo se pega completo en SQL Editor → Run. Si falla, no ha cambiado nada
(una transacción por archivo): lee el mensaje `BA000x` y para.
Tras cada paso: `inspect/verify_after_migrations.sql` y las pruebas de la app.

| Paso | Archivo | Esperado en `verify_after_migrations.sql` | Prueba en la app |
|---|---|---|---|
| 1 | `migrations/0005_security_baseline.sql` | `ba_table_policies=10`, `old_table_policies=0`, `audit_policies=2`, `payment_edit_policies=0`, `payments_editable=false`, `truncate_grants=0` | Login · lista y alta de clientes · crear factura · marcar como pagada · página Pagos y enlace al documento · borrar un documento **sin** pagos |
| 2 | `migrations/0007_storage_company_assets.sql` | `logo_bucket_policies=2` | Mi empresa → subir logo · ver el logo en un documento |
| 2b | `migrations/0009_private_signatures.sql` | `signature_policies=3`, `signatures_bucket_private=true`, `logo_types_limited=true` | Ver §6 |
| 3 | `migrations/0006_payments_document_fk.sql` | `payments_fk_no_action=true` | Borrar una factura **con** pago → mensaje "tiene pagos registrados"; el pago sigue en Pagos |
| 4 | `migrations/0008_definer_function_grants.sql` | `anon_can_edit_fn=false` | Igual que el paso 1 (nada usa la función) |

Por qué este orden: 0005 cierra los huecos más graves y no depende de nada; 0007
es independiente pero toca una tabla gestionada por Supabase; 0009 debe aplicarse
**antes de desplegar** el código de firmas privadas (sin el bucket, las firmas
nuevas no se pueden subir; logos y firmas existentes siguen funcionando); 0006
cambia el comportamiento del borrado (requiere aceptar ese cambio); 0008 es el de
menor impacto.

## 4. Recuperación

| Síntoma | Acción | Impacto en datos |
|---|---|---|
| Una migración da error | Nada que hacer: se revirtió sola. Guarda el mensaje. | Ninguno |
| La app falla tras el paso N | Ejecuta `rollback/<N>_rollback.sql`; si hace falta, los anteriores en orden inverso: 0008 → 0006 → 0009 → 0007 → 0005 | Ninguno: solo políticas, privilegios, la FK y límites de buckets |
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
- Probado en local: aplicar 0005→0007→0009→0006→0008 y revertir
  0008→0006→0009→0007→0005 deja la base idéntica a la inspección (61
  comprobaciones; Storage = 2 políticas).

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
