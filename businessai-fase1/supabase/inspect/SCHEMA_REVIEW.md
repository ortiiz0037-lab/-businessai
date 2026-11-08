# Revisión del esquema real · businessai-dev

Fuente: salida de `inspect_security_baseline.sql` proporcionada por el propietario
(PostgreSQL **17.11**, inspección del 2026-11-08 03:24 UTC). El proyecto tiene una
sola rama, marcada **PRODUCTION**. Nada de lo descrito aquí se ha aplicado.

## 1. Políticas RLS

| Tabla | Políticas actuales | Problema | Decisión (0005) |
|---|---|---|---|
| `clients` | `clients_{select,insert,update,delete}_own_company` | Cualquier miembro puede borrar. | Sustituidas por `ba_clients_*` (misma regla de empresa; borrar = owner/admin). |
| `documents` | `documents_{select,insert,update,delete}_own_company` | Un documento puede apuntar a un cliente de **otra** empresa. Cualquier miembro puede borrar. | Sustituidas por `ba_documents_*`: se conserva la regla `created_by` del insert; `client_id` debe ser de la misma empresa; borrar = owner/admin. |
| `payments` | `payments_{select,insert,update,delete}_own_company` | **Los pagos se pueden editar y borrar.** El insert no exige `created_by` ni que el documento sea de la misma empresa. | `ba_payments_select` + `ba_payments_insert` (documento de la misma empresa, `created_by = auth.uid()`). **Sin políticas update/delete.** |
| `document_deletion_audit` | `audit_insert_company`, `audit_select_company`, `Members can insert deletion audit`, `Members can view deletion audit` | Las dos últimas son **duplicados exactos** de las dos primeras. | Se eliminan los duplicados; se conservan `audit_*`. |
| `companies`, `memberships`, `company_profiles`, `company_subscriptions` | Las de 0001/0003/0004 | Correctas. | Sin cambios. |

No hay políticas `permissive` con `using (true)` ni para `anon`. 0005 aborta si
encuentra cualquier política que no estuviera en la inspección.

## 2. Pagos

- Hoy `authenticated` tiene UPDATE y DELETE sobre `payments` y existen políticas
  que lo permiten → 0005 revoca ambos privilegios y elimina esas políticas.
- **`payments_document_id_fkey` es `ON DELETE CASCADE`**: borrar un documento
  borra sus pagos. Las acciones de FK se ejecutan como propietario de la tabla,
  así que esto **salta RLS y los privilegios** (reproducido en las pruebas).
  → Borrador separado **0006**: `ON DELETE NO ACTION`. Un documento con pagos
  deja de poder borrarse (la app ya muestra un mensaje específico). Borrar una
  empresa entera sigue funcionando.

## 3. TRUNCATE

RLS no se aplica a TRUNCATE.

| Rol | Tablas con TRUNCATE hoy |
|---|---|
| `anon` | `clients`, `documents`, `payments`, `document_deletion_audit` |
| `authenticated` | las 8 tablas de `public` salvo `stripe_events` |

PostgREST no expone TRUNCATE, así que no es explotable desde la API pública;
sí desde cualquier conexión SQL con esos roles. 0005 lo revoca en todas las
tablas de `public` y en las futuras creadas por `postgres`.

## 4. Funciones

| Función | SECURITY | search_path | anon | Uso en políticas | Uso en la app |
|---|---|---|---|---|---|
| `can_edit_company_profile(target_company_id uuid)` | DEFINER | `""` | **sí** | ninguno | ninguno |
| `create_company(text)` | DEFINER | `""` | no | — | onboarding |
| `has_company_role(uuid, text[])` | DEFINER | `""` | no | sí | — |
| `is_company_member(uuid)` | DEFINER | `""` | no | sí | — |
| `delete_document_with_audit(uuid, text)` | INVOKER | `public` | no | — | ninguno |

`can_edit_company_profile` es ejecutable por `anon`. **Su código no ha sido
revisado**: la inspección no incluye código fuente y
`inspect_definer_functions.sql` no se ha ejecutado.

- **Revocar EXECUTE a `anon` es seguro sea cual sea su código:** ninguna política
  la usa (inspección), la app no la llama (solo `rpc('create_company')`) y
  `authenticated` conserva el permiso → borrador **0008**.
- **Lo que no se puede afirmar sin el código:** si el permiso ya expuso algo.
  Con `search_path=""` y `auth.uid()` nulo para `anon`, una implementación
  típica devuelve `false`. Sería un problema si el cuerpo (a) no depende de
  `auth.uid()` (revelaría qué empresas existen), (b) escribe en tablas, o
  (c) llama a otras funciones con efectos.

`delete_document_with_audit` es INVOKER con `search_path=public` (mutable).
No es de alto riesgo por ser INVOKER, pero conviene fijarlo cuando se revise.

