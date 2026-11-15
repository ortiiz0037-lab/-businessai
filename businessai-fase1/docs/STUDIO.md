# BusinessAI Document Studio (entrega 7, migración 0028)

**Estado:** borrador local. `0028_document_studio.sql` **no está aplicada en
ningún entorno** (ni Staging ni Production). Lleva la marca `STAGING-GATE`.
Rollback: `supabase/rollback/0028_rollback.sql`. Se niega a ejecutarse si hay
documentos, plantillas, identidad, imágenes (filas o archivos) o historial.
Ejecutado sin datos, deja el catálogo idéntico a 0027 (comprobado comparando
la huella del esquema). El bucket `Studio-assets` se conserva privado, vacío y
sin políticas: Supabase alojado no permite borrarlo por SQL; si se quiere
eliminar, se hace aparte con la API de Storage.

## Auditoría previa y decisiones

| Ya existía | Cómo lo usa Studio |
|---|---|
| `documents` (cotización, factura, recibo, orden de trabajo, carta, contrato…) con líneas, numeración propia, ciclo de estados protegido y asientos contables | Studio **no** crea otra factura. Un documento de Studio de tipo factura, cotización o recibo se **vincula** al documento comercial existente: usa su número, sus líneas, sus totales y sus pagos. |
| `company_profiles`: logo (bucket público `Company-assets`), firma (bucket privado `Company-signatures`), colores, datos de pago | Se **leen**, no se copian. `studio_brand` solo añade lo que faltaba: tipografías, encabezado y pie, marca de agua, sello, firma por defecto, página y numeración. |
| `clients`, `payments`, `employees`, `vendors`, `ar_invoice_balances` | Son los datos de los campos combinados y de los bloques de datos. Leerlos exige el permiso de cada tabla. |
| Impresión desde el navegador | Se sustituye por un **PDF real** generado en el servidor. |
| *No hay* catálogo de productos ni sucursales | No se inventan. Las líneas vienen del documento comercial. Ver «Limitaciones». |

**Sin registros paralelos.** Los importes nunca se escriben en Studio. Al
**emitir**, la base de datos (`studio_finalize`) copia los datos desde sus
propias tablas a una instantánea inmutable. Esa instantánea es la copia legal
de lo emitido, no una fuente contable. La app solo envía las líneas, y la base
las compara con `documents.items` o, en documentos antiguos, con el subtotal.

## Modelo (migración 0028)

| Tabla | Contenido |
|---|---|
| `studio_documents` | Tipo, título, carpeta, estado (`draft` → `final` → `archived`), número, contenido en bloques (JSON validado), página, referencias (cliente, documento comercial, empleado, proveedor), origen (`user` o `assistant`), versión e instantánea. |
| `studio_versions` | Cada guardado, para el historial y para restaurar. No se modifica. |
| `studio_templates` | Plantillas **de la empresa**. Las del sistema viven en el código, son de solo lectura y hay 10, en ES y EN. |
| `studio_brand` | Identidad de los documentos. |
| `studio_assets` | Imágenes en el bucket **privado** `Studio-assets`, en `<empresa>/<uuid>.png\|jpg`. |
| `studio_counters` | Numeración por empresa, tipo y año. Ningún usuario tiene acceso directo. |
| `studio_events` | Auditoría, solo inserción: creado, borrador del asistente, duplicado, versión restaurada, emitido, archivado, PDF generado, correo preparado, plantilla e identidad modificadas, imagen subida. |

**Reglas que impone PostgreSQL (no solo la app):**
- RLS en todas las tablas: se lee con `studio.view` y se escribe solo mediante funciones.
- `studio_valid_content` acepta solo tipos de bloque conocidos y tamaños acotados. Rechaza código (`<script>`, `<img>`, `javascript:`, atributos `on…=`). Las imágenes solo pueden ser un recurso de la misma empresa o el logo.
- Las referencias deben ser de la misma empresa y del tipo correcto (una factura solo se vincula a una factura).
- `studio_save_document` comprueba la versión esperada: dos personas no se pisan (`STUDIO_CONFLICT`).
- Un documento emitido o archivado no cambia ni con mantenimiento directo (`studio_guard`) y nunca se borra (solo se archiva con motivo), salvo el borrado en cascada de una empresa.
- **Numeración.** Factura, cotización y recibo usan el número de su documento comercial. El resto usa el patrón de la empresa (por defecto `CAR-2026-0001`, configurable con `{YYYY}`, `{YY}` y `{####}`), consecutivo y sin duplicados aunque se emita a la vez (probado).

## Roles

