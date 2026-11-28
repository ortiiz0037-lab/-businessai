'use client'
/**
 * Live preview: the same layout engine and the same font files as the PDF,
 * drawn as SVG pages, so line breaks and page breaks match the PDF exactly.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Locale } from '@/lib/i18n/app'
import { parseTtf, type TtfFont } from '@/lib/studio/ttf'
import { familiesUsed, familyOf, fontKeysOf, styleOf, type Family } from '@/lib/studio/fonts'
import { layout, FONT_FILES, type FontKey, type Fonts, type ImageMap, type LaidPage } from '@/lib/studio/layout'
import type { Brand, DocContent, Kind, PageSettings } from '@/lib/studio/model'
import type { StudioData } from '@/lib/studio/merge'

// one promise per font file: a document loads only the families it uses (S5: nine families)
const fileCache = new Map<FontKey, Promise<TtfFont | null>>()
function loadKey(k: FontKey): Promise<TtfFont | null> {
  let p = fileCache.get(k)
  if (!p) {
    p = fetch(`/studio/fonts/${FONT_FILES[k]}`).then(async (r) => (r.ok ? parseTtf(new Uint8Array(await r.arrayBuffer())) : null)).catch(() => { fileCache.delete(k); return null })
    fileCache.set(k, p)
  }
  return p
}
async function loadFonts(families: Family[]): Promise<Fonts> {
  const keys = [...new Set<Family>(['sans', ...families])].flatMap(fontKeysOf)
  const out: Fonts = {}
  await Promise.all(keys.map(async (k) => { const f = await loadKey(k); if (f) out[k] = f }))
  return out
}
export function useStudioFonts(families: Family[] = ['sans', 'serif']): Fonts | null {
  const want = [...new Set(families)].sort().join(',')
  const [state, setState] = useState<{ want: string; fonts: Fonts } | null>(null)
  useEffect(() => { let live = true; loadFonts(want.split(',') as Family[]).then((f) => { if (live) setState({ want, fonts: f }) }); return () => { live = false } }, [want])
  // keep showing the previous fonts while a newly chosen family loads (no flicker)
  return state?.fonts ?? null
}

const faceOf = (k: FontKey): [string, number, string] => { const { weight, style } = styleOf(k); return [`BAStudio-${familyOf(k)}`, weight, style] }
const FONT_CSS = (Object.keys(FONT_FILES) as FontKey[]).map((k) => { const [family, weight, style] = faceOf(k)
  return `@font-face{font-family:'${family}';src:url('/studio/fonts/${FONT_FILES[k]}') format('truetype');font-weight:${weight};font-style:${style};font-display:block}` }).join('')

export type PreviewImages = Record<string, { width: number; height: number; url: string } | undefined>

export function PageSvg({ page, images, label }: { page: LaidPage; images: PreviewImages; label: string }) {
  return (
    <svg viewBox={`0 0 ${page.width} ${page.height}`} role="img" aria-label={label} className="block h-auto w-full bg-white shadow-lg shadow-black/40" xmlns="http://www.w3.org/2000/svg">
      {page.prims.map((p, i) => {
        switch (p.t) {
          case 'rect': return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill={p.fill ?? 'none'} stroke={p.stroke} strokeWidth={p.lw} />
          case 'line': return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.color} strokeWidth={p.lw} />
          case 'image': { const img = images[p.key]; return img ? <image key={i} href={img.url} x={p.x} y={p.y} width={p.w} height={p.h} preserveAspectRatio="none" /> : null }
          case 'text': { const [family, weight, style] = faceOf(p.font); return <text key={i} x={p.x} y={p.y} fontFamily={family} fontWeight={weight} fontStyle={style} fontSize={p.size} fill={p.color} xmlSpace="preserve">{p.text}</text> }
          case 'watermark': { const [family, weight] = faceOf(p.font); return <text key={i} x={p.cx} y={p.cy + p.size * 0.35} textAnchor="middle" fontFamily={family} fontWeight={weight} fontSize={p.size} fill={p.color} opacity={p.opacity} transform={`rotate(-45 ${p.cx} ${p.cy})`}>{p.text}</text> }
        }
      })}
    </svg>
  )
}

export function StudioPreview({ content, page, brand, accentFallback, data, locale, currency, images, kind, title, onLayout }: {
  content: DocContent; page: PageSettings; brand: Brand; accentFallback: string | null; data: StudioData; locale: Locale; currency: string
  images: PreviewImages; kind?: Kind; title?: string; onLayout?: (r: { pages: number; missing: string[] }) => void
}) {
  const fonts = useStudioFonts(familiesUsed({ blocks: content.blocks, fonts: [page.font, brand.body_font, brand.heading_font, brand.page?.font] }))
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
