import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { ScanLookup } from '@/components/inventory/scanners'
import { inventoryPage } from '@/lib/inventory/page'
import { errorMap, scanCopy } from '@/lib/inventory/copy'

export const dynamic = 'force-dynamic'

/** Scanner: find a product instantly by barcode, SKU or code (scanner, camera or keyboard). */
export default async function ScanPage() {
  const { locale, tr, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Escáner', 'Scanner')}
        description={tr('Escanea con un lector USB o Bluetooth (modo teclado), con la cámara del iPhone, iPad o computadora, o escribe el código.', 'Scan with a USB or Bluetooth reader (keyboard mode), with the iPhone, iPad or computer camera, or type the code.')} />
      <InventoryNav tr={tr} current="/inventory/scan" />
      <section className="card max-w-2xl p-5">
        <ScanLookup copy={scanCopy(tr)} canAssign={access.catalog} labels={{
          unknown: tr('Código desconocido: no corresponde a ningún producto.', 'Unknown code: it matches no product.'),
          notTracked: tr('no controla inventario', 'does not track stock'), archived: tr('archivado', 'archived'),
          open: tr('Ver existencias e historial', 'See stock and history'), assign: tr('Asignar este código a un producto', 'Assign this code to a product'),
          matched: { barcode: tr('código de barras', 'barcode'), sku: 'SKU', code: tr('código del catálogo', 'catalog code') },
          history: tr('Escaneos anteriores', 'Previous scans'), errors: errorMap(locale),
        }} />
      </section>
      {access.operate && (
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/inventory/movements/new?kind=sale" className="btn-secondary">{tr('Registrar salida', 'Record issue')}</Link>
          <Link href="/inventory/purchase-orders" className="btn-secondary">{tr('Recibir mercancía', 'Receive goods')}</Link>
          <Link href="/inventory/counts" className="btn-secondary">{tr('Conteo físico', 'Physical count')}</Link>
          <Link href="/inventory/transfers" className="btn-secondary">{tr('Transferencias', 'Transfers')}</Link>
        </div>
      )}
    </div>
  )
}