| Permiso | Propietario | Admin | Miembro |
|---|---|---|---|
| `studio.view`: ver documentos y plantillas | ✓ | ✓ | ✓ |
| `studio.edit`: crear, editar, duplicar y archivar borradores; subir imágenes | ✓ | ✓ | ✓ |
| `studio.issue`: emitir; archivar emitidos | ✓ | ✓ | — |
| `studio.templates`: plantillas de la empresa | ✓ | ✓ | — |
| `studio.brand`: identidad | ✓ | ✓ | — |

Además, leer un dato vinculado exige su propio permiso: `clients.view`,
`documents.view`, `workforce.manage` (empleados) y `payables.view`
(proveedores). Un miembro no puede preparar un certificado de empleado.

## Motor (sin dependencias nuevas)

| Módulo | Qué hace |
|---|---|
| `src/lib/studio/model.ts` | Bloques: título, párrafo con **negrita** y __cursiva__, datos (etiqueta y valor), tabla, imagen, firma, sello, espacio, separador, salto de página, y bloques de datos (líneas, totales, pagos, estado de cuenta). Valida lo mismo que la base. |
| `merge.ts` | Campos `{{client.name}}`, `{{document.total}}`… Un dato que falta se muestra como **`[falta: …]`** en rojo y **bloquea la emisión**. Nunca se inventa. |
| `ttf.ts` | Lector TrueType (métricas, mapa de caracteres) y subconjunto de fuentes. |
| `layout.ts` | Convierte los bloques en páginas de elementos posicionados. El **mismo resultado** dibuja el PDF y la vista previa, así que los saltos de línea y de página son idénticos. Incluye encabezado con logo, pie con «Página X de Y», marca de agua, tablas que se parten y repiten el encabezado, y márgenes, tamaño (Carta, A4, Legal) y orientación. |
| `pdf.ts` | Escritor de PDF. Fuentes incrustadas como subconjunto con `ToUnicode`, así que el **texto es seleccionable y buscable**. Imágenes JPEG y PNG con transparencia. Metadatos y opacidad. |
| `templates.ts` | 10 plantillas profesionales: carta, cotización, factura, recibo, orden de trabajo, orden de compra, contrato, informe, estado de cuenta y certificado. |
| `assistant.ts` | Arquitectura de BusinessAI Assistant (ver abajo). |

**Tipografías:** Liberation Sans (con las mismas medidas que Arial/Helvetica) y
Liberation Serif (las mismas que Times), licencia **SIL OFL 1.1**
(`public/studio/fonts/OFL.txt`). El navegador usa los mismos archivos, por eso
la vista previa coincide con el PDF.

## Pantallas (`/studio`)

| Ruta | Contenido |
|---|---|
| `/studio` | Lista con búsqueda (título o número), filtros (tipo, estado, carpeta) y paginación. |
| `/studio/new` | Plantilla del sistema o de la empresa, título, carpeta y datos vinculados. Desde una factura de **Documentos** («Diseñar en Document Studio») se abre con la factura ya vinculada. Incluye el formulario del **asistente**. |
| `/studio/[id]` | Ver detalle abajo. |
| `/studio/templates` y `/studio/templates/[id]` | Galería de plantillas del sistema; personalizar una copia; editor de la plantilla de la empresa. |
| `/studio/brand` | Tipografías, colores, encabezado y pie (admiten campos), logo y numeración de páginas, marca de agua, sello, firma por defecto, página y numeración. |
| `/studio/[id]/pdf` | PDF en línea o como descarga (`?download=1`). Cada exportación queda auditada. |
| `/studio/image` y `/studio/assets` | Imágenes leídas con la sesión del usuario; subida validada **por contenido** (PNG o JPEG por bytes mágicos, hasta 2 MB y 6000 px). |

**Editor de borradores (`/studio/[id]`):**
- Bloques editables: mover, duplicar y eliminar.
- Insertar campo en el cursor.
- Tablas con filas y columnas.
- Imágenes, firma y sello.
- Página y tipografía.
- Vista exacta del PDF al lado (en el teléfono, en una pestaña).
- Guardado con Ctrl/Cmd+S y aviso de cambios sin guardar.
- Conflictos de versión explicados.

**Panel lateral del documento:**
- Datos vinculados.
- Emitir, con casilla de confirmación y lista de datos que faltan.
- Duplicar y archivar.
- Versiones con restaurar.
- Historial.

**Documentos emitidos:** solo lectura, más «Preparar correo».

## Distribución

