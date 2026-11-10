import type { Metadata, Viewport } from 'next'
import { Manrope, Playfair_Display } from 'next/font/google'
import './globals.css'

const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' })
const playfair = Playfair_Display({ subsets: ['latin'], variable: '--font-playfair', weight: ['500', '600', '700'], display: 'swap' })

export const metadata: Metadata = {
  title: 'BusinessAI',
  description: 'Clientes, documentos y pagos de tu negocio con imagen profesional.',
}

export const viewport: Viewport = {
  themeColor: '#0a0a0c',
  // Full-bleed on iPhone (notch / home indicator handled with safe-area insets).
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${manrope.variable} ${playfair.variable}`}>
      <body className="bg-canvas font-sans text-ink-900 antialiased">{children}</body>
    </html>
  )
}
