# Migraciones: numeración y orden

## Regla (desde 0010)

1. **Un número nuevo se asigna al crear el archivo**, nunca antes. No se
   reservan números para trabajo futuro.
2. **Números estrictamente crecientes**: la siguiente migración es la última
   aplicada + 1, con 4 dígitos (`0015_…`, `0016_…`). El sufijo de letra
   (`0014a`) solo existió para dividir una entrega ya numerada y no se vuelve
   a usar.
3. **El orden de ejecución es el orden del nombre.** Desde `0010_billing` la
   lista `ORDER` de `scripts/staging/apply-migrations.sh` es exactamente el
   orden alfabético de los archivos; cada migración nueva se añade **al final**.
4. **Cada archivo es una transacción explícita** (`begin;` … `commit;`) con
   `set local lock_timeout` y verificación antes del `commit`.
5. Las migraciones anteriores a 0010 conservan su orden histórico
   (0005 → 0007 → 0009 → 0006 → 0008): ya están aplicadas y no se renumeran.

Las pruebas de `tests/staging-scripts.test.ts` hacen cumplir 3 y 4.

## Estado

| Número | Archivo | Estado |
|---|---|---|
| 0001–0011 | ver `supabase/README.md` | Aplicadas en Staging |
| 0014a | `0014a_permissions.sql` | Aplicada en Staging (versión anterior a R3). La versión con la comprobación de Storage (R3) está **pendiente** de `staging:migrate` autorizado |
| 0015 | `0015_documents_lifecycle.sql` | **Borrador (revisión 2), no aplicada en ningún entorno.** Tras la revisión de 8157f87, todas las reglas las aplica PostgreSQL: documentos emitidos inmutables (solo avanza el estado), tabla de transiciones por tipo, `company_id` inmutable en clientes / documentos / pagos / membresías / perfiles / auditoría, numeración solo por la base de datos (un número enviado por un usuario se reemplaza), no anular facturas con pagos, historial `document_events`, pagos seguros en concurrencia (READ COMMITTED y REPEATABLE READ) con clave de idempotencia, recibos con el cliente de la factura y reemisión tras anular, `billing.manage` solo para el propietario. Requiere 0014a. Marca `STAGING-GATE` |
| 0016 | `0016_billing_hardening.sql` | **Borrador, no aplicada en ningún entorno.** Una prueba gratuita por **persona** (`trial_claims`, `claim_trial`), los recibos no consumen la cuota mensual de documentos. Requiere 0011 (independiente de 0015). Marca `STAGING-GATE` |
| 0017 | `0017_plan_features.sql` | **Borrador, no aplicada en ningún entorno.** Funciones por plan, denegadas por defecto: sucursales Básico 1 / Pro 3 / Premium 10; empleados Pro 25 / Premium 100; nómina Pro y Premium. Empleados en Básico: **decisión pendiente** (sin fila = no disponible, nunca ilimitado). Marca `STAGING-GATE` |
| **0018** | — | **Siguiente número libre** |

### Borradores y `staging:migrate` (hallazgo I12)

Añadir una migración a `ORDER` ya no basta para que se aplique. Un archivo con la
línea `-- STAGING-GATE: approval required` (0015, 0016) se **retiene** —él y todo
lo que va después— hasta que el propietario lo nombre en `APPROVED_DRAFTS`
(entrada `approved_drafts` de una ejecución manual del workflow; una etiqueta
nunca aprueba borradores). Lo comprueban `scripts/staging/draft-gate.sh` y
`tests/staging-scripts.test.ts` (prueba de comportamiento del filtro).

Nota: las cabeceras históricas `-- STATUS: DRAFT` de 0005–0014a describen su
estado en Production y no se editan (cambiar el archivo cambiaría su sha256 en
Staging y provocaría que se reaplicaran).

Los números 0012, 0013 y 0014b se habían reservado en la planificación
(sucursales e invitaciones) y **se retiran**: esas funciones tomarán el
siguiente número libre cuando se construyan. Ninguna migración aplicada usa
esos números, así que no hay nada que renombrar.

Production: ninguna de estas migraciones se ha aplicado (ver `supabase/RUNBOOK.md`).
