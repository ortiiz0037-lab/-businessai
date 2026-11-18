import { z } from 'zod'

export type FormState = { error?: string; message?: string; fieldErrors?: Record<string, string> }

const email = z.string().trim().toLowerCase().email('Correo no válido')

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80, 'Máximo 80 caracteres'),
  email,
  password: z.string().min(8, 'Mínimo 8 caracteres').max(72, 'Máximo 72 caracteres'),
})
export const signInSchema = z.object({ email, password: z.string().min(1, 'Requerida').max(72) })
export const resetRequestSchema = z.object({ email })
export const newPasswordSchema = z
  .object({
    password: z.string().min(8, 'Mínimo 8 caracteres').max(72, 'Máximo 72 caracteres'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: 'Las contraseñas no coinciden', path: ['confirm'] })
export const companySchema = z.object({
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(120, 'Máximo 120 caracteres'),
})

/** English for the messages of the schemas above (the schemas keep Spanish, the default language). */
const FIELD_ERRORS_EN: Record<string, string> = {
  'Correo no válido': 'Invalid email',
  'Mínimo 2 caracteres': 'At least 2 characters',
  'Mínimo 8 caracteres': 'At least 8 characters',
  'Máximo 72 caracteres': 'At most 72 characters',
  'Máximo 80 caracteres': 'At most 80 characters',
  'Máximo 120 caracteres': 'At most 120 characters',
  'Requerida': 'Required',
  'Las contraseñas no coinciden': 'The passwords do not match',
}

/** First message per field, in the language of the request (`en` translates the schema messages). */
export function fieldErrors(err: z.ZodError, locale: 'es' | 'en' = 'es'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '')
    if (key && !out[key]) out[key] = locale === 'en' ? (FIELD_ERRORS_EN[issue.message] ?? issue.message) : issue.message
  }
  return out
}

/** Solo rutas internas: evita open redirect. */
export function safeNext(value: FormDataEntryValue | string | null | undefined, fallback = '/dashboard') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback
}
