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

## Actualización 2026-11-18 (tarde): Stripe TEST y correo de autenticación en Staging

Autorizado: Stripe solo en modo TEST y correo solo en Staging. Ejecuciones de `staging-test.yml` (etiqueta
`staging:test`): #35 (44228213750) y #36 (44229800029, la de referencia). Nada en Stripe LIVE, Production ni `main`.

| Paso | Tipo | Resultado (#36) |
|---|---|---|
| Prueba de humo de la Preview (login, rutas protegidas, webhook rechaza sin firma y con firma falsa) | **Real** (Preview desplegada) | Correcto |
| Facturación de extremo a extremo: Stripe **TEST** con relojes de prueba + webhook desplegado + base de Staging | **Real** (Stripe TEST, no simulado) | **25 / 25** |
| RLS y permisos contra Staging (aislamiento, roles, Storage, matriz de permisos) | **Real** (Staging) | **51 / 51** (en #35, 48 / 51: la prueba declaraba el catálogo hasta 0035; corregido) |
| Capturas reales (iPhone, iPad, escritorio; es / en) | **Real** (Preview) | 78 capturas, artefacto `preview-screenshots` |
| Registro, confirmación de correo, recuperación de contraseña | **Real** (Supabase Auth de Staging + formularios de la Preview) | **15 / 20** — ver abajo |

Escenarios de facturación verificados con Stripe TEST: prueba de 7 días sin cobro → cobro automático del plan
(39.99 USD); **renovación** del mes siguiente (2.º cobro, periodo avanzado); tarjeta que falla → `past_due` con
acceso de gracia → **recuperación** con tarjeta nueva → activa; cancelación durante la prueba (sin cobro) y
**cancelación de una suscripción activa** (solo lectura, datos conservados); **cambio de plan** Pro → Premium
(plan y límites actualizados); tarjeta rechazada al registrarse (sin tarjeta, sin suscripción, sin acceso);
**webhook**: 43 eventos de la ejecución, todos procesados; peticiones sin firma o falsificadas → HTTP 400 y nada
guardado. Datos de prueba borrados (los relojes de Stripe TEST se eliminan con sus clientes).
Las pruebas RLS conservan, por diseño, 1 empresa de prueba con pagos inmutables y 3 usuarios de prueba bloqueados
por ejecución.

Correo de autenticación (Staging):

| Comprobación | Resultado |
|---|---|
| Registro habilitado; confirmación de correo obligatoria | Correcto |
| Antes de confirmar: no inicia sesión; las páginas protegidas llevan a `/login` | Correcto |
| Enlace de confirmación (`token_hash`) → confirma y entra a `/onboarding` | Correcto |
| Enlace de recuperación abierto en **otro navegador** → nueva contraseña → entra; la antigua deja de servir | Correcto |
| Enlace falsificado / caducado → «olvidé mi contraseña» con explicación, sin sesión | Correcto |
| Correo desconocido en «olvidé mi contraseña» → misma respuesta (sin enumeración) | Correcto |
| **Registro desde el formulario** | **Falla**: Supabase rechaza el alta («No se pudo crear la cuenta»); en #35 el envío de recuperación sí quedó registrado |
| **Segundo envío de recuperación** | **Falla**: HTTP 429 «Demasiados intentos» (límite de envío del servicio de correo integrado de Supabase) |
| **Destino de los enlaces de Supabase** | **Falla**: van a la **Site URL `localhost:3000`**, no a la Preview |

Causa: **configuración de Supabase Auth de Staging**, no código de la app. Sin SMTP propio, Supabase usa su
servicio integrado (pocos envíos por hora y solo a direcciones autorizadas del equipo), y la Site URL /
URL de redirección no apuntan a la Preview. Con esa configuración, un usuario real que se registre en Staging no
recibiría el correo o su enlace lo llevaría a `localhost`. Los flujos de la app con enlaces válidos funcionan.

Corregido en el código (alcance autorizado): la prueba RLS `e3-compat` conoce los permisos de 0039 / 0043 / 0044;
la prueba de correo lee el mensaje del formulario (no el anunciador vacío de Next.js) y anota la causa exacta
(estado y código de Supabase); el registro (`signUp`) ahora **registra el estado y el código del error** (sin
correo) y responde «Demasiados intentos» ante un 429, como ya hacía la recuperación — antes el error se perdía.

Acceso que falta (Supabase → proyecto `businessai-staging` → Authentication; no hay credencial de gestión en
este entorno y no es un secreto que deba pegarse en la conversación):

1. **URL Configuration**: Site URL = la URL de la Preview de Staging; Redirect URLs: añadir
   `https://businessai-git-claude-businessai-platform-52cd8d-ortiiz0037-lab.vercel.app/**`.
2. **SMTP propio** (Settings → SMTP) con un remitente del dominio de BusinessAI; subir el límite de envío.
3. Opcional, para comprobar la **entrega** real: un buzón de pruebas (dirección que pueda leerse) para repetir
   el paso 5 con un correo de verdad.
Después: volver a ejecutar `staging:test` (el paso 5 debe dar 20 / 20).

**Repetición #37 (44234509681, 2026-11-18 04:02 UTC, commit `0bac143`)**: facturación Stripe TEST **25 / 25**, RLS
**51 / 51**, 78 capturas, humo correcto; correo **15 / 20**, con la causa exacta ya registrada: Supabase responde
al registro **HTTP 429 `over_email_send_rate_limit`** («email rate limit exceeded») — el límite del servicio de correo
integrado — y sus enlaces siguen yendo a la Site URL **`localhost:3000`**. El formulario de registro desplegado ya
muestra «Demasiados intentos» en lugar del mensaje genérico (corrección de `signUp` verificada en la Preview). Sin
cambios en la configuración de Auth, el resultado del correo no puede mejorar: requiere las acciones 1–2 de arriba.

**Correo con el servicio predeterminado de Supabase (sin dominio propio, decisión del 2026-11-18)**: preparado en
`docs/EMAIL_RESEND.md`. `staging:test` ya no envía correos (paso 5 en modo enlaces); los 2 correos reales por hora
se prueban con la etiqueta `staging:auth-email` hacia un buzón de un miembro de la organización (secreto
`STAGING_AUTH_TEST_EMAIL`), con una persona que abre los correos. Pendiente del propietario: Site URL y Redirect URLs
de Staging (valores en ese documento) y el secreto. Resend queda documentado para cuando haya dominio.

## Actualización 2026-11-21: correo de autenticación verificado en un dispositivo real (Staging)

**Prueba real en iPhone — correcta.** `staging-auth-email.yml` (etiqueta `staging:auth-email-recovery`), ejecución
#25 (44934979126), 18:20–18:27 UTC, commit `276c0b7`: **12 / 12**. Un único correo «Reset Your Password» enviado por
Resend (`BusinessAI (Staging) <no-reply@mail.mybusinessai.site>`) al buzón autorizado; la persona lo abrió en su
iPhone (otro dispositivo y otro navegador que el que pidió el enlace), llegó al formulario de nueva contraseña y la
guardó. Supabase registró el inicio de sesión por el enlace (18:27:12) y la contraseña anterior dejó de servir
(18:27:43). La cuenta de prueba se borró al terminar (por diseño: es una cuenta temporal de la prueba).

Causa del fallo anterior (resuelta): la plantilla por defecto `{{ .ConfirmationURL }}` usa PKCE, cuyo código solo
puede canjearlo el navegador que pidió el enlace. Cambios en **Staging** (`wbfpvxptoujgvflljasc`), con autorización:

| Cambio | Ejecución | Verificación |
|---|---|---|
| SMTP propio: `smtp.resend.com:465`, usuario `resend`, remitente `no-reply@mail.mybusinessai.site` (dominio verificado en Resend; DKIM, MX y SPF publicados) | `staging-auth-smtp.yml` #4 | Relectura: campos iguales; Site URL sin cambios |
| Plantillas Confirm signup y Reset password: solo el enlace → `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=…&next=…`; resto idéntico | `staging-auth-templates.yml` #10 | Relectura: enlace nuevo, resto byte a byte igual |
| `NEXT_PUBLIC_APP_URL=https://staging.mybusinessai.site` (solo Preview) | `staging-app-url.yml` #3 | La compilación acepta ese origen (#4) |

`staging:test` #61 (0 correos): humo, Stripe TEST, RLS, 79 capturas y enlaces **15 / 15** (confirmación,
recuperación en otro navegador, token falsificado rechazado). Correos reales enviados en total: confirmación de
registro (recibida, 2026-11-19) y recuperación (recibida y completada en iPhone, 2026-11-21).

## Bloqueos que quedan para el lanzamiento comercial (2026-11-21)

Ya no bloquean: correo de autenticación (Staging), Stripe TEST de extremo a extremo, esquema completo en Staging
(0001–0045), dominio propio y subdominio de Staging. Pendientes, por orden:

| # | Bloqueo | Tipo | Qué hace falta |
|---|---|---|---|
| 1 | **Production sin esquema**: `rugqcumiuqrjbfwpuslm` no tiene 0005–0045 | Autorización | Aprobar `docs/PRODUCTION_MIGRATION_PLAN.md`: respaldo, una migración por ejecución, verificación tras cada una |
| 2 | **Fusión del PR #1 y despliegue de Production** | Autorización | Revisión del PR; `main` y Production no se han tocado |
| 3 | **Dominio de Production**: `mybusinessai.site` → Vercel Production; `NEXT_PUBLIC_APP_URL` de Production (obligatoria: sin ella no se envían enlaces de recuperación); Site URL y Redirect URLs de Production | Autorización + DNS | Mismo procedimiento que Staging |
| 4 | **Correo de Auth en Production**: Supabase gratuito no permite cambiar plantillas sin SMTP propio | Autorización | SMTP de Resend (mismo dominio `mail.mybusinessai.site`, clave propia de Production) + plantillas `token_hash`; scripts listos, hoy fijados a Staging |
| 5 | **Stripe LIVE**: productos y precios (Basic 19.99 / Pro 39.99 / Premium 59.99, mismas lookup keys), webhook LIVE, claves en Vercel Production | Autorización + credenciales | Nada de LIVE se ha tocado |
| 6 | **Textos legales**: términos y privacidad son **borradores** con datos pendientes (razón social, registro, dirección, correo de contacto, correo de privacidad) y **solo en español** | Contenido / legal | Datos del titular, revisión legal y versión en inglés |
| 7 | **Correo transaccional de la app** (invitaciones de equipo, recordatorios de cobro): `RESEND_API_KEY` y `EMAIL_FROM` no están en Vercel; sin ellas no se envía nada | Configuración | Clave de Resend «Sending access» para la app (Preview y Production) y una prueba real con aprobación |
| 8 | **Soporte**: correo de soporte y plan de atención | Operación | Dirección (p. ej. en el dominio propio) visible en la app y los textos legales |
| 9 | **Funciones con proveedor externo sin probar con el proveedor**: asistente (clave de Anthropic y límite de gasto), Plaid, OCR Azure, POS (Square/Clover/Shopify/Lightspeed), hardware | Decisión | Elegir qué se ofrece en el piloto; lo no elegido queda desactivado (cerrado por defecto) |

No bloquean un piloto supervisado: aviso de Node 20 en GitHub Actions (`docs/CI_NODE24.md`), aviso de `picomatch`
solo en herramientas de desarrollo, 6 avisos de ESLint, iPad no probado en dispositivo físico.

Seguridad: el secreto `SUPABASE_ACCESS_TOKEN` es un token de cuenta (alcanza también Production); los scripts
fijan la referencia de Staging y rechazan la de Production. Recomendado: revocarlo en Supabase cuando no se use, o
mantenerlo solo para los pasos de Production que usted autorice.
