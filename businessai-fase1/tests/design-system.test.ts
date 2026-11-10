import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH } from '@/lib/i18n/auth'
import { documentIcon, documentStatus } from '@/components/ui/status'
import { planHrefs } from '@/components/marketing/plan-cards'

const ROOT = new URL('..', import.meta.url).pathname
const css = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf8')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx$/.test(name) && !/backup|before-|pre-audit/.test(name) ? [p] : []
  })
}

describe('design system', () => {
  it('every design-system class used in the app is defined in globals.css', () => {
    const used = new Set<string>()
    for (const file of sources(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/(?<![\w-])((?:btn|badge|alert|card|field|table)(?:-[a-z]+)*|eyebrow|page-title|section-title|divider-glow)(?![\w-])/g)) {
        used.add(m[1])
      }
    }
    // Words that only appear in code (identifiers / props), not CSS classes.
    for (const notCss of ['field', 'card', 'btn', 'badge', 'alert', 'table', 'table-cell']) used.delete(notCss)
    const missing = [...used].filter((c) => !new RegExp(`@utility ${c} \\{`).test(css))
    expect(missing).toEqual([])
    for (const base of ['btn', 'card', 'card-hero', 'field', 'badge', 'alert', 'table-premium']) {
      expect(css).toMatch(new RegExp(`@utility ${base} \\{`))
    }
  })

  it('brand tokens: Black & Electric Blue palette and the two typefaces', () => {
    const palette: Record<string, string> = {
      app: '#070b14', 'app-2': '#0b1220', card: '#111827', elevated: '#172235', brand: '#2563eb', electric: '#3b82f6',
      accent: '#22d3ee', line: '#263449', fg: '#f8fafc', muted: '#94a3b8', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
    }
    for (const [name, hex] of Object.entries(palette)) expect(css, name).toMatch(new RegExp(`--color-${name}: ${hex};`))
    expect(css).toMatch(/--font-display: var\(--font-sora\)/)
    expect(css).toMatch(/--font-sans: var\(--font-manrope\)/)
    // The print rules for documents are preserved.
    expect(css).toMatch(/@media print[\s\S]*article/)
  })
})

describe('no gold, yellow-gold, cream or warm tones left (Black & Electric Blue)', () => {
  const files = [...sources(join(ROOT, 'src')), join(ROOT, 'src/app/globals.css')]
  // Old identity: gold / stone / ink / canvas scales, cream & warm hexes, warm rgb shadows, Playfair.
  const banned = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|divide|decoration|shadow|fill|stroke)-(?:gold|stone|ink|canvas)\b|--color-(?:gold|ink|canvas)|#(?:f6f4ef|fbf8ef|c39a3c|d4ad55|a67e2f|e0c47a|0a0a0c|f5f5f4|e7e5e4|78716c)\b|rgb\(\s*(?:195|212)[ _]+(?:154|173)|rgb\(\s*20[ _]+16[ _]+8|Playfair|btn-gold|badge-gold|divider-gold|card-dark/i
  it('no source file uses the previous palette', () => {
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => (banned.test(line) ? `${f.replace(ROOT, '')}:${i + 1}: ${line.trim().slice(0, 90)}` : null))
      .filter((x): x is string => x !== null))
    expect(hits).toEqual([])
  })
  it('no light surfaces or dark-on-dark text outside the printable document sheet', () => {
    // The document detail page renders a white paper sheet on purpose (print/PDF): excluded.
    const screens = files.filter((f) => !f.includes('documents/[id]'))
    const light = /(?<![\w-])(?:bg-white(?:\/(?:[2-9]\d|100))?(?![\w/-])|text-slate-(?:600|700|800|900)\b)/
    const hits = screens.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => (light.test(line) ? `${f.replace(ROOT, '')}:${i + 1}: ${line.trim().slice(0, 90)}` : null))
      .filter((x): x is string => x !== null))
    expect(hits).toEqual([])
  })
  it('the app shell is dark (no light page background)', () => {
    expect(css).toMatch(/body \{[\s\S]*?background-color: var\(--color-app\)/)
    expect(css).toMatch(/color-scheme: dark/)
  })
})

describe('sign-in / sign-up copy (es / en)', () => {
  const keys = (o: unknown, p = ''): string[] =>
    typeof o === 'object' && o !== null
      ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k))
      : [p]
  it('both languages have the same texts', () => {
    expect(keys(AUTH.en).sort()).toEqual(keys(AUTH.es).sort())
    expect(AUTH.en.signup.chosen('Pro', 7)).toMatch(/7-day/)
    expect(AUTH.es.signup.chosen('Pro', 7)).toMatch(/7 días/)
  })
  it('makes no claims about taxes or AI features', () => {
    const text = JSON.stringify(AUTH)
    expect(text).not.toMatch(/IVU|impuesto|\bIA\b|inteligencia artificial|AI-powered/i)
  })
})

describe('shared document status', () => {
  it('labels and styles every status in Spanish', () => {
    expect(documentStatus('paid')).toEqual({ label: 'Pagado', className: 'badge-success' })
    expect(documentStatus('sent').label).toBe('Enviado')
    expect(documentStatus('overdue').className).toBe('badge-danger')
    expect(documentStatus(null)).toEqual({ label: 'Pendiente', className: 'badge-warning' })
    expect(documentStatus('custom').label).toBe('custom')
  })
  it('has an icon per document type', () => {
    expect(documentIcon('invoice')).toBe('receipt')
    expect(documentIcon('quote')).toBe('clipboard')
    expect(documentIcon('unknown')).toBe('file')
  })
})

describe('English plan links keep the language', () => {
  it('signup and login carry lang=en', () => {
    expect(planHrefs('pro', false, 'en')).toEqual({
      start: '/signup?plan=pro&lang=en',
      login: '/login?next=%2Fbilling%3Fplan%3Dpro%23plan-pro&lang=en',
    })
  })
})

describe('language switch links', () => {
  // Next prefetches visible links and the proxy remembers ?lang= — a prefetched switch link
  // would silently change the saved language. Only a real click may switch it.
  it('ES/EN switch links are not prefetched', () => {
    for (const f of ['src/components/auth-card.tsx', 'src/app/page.tsx']) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => /<Link[^>]*switchLabel/.test(l))
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) expect(l).toContain('prefetch={false}')
    }
  })
  it('the switch link always names the target language', () => {
    for (const f of ['src/app/(auth)/login/page.tsx', 'src/app/(auth)/signup/page.tsx']) {
      expect(readFileSync(join(ROOT, f), 'utf8')).toContain("params.set('lang', locale === 'es' ? 'en' : 'es')")
    }
    expect(readFileSync(join(ROOT, 'src/app/page.tsx'), 'utf8')).toContain("other: locale === 'es' ? '/?lang=en' : '/?lang=es'")
  })
})
