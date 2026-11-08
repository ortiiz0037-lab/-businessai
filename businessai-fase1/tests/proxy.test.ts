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
})
