import { z } from 'zod'

export type FormState = { error?: string; message?: string; fieldErrors?: Record<string, string> }

const email = z.string().trim().toLowerCase().email('Correo no válido')

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80, 'Máximo 80 caracteres'),
  email,
  password: z.string().min(8, 'Mínimo 8 caracteres').max(72, 'Máximo 72 caracteres'),
})
export const signInSchema = z.object({ email, password: z.string().min(1, 'Requerida').max(72) })
export const companySchema = z.object({
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(120, 'Máximo 120 caracteres'),
})

export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '')
    if (key && !out[key]) out[key] = issue.message
  }
  return out
}

/** Solo rutas internas: evita open redirect. */
export function safeNext(value: FormDataEntryValue | string | null | undefined, fallback = '/dashboard') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback
}
