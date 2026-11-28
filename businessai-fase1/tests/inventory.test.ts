/**
 * Inventory (S7) pure logic: GTIN / UPC-E check digits (the same rules as the database), symbology
 * detection, scanner bursts (HID keyboard mode) and duplicate reads, quantities, replenishment
 * suggestions (no invented demand) and grouping into draft purchase orders.
 */
import { describe, expect, it } from 'vitest'
import { barcodeValid, gtinValid, guessSymbology, normalizeScan, upceToUpca, upceValid } from '@/lib/inventory/codes'
import { DuplicateGuard, HidDetector } from '@/lib/inventory/scanner'
import { groupForOrders, normalizeRow, suggest, type ReplenishmentRow } from '@/lib/inventory/replenishment'
import { inventoryErrorCode, inventoryMessage, parseQty, qtyText } from '@/lib/inventory/labels'

describe('product codes', () => {
  it('GTIN check digits: EAN-13, UPC-A, EAN-8, GTIN-14', () => {
    expect(gtinValid('4006381333931')).toBe(true); expect(gtinValid('4006381333932')).toBe(false)
    expect(gtinValid('036000291452')).toBe(true); expect(gtinValid('96385074')).toBe(true); expect(gtinValid('10012345678902')).toBe(true)
    expect(gtinValid('12345')).toBe(false); expect(gtinValid('abc')).toBe(false)
  })
  it('UPC-E expands to UPC-A and is checked', () => {
    expect(upceToUpca('04252614')).toBe('042100005264'); expect(upceValid('04252614')).toBe(true); expect(upceValid('04252615')).toBe(false)
    expect(upceToUpca('24252614')).toBeNull()
  })
  it('per format; the symbology of a scanned code is guessed from its check digit', () => {
    expect(barcodeValid('ABC-123', 'code39')).toBe(true); expect(barcodeValid('abc', 'code39')).toBe(false)
    expect(barcodeValid('Lote 7/a', 'code128')).toBe(true); expect(barcodeValid('x'.repeat(65), 'code128')).toBe(false)
    expect(guessSymbology('4006381333931')).toBe('ean13'); expect(guessSymbology('036000291452')).toBe('upca'); expect(guessSymbology('96385074')).toBe('ean8')
    expect(guessSymbology('04252614')).toBe('upce'); expect(guessSymbology('P-001')).toBe('code128')
  })
  it('scanner suffixes and control characters are removed', () => {
    expect(normalizeScan(' 4006381333931\r\n')).toBe('4006381333931'); expect(normalizeScan('\tABC\u0000')).toBe('ABC')
  })
})

describe('scanners', () => {
  it('a fast burst ended by Enter is a scan; slow typing is not', () => {
    const h = new HidDetector({ minLength: 4, maxGapMs: 50 })
    let t = 1000, out: string | null = null
    for (const c of '4006381333931') out = h.key(c, (t += 8))
    expect(out).toBeNull()
    expect(h.key('Enter', (t += 8))).toBe('4006381333931')
    // a person typing (200 ms between keys): only the last key remains → too short
    for (const c of 'ABCDE') h.key(c, (t += 200))
    expect(h.key('Enter', (t += 200))).toBeNull()
    // Tab as suffix, modifiers ignored
    for (const c of 'P-001') { h.key('Shift', t); h.key(c, (t += 5)) }
    expect(h.key('Tab', (t += 5))).toBe('P-001')
  })
  it('the same code read again too soon is ignored; later it counts again', () => {
    const g = new DuplicateGuard(1500)
    expect(g.accept('X', 0)).toBe(true); expect(g.accept('X', 400)).toBe(false); expect(g.accept('Y', 500)).toBe(true); expect(g.accept('X', 2100)).toBe(true)
  })
})

