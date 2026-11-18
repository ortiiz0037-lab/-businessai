import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkAppUrl, planAppUrl } from '../scripts/staging/preview-app-url.mjs'

const URL_ = 'https://staging.mybusinessai.site'
const e = (target: string[], value: string, extra: Record<string, unknown> = {}) => ({ id: `id-${target.join('-')}`, key: 'NEXT_PUBLIC_APP_URL', target, gitBranch: null, type: 'plain', value, ...extra })

describe('NEXT_PUBLIC_APP_URL for Preview only', () => {
  it('accepts only an https staging.* origin', () => {
    expect(checkAppUrl(URL_)).toBeNull()
    expect(checkAppUrl('http://staging.mybusinessai.site')).toMatch(/https/)
    expect(checkAppUrl('https://mybusinessai.site')).toMatch(/staging/)
    expect(checkAppUrl('https://staging.mybusinessai.site/app')).toMatch(/origin/)
  })
  it('updates the Preview-only entry and never the Production one', () => {
    const p = planAppUrl([e(['production'], 'https://prod.example'), e(['preview'], 'https://old.vercel.app')], URL_)
    expect(p).toEqual({ op: 'update', id: 'id-preview', from: 'https://old.vercel.app', value: URL_ })
  })
  it('creates a Preview-only entry when there is none, and does nothing when already set', () => {
    expect(planAppUrl([e(['production'], 'https://prod.example')], URL_)).toEqual({ op: 'create', value: URL_ })
    expect(planAppUrl([e(['preview'], URL_)], URL_).op).toBe('none')
  })
  it('stops when the only Preview value is shared with Production', () => {
    expect(planAppUrl([e(['production', 'preview'], 'https://x')], URL_).op).toBe('blocked')
  })
  it('the workflow writes only with the apply label, on the authorised branch', () => {
    const yml = readFileSync(new URL('../../.github/workflows/staging-app-url.yml', import.meta.url), 'utf8')
    expect(yml).toContain("MODE: ${{ github.event.label.name == 'staging:app-url-apply' && 'apply' || 'plan' }}")
    expect(yml).toContain('[ "$STAGING_BRANCH" = "claude/businessai-platform-audit-vjjcoc" ]')
    expect(yml).toContain('APP_URL: https://staging.mybusinessai.site')
    expect(yml).not.toMatch(/target: \[?'?production/)
  })
})
