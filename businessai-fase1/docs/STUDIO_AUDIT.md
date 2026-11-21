# Document Studio — auditoría funcional y visual (entrega 7)

**Fecha:** 12 nov 2026 · **Rama:** `claude/businessai-platform-audit-vjjcoc`
**Resultado:** 76 aprobadas · 0 fallidas · 3 no comprobables (`e2e/studio-audit.e2e.mjs`)

## Cómo se probó

- **Interfaz real:** Playwright maneja la interfaz con una sesión iniciada en
  el formulario de acceso. No se usan llamadas internas, salvo en las pruebas
  de seguridad que **intentan** saltarse la interfaz.
- **Pila 100 % local:** PostgreSQL con todas las migraciones hasta la 0028,
  más PostgREST 12.2.3 y el sustituto de Auth (`e2e/local-stack`), todo en
  `127.0.0.1`.
- **PDF:** se verifica con lectores independientes de Poppler (`pdftotext`,
  `pdfinfo`, `pdfimages`, `pdftoppm`).
- **Evidencia:** capturas, PDF y texto extraído se guardan en `$EVIDENCE`
  (fuera del repositorio).

### Sustitutos locales en lugar de servicios reales

| Servicio real | Sustituto | Qué es real y qué no |
|---|---|---|
| Supabase Auth | `auth-stub.mjs`: JWT HS256 con clave aleatoria por ejecución y 4 usuarios de prueba | El inicio de sesión de la app, las cookies y las comprobaciones `getUser` son reales. No prueba registro, correo, recuperación ni renovación real de tokens. |
| Supabase API (PostgREST) | **PostgREST 12.2.3 oficial**, local | Real: es el mismo componente que usa Supabase. |
| Supabase Storage | Emulación en `auth-stub.mjs`: cada subida, lectura, firma o borrado se ejecuta **como el usuario** sobre `storage.objects` vía PostgREST | **Las políticas reales de los buckets** (migraciones 0007, 0009 y 0028) deciden. Se respetan el límite de tamaño y los tipos de cada bucket. No es el servidor de Storage de Supabase (sin CDN ni transformaciones de imagen). |
| Correo | ninguno | Studio prepara el correo, no lo envía. |
| Diálogo de impresión | ninguno | Un navegador sin interfaz no puede operar el diálogo del sistema operativo. Se verifica el PDF que se imprime. |

Para que la subida del logo y de la firma (que ocurre en el navegador) use la
pila local, la auditoría construye la app con
`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3252`. Así es como funciona en
producción: Next incrusta la URL al compilar. Después se vuelve a construir
de forma normal.

## Errores encontrados y corregidos en esta auditoría

| Error | Corrección |
|---|---|
| Al elegir **Serif** en el documento, los títulos seguían en Sans (solo se usaba la tipografía de títulos de la identidad) | La tipografía del documento también se aplica a los títulos. Prueba unitaria añadida. |
| No había forma de dar formato al **texto seleccionado** (había que escribir `**…**` a mano) | Botones **B** e *I* que aplican el formato a la selección. |
| No se podía crear un documento **desde cero** | Opción «Documento en blanco», eligiendo el tipo. |
| El color solo se podía cambiar en la identidad, no por documento | Color de acento por documento («Página y tipografía»), validado también por la base de datos. |
| Un proceso `next-server` podía quedar vivo tras las pruebas | Los ejecutores esperan a que el grupo de procesos termine. |

Los demás fallos de las primeras ejecuciones eran del propio script de
auditoría (selectores ambiguos, una tecla que no lleva al final del texto,
ancho de página supuesto, la marca de agua contada como texto fuera del
margen). Se corrigieron en el script, no en la app.

## Resultados