- **PDF:** con texto seleccionable, fuentes incrustadas, metadatos (título, autor y `Producer: BusinessAI Document Studio`) y la misma maquetación que la vista previa.
- **Marca de agua:** los borradores llevan BORRADOR y los archivados ARCHIVADO, tanto en el PDF como en la vista previa.
- **Impresión:** el PDF se abre en el visor del navegador (Ver PDF / Imprimir).
- **Correo:** se **prepara**, no se envía, y solo para documentos emitidos. Se proponen el destinatario (el correo del cliente o del proveedor), el asunto y el texto; luego se descarga el PDF y se abre el programa de correo. Se audita el destinatario, nunca el texto.

## BusinessAI Assistant: arquitectura

Contrato en `src/lib/studio/assistant.ts`:
- **Qué datos lee:** solo `studio_data`, es decir, lo que el usuario ya puede ver con sus permisos.
- **Qué hace:** elige la plantilla y conserva las palabras del usuario. Marca `[falta: …]` en lugar de inventar.
- **Qué crea:** solo **borradores**, con `origin = 'assistant'` y el evento `drafted_by_assistant`.
- **Qué no hace:** emitir, enviar, archivar ni modificar documentos emitidos. Emitir exige que una persona confirme en el editor.
- **Barrera de seguridad:** `assertDraftIsSafe` rechaza contenido no válido e **importes escritos** en facturas, cotizaciones, recibos y estados de cuenta, porque esos importes salen de los libros.

Hoy funciona `ruleAssistant`, que es determinista y no necesita proveedor ni
clave. Un asistente basado en un modelo de lenguaje debe implementar la misma
interfaz y pasar las mismas comprobaciones. No se guardó ninguna clave ni se
conectó ningún servicio externo.

## Pruebas

| Prueba | Qué cubre |
|---|---|
| `supabase/tests/local/94_studio.test.sql` | Validación de contenido (código, URL, bloques desconocidos), referencias y aislamiento, permisos por rol, versiones y conflictos, restaurar, duplicar, datos en vivo desde las tablas reales, emisión (número de la factura, líneas verificadas, importes distintos rechazados, factura en borrador rechazada), numeración y formato propio, inmutabilidad, archivo, auditoría solo de inserción, plantillas, identidad, imágenes (bucket privado, carpeta por empresa, nombres válidos), cascada. |
| `95_studio_race.sh` | Dos emisiones a la vez dan números consecutivos; dos guardados de la misma versión dan un conflicto; guardar mientras se emite queda rechazado. |
| `run.sh`, escenario 34 | Aplicar y reaplicar, verificación de permisos, bucket privado, suites anteriores con 0028, rollback con huella idéntica a 0027 y rechazo cuando hay datos. |
| `tests/studio.test.ts` | Modelo, campos combinados, fuentes y subconjuntos, maquetación (márgenes, paginación, tablas partidas, totales, estado de cuenta, tamaños, identidad), imágenes, PDF (estructura, xref, `ToUnicode` con caracteres reales), plantillas y asistente. |
| `e2e/studio.auth.e2e.mjs` | Navegador con sesión iniciada sobre la pila local (ver `docs/FINANCE.md`): factura vinculada con cifras reales, edición, campos, guardado, conflicto, PDF verificado con `pdftotext`/`pdfinfo`, emisión con confirmación, correo preparado, duplicar, datos faltantes que bloquean, asistente, plantilla de la empresa, identidad, roles, aislamiento, subida rechazada por contenido, iPhone e iPad. |

## Sucursales (Studio · entrega S1, migración 0037)

- Un borrador se emite **desde una sucursal** de la empresa (bloque «Sucursal»
  del editor). Solo sucursales activas de la misma empresa; con el alcance por
  sucursal del CRM activado, un miembro solo usa las suyas (`branches.manage`
  puede elegir cualquiera). Un documento emitido conserva su sucursal.
- Campos combinados del grupo **Sucursal**: `{{branch.name}}`, `{{branch.code}}`,
  `{{branch.address}}`. Si un documento los usa, no se emite sin sucursal
  («faltan datos»).
- Numeración: `{SUC}` en el formato (Identidad → Numeración), p. ej.
  `OC-{SUC}-{YYYY}-{####}` → `OC-CEN-2026-0001`. Sin sucursal, el token y su
  separador desaparecen. El consecutivo sigue siendo por empresa, tipo y año.
- La instantánea inmutable al emitir guarda la sucursal: renombrarla después no
  cambia lo emitido. La lista de documentos filtra por sucursal.
- Sin 0037 (Staging hoy) el editor y la lista funcionan como antes, sin el bloque.
- Pruebas: `110_studio_branches.test.sql` (escenario 44 de `npm run test:db`) y
  `e2e/studio-branches.auth.e2e.mjs` (navegador, PDF real, inglés, iPhone).

