# Banca, pagos y captura inteligente de recibos (S6)

**Estado:** implementado y probado **en local** (base de datos de prueba, dobles de
prueba del proveedor bancario y del OCR). La migración `0042_banking.sql` es un
**borrador** (`STAGING-GATE: approval required`): no está aplicada en Staging ni en
Production. No hay credenciales reales de Plaid ni de Azure configuradas: **ninguna
conexión bancaria real ni lectura real de recibos se ha probado todavía**.

## 1. Arquitectura

S6 amplía lo existente, sin datos financieros paralelos:

| Pieza | Reutiliza | Qué añade (0042) |
|---|---|---|
| Movimientos bancarios | `bank_lines` / `bank_imports` de 0026 (CSV, emparejamiento, conciliación) | Cada sincronización es una importación con `source = 'provider'`; el id de la transacción del proveedor es la huella (`id:<txid>`), así que repetir una sincronización o un webhook no inserta nada. |
| Conexiones | — | `bank_connections` (proveedor, entorno, institución, estado, cursor), `bank_provider_accounts` (nombre, últimos 4, tipo; se vinculan a una cuenta bancaria de BusinessAI), `bank_sync_runs` (historial), `bank_webhook_events` (idempotentes por SHA-256 del cuerpo). |
| Credenciales | Esquema `ba_private` de 0030 | El *access token* del proveedor se guarda **cifrado por el servidor** (AES-256-GCM, `BANK_TOKEN_KEYS`) en `ba_private.bank_connection_secrets`, que la API no expone. Se borra al desconectar. **Nunca** una contraseña bancaria: el cliente la escribe solo en Plaid Link. |
| Escrituras sin usuario | Firmas HMAC del servidor de 0030 | Webhooks y sincronizaciones escriben solo mediante funciones que verifican una firma del servidor (`BANK_SERVER_KEYS`), una marca de tiempo de 2 minutos y un *nonce* de un solo uso. |
| Depósitos aplicados a facturas | Pagos de Cuentas por cobrar (0015/0025), asiento automático (0023/0026), `bank_match` (0026) | `bank_line_allocations`: cada decisión (depósito → pago) con autor, confianza, motivos y anulación trazable. Un depósito nunca se aplica por encima de su importe; un pago nunca tiene dos aplicaciones. |
| Pagos manuales | `payments` + formulario existente | `branch_id`, `notes`, `evidence_capture_id` (se fijan al registrar; los pagos siguen siendo inmutables). Métodos: efectivo, cheque, ATH Móvil, transferencia bancaria, tarjeta de crédito, tarjeta de débito, otro (los antiguos `card` / `transfer` siguen siendo válidos y legibles). |
| Recibos | Adjuntos de gastos (`bill_attachments`, bucket `Finance-attachments`) | `receipt_captures` + bucket **privado** `Banking-evidence`: archivo original, huella SHA-256 (el mismo archivo dos veces es el mismo recibo), sugerencias del OCR, datos confirmados por la persona, vínculo a un gasto o a un pago. |
| Sucursales | `branches` de 0035 | `bank_accounts.branch_id` y `bank_lines.branch_id` (los movimientos nuevos heredan la de la cuenta; se puede cambiar por movimiento). |

### Flujo de una conexión

1. El administrador pulsa **Conectar banco** → el servidor pide un *link token* →
   se abre **Plaid Link** (ventana del proveedor, script oficial de `cdn.plaid.com`).
2. Plaid devuelve un *public token* de un solo uso → el servidor lo cambia por el
   *access token*, lo cifra y guarda la conexión con su firma
   (`bank_connection_save`). Se listan las cuentas con sus últimos 4 dígitos.
3. El administrador vincula cada cuenta con una cuenta bancaria de BusinessAI (solo
   las vinculadas se sincronizan; vincular reinicia el cursor para traer su historial).
4. **Sincronizar ahora** o un webhook `SYNC_UPDATES_AVAILABLE` → `/transactions/sync`
   página a página; cada página se escribe con su cursor (`bank_sync_apply`). Las
   transacciones pendientes no se importan; las retiradas por el banco se excluyen
   si no están emparejadas (si lo están, se registra un aviso para revisarlas).
