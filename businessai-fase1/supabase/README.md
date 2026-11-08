# Base de datos (Supabase)

## Estado del esquema

`clients`, `documents` y `payments` **ya existen** en las bases de datos en vivo,
pero se crearon fuera de este repositorio: no hay migración que las defina.
No las recrees. `migrations/0005_security_baseline.sql` solo añade la capa de
seguridad encima de lo que existe.

| Archivo | Qué es | ¿Aplicado? |
|---|---|---|
| `migrations/0001`, `0003`, `0004` | Núcleo multi-tenant, perfil, suscripciones | Sí (según la inspección) |
| `migrations/0005_security_baseline.sql` | RLS, privilegios y Storage sobre el esquema inspeccionado | **No — borrador, requiere aprobación** |
| `migrations/0006_payments_document_fk.sql` | `payments.document_id`: CASCADE → NO ACTION | **No — borrador, aprobación aparte** |
| `migrations/0007_storage_company_assets.sql` | Políticas de Storage para `Company-assets` | **No — borrador, aprobación aparte** |
| `migrations/0008_definer_function_grants.sql` | Quitar EXECUTE a anon en `can_edit_company_profile` | **No — borrador, aprobación aparte** |
| `rollback/000x_rollback.sql` | Vuelta exacta al estado inspeccionado, por migración | Solo emergencias |
| `RUNBOOK.md` | Respaldo, orden de ejecución, verificación y recuperación | — |
| `inspect/verify_after_migrations.sql` | Verificación de solo lectura tras cada paso | — |
| `inspect/inspect_security_baseline.sql` | Inspección de solo lectura (ya ejecutada) | — |
| `inspect/SCHEMA_REVIEW.md` | Hallazgos y decisiones sobre el esquema real | — |
| `inspect/inspect_definer_functions.sql` | Código de las funciones SECURITY DEFINER (solo lectura) | Pendiente |
| `inspect/inspect_relationship_integrity.sql` | Recuentos de relaciones entre empresas (solo lectura, opcional) | Opcional |
| `tests/local/` | Réplica local del esquema inspeccionado + suites SQL | `npm run test:db` |

## Flujo para aplicar 0005 (no ejecutar en producción sin revisión)

1. **Inspección (solo lectura)** — en el proyecto de *desarrollo*, SQL Editor:
   ejecuta `inspect/inspect_security_baseline.sql` y guarda el JSON en
   `inspect/dev-schema.json` (no contiene datos de negocio ni secretos).
2. **Revisión** — se comparan columnas, FKs, índices y políticas reales con lo
   que asume 0005. Las políticas existentes que deban sustituirse se listan en
   `_ba_reviewed_policies` al inicio de la migración.
   Sin esa lista, 0005 **aborta sin cambiar nada** si encuentra políticas
   propias en estas tablas o en el bucket `Company-assets`.
3. **Desarrollo** — aplica 0005 en desarrollo y ejecuta `npm test` con
   `RLS_TEST_PROJECT_REF` apuntando a ese proyecto.
4. **Producción** — solo tras aprobación explícita, con copia de seguridad.

## Garantías de 0005

- Una sola transacción: si algo falla, no cambia nada. Se puede re-ejecutar.
- No crea, borra ni altera columnas; no toca filas.
- Verifica que existen las columnas que usa la app; si no, aborta.
- Aborta si hay políticas no revisadas (nunca coexiste con una política más amplia).
- Autocomprobación final (RLS activo, sin permisos `anon`, pagos inmutables).

## Pruebas locales

`npm run test:db` levanta un Postgres temporal (requiere `initdb`, p. ej.
`postgresql-16`), aplica 0001/0003/0004 sobre un *shim* de Supabase y un
*fixture* de las tablas de negocio con solo las columnas que usa la app, y
ejecuta: aplicación limpia + idempotencia + suite RLS, guardas de abortado,
y un control negativo que demuestra que la suite falla en una BD insegura.
El fixture reproduce el esquema inspeccionado (columnas, restricciones, FKs,
índices, políticas y privilegios); el escenario 0 lo comprueba contra
`tests/local/inspected_expectations.json`. El servidor local es PostgreSQL 16;
producción es 17.11 (no se usa nada específico de una versión).
