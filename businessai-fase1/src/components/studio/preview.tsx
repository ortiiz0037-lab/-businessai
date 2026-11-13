'use client'
/**
 * Live preview: the same layout engine and the same font files as the PDF,
 * drawn as SVG pages, so line breaks and page breaks match the PDF exactly.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Locale } from '@/lib/i18n/app'
import { parseTtf } from '@/lib/studio/ttf'
import { layout, FONT_FILES, type FontKey, type Fonts, type ImageMap, type LaidPage } from '@/lib/studio/layout'
import type { Brand, DocContent, Kind, PageSettings } from '@/lib/studio/model'
import type { StudioData } from '@/lib/studio/merge'

let fontPromise: Promise<Fonts> | null = null
function loadFonts(): Promise<Fonts> {
  fontPromise ??= (async () => {
    const out: Fonts = {}
    await Promise.all(Object.entries(FONT_FILES).map(async ([k, f]) => {
      const r = await fetch(`/studio/fonts/${f}`)
      if (r.ok) out[k as FontKey] = parseTtf(new Uint8Array(await r.arrayBuffer()))
    }))
    return out
  })()
  return fontPromise
}
export function useStudioFonts(): Fonts | null {
  const [fonts, setFonts] = useState<Fonts | null>(null)
  useEffect(() => { let live = true; loadFonts().then((f) => { if (live) setFonts(f) }).catch(() => { fontPromise = null }); return () => { live = false } }, [])
  return fonts
}

const FACE: Record<FontKey, [string, number, string]> = {
  sans: ['BAStudioSans', 400, 'normal'], 'sans-bold': ['BAStudioSans', 700, 'normal'], 'sans-italic': ['BAStudioSans', 400, 'italic'], 'sans-bolditalic': ['BAStudioSans', 700, 'italic'],
  serif: ['BAStudioSerif', 400, 'normal'], 'serif-bold': ['BAStudioSerif', 700, 'normal'], 'serif-italic': ['BAStudioSerif', 400, 'italic'], 'serif-bolditalic': ['BAStudioSerif', 700, 'italic'],
}
const FONT_CSS = Object.entries(FACE).map(([k, [family, weight, style]]) =>
  `@font-face{font-family:'${family}';src:url('/studio/fonts/${FONT_FILES[k as FontKey]}') format('truetype');font-weight:${weight};font-style:${style};font-display:block}`).join('')

export type PreviewImages = Record<string, { width: number; height: number; url: string } | undefined>

export function PageSvg({ page, images, label }: { page: LaidPage; images: PreviewImages; label: string }) {
  return (
    <svg viewBox={`0 0 ${page.width} ${page.height}`} role="img" aria-label={label} className="block h-auto w-full bg-white shadow-lg shadow-black/40" xmlns="http://www.w3.org/2000/svg">
      {page.prims.map((p, i) => {
        switch (p.t) {
          case 'rect': return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill={p.fill ?? 'none'} stroke={p.stroke} strokeWidth={p.lw} />
          case 'line': return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.color} strokeWidth={p.lw} />
          case 'image': { const img = images[p.key]; return img ? <image key={i} href={img.url} x={p.x} y={p.y} width={p.w} height={p.h} preserveAspectRatio="none" /> : null }
          case 'text': { const [family, weight, style] = FACE[p.font]; return <text key={i} x={p.x} y={p.y} fontFamily={family} fontWeight={weight} fontStyle={style} fontSize={p.size} fill={p.color} xmlSpace="preserve">{p.text}</text> }
          case 'watermark': { const [family, weight] = FACE[p.font]; return <text key={i} x={p.cx} y={p.cy + p.size * 0.35} textAnchor="middle" fontFamily={family} fontWeight={weight} fontSize={p.size} fill={p.color} opacity={p.opacity} transform={`rotate(-45 ${p.cx} ${p.cy})`}>{p.text}</text> }
        }
      })}
    </svg>
  )
}

export function StudioPreview({ content, page, brand, accentFallback, data, locale, currency, images, kind, title, onLayout }: {
  content: DocContent; page: PageSettings; brand: Brand; accentFallback: string | null; data: StudioData; locale: Locale; currency: string
  images: PreviewImages; kind?: Kind; title?: string; onLayout?: (r: { pages: number; missing: string[] }) => void
}) {
  const fonts = useStudioFonts()
  const dims: ImageMap = useMemo(() => Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v ? { width: v.width, height: v.height } : undefined])), [images])
  const result = useMemo(() => (fonts ? layout({ content, page, brand, accentFallback, data, locale, currency, images: dims, fonts, kind, title }) : null),
    [fonts, content, page, brand, accentFallback, data, locale, currency, dims, kind, title])
  useEffect(() => { if (result && onLayout) onLayout({ pages: result.pages.length, missing: result.missing }) }, [result, onLayout])
  const es = locale !== 'en'
  return (
    <div className="space-y-4">
      <style>{FONT_CSS}</style>
      {!result ? <p className="text-sm text-muted" role="status">{es ? 'Cargando tipografías…' : 'Loading fonts…'}</p>
        : result.pages.map((p, i) => (
          <figure key={i} className="space-y-1">
            <PageSvg page={p} images={images} label={es ? `Página ${i + 1} de ${result.pages.length}` : `Page ${i + 1} of ${result.pages.length}`} />
            <figcaption className="text-center text-[11px] text-muted">{i + 1} / {result.pages.length}</figcaption>
          </figure>
        ))}
    </div>
  )
}
