/**
 * Architecture boundaries of the assistant / Intelligence Engine (Delivery 10):
 * least privilege is enforced by the code layout, not only by convention.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../src/', import.meta.url).pathname
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = (...dirs: string[]) => dirs.flatMap((d) => walk(join(root, d))).filter((f) => /\.(ts|tsx)$/.test(f))
const assistantCode = [...files('lib/assistant', 'lib/intelligence', 'components/assistant'), join(root, 'app/actions/assistant.ts'), join(root, 'app/api/assistant/stream/route.ts')]

describe('assistant boundaries', () => {
  it('never uses the service role (no admin client, no service-role key)', () => {
    for (const f of assistantCode) {
      const s = readFileSync(f, 'utf8')
      expect(s, f).not.toMatch(/supabase\/admin|createAdminClient|SUPABASE_SERVICE_ROLE_KEY|getServiceRoleConfig/)
    }
  })
  it('secrets are read only on the server, never through NEXT_PUBLIC_ variables', () => {
    for (const f of assistantCode) {
      const s = readFileSync(f, 'utf8')
      expect(s, f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(KEY|SECRET)/)
      if (/^'use client'/.test(s)) expect(s, f).not.toMatch(/process\.env|ANTHROPIC_API_KEY|ASSISTANT_SERVER_KEYS|node:crypto|@anthropic-ai\/sdk/)
    }
  })
  it('client components import server modules for types only', () => {
    for (const f of files('components/assistant')) {
      const s = readFileSync(f, 'utf8')
      for (const m of s.matchAll(/^import (type )?[^\n]*from '(@\/lib\/(assistant\/(service|tools|engine|config)|intelligence\/[a-z-/]+))'/gm)) {
        expect(m[1], `${f}: ${m[2]}`).toBe('type ')
      }
    }
  })
  it('the database company and user are never parameters chosen by the model', () => {
    const tools = readFileSync(join(root, 'lib/assistant/tools.ts'), 'utf8')
    expect(tools).not.toMatch(/(company_id|user_id|companyId|userId)\s*:\s*(z\.|uuid)/)
  })
  it('the stream endpoint checks the origin and bounds the body', () => {
    const r = readFileSync(join(root, 'app/api/assistant/stream/route.ts'), 'utf8')
    expect(r).toMatch(/sameOrigin\(req\)/)
    expect(r).toMatch(/16_384/)
    expect(r).toMatch(/maxDuration = 60/)
  })
})
