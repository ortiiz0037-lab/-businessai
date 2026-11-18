# Revisión final de preparación para el piloto comercial (2026-11-18)

Rama `claude/businessai-platform-audit-vjjcoc` · PR #1 abierto, sin fusionar · Production, Stripe y `main` sin tocar.
Complementa `docs/LAUNCH_READINESS.md` (S9, 17 nov): no se repitieron sus auditorías; se volvió a verificar
lo que cambió desde entonces y se añadió lo que faltaba (barrido de todas las pantallas, encabezados de seguridad,
idioma del acceso).

**Estado final: NO LISTO para cobrar a clientes hoy · el software está LISTO CON LIMITACIONES para un piloto.**
Los bloqueos que quedan no son defectos de código: son operaciones que requieren su autorización o
credenciales (§E). En cuanto se resuelvan los tres primeros, el piloto puede empezar.

## A. Qué se revisó y qué funciona

| Área | Evidencia | Tipo |
|---|---|---|
| Staging con 0001–0045 | 43 migraciones registradas, matriz de permisos 153, comprobaciones por paso y respaldo cifrado verificado tras cada una (`STAGING_STATUS.md`, ejecuciones #39–#48, respaldos #1–#11) | **Real** (Staging) |
| Recuperación | Respaldo cifrado antes de 0037 y después de cada migración, restauración real comprobada tabla por tabla; rollback por migración (`supabase/RUNBOOK.md` §10) | Real (Staging, solo lectura) + ensayo local |
| Todas las pantallas con sesión (92 de 111; las 19 restantes son de detalle sin registro en la semilla y las cubre su suite de módulo) | Barrido nuevo `e2e/sweep.auth.e2e.mjs`: propietario en escritorio es/en, iPhone 13 es, iPad Mini en; miembro en escritorio; páginas públicas y de acceso en iPhone y escritorio. Sin error 500, sin pantalla de error, sin desplazamiento horizontal, sin errores de consola, `<html lang>` correcto | Automatizada, navegador real (Chromium), pila **local** |
| Flujos por módulo: finanzas, cobros/pagos, Studio (documentos, sucursales, finanzas, avanzado), catálogo, asistente, banca, inventario, POS, Workforce, enlace de empleado, nómina, CRM | 16 suites `*.auth.e2e.mjs` en verde en CI | Automatizada, navegador real, pila local; proveedores con **dobles** |
| Sin sesión: rutas protegidas, idioma del acceso, recuperación, invitación, quiosco, diseño en iPhone / iPad / escritorio, encabezados de seguridad | `e2e/public.e2e.mjs` (ahora también en CI) | Automatizada, navegador real |
| Base de datos: migraciones, rollbacks, RLS, aislamiento entre empresas (>120 tablas), permisos, carreras, idempotencia, paginación | `npm run test:db`: 52 escenarios | Automatizada, PostgreSQL local |
| Lógica de la app | `vitest`: 918 aprobadas | Automatizada (unidad) |
| Autenticación de rutas y APIs | Revisadas las 15 rutas `api/*`: sesión + RLS / permiso, o firma del proveedor sobre el cuerpo crudo (Stripe, POS, Plaid); el webhook de Stripe descarta eventos repetidos; las acciones del servidor escriben por funciones con permisos | Revisión de código + pruebas existentes |
| Registros financieros | Asientos balanceados, ventas/pagos/reembolsos idempotentes, libros no editables directamente, anulación por asiento inverso (suites 84–126) | Automatizada, PostgreSQL local |
| Eliminación de cuenta | Solicitud desde «Mi cuenta», conserva pagos/documentos/asientos (0045, `126` §J) | Automatizada local; Staging con 0045 |

## B. Problemas encontrados y corregidos en esta revisión

| # | Problema | Causa raíz | Corrección | Prueba |
|---|---|---|---|---|
| R-1 | El check `test` de CI fallaba entre 00:00 y 04:00 UTC | `127_pagination` creaba facturas con la fecha UTC; la función usa la fecha de Puerto Rico | El test usa `ba_today()` | `test:db` 680/0 en esa franja horaria (`fbdd20e`) |
| R-2 | **`/settings/company` mostraba «Algo salió mal»** (todas las vistas) cuando el cliente del navegador no tenía configuración | `CompanyBranding` creaba el cliente de Supabase al renderizar | Se crea al subir la imagen; el error se muestra como mensaje (bilingüe) | Barrido: 92/92 en todas las vistas |
| R-3 | Recuperación de contraseña y validaciones en **español aun con la app en inglés** | Mensajes fijos en `requestPasswordReset` / `updatePassword`; `fieldErrors` sin idioma | Mensajes bilingües; `fieldErrors(error, locale)` | `tests/validators.test.ts` (8) |
| R-4 | Páginas de acceso **ignoraban el idioma elegido** (solo `?lang=`): formulario en español y respuesta del servidor en inglés | Regla distinta a la de la app | `pageLocale`: `?lang`, idioma recordado, navegador, español; `<html lang>` correcto | `public.e2e` (idioma recordado, navegador es/en) |
| R-5 | Botón «Imprimir / Guardar PDF» en español en la vista de documento en inglés | Etiqueta por defecto | Etiqueta bilingüe | Barrido (sin aviso) |
| R-6 | Inicio en inglés con `<html lang="es">` | Sin `HtmlLang` | Añadido | Barrido |
| R-7 | **Sin encabezados de seguridad**: la app podía mostrarse dentro de otro sitio (clickjacking) | No configurados | `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (cámara y micrófono solo para la app) | `public.e2e` (9 comprobaciones) |
| R-8 | Las acciones del servidor aceptaban orígenes `*.github.dev` **en producción** | Lista de desarrollo sin condición | Solo en desarrollo; `SERVER_ACTIONS_ALLOWED_ORIGINS` opcional | Build + suites |
| R-9 | `public.e2e` no corría en CI y dejaba su servidor vivo (una segunda ejecución probaba la compilación anterior) | — | En la matriz de CI; detiene su grupo de procesos | CI + ejecución local |
| R-10 | No había barrido de todas las pantallas | — | `e2e/sweep.auth.e2e.mjs` en CI | Ver C |

No se debilitó ninguna protección: todos los cambios añaden comprobaciones o restringen.

## C. Pruebas ejecutadas y resultados exactos

CI del último commit (`bfe53f7`, mismo código que `ed554fb`): **19 / 19 comprobaciones en verde**
(`test` + 18 suites de navegador, ejecución 44224683651). Todas en una pila **local** del runner (PostgreSQL 16
con 0001–0045, PostgREST, sustituto de Auth): nada contacta Supabase, Stripe ni Vercel.

| Suite (navegador, Chromium) | Resultado | Suite | Resultado |
|---|---|---|---|
| **sweep (nueva)** — 92 pantallas × 5 vistas + 12 públicas × 2 | **2420 / 0**, 0 avisos | **public** (ahora en CI) | **171 / 0** |
| finance | 85 / 0 | finance-flows | 97 / 0 |
| studio | 50 / 0 | studio-branches | 26 / 0 |
| studio-finance | 29 / 0 | studio-advanced | 28 / 0 |
| catalog | 35 / 0 | assistant (doble del modelo) | 80 / 0 |
| assistant-s4 | 24 / 0 | banking (dobles Plaid / OCR) | 56 / 0 |
| inventory | 72 / 0 | pos (dobles de proveedores) | 38 / 0 |
| workforce | 53 / 0 | employee-link | 24 / 0 |
| payroll | 41 / 0 | crm | 57 / 0 |

**Total en navegador: 3386 verificaciones, 0 fallidas.**

| Otras pruebas | Resultado |
|---|---|
| `npm run test:db` (local, 52 escenarios: migraciones, rollbacks, RLS, carreras, flujos A–H, paginación) | **680 / 0** (ejecutada a las 01:50 UTC, la franja que fallaba antes de R-1) |
| CI `test` (lint, TypeScript, vitest, build, `test:db`) | Verde |
| `vitest` (local) | **918 aprobadas**, 51 omitidas (requieren servicios externos) |
| `tsc --noEmit` · ESLint | 0 errores · 0 errores, 6 avisos preexistentes |
| `next build` (Next.js 16.4.5) | Correcto |
| `npm audit --omit=dev` | **0 vulnerabilidades** (desarrollo: ver limitaciones) |
| Staging (real): 0037–0045 una por ejecución + respaldo verificado tras cada una | 9 / 9 migraciones y 9 / 9 respaldos correctos (`STAGING_STATUS.md`) |

Iteraciones del barrido: 1.ª ejecución 2390 / 20 fallos (R-2, R-4) → 2.ª 2418 / 2 (R-6) → final 2420 / 0.

## D. Funciones que dependen de credenciales o proveedores reales (no probadas con el proveedor)

| Función | Estado |
|---|---|
| Registro con confirmación por correo, recuperación de contraseña | Código revisado; formularios probados en navegador. **El envío y el enlace del correo dependen de Supabase Auth + SMTP: no verificados de extremo a extremo** (requiere prueba en Staging con usuario de prueba) |
| Invitaciones de equipo por correo | Correo transaccional no configurado |
| Suscripciones (Stripe TEST / LIVE): alta, cambio, fallo de pago, cancelación, portal | Lógica y webhook probados con dobles y en base local; **Stripe TEST nunca ejecutado de extremo a extremo** |
| Asistente BusinessAI | Probado con un **doble** del modelo; requiere clave de Anthropic y límite de gasto |
| Conexión bancaria (Plaid), OCR de recibos (Azure) | Solo dobles |
| Integraciones POS: Square, Clover, Shopify POS, Lightspeed X | Solo dobles (firmas, reintentos, idempotencia probados) |
| Escáner, cámara, impresora de recibos, cajón | Escáner HID simulado en navegador; sin hardware físico |

## E. Lo que impide iniciar el piloto comercial

1. **Production no tiene el esquema**: `businessai-dev` (PRODUCTION) no ha recibido 0005–0045. Se necesita su
   autorización para un plan de migración de Production (respaldo, una migración por ejecución, como en Staging).
2. **Stripe sin verificar de extremo a extremo**: autorización para `staging-test.yml` con Stripe TEST
   (productos `businessai_*_monthly`, webhook, ciclo completo); después, configuración LIVE.
3. **Correo de autenticación sin verificar**: autorización para una prueba de humo en la Preview contra Staging
   (crear usuario de prueba, confirmar correo, recuperar contraseña) y SMTP propio para Production.
4. `NEXT_PUBLIC_APP_URL` y variables de Production en Vercel (sin ellas no se envían enlaces de recuperación).

## F. Requisitos para empezar a cobrar

- Las cuatro acciones de §E.
- Precios definitivos (Basic 19.99 / Pro 39.99 / Premium 59.99) creados en Stripe LIVE con las mismas claves.
- Textos legales revisados (términos, privacidad); **hoy solo en español** (precios, términos y privacidad no tienen versión en inglés).
- Dominio propio, correo de soporte y plan de soporte.
- Respaldo y punto de restauración de Production antes de la primera migración.
- Pilotos en Puerto Rico, en USD (moneda y zona horaria fijas).
- Decisiones abiertas: clave del asistente (y su límite de gasto), integraciones POS/bancarias que se ofrecerán en el piloto.

## Limitaciones conocidas (no bloquean un piloto supervisado)

- `npm audit` (desarrollo): aviso alto de `picomatch` (ReDoS) en herramientas de lint/test; **no hay versión
  corregida publicada** (afecta ≤ 4.0.7, la última). Producción: 0 vulnerabilidades. No se ejecuta con datos de usuarios.
- 6 avisos de ESLint (imágenes `<img>` de logotipo/firma con URL firmada, dos variables sin uso): sin efecto funcional.
- Acciones de GitHub en Node 20 (propuesta Node 24 en `docs/CI_NODE24.md`, pendiente de su decisión).
- Pruebas de iPhone / iPad: tamaños de pantalla en Chromium, no dispositivos físicos.
