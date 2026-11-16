/** Texts passed to the client scanner components (built on the server in the user's language). */
import type { Locale } from '@/lib/i18n/app'
import type { Tr } from '@/lib/i18n/t'
import { inventoryMessage } from '@/lib/inventory/labels'
import type { ScanCopy } from '@/components/inventory/scan-input'

export function scanCopy(tr: Tr): ScanCopy {
  return {
    placeholder: tr('Escanea o escribe el código', 'Scan or type the code'), submit: tr('Buscar', 'Find'),
    camera: tr('Usar la cámara', 'Use the camera'), stop: tr('Detener cámara', 'Stop camera'),
    cameraDenied: tr('Sin permiso para la cámara: escribe el código o usa un escáner.', 'No camera permission: type the code or use a scanner.'),
    cameraUnavailable: tr('La cámara no está disponible en este dispositivo o navegador: escribe el código o usa un escáner.', 'The camera is not available on this device or browser: type the code or use a scanner.'),
    hint: tr('Escáneres USB / Bluetooth en modo teclado: escanea directamente.', 'USB / Bluetooth scanners in keyboard mode: just scan.'),
  }
}
export function errorMap(locale: Locale): Record<string, string> {
  const keys = ['unknown_code', 'invalid', 'unavailable', 'forbidden', 'branch_forbidden', 'count_not_open', 'inventory_variant_required', 'inventory_item_invalid', 'inventory_invalid', 'save']
  return Object.fromEntries(keys.map((k) => [k, inventoryMessage(k === 'invalid' ? 'inventory_invalid' : k, locale)!]))
}
