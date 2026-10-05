import { describe, expect, it } from 'vitest'
import { companySchema, fieldErrors, safeNext, signInSchema, signUpSchema } from '../src/lib/validators'

describe('safeNext', () => {
  it('acepta rutas internas', () => expect(safeNext('/dashboard/x')).toBe('/dashboard/x'))
  it('bloquea open redirect', () => {
    expect(safeNext('//evil.com')).toBe('/dashboard')
    expect(safeNext('https://evil.com')).toBe('/dashboard')
    expect(safeNext(null)).toBe('/dashboard')
    expect(safeNext(undefined, '/onboarding')).toBe('/onboarding')
  })
})

describe('schemas', () => {
  it('signUp normaliza el correo y valida contraseña', () => {
    const ok = signUpSchema.safeParse({ fullName: ' Ana ', email: ' ANA@Mail.COM ', password: '12345678' })
    expect(ok.success && ok.data).toMatchObject({ fullName: 'Ana', email: 'ana@mail.com' })
    const bad = signUpSchema.safeParse({ fullName: 'Ana', email: 'x', password: '123' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(Object.keys(fieldErrors(bad.error)).sort()).toEqual(['email', 'password'])
  })
  it('signIn exige contraseña', () => {
    expect(signInSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false)
  })
  it('company recorta y valida longitud', () => {
    expect(companySchema.safeParse({ name: '  Acme  ' }).data?.name).toBe('Acme')
    expect(companySchema.safeParse({ name: 'x' }).success).toBe(false)
    expect(companySchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false)
  })
})
