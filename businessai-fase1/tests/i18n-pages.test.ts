/**
 * Phase B: every signed-in page is bilingual. Each page under src/app/(app)
 * must take the user's language (getLocale) and render through the
 * translator or the APP dictionary; the shared labels exist in both
 * languages; no backup copies of pages are left in src.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { documentStatus, documentTypeName } from '@/components/ui/status'
import { paymentErrorMessage, paymentMethodLabel, PAYMENT_ERROR_MESSAGE, PAYMENT_ERROR_MESSAGE_EN } from '@/lib/documents/payments'
import { BILLING_ERROR_MESSAGE, BILLING_ERROR_MESSAGE_EN, STATE_LABEL, STATE_LABEL_EN } from '@/lib/billing/state'
import { translator } from '@/lib/i18n/t'

const root = new URL('../src/', import.meta.url).pathname
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

describe('every signed-in page is bilingual', () => {
  const pages = walk(join(root, 'app/(app)')).filter((p) => p.endsWith('page.tsx'))
  it('finds the app pages', () => expect(pages.length).toBeGreaterThanOrEqual(11))
  for (const page of pages) {
    it(page.slice(root.length), () => {
      const text = readFileSync(page, 'utf8')
      // directly, or through the workforce / accounting / payroll page helpers (which call both)
      expect(text).toMatch(/getLocale\(\)|workforcePage\(\)|accountingPage\(\)|payablesPage\(\)|receivablesPage\(\)|bankPage\(\)|financePage\(\)|studioPage\(\)|payrollPage\(\)|crmPage\(/)
      expect(text).toMatch(/translator\(|APP\[locale\]|workforcePage\(\)|accountingPage\(\)|payablesPage\(\)|receivablesPage\(\)|bankPage\(\)|financePage\(\)|studioPage\(\)|payrollPage\(\)|crmPage\(/)
    })
  }
  it('no backup copies of pages in src', () => {
    expect(walk(root).filter((p) => /backup|\.bak$|\.orig$/.test(p))).toEqual([])
  })
})

describe('shared labels exist in both languages', () => {
  it('translator', () => {
    expect(translator('es')('Hola', 'Hi')).toBe('Hola')
    expect(translator('en')('Hola', 'Hi')).toBe('Hi')
  })
  it('statuses and document types', () => {
    for (const s of ['draft', 'sent', 'partial', 'paid', 'overdue', 'accepted', 'rejected', 'cancelled']) {
      expect(documentStatus(s, 'en').label).not.toBe(documentStatus(s, 'es').label)
      expect(documentStatus(s, 'en').label).toMatch(/^[A-Z][a-z ]+$/)
    }
    expect(documentTypeName('invoice', 'en')).toBe('Invoice')
    expect(documentTypeName('quote', 'es')).toBe('Cotización')
  })
  it('payment and billing messages have the same codes in both languages', () => {
    expect(Object.keys(PAYMENT_ERROR_MESSAGE_EN).sort()).toEqual(Object.keys(PAYMENT_ERROR_MESSAGE).sort())
    expect(Object.keys(BILLING_ERROR_MESSAGE_EN).sort()).toEqual(Object.keys(BILLING_ERROR_MESSAGE).sort())
    expect(Object.keys(STATE_LABEL_EN).sort()).toEqual(Object.keys(STATE_LABEL).sort())
    expect(paymentErrorMessage('over_balance', 'en')).toMatch(/open balance/)
    expect(paymentMethodLabel('transfer', 'en')).toBe('Bank transfer')
  })
})