5. Errores del proveedor: `ITEM_LOGIN_REQUIRED` → «Requiere reconectar» (Link en
   modo actualización), `PENDING_DISCONNECT` / `PENDING_EXPIRATION`, permisos
   revocados (`USER_PERMISSION_REVOKED`) → «Permiso revocado».
6. **Desconectar** (con confirmación): primero se elimina el *item* en el proveedor
   (`/item/remove`), después se borra el acceso cifrado. Movimientos, emparejamientos
   y conciliaciones se conservan.

### Webhooks (`POST /api/banking/webhooks/plaid`)

Ruta pública de máquina. Antes de escribir nada verifica el JWT ES256 de la
cabecera `Plaid-Verification` con la clave que Plaid devuelve para su `kid`
(`/webhook_verification_key/get`), su antigüedad (≤ 5 min) y el SHA-256 del cuerpo.
Solo se guarda `item_id`, tipo, código y código de error (nunca datos de cuentas).
Un reintento del mismo webhook se registra una vez.

### Emparejamiento inteligente (sugerencias, nunca decisiones)

`src/lib/banking/matching.ts` propone para cada depósito, con confianza y motivos:

- una factura con el importe exacto de su balance (más confianza si la referencia o
  la descripción menciona el número de factura o el cliente, y si la fecha encaja);
- un **pago parcial** cuando la referencia nombra la factura pero el importe difiere;
- **varias facturas del mismo cliente** cuya suma coincide con el depósito;
- un **pago ya registrado** en esa cuenta bancaria por el mismo importe (se vincula
  sin crear otro pago).

Cuando dos opciones son igual de probables se marcan como ambiguas y su confianza se
limita al 60 %. Nada se marca como pagado sin que una persona pulse **Confirmar**; la
base de datos vuelve a comprobar balances, importes y duplicados. Una misma decisión
enviada dos veces (doble clic) no crea pagos duplicados (clave de idempotencia).
Deshacer una aplicación exige un motivo, reabre el depósito y **no** borra el pago
(se anula desde la factura, con su asiento de reversión).

### Cuatro cosas distintas

La pantalla **Depósitos y pagos** las muestra por separado: **pago registrado**
(en BusinessAI), **pago de procesador** (cobrado por un procesador, p. ej. Stripe),
**depósito bancario** (línea del banco) y **movimiento conciliado** (dentro de una
conciliación cerrada). Los asientos contabilizados nunca se editan.

### Recibos

Foto (cámara del iPhone / iPad) o archivo (escritorio) → subida directa al bucket
privado con la sesión del usuario → el servidor lo lee de nuevo, comprueba el tipo
real por sus bytes (JPEG, PNG, WebP, PDF; ≤ 10 MB), calcula su huella, lo registra y,
si hay OCR configurado, guarda las **sugerencias**. La persona corrige y confirma
(fecha, comercio, nº de recibo, total, impuestos, método, referencia, moneda). Lo que
el OCR no reconoce se muestra como **«No reconocido»** y queda vacío: no se inventa
nada, ni siquiera la moneda. Vincularlo a un gasto adjunta además una copia al gasto
(reglas de Finanzas). Descartar no borra el original.

## 2. Seguridad

- Multiempresa con RLS en todas las tablas nuevas; escrituras solo por funciones con
  comprobación de permisos en el servidor (`bank.view`, `bank.manage`,
  `bank.reconcile`, `payments.record`; recibos: `payables.create`, `payments.record` o
  `bank.manage`). Sin permisos nuevos en la matriz.
- Sucursales y evidencias validadas contra la empresa (`BRANCH_INVALID`, `EVIDENCE_INVALID`).
- Webhooks y sincronizaciones idempotentes; importes en centavos enteros y nunca 0.
- Archivos privados con políticas que empiezan por `bucket_id = 'Banking-evidence'`
  (clasificadas por `staging:check`); un original registrado no se puede borrar.
