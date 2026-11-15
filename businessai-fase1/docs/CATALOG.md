# BusinessAI · Catálogo de productos y servicios (entrega S3, migración 0039)

**Estado:** borrador local. La migración `0039_catalog.sql` **no está aplicada en
ningún entorno** (Staging ni Production). Marca `STAGING-GATE`. Aplicarla en
Staging requiere la autorización del propietario.

## Qué resuelve

Un catálogo por empresa con los precios y unidades de lo que se vende o se
compra. Lo usan las facturas, las cotizaciones y las tablas de Document Studio,
y es la base del inventario. **No hay existencias, movimientos ni costos todavía.**

## Modelo

| Tabla | Qué guarda |
|---|---|
| `catalog_items` | Código (único por empresa, sin distinguir mayúsculas; los archivados también cuentan), nombre, descripción, tipo (producto / servicio), unidad, **precio en centavos enteros**, impuesto propio opcional (vacío: el del documento), «controlará inventario» (solo productos), estado (activo / archivado), versión |
| `catalog_events` | Historial de solo anexar: creado, editado (solo los campos que cambiaron, antes y después), archivado, restaurado |

- **Escrituras solo por funciones** (`catalog_save`, `catalog_set_status`,
  `SECURITY DEFINER`, `search_path` vacío): comprueban `catalog.manage` en la
  empresa del artículo, el código, los límites y la **versión** (dos personas
  editando a la vez: la segunda recibe «otra persona cambió este artículo», no
  pisa los cambios).
- **Nunca se borra** un artículo mientras exista la empresa: se archiva. Un
  archivado no se edita ni se ofrece en documentos nuevos, y su código no se
  reutiliza. Borrar la empresa sí borra su catálogo.

## Permisos

| Permiso | Propietario | Administrador | Miembro |
|---|---|---|---|
| `catalog.view` (leer y usar en documentos) | ✓ | ✓ | ✓ |
| `catalog.manage` (crear, editar, archivar, historial) | ✓ | ✓ | — |

Otra empresa no ve nada (RLS). `verify_0014a.sql` conoce los dos permisos.

## Sin datos paralelos: el catálogo copia, no enlaza

- **Facturas y cotizaciones** (`/documents/new`): cada línea tiene «del catálogo
  (opcional)». Elegir un artículo **copia** el nombre y el precio en la línea
  (se pueden cambiar) y sugiere su impuesto si el documento aún no tiene uno.
  Al guardar, el servidor comprueba que el artículo sigue **activo y es de la
  empresa** y guarda en la línea (`documents.items`) `catalog_item_id`, `code` y
  `unit`. Si se archivó mientras tanto, el documento no se guarda y lo explica.
- Cambiar el precio o archivar un artículo **no cambia** ningún documento ya
  escrito. La conversión de cotización a factura (CRM) copia las líneas tal cual.
- **Dónde se usó**: la ficha del artículo lista los documentos con líneas que
  vienen de él (lectura con la RLS de documentos).
- **Document Studio**: en una tabla del editor, «+ Fila del catálogo…» añade una
  fila (código, nombre, unidad, precio, según las columnas). Es texto: el
  documento emitido conserva lo que se escribió.
- El documento sigue teniendo **un solo impuesto**. El impuesto propio del
  artículo es una sugerencia; el impuesto por línea es una entrega posterior.

## Pantallas

- `/catalog`: búsqueda por código o nombre, filtros por tipo y estado, alta.
- `/catalog/[id]`: edición, archivar / restaurar, dónde se usó, historial.
- Sin 0039 (Staging hoy) `/catalog` dice que el catálogo no está activado y el
  formulario de facturas funciona igual, sin el selector.

## Pruebas

- SQL: `supabase/tests/local/114_catalog.test.sql` (escenario 46 de
  `npm run test:db`: aplicar y reaplicar, suites de Studio con 0039, rollback
  idéntico a 0038 con el catálogo vacío y rechazado con artículos).
- Unidad: `tests/catalog.test.ts` (centavos, impuestos, líneas copiadas, filas
  de Studio).
- Navegador: `e2e/catalog.auth.e2e.mjs` (`npm run test:e2e:catalog`): alta,
  validación, conflicto de versión, factura con línea del catálogo (4 × 13.00 +
  11.5 % = 57.98), el precio cambia y la factura no, archivar / restaurar, fila en
  Studio, permisos, inglés, iPhone. `e2e/staging-shape.e2e.mjs` comprueba
  `/catalog` y el formulario de facturas sin la migración.

## Rollback

`supabase/rollback/0039_rollback.sql` se niega si el catálogo tiene artículos
(son datos del negocio). Las líneas de documentos que copiaron un artículo
conservan su copia.

## Siguiente paso (inventario)

Existencias por sucursal, movimientos (entradas, salidas, ajustes) y costo,
solo para productos con «controlará inventario»; cuentas contables por artículo.
