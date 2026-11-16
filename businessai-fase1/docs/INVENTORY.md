# Inventario, escáneres de código de barras y reposición inteligente (S7)

**Estado:** implementado y probado **en local** (base de datos de prueba, navegador con la pila
local). La migración `0043_inventory.sql` es un **borrador** (`STAGING-GATE: approval required`):
no está aplicada en Staging ni en Production.

## 1. Arquitectura: una sola fuente de verdad

| Pieza | Qué es | Regla |
|---|---|---|
| **Catálogo** (0039, ampliado) | El mismo `catalog_items`: costo de adquisición (`cost_cents`, distinto del precio), **variantes** (`catalog_variants`: talla, color, modelo; SKU, precio y costo propios) y **códigos** (`catalog_barcodes`: UPC-A, UPC-E, EAN-13, EAN-8, GTIN-14 con dígito de control, Code 128, Code 39, QR, otros). | Un código, un SKU o un código de catálogo identifica **un solo** producto o variante de la empresa (trigger + bloqueo; probado en carrera). Los documentos existentes no cambian. |
| **Movimientos** (`inventory_movements`) | Libro **solo de anotación**: recepción, venta/salida, devolución de cliente, devolución a proveedor, transferencia (salida/entrada), ajuste ±, dañado, perdido, no vendible, conteo, corrección, revaluación. Producto/variante, empresa, sucursal, ubicación, cantidad, fecha y hora, responsable, documento u origen, motivo. | No se edita ni se borra (trigger). Una corrección es un **movimiento compensatorio** que apunta al original (una vez). Clave de idempotencia por empresa. |
| **Existencias** (`inventory_stock`, `inventory_location_stock`) | Caché por sucursal (y por ubicación) mantenida **en la misma transacción** por la única función que escribe movimientos. | `inventory_verify()` recalcula desde el libro: debe dar 0 diferencias (probado en SQL y en el navegador). |
| **Reservado / comprometido / en tránsito / pedido** | Se leen de sus propios registros: reservas (`inventory_reservations`), transferencias aprobadas o preparadas (comprometido en origen), transferencias despachadas (en tránsito al destino) y órdenes de compra abiertas. | Nunca se guardan dos veces. **Disponible = en mano − reservado − comprometido** (`inventory_levels`). |
| **Costo** | Promedio ponderado por sucursal y **capas FIFO** (`inventory_cost_layers`), ambos desde los movimientos; historial de costos (`inventory_cost_history`: manual, recepción, revaluación). | Cada salida guarda su costo FIFO y su costo promedio. La revaluación es un movimiento con motivo. |

Concurrencia: cada clave de existencias (sucursal + producto + variante) se serializa con un
bloqueo; las salidas **nunca** dejan el inventario en negativo salvo que la empresa lo permita
expresamente (ajuste de inventario, desactivado por defecto). Las órdenes, transferencias y
conteos bloquean su fila al cambiar de estado.

## 2. Funcionalidades

- **Escáneres** (`/inventory/scan` y en recepción, salidas, conteos y transferencias):
  - USB y Bluetooth en **modo teclado (HID)**: escriben el código en el campo enfocado y pulsan
    Enter; si el foco está en otra parte de la página, la ráfaga rápida también se reconoce.
  - **Cámara** del iPhone, iPad o computadora: `BarcodeDetector` del navegador cuando existe;
    si no (Safari en iPhone/iPad), el decodificador **ZXing** (`@zxing/browser`, se carga solo al usarla).
  - Escritura manual + Enter, siempre disponible. Sin permiso de cámara se ofrece la búsqueda manual.
  - El mismo código leído otra vez en 1,5 s se ignora (doble lectura accidental); en conteos y recepciones
    cada lectura posterior suma uno. Los códigos desconocidos se informan y pueden asignarse a un producto.
- **Movimientos**: ventas y devoluciones de clientes se registran al instante; ajustes, dañados,
  perdidos, no vendibles, devoluciones a proveedor e inventario inicial **requieren aprobación**
  (un aprobador los registra directamente, con motivo). Salida de las líneas de catálogo de una
  **factura emitida**, una vez por factura.
- **Compras y recepción**: orden de compra (proveedor, sucursal, productos, cantidades, costo) →
  enviar a aprobación → aprobar y emitir → **recepciones parciales y múltiples** por escaneo o a mano,
  con dañados y notas → completa / cerrar con pendientes (motivo) / cancelar (sin recepciones).
  Nunca se recibe más de lo pedido. **Vínculo con la factura del proveedor** de Gastos: una factura
  pertenece a una sola orden; no se crea ningún gasto ni pago (sin duplicados).
- **Transferencias**: solicitud → aprobación → preparación (escaneo) → despacho (sale del origen,
  **en tránsito**) → recepción en destino (escaneo) con diferencias y dañados; la nota es obligatoria
  si hay diferencias. El destino **no** suma existencias antes de confirmar. Queda quién solicitó,
  aprobó, preparó, despachó y recibió.
- **Conteos físicos**: completos (lo que tenga existencias y no se cuente cuenta como 0) o
  parciales, por sucursal y ubicación, por escaneo (cada lectura suma uno) o escribiendo. Al enviar
  se compara con lo registrado; al **aprobar** se ajusta contra las existencias de ese momento
  (respeta las ventas ocurridas entre medio). Historial de diferencias.