- Ningún secreto, token ni número de cuenta en registros ni respuestas: los errores
  del proveedor se reducen a su código.

## 3. Proveedores evaluados

### Datos bancarios

| Proveedor | Puerto Rico / EE. UU. | Notas | Decisión |
|---|---|---|---|
| **Plaid** | EE. UU. completo. Puerto Rico no aparece en la lista oficial de países, pero directorios de terceros indican cobertura de **Banco Popular de PR** y **FirstBank PR** (instituciones de EE. UU.). Confirmar con la búsqueda de instituciones del *sandbox* antes de prometer bancos concretos. | `/transactions/sync` con cursor, webhooks firmados (ES256), modo actualización de Link, *sandbox* gratuito. Transactions se factura por cuenta conectada al mes (estimaciones de terceros: ~0,25–0,30 USD; confirmar con Plaid). | **Elegido** (adaptador implementado). |
| Finicity (Mastercard) | Fuentes de terceros listan **Oriental Bank** y **FirstBank PR**. | API distinta; útil si Plaid no cubre Oriental. | Alternativa futura (nuevo adaptador, mismas tablas). |
| MX / Teller | Sin evidencia de cobertura en PR. | — | No elegidos. |

### OCR de recibos

| Servicio | Precio aproximado | Notas | Decisión |
|---|---|---|---|
| **Azure AI Document Intelligence** (modelo *prebuilt-receipt*, API 2024-11-30) | ~10 USD / 1.000 páginas | Comercio, fecha, total, impuestos, moneda con confianza; asíncrono (202 + `Operation-Location`). Nº de recibo y método de pago no son campos estándar → quedan «No reconocido». Los nombres de campo `MerchantName`, `TransactionDate`, `Total` deben confirmarse con una prueba real. | **Elegido** (adaptador implementado). |
| AWS Textract *AnalyzeExpense* | ~0,01 USD / página | Comparable; necesita credenciales AWS. | Alternativa (la interfaz `ReceiptOcr` permite cambiarlo). |
| Sin OCR | 0 | La persona escribe los datos; el original se guarda igual. | Modo por defecto. |

### Procesadores de pago (no activados)

- **Stripe**: hoy solo cobra la **suscripción de BusinessAI** (`docs/BILLING.md`). Los
  cobros que los negocios clientes reciben de *sus* clientes deben ir por Stripe
  Connect (cuentas propias de cada negocio), separados de esa suscripción. Stripe
  admite empresas de Puerto Rico como empresas de EE. UU.; la disponibilidad de
  Connect para PR debe confirmarse. **Nada activado ni configurado.**
- **ATH Móvil Business** (Evertec): botón de pago con API REST y SDK para iOS/Android.
  Integración futura; hoy se registran como método «ATH Móvil» en pagos manuales o
  desde el depósito bancario.

## 4. Configuración (cuando el propietario lo autorice)

Variables solo de servidor (ver `.env.example`); nunca con prefijo `NEXT_PUBLIC_`:

| Variable | Uso |
|---|---|
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` / `production`) | Credenciales del proveedor. |
| `PLAID_WEBHOOK_URL` | `https://<dominio>/api/banking/webhooks/plaid` |
| `BANK_SERVER_KEYS` | `"<id>:<base64 de 32+ bytes>"`; la misma clave se registra en la base de datos como propietario: `select public.bank_set_server_key('<id>', '<base64>')`. |
| `BANK_TOKEN_KEYS` | `"<id>:<base64 de 32 bytes exactos>"` (cifrado de los *access tokens*; la primera cifra, todas descifran → rotación). Perderla obliga a reconectar los bancos. |
| `OCR_PROVIDER=azure`, `AZURE_DOCINTEL_ENDPOINT`, `AZURE_DOCINTEL_KEY` | OCR opcional. |
| `BANKING_DISABLED=1` | Apaga las conexiones. |

Generar claves sin mostrarlas: `openssl rand -base64 32`, guardarlas directamente en
el gestor de secretos del entorno (Vercel / Supabase) y no pegarlas en chats ni
registros. Además: aplicar 0042 en Staging (autorización), pedir a Plaid acceso de
producción (*Launch checklist*, revisión de la app) y verificar la cobertura de los
bancos de PR en el *sandbox*.

