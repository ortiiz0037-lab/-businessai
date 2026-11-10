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
| **0015** | — | **Siguiente número libre** |

Los números 0012, 0013 y 0014b se habían reservado en la planificación
(sucursales e invitaciones) y **se retiran**: esas funciones tomarán el
siguiente número libre cuando se construyan. Ninguna migración aplicada usa
esos números, así que no hay nada que renombrar.

Production: ninguna de estas migraciones se ha aplicado (ver `supabase/RUNBOOK.md`).
