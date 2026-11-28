import { describe, expect, it } from 'vitest'
import { companySchema, fieldErrors, newPasswordSchema, resetRequestSchema, safeNext, signInSchema, signUpSchema } from '../src/lib/validators'

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

describe('fieldErrors in the language of the request', () => {
  it('keeps Spanish by default', () => {
    const bad = signUpSchema.safeParse({ fullName: 'A', email: 'x', password: '123' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(fieldErrors(bad.error)).toEqual({ fullName: 'Mínimo 2 caracteres', email: 'Correo no válido', password: 'Mínimo 8 caracteres' })
  })
  it('answers in English for sign-up, sign-in, password recovery and the new password', () => {
    const up = signUpSchema.safeParse({ fullName: 'A', email: 'x', password: '123' })
    if (!up.success) expect(fieldErrors(up.error, 'en')).toEqual({ fullName: 'At least 2 characters', email: 'Invalid email', password: 'At least 8 characters' })
    const inn = signInSchema.safeParse({ email: 'a@b.co', password: '' })
    if (!inn.success) expect(fieldErrors(inn.error, 'en')).toEqual({ password: 'Required' })
    const reset = resetRequestSchema.safeParse({ email: 'nope' })
    if (!reset.success) expect(fieldErrors(reset.error, 'en')).toEqual({ email: 'Invalid email' })
    const pw = newPasswordSchema.safeParse({ password: '12345678', confirm: '87654321' })
    if (!pw.success) expect(fieldErrors(pw.error, 'en')).toEqual({ confirm: 'The passwords do not match' })
    expect([up.success, inn.success, reset.success, pw.success]).toEqual([false, false, false, false])
  })
  it('every Spanish message of the schemas has its English text', () => {
    expect(fieldErrors(companySchema.safeParse({ name: 'A'.repeat(200) }).error!, 'en')).toEqual({ name: 'At most 120 characters' })
    expect(fieldErrors(companySchema.safeParse({ name: 'A' }).error!, 'en')).toEqual({ name: 'At least 2 characters' })
  })
})
