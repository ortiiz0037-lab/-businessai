/**
 * Security headers on every response:
 * - the app is never shown inside another site's frame (clickjacking): CSP frame-ancestors + X-Frame-Options;
 * - no MIME sniffing; the full URL (tokens in query strings) never leaves as a referrer to other sites;
 * - camera (barcode / receipt capture) and microphone (assistant dictation) only for the app itself;
 *   location and payment APIs are off.
 * HTTPS / HSTS is applied by the hosting platform (Vercel) on its domains.
 */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), payment=()' },
]

const nextConfig = {
  // Document Studio reads its font files on the server to embed them in PDFs.
  outputFileTracingIncludes: {
    '/studio/[id]/pdf': ['./public/studio/fonts/*.ttf'],
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
  experimental: {
    serverActions: {
      // Bank statement CSV import (Finance 0026): files up to 2 MB.
      bodySizeLimit: '3mb',
      // Same-origin is always allowed. Development hosts (Codespaces port forwarding) only outside
      // production builds: in production they would accept server actions posted from any Codespace.
      // A production build served elsewhere (e.g. `next start` in a Codespace) can list its host in
      // SERVER_ACTIONS_ALLOWED_ORIGINS (comma-separated) at build time.
      allowedOrigins: process.env.NODE_ENV === 'production'
        ? (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        : ['localhost:3000', '*.github.dev', '*.app.github.dev'],
    },
  },
}

export default nextConfig