**Necesitan credenciales reales (no probado):** Plaid Link real, intercambio real,
sincronización y webhooks reales de Plaid, cobertura de bancos de Puerto Rico, OCR
real de Azure (nombres de campos y calidad), costos reales.

## 5. Pruebas

| Prueba | Qué cubre |
|---|---|
| `supabase/tests/local/120_banking.test.sql` (escenario 49 de `npm run test:db`) | Tokens cifrados no legibles, firmas (usuario, caducidad, clave, contenido, *nonce* repetido), sincronización idempotente y retiradas, errores y reconexión, webhooks idempotentes y cambios de estado, sucursales, depósitos repartidos / parciales / varios por factura, pagos existentes, sobreaplicación, deshacer con motivo, inmutabilidad, recibos (bucket privado, duplicados, OCR sin inventar, confirmación, aislamiento), desconexión, borrado de empresa, rollback. |
| `tests/banking.test.ts` | Configuración (cerrada por defecto, doble solo en *loopback* y fuera de producción), cifrado AES-GCM, firmas, adaptador Plaid y verificación ES256 contra el doble, sincronización, emparejamiento, OCR y validación. |
| `e2e/banking.auth.e2e.mjs` (`npm run test:e2e:banking`) | Navegador contra la pila local con los **dobles de prueba** de Plaid y Azure: conexión de prueba, vinculación, sincronización sin duplicados, webhooks firmados (falsificado / repetido / sin firma), sugerencia confirmada, reparto manual, deshacer, recibo con foto (con `E2E_BROWSER_STORAGE=1` y build apuntando al sustituto local), duplicado, campos no reconocidos, pago manual con sucursal y evidencia, aislamiento, desconexión, inglés, iPhone y iPad. |

Los dobles (`e2e/local-stack/plaid-double.mjs`, `ocr-double.mjs`) **no son un banco ni
un OCR**: la app solo los acepta en `http://127.0.0.1` fuera de producción y los marca
como «DOBLE DE PRUEBA» en todas las pantallas.

## 6. Limitaciones conocidas

- Sin credenciales reales: nada de lo anterior se ha probado contra Plaid ni Azure.
- La reconexión (modo actualización) deja el estado en «Requiere reconectar» hasta el
  siguiente webhook `LOGIN_REPAIRED` o una sincronización correcta.
- Transacciones **modificadas** por el banco después de importarse no cambian la
  línea (las líneas son inmutables); una transacción retirada ya emparejada queda
  registrada para revisión manual.
- Una sola moneda por cuenta (USD), como en 0026.
- El OCR no extrae nº de recibo ni método de pago (no son campos del modelo).
- La subida desde el navegador en la pila local requiere un build apuntando al
  sustituto local (igual que los adjuntos de Finanzas).
- Las apps nativas usarán la misma pantalla de captura (`capture="environment"`);
  Plaid Link en el contenedor nativo necesita su SDK o la redirección OAuth (fase 1 de `docs/MOBILE.md`).

## 7. Hoja de ruta

1. **Autorización del propietario:** aplicar 0042 en Staging; cuentas de Plaid
   (sandbox → desarrollo → producción) y Azure; claves en el gestor de secretos.
2. Prueba real en *sandbox* de Plaid (Link, intercambio, sync, webhooks) y búsqueda
   de Banco Popular, FirstBank y Oriental; prueba de OCR con recibos reales.
3. Adaptador Finicity si falta cobertura en PR; Textract como OCR alternativo.
4. Stripe Connect / ATH Móvil Business para cobros de los negocios clientes
   (separados de la suscripción de BusinessAI), con autorización expresa.
5. Herramientas del asistente: resumen de depósitos pendientes y sugerencias (solo
   lectura; aplicar seguiría exigiendo confirmación en pantalla).
6. Reglas recurrentes (comisiones, transferencias internas) y conciliación automática
   de coincidencias exactas al sincronizar, siempre revisables.
