import { describe, expect, it } from 'vitest'
import { PRODUCTION_ORIGIN, PRODUCTION_REF, applyAllowed, checkProductionSiteUrl, checkProductionTarget } from '../scripts/production/auth-email.mjs'
import { REQUIRED, planProductionAppUrl, readiness } from '../scripts/production/vercel-env.mjs'

const env = { EXPECTED_SITE_URL: 'https://mybusinessai.site' }

describe('production auth email guards', () => {
  it('accepts only https://mybusinessai.site', () => {
    expect(PRODUCTION_ORIGIN).toBe('https://mybusinessai.site')
    expect(checkProductionSiteUrl('https://mybusinessai.site')).toBeNull()
    expect(checkProductionSiteUrl('https://mybusinessai.site/')).toBeNull()
    expect(checkProductionSiteUrl('https://app.mybusinessai.site')).toMatch(/must be https:\/\/mybusinessai\.site/)
    expect(checkProductionSiteUrl('https://www.mybusinessai.site')).toMatch(/must be https:\/\/mybusinessai\.site/)
    expect(checkProductionSiteUrl('https://staging.mybusinessai.site')).toMatch(/Production domain/)
    expect(checkProductionSiteUrl('https://businessai-x.vercel.app')).toMatch(/Production domain/)
    expect(checkProductionSiteUrl('http://mybusinessai.site')).toMatch(/https/)
    expect(checkProductionSiteUrl('https://mybusinessai.site/login')).toMatch(/origin/)
    expect(checkProductionSiteUrl(undefined)).toMatch(/not a URL/)
  })
  it('pins the Production ref and refuses any other project', () => {
    expect(PRODUCTION_REF).toBe('rugqcumiuqrjbfwpuslm')
    expect(checkProductionTarget(env)).toBeNull()
    expect(checkProductionTarget({ ...env, PROJECT_REF: 'wbfpvxptoujgvflljasc' })).toMatch(/pinned Production/)
  })
  it('stops when the Production Site URL is not the expected origin', () => {
    expect(checkProductionTarget(env, 'https://mybusinessai.site/')).toBeNull()
    expect(checkProductionTarget(env, 'http://localhost:3000')).toMatch(/nothing changed/)
    expect(checkProductionTarget(env, '')).toMatch(/\(empty\)/)
  })
  it('apply needs both the flag and the typed ref', () => {
    expect(applyAllowed(['--apply'], {})).toBe(false)
    expect(applyAllowed(['--plan'], { CONFIRM_PRODUCTION: PRODUCTION_REF })).toBe(false)
    expect(applyAllowed(['--apply'], { CONFIRM_PRODUCTION: PRODUCTION_REF })).toBe(true)
  })
})

describe('vercel production env', () => {
  const e = (key: string, target: string[], value?: string, id = key + target.join()) => ({ id, key, target, gitBranch: null, value })
  it('reports presence for the Production target only', () => {
    const r = readiness([e('APP_ENV', ['production']), e('STRIPE_SECRET_KEY', ['preview'])])
    expect(r.map((x: { key: string }) => x.key)).toEqual(REQUIRED)
    expect(r.find((x: { key: string }) => x.key === 'APP_ENV')!.present).toBe(true)
    expect(r.find((x: { key: string }) => x.key === 'STRIPE_SECRET_KEY')!.present).toBe(false)
  })
  it('never edits an entry shared with Preview', () => {
    expect(planProductionAppUrl([e('NEXT_PUBLIC_APP_URL', ['production', 'preview'], 'x')], 'https://mybusinessai.site').op).toBe('blocked')
  })
  it('creates, updates or leaves the Production-only entry', () => {
    expect(planProductionAppUrl([e('NEXT_PUBLIC_APP_URL', ['preview'], 'https://staging.mybusinessai.site')], 'https://mybusinessai.site')).toEqual({ op: 'create', value: 'https://mybusinessai.site' })
    expect(planProductionAppUrl([e('NEXT_PUBLIC_APP_URL', ['production'], 'https://old.example', 'p1')], 'https://mybusinessai.site')).toMatchObject({ op: 'update', id: 'p1', from: 'https://old.example' })
    expect(planProductionAppUrl([e('NEXT_PUBLIC_APP_URL', ['production'], 'https://mybusinessai.site')], 'https://mybusinessai.site').op).toBe('none')
  })
})
