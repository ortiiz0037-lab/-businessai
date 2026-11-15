/**
 * Mobile preparation (S4): the installable web app manifest the native shells
 * load (docs/MOBILE.md) and its public route.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import manifest from '@/app/manifest'

describe('web app manifest', () => {
  it('installable: name, standalone, start in the app, theme and an icon', () => {
    const m = manifest()
    expect(m).toMatchObject({ name: 'BusinessAI', display: 'standalone', start_url: '/dashboard', scope: '/', theme_color: '#070b14', background_color: '#070b14' })
    expect(m.icons?.some((i) => i.src === '/icon.svg' && i.purpose === 'maskable')).toBe(true)
    expect(readFileSync('public/icon.svg', 'utf8')).toMatch(/^<svg[^>]+viewBox="0 0 512 512"/)
  })
  it('the manifest is public (no login redirect); nothing else was opened', () => {
    const proxy = readFileSync('src/lib/supabase/proxy.ts', 'utf8')
    expect(proxy).toMatch(/const PUBLIC_EXACT = \['\/', '\/manifest\.webmanifest'\]/)
  })
})