describe('quantities and messages', () => {
  it('quantities: positive, up to 3 decimals, comma accepted', () => {
    expect(parseQty('12')).toBe(12); expect(parseQty('1,5')).toBe(1.5); expect(parseQty('0')).toBeNull(); expect(parseQty('-1')).toBeNull(); expect(parseQty('1.2345')).toBeNull()
    expect(qtyText(5)).toBe('5'); expect(qtyText('2.500')).toBe('2.5')
  })
  it('database errors become clear messages in both languages', () => {
    expect(inventoryErrorCode({ message: 'INVENTORY_INSUFFICIENT' })).toBe('inventory_insufficient')
    expect(inventoryErrorCode({ message: 'x', code: '42501' })).toBe('forbidden')
    expect(inventoryMessage('inventory_insufficient', 'es')).toMatch(/negativo/); expect(inventoryMessage('po_over_receipt', 'en')).toMatch(/more than ordered/)
  })
})

describe('smart replenishment (no invented demand)', () => {
  const base: ReplenishmentRow = { branch_id: 'b', item_id: 'i', variant_key: '0', on_hand: 4, reserved: 1, committed: 0, available: 3, in_transit: 0, on_order: 0,
    min_qty: 2, max_qty: null, reorder_point: 5, reorder_qty: 10, preferred_vendor_id: 'v', lead_time_days: 7, sold_90d: null, sale_days: null, first_sale: null, unit_cost_cents: 500 }
  const today = new Date('2026-11-16T12:00:00Z')
  it('without recorded sales: basic rules, and it says so', () => {
    const s = suggest(base, today)
    expect(s).toMatchObject({ needed: true, qty: 10, basis: 'rules', daily: null })
    expect(s.reasons).toEqual(expect.arrayContaining(['no_sales_history', 'below_reorder_point', 'reorder_quantity']))
  })
  it('up to the maximum when there is one; incoming goods are counted', () => {
    expect(suggest({ ...base, max_qty: 20 }, today)).toMatchObject({ qty: 17 })
    const covered = suggest({ ...base, in_transit: 3, on_order: 2 }, today)
    expect(covered.needed).toBe(false); expect(covered.reasons).toContain('covered_by_incoming')
  })
  it('with recorded sales and a lead time: enough to cover the lead time above the reorder point', () => {
    // 30 sold in the 30 days since the first sale → 1 / day; lead 7 → 5 + 7 − 3 = 9 < reorder qty 10; with 3 / day → 5 + 21 − 3 = 23
    expect(suggest({ ...base, sold_90d: 30, first_sale: '2026-10-18' }, today)).toMatchObject({ qty: 10, basis: 'rules' })
    const fast = suggest({ ...base, sold_90d: 90, first_sale: '2026-10-18' }, today)
    expect(fast).toMatchObject({ qty: 23, basis: 'velocity' }); expect(fast.reasons).toContain('velocity_lead_time'); expect(fast.daysOfCover).toBe(1)
    expect(suggest({ ...base, sold_90d: 90, first_sale: '2026-10-18', lead_time_days: null }, today).reasons).toContain('no_lead_time')
  })
  it('no rule → no suggestion; database rows are normalized', () => {
    expect(suggest({ ...base, reorder_point: null, min_qty: null }, today)).toMatchObject({ needed: false, qty: 0, reasons: expect.arrayContaining(['no_rule']) })
    expect(normalizeRow({ branch_id: 'b', item_id: 'i', variant_key: 'z', on_hand: '4.000', available: '3', reorder_point: '5.000', sold_90d: null }).reorder_point).toBe(5)
  })
  it('chosen lines are grouped per vendor and branch (lines without a vendor are left out)', () => {
    const g = groupForOrders([{ vendor: 'v1', branch: 'b1', item: 'a', variant: null, qty: 2, unit_cost: 1 }, { vendor: 'v1', branch: 'b1', item: 'b', variant: null, qty: 1, unit_cost: 1 },
      { vendor: 'v2', branch: 'b1', item: 'c', variant: null, qty: 1, unit_cost: 1 }, { vendor: null, branch: 'b1', item: 'd', variant: null, qty: 1, unit_cost: 1 }])
    expect(g.map((x) => [x.vendor, x.lines.length])).toEqual([['v1', 2], ['v2', 1]])
  })
})
