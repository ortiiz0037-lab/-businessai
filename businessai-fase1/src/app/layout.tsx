import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'BusinessAI',
  description: 'Documentos profesionales con IA para tu negocio',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  )
}
