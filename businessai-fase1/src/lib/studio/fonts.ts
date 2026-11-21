/**
 * Document Studio typefaces. Every family has four static TrueType files in
 * public/studio/fonts (regular, bold, italic, bold italic) under the SIL Open
 * Font License (public/studio/fonts/OFL.txt and licenses/). The same files feed
 * the layout (measurements), the preview (SVG) and the PDF (embedded subsets
 * with ToUnicode, so the text stays selectable and searchable).
 * The database accepts the same keys (studio_valid_page / studio_brand, 0041).
 */
export const FAMILIES = ['sans', 'serif', 'lato', 'montserrat', 'plex-sans', 'plex-serif', 'lora', 'playfair', 'mono'] as const
export type Family = (typeof FAMILIES)[number]
export type FontKey = Family | `${Family}-bold` | `${Family}-italic` | `${Family}-bolditalic`

export const FAMILY_INFO: Record<Family, { label: string; file: string; serif: boolean; mono?: boolean }> = {
  sans: { label: 'Liberation Sans', file: 'LiberationSans', serif: false },
  serif: { label: 'Liberation Serif', file: 'LiberationSerif', serif: true },
  lato: { label: 'Lato', file: 'Lato', serif: false },
  montserrat: { label: 'Montserrat', file: 'Montserrat', serif: false },
  'plex-sans': { label: 'IBM Plex Sans', file: 'IBMPlexSans', serif: false },
  'plex-serif': { label: 'IBM Plex Serif', file: 'IBMPlexSerif', serif: true },
  lora: { label: 'Lora', file: 'Lora', serif: true },
  playfair: { label: 'Playfair Display', file: 'PlayfairDisplay', serif: true },
  mono: { label: 'IBM Plex Mono', file: 'IBMPlexMono', serif: false, mono: true },
}
const STYLES = [['', 'Regular'], ['-bold', 'Bold'], ['-italic', 'Italic'], ['-bolditalic', 'BoldItalic']] as const

export const FONT_FILES = Object.fromEntries(FAMILIES.flatMap((f) => STYLES.map(([suffix, name]) => [`${f}${suffix}`, `${FAMILY_INFO[f].file}-${name}.ttf`]))) as Record<FontKey, string>
export const isFamily = (v: unknown): v is Family => typeof v === 'string' && (FAMILIES as readonly string[]).includes(v)
export const fontKeyOf = (fam: Family, bold: boolean, italic: boolean): FontKey => `${fam}${bold && italic ? '-bolditalic' : bold ? '-bold' : italic ? '-italic' : ''}` as FontKey
export const familyOf = (k: FontKey): Family => k.replace(/-(bold|italic|bolditalic)$/, '') as Family
export const styleOf = (k: FontKey): { weight: 400 | 700; style: 'normal' | 'italic' } => ({ weight: /-bold/.test(k) ? 700 : 400, style: /italic$/.test(k) ? 'italic' : 'normal' })
export const fontKeysOf = (fam: Family): FontKey[] => STYLES.map(([s]) => `${fam}${s}` as FontKey)

/** Families a document needs: page / brand choices plus inline {f=…|…} spans in its text. Always includes the default. */
export function familiesUsed(input: { blocks?: unknown[]; fonts?: (string | null | undefined)[] }): Family[] {
  const out = new Set<Family>(['sans'])
  for (const f of input.fonts ?? []) if (isFamily(f)) out.add(f)
  const text = JSON.stringify(input.blocks ?? [])
  for (const m of text.matchAll(/\{(?:[a-z]+(?:=[^;|}]*)?;)*f=([a-z-]+)/g)) if (isFamily(m[1])) out.add(m[1])
  return [...out]
}