| Fase | Función | Resultado | Evidencia | Notas |
|---|---|---|---|---|
| Fase 1 — Editor visual | Crear un documento desde cero (documento en blanco, tipo Informe) | ✅ aprobada | 1-01-blank-created.png |  |
| Fase 1 — Editor visual | Seleccionar texto y aplicar negrita y cursiva con los botones | ✅ aprobada |  | Este texto contiene una palabra **importante** y otra __destacada__ para el cliente {{client.name}}. |
| Fase 1 — Editor visual | Escribir y editar texto en el bloque | ✅ aprobada |  |  |
| Fase 1 — Editor visual | Insertar tabla, añadir filas y columnas | ✅ aprobada |  |  |
| Fase 1 — Editor visual | Insertar imagen subiéndola desde el editor (bucket privado, validada) | ✅ aprobada |  | c1f5437d-3a47-416c-b91b-70b45baa5a5a |
| Fase 1 — Editor visual | Insertar firma con nombre y cargo | ✅ aprobada |  |  |
| Fase 1 — Editor visual | Cambiar tamaño de página (A4) — la vista previa cambia | ✅ aprobada | 1-02-editor-before-save.png | 0 0 595.28 841.89 |
| Fase 1 — Editor visual | Guardar (Ctrl/Cmd+S o botón, sin salir de la página) | ✅ aprobada |  |  |
| Fase 1 — Editor visual | Cerrar y volver a abrir: textos, formato, tabla, imagen, firma, márgenes, tipografía y color persisten | ✅ aprobada | 1-03-reopened.png | {"heading":"Informe de auditoría visual","para":"Este texto contiene una palabra **importante** y otra __destacada__ para el cliente {{client.name}}. Texto añad |
| Fase 1 — Editor visual | Vista previa: color de acento y tipografía Serif aplicados al título | ✅ aprobada |  | #0f766e BAStudioSerif |
| Fase 1 — Editor visual | Vista previa: la negrita y la cursiva se ven como tales | ✅ aprobada |  | 700 italic |
| Fase 1 — Editor visual | Vista previa: imagen, tabla y firma presentes | ✅ aprobada |  |  |
| Fase 1 — Editor visual | La imagen se sirve desde el almacenamiento privado con la sesión del usuario | ✅ aprobada |  |  |
| Fase 1 — Editor visual | Alineación centrada aplicada al párrafo | ✅ aprobada |  | línea 280.7–348.6 · márgenes 90.7–538.6 |
| Fase 2 — Plantillas | Plantilla Carta: datos reales en la vista y en el PDF | ✅ aprobada | 2-business_letter.png, 2-business_letter.pdf |  |
| Fase 2 — Plantillas | Plantilla Cotización: datos reales en la vista y en el PDF | ✅ aprobada | 2-quote_classic.png, 2-quote_classic.pdf |  |
| Fase 2 — Plantillas | Plantilla Factura: datos reales en la vista y en el PDF | ✅ aprobada | 2-invoice_classic.png, 2-invoice_classic.pdf |  |
| Fase 2 — Plantillas | Plantilla Recibo: datos reales en la vista y en el PDF | ✅ aprobada | 2-receipt_classic.png, 2-receipt_classic.pdf |  |
| Fase 2 — Plantillas | Plantilla Orden de trabajo: datos reales en la vista y en el PDF | ✅ aprobada | 2-work_order.png, 2-work_order.pdf |  |
| Fase 2 — Plantillas | Plantilla Orden de compra: datos reales en la vista y en el PDF | ✅ aprobada | 2-purchase_order.png, 2-purchase_order.pdf |  |
| Fase 2 — Plantillas | Plantilla Contrato: datos reales en la vista y en el PDF | ✅ aprobada | 2-service_contract.png, 2-service_contract.pdf |  |
| Fase 2 — Plantillas | Plantilla Informe: datos reales en la vista y en el PDF | ✅ aprobada | 2-business_report.png, 2-business_report.pdf |  |
| Fase 2 — Plantillas | Plantilla Estado de cuenta: datos reales en la vista y en el PDF | ✅ aprobada | 2-account_statement.png, 2-account_statement.pdf |  |
| Fase 2 — Plantillas | Plantilla Certificado: datos reales en la vista y en el PDF | ✅ aprobada | 2-certificate.png, 2-certificate.pdf |  |
| Fase 2 — Plantillas | Emitir factura (usa el número de la factura comercial) | ✅ aprobada |  | Emitido el 12 nov, 11:35 p. m.: no se modifica. |
| Fase 2 — Plantillas | Emitir carta (numeración propia) | ✅ aprobada |  | Emitido el 12 nov, 11:35 p. m.: no se modifica. |
| Fase 2 — Plantillas | Emitir certificado | ✅ aprobada |  | Emitido el 12 nov, 11:35 p. m.: no se modifica. |
| Fase 2 — Plantillas | Personalizar una plantilla del sistema y editarla (copia de la empresa) | ✅ aprobada | 2-template-editor.png |  |
| Fase 2 — Plantillas | Reutilizar la plantilla personalizada (dos documentos nuevos la incluyen) | ✅ aprobada |  |  |
| Fase 2 — Plantillas | La plantilla del sistema sigue intacta junto a la de la empresa | ✅ aprobada |  |  |
| Fase 3 — Identidad corporativa | Cargar un logo de prueba (Mi empresa → bucket público de logos, con las políticas reales) | ✅ aprobada | 3-01-logo-uploaded.png |  |
| Fase 3 — Identidad corporativa | Cargar la firma de la empresa (bucket privado de firmas) | ✅ aprobada |  |  |
| Fase 3 — Identidad corporativa | Modificar colores, encabezado, pie, marca de agua, firma por defecto y sello | ✅ aprobada | 3-02-brand.png |  |
| Fase 3 — Identidad corporativa | Logo, firma y sello aparecen en el documento | ✅ aprobada | 3-03-identity-in-document.png | logo=1 firma=1 sello=1 |
| Fase 3 — Identidad corporativa | Encabezado (con campos), pie y firma por defecto aplicados | ✅ aprobada |  |  |
| Fase 3 — Identidad corporativa | El color corporativo se aplica | ✅ aprobada |  | #7c3aed |
| Fase 3 — Identidad corporativa | El PDF incluye encabezado, logo, firma y sello | ✅ aprobada | 3-identity.pdf | imágenes en el PDF: 6 |
| Fase 3 — Identidad corporativa | Cada empresa conserva su propia identidad | ✅ aprobada | 3-04-other-company.png |  |
| Fase 4 — Integración | Clientes: nombre, empresa, dirección y correo del cliente vinculado (cartas, contratos, estados de cuenta) | ✅ aprobada | 2-business_letter.pdf |  |
| Fase 4 — Integración | Facturas: número, líneas, impuesto, total, pagado y balance leídos de la factura comercial | ✅ aprobada | 2-invoice_classic.pdf |  |
| Fase 4 — Integración | Cotizaciones: líneas y total de la cotización vinculada | ✅ aprobada | 2-quote_classic.pdf |  |
| Fase 4 — Integración | Pagos: pagos registrados de la factura (recibo) | ✅ aprobada | 2-receipt_classic.pdf |  |
| Fase 4 — Integración | Empleados: nombre, puesto y fecha de ingreso (certificado) | ✅ aprobada | 2-certificate.pdf |  |
| Fase 4 — Integración | Proveedores: orden de compra con datos del proveedor | ✅ aprobada | 2-purchase_order.pdf |  |
| Fase 4 — Integración | Sin duplicados ni datos financieros paralelos: documentos comerciales, pagos, clientes, empleados y asientos sin cambios tras crear y emitir documentos de Studio | ✅ aprobada |  | antes {"documents":4,"payments":2,"clients":2,"employees":1,"journal":29} · después {"documents":4,"payments":2,"clients":2,"employees":1,"journal":29} |
| Fase 4 — Integración | La factura emitida en Studio usa el número de la factura comercial (sin segunda numeración) | ✅ aprobada |  | FAC-2026-0003 = FAC-2026-0003 |
| Fase 4 — Integración | Sucursales | ⚪ no probada |  | No existe en BusinessAI (no hay tabla ni pantalla): no se puede vincular. Se reporta, no se inventa. |
| Fase 4 — Integración | Productos y servicios | ⚪ no probada |  | No existe en BusinessAI (no hay tabla ni pantalla): no se puede vincular. Se reporta, no se inventa. |
| Fase 5 — PDF e impresión | Documento de varias páginas guardado | ✅ aprobada |  |  |
| Fase 5 — PDF e impresión | Generar PDF (en línea, para ver e imprimir) | ✅ aprobada | 5-multipage.pdf |  |
| Fase 5 — PDF e impresión | Varias páginas: el PDF tiene las mismas páginas que la vista previa | ✅ aprobada |  | PDF 4 · vista 4 |
| Fase 5 — PDF e impresión | Texto seleccionable y extraíble (pdftotext) | ✅ aprobada | 5-multipage.txt |  |
| Fase 5 — PDF e impresión | Tablas: se parten entre páginas y repiten el encabezado | ✅ aprobada |  | encabezado 3 veces |
| Fase 5 — PDF e impresión | Salto de página: el anexo empieza en su propia página | ✅ aprobada |  |  |
| Fase 5 — PDF e impresión | Imágenes incrustadas en el PDF (pdfimages) | ✅ aprobada |  | 10 imágenes |
| Fase 5 — PDF e impresión | Márgenes respetados (ningún texto fuera de 30 mm) | ✅ aprobada |  | x 85.0–527.0 · margen 85.0–527.0 |
| Fase 5 — PDF e impresión | El PDF conserva el diseño: la misma palabra está en la misma posición en la vista previa y en el PDF | ✅ aprobada | 5-multipage-page-1.png, 5-multipage-page-2.png | vista x=85.04 · PDF x=85.04 |
| Fase 5 — PDF e impresión | Descargar PDF desde el botón | ✅ aprobada | 5-download.pdf | Informe-de-varias-p-ginas.pdf |
| Fase 5 — PDF e impresión | Imprimir: «Ver PDF / Imprimir» abre el PDF en una pestaña para el diálogo de impresión del navegador | ✅ aprobada |  |  |
| Fase 5 — PDF e impresión | Diálogo de impresión del sistema | ⚪ no probada |  | Un navegador sin interfaz no puede abrir ni operar el diálogo de impresión del sistema operativo; se verificó el PDF que se imprime. |
| Fase 6 — Seguridad | Miembro: consulta y edita borradores, no ve «Emitir» | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Miembro: emitir por la API directamente es rechazado por la base de datos | ✅ aprobada |  | {"code":"P0001","details":null,"hint":null,"message":"STUDIO_NOT_FOUND"} |
| Fase 6 — Seguridad | Miembro: no puede cambiar la identidad (ni por la API) | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Miembro: usa plantillas, no las personaliza | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Administrador: puede emitir | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Otra empresa: no abre el documento (404) | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Otra empresa: no descarga su PDF (404) | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Otra empresa: no obtiene sus imágenes (404) | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Otra empresa por la API: 0 documentos visibles; datos del documento rechazados | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Almacenamiento privado: el archivo lo lee su empresa; otra empresa y el acceso público no | ✅ aprobada |  | empresa 200 · otra 400 · público 404 |
| Fase 6 — Seguridad | Otra empresa no puede subir archivos a la carpeta de esta empresa (política del bucket) | ✅ aprobada |  | 403 |
| Fase 6 — Seguridad | Un SVG con extensión .png se rechaza por su contenido | ✅ aprobada |  |  |
| Fase 6 — Seguridad | Documento emitido inmutable: sin editor, guardar por la API → STUDIO_LOCKED, modificación directa denegada | ✅ aprobada | 6-issued-readonly.png | rpc: {"code":"P0001","details":null,"hint":"final","message":"STU · patch 403 |
| Fase 7 — Responsive | iPhone 13: el editor se usa (escribir, guardar, vista previa), sin controles cortados ni desplazamiento horizontal | ✅ aprobada | 7-iphone-13-editor.png | guardado=true vista=true · cortados: ninguno · desborde 0px |
| Fase 7 — Responsive | iPad Mini: el editor se usa (escribir, guardar, vista previa), sin controles cortados ni desplazamiento horizontal | ✅ aprobada | 7-ipad-mini-editor.png | guardado=true vista=true · cortados: ninguno · desborde 0px |
| Fase 7 — Responsive | Escritorio: el editor se usa (escribir, guardar, vista previa), sin controles cortados ni desplazamiento horizontal | ✅ aprobada | 7-escritorio-editor.png | guardado=true vista=true · cortados: ninguno · desborde 0px |
| Fase 8 — Errores de consola y HTTP | Sin errores en el registro del servidor Next.js | ✅ aprobada |  |  |
| Fase 8 — Errores de consola y HTTP | Sin errores de consola del navegador ni respuestas HTTP 5xx/405 | ✅ aprobada |  |  |
| Fase 8 — Errores de consola y HTTP | La app usó solo endpoints implementados por el sustituto local | ✅ aprobada |  |  |

## Regresión (después de las correcciones)

| Prueba | Resultado |
|---|---|
| Arnés PostgreSQL completo desde cero (`supabase/tests/local/run.sh`) | 400 / 0 |
| Pruebas unitarias (vitest) | 581 aprobadas |
| TypeScript | sin errores |
| Lint | 0 errores (5 avisos que ya existían) |
| `next build` | compila |
| E2E público | 137 / 0 |
| E2E Document Studio con sesión | 51 / 0 |
| E2E finanzas, entregas 2–6, con sesión | 85 / 0 |

## Cómo repetirla

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3252 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local-e2e-placeholder npm run build
PSQL="psql -h /ruta/socket -p 5432 -U postgres" bash e2e/local-stack/db.sh
PGRST_BIN=/ruta/postgrest PG_SOCKET=/ruta/socket PG_PORT=5432 EVIDENCE=/tmp/auditoria node e2e/studio-audit.e2e.mjs
npm run build   # volver a la compilación normal
```
