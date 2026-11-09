import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH } from '@/lib/i18n/auth'
import { documentIcon, documentStatus } from '@/components/ui/status'
import { planHrefs } from '@/components/marketing/plan-cards'

const ROOT = new URL('..', import.meta.url).pathname
const css = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf8')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx$/.test(name) && !/backup|before-|pre-audit/.test(name) ? [p] : []
  })
}

describe('design system', () => {
  it('every design-system class used in the app is defined in globals.css', () => {
    const used = new Set<string>()
    for (const file of sources(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/(?<![\w-])((?:btn|badge|alert|card|field|table)(?:-[a-z]+)*|eyebrow|page-title|section-title|divider-gold)(?![\w-])/g)) {
        used.add(m[1])
      }
    }
    // Words that only appear in code (identifiers / props), not CSS classes.
    for (const notCss of ['card-dark', 'field', 'card', 'btn', 'badge', 'alert', 'table']) used.delete(notCss)
    const missing = [...used].filter((c) => !new RegExp(`@utility ${c} \\{`).test(css))
    expect(missing).toEqual([])
    for (const base of ['btn', 'card', 'card-dark', 'field', 'badge', 'alert', 'table-premium']) {
      expect(css).toMatch(new RegExp(`@utility ${base} \\{`))
    }
  })

  it('brand tokens: ink (black), gold and the two typefaces', () => {
    expect(css).toMatch(/--color-ink-950: #0a0a0c/)
    expect(css).toMatch(/--color-gold-500: #c39a3c/)
    expect(css).toMatch(/--font-display: var\(--font-playfair\)/)
    expect(css).toMatch(/--font-sans: var\(--font-manrope\)/)
    // The print rules for documents are preserved.
    expect(css).toMatch(/@media print[\s\S]*article/)
  })
})

describe('sign-in / sign-up copy (es / en)', () => {
  const keys = (o: unknown, p = ''): string[] =>
    typeof o === 'object' && o !== null
      ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k))
      : [p]
  it('both languages have the same texts', () => {
    expect(keys(AUTH.en).sort()).toEqual(keys(AUTH.es).sort())
    expect(AUTH.en.signup.chosen('Pro', 7)).toMatch(/7-day/)
    expect(AUTH.es.signup.chosen('Pro', 7)).toMatch(/7 días/)
  })
  it('makes no claims about taxes or AI features', () => {
    const text = JSON.stringify(AUTH)
    expect(text).not.toMatch(/IVU|impuesto|\bIA\b|inteligencia artificial|AI-powered/i)
  })
})

describe('shared document status', () => {
  it('labels and styles every status in Spanish', () => {
    expect(documentStatus('paid')).toEqual({ label: 'Pagado', className: 'badge-success' })
    expect(documentStatus('sent').label).toBe('Enviado')
    expect(documentStatus('overdue').className).toBe('badge-danger')
    expect(documentStatus(null)).toEqual({ label: 'Pendiente', className: 'badge-warning' })
    expect(documentStatus('custom').label).toBe('custom')
  })
  it('has an icon per document type', () => {
    expect(documentIcon('invoice')).toBe('receipt')
    expect(documentIcon('quote')).toBe('clipboard')
    expect(documentIcon('unknown')).toBe('file')
  })
})

describe('English plan links keep the language', () => {
  it('signup and login carry lang=en', () => {
    expect(planHrefs('pro', false, 'en')).toEqual({
      start: '/signup?plan=pro&lang=en',
      login: '/login?next=%2Fbilling%3Fplan%3Dpro%23plan-pro&lang=en',
    })
  })
})