## Cobros y pagos (Studio · entrega S2, migración 0038)

Studio **lee** Finanzas (Cuentas por cobrar, Cuentas por pagar, proveedores):
nunca crea pagos, cobros, gastos ni asientos. Las pruebas cuentan esos registros
antes y después de cada acción de Studio.

- **Carta de cobro** (`collection_letter`, numeración `CC-{YYYY}-{####}`): se
  prepara desde la factura (Cobros → factura → «Preparar carta de cobro»). Lee el
  saldo, los días de atraso, el vencimiento, la promesa de pago pendiente y la
  antigüedad del saldo del cliente. Siempre apunta a una factura; no se emite
  sobre un borrador.
- **Comprobante de pago a proveedor** (`payment_voucher`, `CP-{YYYY}-{####}`):
  se prepara desde un pago **ya registrado** en el gasto (Gastos → gasto →
  «Comprobante de pago (Studio)»). Lee el proveedor, el pago (fecha, método,
  referencia, importe) y las líneas del gasto. No se emite sobre un pago anulado.
- **Orden de compra** vinculable a su gasto (bloque «Gasto vinculado» del editor):
  muestra las líneas y el total del gasto.
- **Estado de cuenta**: ahora incluye la **antigüedad del saldo** (corriente,
  1–30, 31–60, 61–90, más de 90 días).
- Bloques nuevos del editor: **Gasto** (`bill`) y **Antigüedad** (`aging`).
  Campos combinados nuevos: grupos «Cobro (factura vinculada)» y «Gasto y pago al
  proveedor». Un campo puede ser **opcional** con `?`: `{{vendor.tax_id?}}` queda
  vacío sin bloquear la emisión, y una fila de «Campos» con un dato opcional vacío
  no se imprime.
- **Trazabilidad**: el gasto lista sus documentos de Studio (órdenes de compra,
  comprobantes) y la factura lista sus cartas de cobro (`studio_finance_links`).
  Cada vínculo queda en el historial de Studio (`finance_linked`).
- **PDF en el gasto**: un comprobante u orden **emitido** guarda su PDF como
  adjunto del gasto, en el almacenamiento privado `Finance-attachments` (mismas
  reglas que cualquier recibo; descarga con enlace firmado). Queda en el historial
  (`attached_to_bill`).
- **Permisos**: vincular o leer un gasto exige `payables.view`; la carta de cobro
  exige `documents.view`. Un miembro sin `payables.view` no ve los datos del gasto
  en Studio ni la lista de documentos del gasto. Todo es por empresa.
- Un pago con comprobante no se puede borrar (las anulaciones siguen igual: el
  comprobante emitido conserva su instantánea).
- **Sin 0038** (Staging hoy) la aplicación sigue funcionando: no aparecen los dos
  tipos nuevos ni los bloques nuevos, y las páginas de gastos y facturas no
  muestran la sección de Studio.
- Pruebas: `112_studio_finance.test.sql` (escenario 45 de `npm run test:db`:
  aplicar, reaplicar, rollback idéntico a 0037, rollback rechazado con datos o con
  bloques nuevos) y `e2e/studio-finance.auth.e2e.mjs` (`npm run
  test:e2e:studio-finance`: flujo completo en el navegador, PDF real, inglés,
  iPhone).

## Limitaciones conocidas

- **No hay catálogo de productos y servicios** (las sucursales llegan con 0037). Las
  líneas de factura, cotización y recibo vienen del documento comercial. Las
  órdenes de compra y de trabajo usan una tabla editable que **no** crea gastos
  ni facturas. Un catálogo real es otra entrega.
- **La subida y la descarga de imágenes no se probaron contra el servidor de
  Storage de Supabase.** Se probaron con una emulación local que aplica las
  **políticas reales** de los buckets, con el logo, la firma, el sello y las
  imágenes del editor (ver `docs/STUDIO_AUDIT.md`).
- **El asistente aún no usa un modelo de lenguaje.** La arquitectura y las
  barreras están listas.
- **El correo se prepara, no se envía** (no hay proveedor configurado).
- **El editor es por bloques, no de texto enriquecido libre.** Dentro de un
  párrafo, la negrita y la cursiva se aplican al texto seleccionado con los
  botones **B** e *I* (internamente `**…**` y `__…__`). No hay color por
  palabra: el color de acento es por documento o por identidad.
- **Tipografías:** solo Sans y Serif, para que el PDF y la vista previa
  coincidan exactamente.
- **El PDF no es PDF/A ni lleva firma digital criptográfica.** La «firma» es la
  imagen de firma de la empresa.