## 5. Storage (`Company-assets`, público, 5 MB)

Los `bucket_id` distinguen mayúsculas. De las 11 políticas sobre `storage.objects`:

- **9 nunca coinciden**: usan `'company-assets'` o `'COMPANY-ASSETS'`. Una de ellas
  (`Authenticated users can upload company assets`) permitiría subir a cualquier
  miembro, si el nombre coincidiera.
- **2 funcionan**: `company_assets_read` (select) y `company_assets_upload`
  (insert), solo owner/admin de la carpeta `<company_id>/`.
- La inspección muestra `Company assets update kgntv7_0` y `_1` **dos veces** con
  el mismo nombre; PostgreSQL no lo permite, así que los nombres reales difieren
  (probablemente caracteres invisibles). 0005 identifica estas políticas por su
  contenido, no por su nombre.

**0007** (antes dentro de 0005) elimina las 11 y crea `ba_company_assets_select` /
`ba_company_assets_insert` con **la misma regla que hoy** (owner/admin, solo
select + insert). No se añaden políticas de update/delete ni se cambia que el
bucket sea público.

### ¿Protegen los permisos actuales los archivos?

**Solo en parte.** Las políticas controlan *listar* y *subir* mediante la API;
la **lectura** de un bucket público no pasa por RLS: cualquiera con la URL
`/storage/v1/object/public/Company-assets/<ruta>` descarga el archivo sin sesión.

| Acción | ¿Quién puede? |
|---|---|
| Subir a `<empresa>/…` | Solo owner/admin de esa empresa ✔ |
| Listar los archivos de una empresa | Solo owner/admin de esa empresa ✔ (anon no tiene política) |
| Sobrescribir / borrar por la API | Nadie (no hay políticas update/delete) ✔ |
| **Descargar un archivo conociendo su URL** | **Cualquiera** ✘ |

Consecuencias:
- **Logo:** está bien que sea público; aparece en los documentos que se envían.
- **Firma:** es sensible y **también es pública**. La ruta es
  `<company_id>/signature-<milisegundos>.<ext>`. El `company_id` aparece en la URL
  del logo de cualquier documento compartido, y la marca de tiempo de la firma
  suele estar a minutos de la del logo, así que la URL de la firma se puede
  adivinar probando marcas de tiempo cercanas (del orden de 10⁵ intentos).
- `allowed_mime_types` es nulo: un owner/admin puede subir cualquier tipo de
  archivo (p. ej. HTML o SVG) y servirlo públicamente desde el dominio de Storage.

Correcciones recomendadas (cambian configuración o código; no incluidas en las
migraciones, requieren aprobación aparte):
1. Firmas en un **bucket privado** y servirlas con URLs firmadas de corta
   duración al generar el documento (cambio en `CompanyBranding.tsx` y en la vista
   del documento).
2. Nombres de archivo con un componente aleatorio (`crypto.randomUUID()`) en vez
   de solo la marca de tiempo.
3. `allowed_mime_types` = `image/png, image/jpeg, image/webp` en `Company-assets`
   (Dashboard → Storage → bucket → Edit). No incluir `image/svg+xml`.

## 6. Relaciones

```
companies ─┬─< memberships            (CASCADE)
           ├─< clients                (CASCADE)
           ├─< documents              (CASCADE) >── clients (SET NULL)
           ├─< payments               (CASCADE) >── documents (CASCADE → 0006: NO ACTION)
           ├── company_profiles       (CASCADE)
           ├── company_subscriptions  (CASCADE)
           └─< document_deletion_audit (RESTRICT)
auth.users ─< companies.created_by (RESTRICT), payments.created_by (NO ACTION),
              documents.created_by (SET NULL), audit.deleted_by (SET NULL),
              memberships.user_id (CASCADE)
```

Observaciones:
- Ninguna FK garantiza que `payments.company_id = documents.company_id` ni que
  `documents.company_id = clients.company_id`; 0005 lo impone para los usuarios
  de la app vía RLS. Los datos ya existentes se pueden comprobar con
  `inspect_relationship_integrity.sql` (opcional, solo recuentos).
- `document_deletion_audit → companies` es RESTRICT: una empresa con registros de
  auditoría no se puede borrar.
- `companies.created_by` (RESTRICT) y `payments.created_by` (NO ACTION) impiden
  borrar un usuario de Auth que haya creado una empresa o registrado un pago.
- `payments.document_id` es NOT NULL: cada pago pertenece a un documento.

## 7. Índices

Ya existen todos los índices por empresa que 0005 habría creado, así que 0005 ya
no crea índices. Redundantes (no se tocan): `company_subscriptions_company_idx`
(duplica el índice único de `company_id`) y `clients_company_id_idx` (prefijo de
`clients_company_name_idx`).
