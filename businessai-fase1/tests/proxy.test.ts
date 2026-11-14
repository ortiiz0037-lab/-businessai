import { describe, expect, it, beforeAll } from 'vitest'
import { NextRequest } from 'next/server'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'placeholder'
})

async function run(path: string, method = 'GET') {
  const { updateSession } = await import('@/lib/supabase/proxy')
  return updateSession(new NextRequest(`http://localhost:3000${path}`, { method }))
}

describe('proxy de sesión', () => {
  it('deja pasar el webhook de Stripe sin sesión (sin redirección a /login)', async () => {
    const res = await run('/api/stripe/webhook', 'POST')
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('no amplía la excepción a otras rutas de la API', async () => {
    const res = await run('/api/stripe/checkout', 'POST')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('no exime subrutas del webhook', async () => {
    const res = await run('/api/stripe/webhook/extra', 'POST')
    expect(res.status).toBe(307)
  })

  it('sigue protegiendo /payments sin sesión', async () => {
    const res = await run('/payments')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login?next=%2Fpayments')
  })

  it('deja ver /precios, /terminos y /privacidad sin sesión', async () => {
    for (const path of ['/precios', '/terminos', '/privacidad']) {
      const res = await run(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('location'), path).toBeNull()
    }
  })

  it('no hace públicas rutas parecidas', async () => {
    for (const path of ['/precios-admin', '/billing', '/terminosx']) {
      const res = await run(path)
      expect(res.status, path).toBe(307)
    }
  })

  it('la página principal "/" y /register son públicas; el panel sigue protegido', async () => {
    for (const path of ['/', '/register']) {
      const res = await run(path)
      expect(res.status, path).toBe(200)
    }
    for (const path of ['/dashboard', '/billing', '/clients', '/documents/new']) {
      const res = await run(path)
      expect(res.status, path).toBe(307)
      expect(res.headers.get('location'), path).toContain('/login?next=')
    }
  })
})
