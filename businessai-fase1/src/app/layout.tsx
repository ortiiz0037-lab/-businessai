import type { Metadata, Viewport } from 'next'
import { Manrope, Sora } from 'next/font/google'
import './globals.css'

const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' })
const sora = Sora({ subsets: ['latin'], variable: '--font-sora', weight: ['500', '600', '700'], display: 'swap' })

export const metadata: Metadata = {
  title: 'BusinessAI',
  description: 'Clientes, documentos y pagos de tu negocio con imagen profesional.',
}

export const viewport: Viewport = {
  themeColor: '#070b14',
  // Full-bleed on iPhone (notch / home indicator handled with safe-area insets).
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${manrope.variable} ${sora.variable}`}>
      <body className="bg-app font-sans text-fg antialiased">{children}</body>
    </html>
  )
}
