import type { MetadataRoute } from 'next'

/**
 * Web app manifest: BusinessAI can be installed on iOS / iPadOS / Android home
 * screens today, and it is the first step of the mobile plan (docs/MOBILE.md):
 * the native shells load this same app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BusinessAI',
    short_name: 'BusinessAI',
    description: 'Clientes, documentos, finanzas, personal y asistente con inteligencia artificial para tu negocio.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#070b14',
    theme_color: '#070b14',
    lang: 'es',
    categories: ['business', 'finance', 'productivity'],
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }],
  }
}
