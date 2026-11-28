import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PLAN_CATALOG, TRIAL_DAYS, catalogPlan, isPlanKey, limitLine, limitText } from '@/lib/billing/catalog'
import { buildPlanChangeSession, singleItemId } from '@/lib/billing/portal'
import { isActivePath } from '@/lib/nav'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('public plan catalog', () => {
  it('mirrors billing_plans and billing_config of migration 0010', () => {
    const sql = read('supabase/migrations/0010_billing.sql')
    const rows = [...sql.matchAll(/\('(basic|pro|premium)',\s*'([^']+)',\s*'([^']+)',\s*(\w+),\s*(\w+),\s*(\w+),\s*\d+\)/g)]
      .map(([, plan, name, lookupKey, c, d, m]) => ({
        plan, name, lookupKey,
        maxClients: c === 'null' ? null : Number(c),
        maxDocumentsPerMonth: d === 'null' ? null : Number(d),
        maxMembers: m === 'null' ? null : Number(m),
      }))
    expect(rows).toHaveLength(3)
    expect(PLAN_CATALOG.map(({ plan, name, lookupKey, maxClients, maxDocumentsPerMonth, maxMembers }) =>
      ({ plan, name, lookupKey, maxClients, maxDocumentsPerMonth, maxMembers }))).toEqual(rows)
    expect(sql).toMatch(new RegExp(`trial_days integer not null default ${TRIAL_DAYS}\\b`))
  })

  it('list prices are $19.99 / $39.99 / $59.99, one plan recommended', () => {
    expect(PLAN_CATALOG.map((p) => p.listPriceCents)).toEqual([1999, 3999, 5999])
    expect(PLAN_CATALOG.filter((p) => p.recommended).map((p) => p.plan)).toEqual(['pro'])
    expect(TRIAL_DAYS).toBe(7)
  })

  it('validates plan keys from URLs and cookies', () => {
    expect(['basic', 'pro', 'premium'].every(isPlanKey)).toBe(true)
    for (const bad of ['', 'Pro', 'enterprise', null, undefined, 'pro ', '../billing']) expect(isPlanKey(bad)).toBe(false)
    expect(catalogPlan('premium').name).toBe('Premium')
    expect(limitText(null)).toBe('Ilimitados')
    expect(limitText(1000)).toBe('1,000')
    expect(limitLine(1, 'usuario', 'usuarios')).toBe('1 usuario')
    expect(limitLine(50, 'cliente', 'clientes')).toBe('50 clientes')
    expect(limitLine(null, 'cliente', 'clientes')).toBe('Clientes ilimitados')
  })
})

describe('main menu highlights the current section', () => {
  it('matches the page and its sub-pages only', () => {
    expect(isActivePath('/billing', '/billing')).toBe(true)
    expect(isActivePath('/documents/123', '/documents')).toBe(true)
    expect(isActivePath('/documents', '/dashboard')).toBe(false)
    expect(isActivePath('/documentsx', '/documents')).toBe(false)
    expect(isActivePath('/settings/company', '/settings/company')).toBe(true)
    expect(isActivePath(null, '/dashboard')).toBe(false)
  })
})

describe('plan change through the Customer Portal', () => {
  it('opens the confirmation of the chosen price and returns to /billing', () => {
    const params = buildPlanChangeSession({
      customerId: 'cus_1', subscriptionId: 'sub_1', itemId: 'si_1', priceId: 'price_pro', appUrl: 'https://app.example',
    })
    expect(params).toEqual({
      customer: 'cus_1',
      return_url: 'https://app.example/billing',
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: { subscription: 'sub_1', items: [{ id: 'si_1', price: 'price_pro', quantity: 1 }] },
        after_completion: { type: 'redirect', redirect: { return_url: 'https://app.example/billing?changed=1' } },
      },
    })
  })

  it('only single-item subscriptions use the direct flow', () => {
    expect(singleItemId({ items: { data: [{ id: 'si_1' }] } })).toBe('si_1')
    expect(singleItemId({ items: { data: [] } })).toBeNull()
    expect(singleItemId({ items: { data: [{ id: 'a' }, { id: 'b' }] } })).toBeNull()
  })

  it('the portal route validates the plan and falls back to the portal home', () => {
    const route = read('src/app/api/stripe/portal/route.ts')
    expect(route).toMatch(/!isPlanKey\(requested\)\) return back\(request, 'error=plan'\)/)
    expect(route).toMatch(/PORTAL_PLAN_CHANGE_FALLBACK/)
    expect(route).toMatch(/canManageBilling\) return back\(request, 'error=forbidden'\)/)
  })
})

describe('public texts', () => {
  const pages = ['src/app/(public)/precios/page.tsx', 'src/app/(public)/terminos/page.tsx', 'src/app/(public)/privacidad/page.tsx']

  it('never state that IVU / taxes are included; tax treatment stays pending', () => {
    for (const p of pages) {
      const src = read(p)
      expect(src, p).not.toMatch(/(IVU|impuestos?)[^.]{0,60}\bincluid[oa]s?\b(?![^.]{0,40}(pendiente|<Pending>))/i)
      expect(src, p).not.toMatch(/incluye(n)? (el )?IVU/i)
    }
    expect(read(pages[0])).toMatch(/IVU, está pendiente de confirmación/)
    expect(read(pages[1])).toMatch(/tratamiento contributivo por verificar/)
  })

  it('legal pages are marked as preliminary drafts with pending items', () => {
    expect(read('src/components/legal.tsx')).toMatch(/Borrador preliminar para revisión/)
    for (const p of pages.slice(1)) expect((read(p).match(/<Pending>/g) ?? []).length, p).toBeGreaterThan(5)
  })
})
