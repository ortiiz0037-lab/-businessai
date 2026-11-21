/**
 * Catalog of products and services (0039): prices in cents, tax rates, error
 * codes, document lines chosen from the catalog (a copy that records where it
 * came from) and Studio table rows.
 */
import { describe, expect, it } from 'vitest'
import { catalogErrorCode, catalogMessage, parsePriceCents, parseTaxRate } from '@/lib/catalog'
import { attachCatalog, parseItemsInput } from '@/lib/documents/items'
import { catalogRow } from '@/components/studio/editor'

const ID = '0f000000-0000-4000-8000-000000000001'
const form = (o: Record<string, string>) => (k: string) => o[k] ?? ''

describe('prices and taxes', () => {
  it('reads prices into integer cents', () => {
    expect(parsePriceCents('12.50')).toBe(1250)
    expect(parsePriceCents('12,5')).toBe(1250)
    expect(parsePriceCents('1,234.56')).toBe(123456)
    expect(parsePriceCents('0')).toBe(0)
    expect(parsePriceCents('0.1')).toBe(10)
    expect(parsePriceCents('1000000000.00')).toBe(100_000_000_000)
  })
  it('refuses negative, malformed or too large prices (never rounds a third decimal)', () => {
    for (const bad of ['', '-1', 'abc', '1.005', '1e3', '10000000000', '1.2.3']) expect(parsePriceCents(bad)).toBeNull()
  })
  it('tax: empty means the document rate; 0–100 with two decimals', () => {
    expect(parseTaxRate('')).toBeNull()
    expect(parseTaxRate('11,5')).toBe(11.5)
    expect(parseTaxRate('100')).toBe(100)
    expect(parseTaxRate('101')).toBeUndefined()
    expect(parseTaxRate('-1')).toBeUndefined()
  })
  it('database errors map to messages in both languages', () => {
    expect(catalogErrorCode({ message: 'CATALOG_CODE_TAKEN' })).toBe('catalog_code_taken')
    expect(catalogErrorCode({ message: 'FORBIDDEN' })).toBe('forbidden')
    expect(catalogErrorCode({ message: 'boom' })).toBe('unexpected')
    expect(catalogMessage('catalog_conflict', 'en')).toMatch(/changed this item/)
    expect(catalogMessage(undefined, 'es')).toBeNull()
  })
})

describe('document lines from the catalog', () => {
  it('a chosen line records its item; a typed line stays as before', () => {
    const r = parseItemsInput(form({ item_description_1: 'Cemento', item_quantity_1: '2', item_price_1: '12.50', item_catalog_1: ID.toUpperCase(),
      item_description_2: 'A mano', item_quantity_2: '1', item_price_2: '5', item_catalog_2: 'not-a-uuid' }))
    expect(r.error).toBeNull()
    expect(r.items[0]).toEqual({ description: 'Cemento', quantity: 2, unit_price: 12.5, amount: 25, catalog_item_id: ID })
    expect(r.items[1]).toEqual({ description: 'A mano', quantity: 1, unit_price: 5, amount: 5 })
  })
  it('the code and unit are copied from the active item; an unknown or archived item is refused', () => {
    const r = parseItemsInput(form({ item_description_1: 'Cemento', item_quantity_1: '1', item_price_1: '12.50', item_catalog_1: ID }))
    expect(attachCatalog(r.items, [{ id: ID, code: 'MAT-01', unit: 'saco' }])?.[0]).toMatchObject({ catalog_item_id: ID, code: 'MAT-01', unit: 'saco', unit_price: 12.5 })
    expect(attachCatalog(r.items, [])).toBeNull()
  })
  it('the line keeps the price the user typed (a copy, not a live link)', () => {
    const r = parseItemsInput(form({ item_description_1: 'Cemento con descuento', item_quantity_1: '1', item_price_1: '10', item_catalog_1: ID }))
    expect(attachCatalog(r.items, [{ id: ID, code: 'MAT-01', unit: 'saco' }])?.[0]).toMatchObject({ description: 'Cemento con descuento', unit_price: 10 })
  })
})

describe('Studio table rows from the catalog', () => {
  const it0 = { id: ID, code: 'MAT-01', name: 'Cemento', price_cents: 1250, unit: 'saco', tax_rate: null }
  const money = (c: number) => `$${(c / 100).toFixed(2)}`
  it('fits the row to the table columns', () => {
    expect(catalogRow(it0, 4, money)).toEqual(['MAT-01', 'Cemento', 'saco', '$12.50'])
    expect(catalogRow(it0, 3, money)).toEqual(['Cemento', 'saco', '$12.50'])
    expect(catalogRow(it0, 2, money)).toEqual(['Cemento', '$12.50 / saco'])
    expect(catalogRow(it0, 1, money)).toEqual(['Cemento · $12.50 / saco'])
    expect(catalogRow(it0, 6, money)).toEqual(['MAT-01', 'Cemento', 'saco', '$12.50', '', ''])
  })
})
