/**
 * Origin used in links sent by email (password reset, invitations).
 * Review finding I10: never trust the request's Host header in production —
 * a forged Host would put an attacker's domain in a reset link.
 *   1. NEXT_PUBLIC_APP_URL when set (required in Production);
 *   2. Vercel Preview: the deployment URL Vercel itself provides (VERCEL_URL);
 *   3. local development only: the request host.
 * Returns null when no trustworthy origin exists (the caller refuses to send).
 */
export function resolveAppOrigin(
  env: { NEXT_PUBLIC_APP_URL?: string; VERCEL_ENV?: string; VERCEL_URL?: string; NODE_ENV?: string },
  host: string | null,
): string | null {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  if (configured && /^https?:\/\/[^/\s]+$/i.test(configured)) return configured
  if (env.VERCEL_ENV === 'production') return null
  if (env.VERCEL_URL && /^[a-z0-9.-]+$/i.test(env.VERCEL_URL)) return `https://${env.VERCEL_URL}`
  if (env.NODE_ENV !== 'production' && host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`
  return null
}