- **Reservas**: reservado o comprometido (para pedidos y el futuro punto de venta, S8).
- **Reposición inteligente**: reglas por sucursal y producto (mínimo, máximo, punto de reposición,
  cantidad a pedir, proveedor preferido, días de entrega). Sugerencia con sus motivos:
  proyección = disponible + en tránsito + pedido; con **ventas registradas** de los últimos 90 días
  y tiempo de entrega cubre ese tiempo; **sin ventas registradas lo dice** y usa las reglas básicas;
  nada se inventa. Las líneas elegidas se agrupan por proveedor en **borradores** de orden de compra
  que necesitan aprobación.
- **Informes**: valor por promedio y por FIFO (informativo), movimientos por tipo y periodo con su
  costo, diferencias de conteos aprobados, consistencia con el libro y exportación CSV.
- **Ajustes**: método de valoración destacado, existencias negativas (no recomendado), ubicaciones.

## 3. Permisos y seguridad

| Permiso (0043) | Roles | Para |
|---|---|---|
| `inventory.view` | propietario, administrador, miembro | Ver existencias, movimientos, compras, transferencias y conteos (cantidades). |
| `inventory.operate` | propietario, administrador, miembro | Ventas y devoluciones, solicitudes de ajuste, borradores de compra, recepción, transferencias (solicitar, preparar, despachar, recibir), conteos. |
| `inventory.approve` | propietario, administrador | Aprobar ajustes, conteos, transferencias y órdenes; correcciones; revaluación; reglas de reposición; ajustes de inventario; ver costos. |

Justificación: los miembros ya operan ventas y gastos; reciben, cuentan y despachan, pero no
aprueban. Los costos solo los ven los aprobadores. **Alcance por sucursal**: quien esté asignado a
sucursales (`branch_members`, de 0035) solo ve y mueve esas sucursales; los aprobadores, todas.
RLS en todas las tablas; escrituras solo por funciones `SECURITY DEFINER` con comprobaciones en el
servidor; registro de auditoría (`inventory_events`); el catálogo sigue con `catalog.manage`.

## 4. Valoración y contabilidad (revisado antes de implementar)

Hoy **Gastos (0024)** contabiliza cada factura de proveedor a la cuenta de gasto de su categoría,
y el libro mayor (0023) no tiene cuenta de inventario ni costo de ventas automático. Por eso S7:

- calcula **promedio ponderado y FIFO** desde los movimientos y los muestra como **valor
  informativo, no contabilizado**;
- **no** crea asientos ni un segundo sistema contable, y no cambia cómo Gastos contabiliza.

**Preparado, no implementado** (requiere decisión del propietario y su contador): inventario
perpetuo contable — compras de mercancía a una cuenta de activo «Inventario» (1300) en vez de a
gasto, costo de ventas (5000) al dar salida, y ajustes/revaluaciones contra una cuenta de
diferencias; cierre de periodos coherente con la valoración elegida.

## 5. Probado

| Prueba | Resultado |
|---|---|
| `supabase/tests/local/122_inventory.test.sql` (escenario 50 de `npm run test:db`) | Dígitos de control, unicidad de códigos, búsqueda, libro sin negativos, idempotencia, inmutabilidad, aprobaciones, correcciones, órdenes con recepciones parciales y factura, transferencias en tránsito, conteos, reservas, promedio y FIFO exactos, revaluación, datos de reposición, salida de factura, alcance por sucursal, aislamiento, borrado de empresa |
| `supabase/tests/local/123_inventory_race.sh` | Dos ventas a la vez sin negativos; la misma solicitud dos veces; el mismo código a dos productos; doble despacho; doble recepción |
| `tests/inventory.test.ts` | Dígitos de control GTIN / UPC-E, formatos, ráfagas de escáner HID, dobles lecturas, cantidades, reposición sin datos inventados, agrupación por proveedor |
| `e2e/inventory.auth.e2e.mjs` (`npm run test:e2e:inventory`) | Navegador: catálogo (variantes, códigos, costo), escáner, inventario inicial y ventas escaneando, protección de negativos, aprobación, compra con recepción parcial por escaneo y factura, transferencia, conteo por escaneo, reposición → borrador, informes y CSV, alcance por sucursal, aislamiento, inglés, iPhone y iPad |

## 6. Limitaciones y hardware

- **Escáneres**: probados como entrada de teclado (lo que envía un escáner HID). No se probó un
  modelo físico concreto: cada escáner debe estar en **modo HID / teclado** con sufijo **Enter**
  (o Tab). Algunos lectores Bluetooth en modo SPP/BLE propio no escriben como teclado y no
  funcionarán sin su aplicación. No se asume compatibilidad universal.
- **Cámara**: requiere HTTPS y permiso; `BarcodeDetector` existe en Chrome/Edge (Android, macOS,
  Windows según versión); en Safari se usa ZXing. La lectura con cámara real no se probó en un
  dispositivo físico (el navegador de pruebas no tiene cámara).
- Ubicaciones: la protección contra negativos es por sucursal; el desglose por ubicación es
  informativo.
- La valoración no se contabiliza (punto 4). Sin lotes, números de serie ni caducidad.
- Las órdenes de compra no se imprimen todavía desde Document Studio (el tipo «orden de compra»
  existe en Studio; el bloque de datos de la orden queda para la siguiente entrega).
- El punto de venta (S8) usará `inventory_move` / `inventory_reserve` (ya preparados).

## 7. Hoja de ruta

1. Aprobación de 0043 en Staging.
2. Inventario perpetuo contable (decisión del propietario, punto 4).
3. Documento de orden de compra en Document Studio (bloque de líneas desde la orden).
4. Punto de venta (S8): ventas con escaneo, reservas, devoluciones.
5. Lotes / series / caducidad; etiquetas con código de barras imprimibles.
6. Herramienta de solo lectura del asistente: existencias y alertas de reposición.
