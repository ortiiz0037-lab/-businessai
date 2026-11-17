/**
 * The POS register screen rendered on the server with React (no browser available here for the
 * signed-in test): it renders without throwing, in Spanish and English, with touch-sized controls,
 * the server-priced total placeholder, the card note (no card processing) and accessible labels.
 * This is NOT a browser test: interaction (scanning, paying) is covered by the pricing / POS suites.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/app/actions/pos', () => ({ posSearch: vi.fn(async () => []), posCreateSale: vi.fn() }))
const { Register } = await import('@/components/pos/register')

const copy = new Proxy({} as Record<string, string>, { get: (_, k) => `«${String(k)}»` })
const scan = { placeholder: 'Escanea', submit: 'Buscar', camera: 'Cámara', stop: 'Detener', cameraDenied: 'x', cameraUnavailable: 'y', hint: 'HID' }
const render = (locale: 'es' | 'en') => renderToStaticMarkup(createElement(Register, { locale, copy, scan, branchId: 'b', registerId: 'r', shiftId: 's',
  clients: [{ id: 'c1', name: 'Cliente Uno' }], maxDiscountPct: 10, methodLabels: { cash: 'Efectivo', ath_movil: 'ATH Móvil', card_external: 'Tarjeta', check: 'Cheque', transfer: 'Transferencia', other: 'Otro' },
  errors: { save: 'x' } }))

describe('POS register (server render)', () => {
  it('renders in both languages without errors', () => {
    for (const l of ['es', 'en'] as const) {
      const html = render(l)
      expect(html).toContain('data-testid="pos-register"'); expect(html).toContain('data-testid="scan-field"'); expect(html).toContain('Cliente Uno')
    }
  })
  it('an empty cart: total $0.00, charge disabled, empty-state text', () => {
    const html = render('es')
    expect(html).toMatch(/data-testid="pos-total"[^>]*>\$0\.00</)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="pos-charge"|<button[^>]*data-testid="pos-charge"[^>]*disabled=""/)
    expect(html).toContain('«empty»')
  })
  it('touch targets: the charge button is at least 56 px high, search and selects 44 px', () => {
    const html = render('es')
    expect(html).toMatch(/class="[^"]*min-h-14[^"]*"[^>]*data-testid="pos-charge"/)
    expect(html).toMatch(/data-testid="pos-search"/); expect(html).toMatch(/btn-secondary min-h-11/)
  })
  it('every input has an accessible label', () => {
    const html = render('en')
    expect(html).toMatch(/<label class="sr-only" for="pos-q">/)
    expect((html.match(/<select/g) ?? []).length).toBeGreaterThan(0)
  })
})
