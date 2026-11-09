import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LANDING, toLocale, type LandingCopy } from '@/lib/i18n/landing'
import { displayPrice, planHrefs } from '@/components/marketing/plan-cards'
import { PLAN_CATALOG } from '@/lib/billing/catalog'

/** Every string of a copy object, with the shape (keys) as a path. */
function flatten(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value }
  if (typeof value === 'function') return { [path]: String((value as (n: string) => string)('7')) }
  if (Array.isArray(value)) return Object.assign({}, ...value.map((v, i) => flatten(v, `${path}[${i}]`)))
  if (value && typeof value === 'object') {
    return Object.assign({}, ...Object.entries(value).map(([k, v]) => flatten(v, path ? `${path}.${k}` : k)))
  }
  return {}
}

describe('home page copy (es / en)', () => {
  const es = flatten(LANDING.es)
  const en = flatten(LANDING.en)

  it('both languages have exactly the same texts (no missing translation)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort())
    for (const [k, v] of Object.entries(en)) expect(v.trim(), k).not.toBe('')
  })

  it('language comes from ?lang=en, Spanish otherwise', () => {
    expect(toLocale('en')).toBe('en')
    for (const v of [undefined, '', 'es', 'EN', 'fr']) expect(toLocale(v)).toBe('es')
  })

  it('shows the 7-day trial and plan names Básico/Basic, Pro, Premium', () => {
    const copy: LandingCopy[] = [LANDING.es, LANDING.en]
    for (const c of copy) {
      expect(c.hero.badge).toMatch(/7/)
      expect(c.pricing.trial).toMatch(/7/)
      expect(Object.keys(c.pricing.plans)).toEqual(['basic', 'pro', 'premium'])
    }
    expect(LANDING.en.pricing.plans.basic.name).toBe('Basic')
    expect(LANDING.es.pricing.plans.basic.name).toBe('Básico')
  })

  it('never says taxes / IVU are included and makes no AI claims', () => {
    for (const text of [...Object.values(es), ...Object.values(en)]) {
      expect(text).not.toMatch(/(IVU|tax(es)?|impuestos?)[^.]{0,40}\binclu(ded|ido|idos|ye|yen)\b/i)
      expect(text).not.toMatch(/\bIA\b|inteligencia artificial|artificial intelligence|\bAI[- ]powered\b/i)
    }
    expect(LANDING.es.pricing.taxes).toMatch(/pendientes de confirmar/)
    expect(LANDING.en.pricing.taxes).toMatch(/pending confirmation/)
  })
})

describe('plan cards', () => {
  it('fall back to $19.99 / $39.99 / $59.99 without Stripe', () => {
    expect(PLAN_CATALOG.map((p) => displayPrice(p, new Map()).amount)).toEqual(['$19.99', '$39.99', '$59.99'])
  })

  it('use the Stripe price when configured', () => {
    const prices = new Map([['businessai_pro_monthly', { unitAmount: 4999, currency: 'usd', interval: 'month' as const }]])
    expect(displayPrice(PLAN_CATALOG[1], prices).amount).toBe('$49.99')
  })

  it('lead to signup with the plan (signed out) or to the plan page (signed in)', () => {
    expect(planHrefs('pro', false)).toEqual({ start: '/signup?plan=pro', login: '/login?next=%2Fbilling%3Fplan%3Dpro%23plan-pro' })
    expect(planHrefs('premium', true).start).toBe('/billing?plan=premium#plan-premium')
  })
})

describe('routes', () => {
  it('/register forwards to /signup keeping only a valid plan', () => {
    const src = readFileSync(new URL('../src/app/register/page.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/isPlanKey\(plan\) \? `\/signup\?plan=\$\{plan\}` : '\/signup'/)
  })
})
