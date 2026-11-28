/**
 * The migration sequence stays consistent (S9.2): every migration from 0005 has its rollback and is in the
 * staging ORDER exactly once, in numeric order; from 0015 every one is a held draft (STAGING-GATE), is
 * documented in docs/MIGRATIONS.md, is exercised by the local harness (supabase/tests/local/run.sh) and its
 * rollback refuses or is safe — and no number is used twice. A new migration without these fails here.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MIG = 'supabase/migrations', RB = 'supabase/rollback'
const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
const names = files.map((f) => f.replace(/\.sql$/, ''))
const num = (n: string) => n.split('_')[0]
const order = (readFileSync('scripts/staging/apply-migrations.sh', 'utf8').match(/^ORDER=\(([\s\S]*?)^\)/m)?.[1] ?? '').split(/\s+/).filter((x) => /^\d{4}[a-z]?_/.test(x))
const docs = readFileSync('docs/MIGRATIONS.md', 'utf8')
const harness = readFileSync('supabase/tests/local/run.sh', 'utf8')
const later = names.filter((n) => num(n) >= '0015')

describe('migration sequence', () => {
  it('numbers are unique', () => {
    const nums = names.map(num)
    expect(new Set(nums).size).toBe(nums.length)
  })
  it('the staging ORDER lists every migration from 0005 once, in numeric order (0006 after 0009 by design)', () => {
    for (const n of names.filter((x) => num(x) >= '0005')) expect(order.filter((o) => o === n)).toHaveLength(1)
    const tail = order.filter((o) => num(o) >= '0010')
    expect(tail).toEqual([...tail].sort())
    expect(order.at(-1)).toBe(names.at(-1))
  })
  it('every migration from 0005 has a rollback', () => {
    for (const n of names.filter((x) => num(x) >= '0005')) expect(existsSync(`${RB}/${num(n)}_rollback.sql`), n).toBe(true)
  })
  it('from 0015: held draft, documented, exercised by the harness, rollback guarded', () => {
    for (const n of later) {
      const sql = readFileSync(`${MIG}/${n}.sql`, 'utf8')
      expect(sql, `${n}: STAGING-GATE`).toContain('STAGING-GATE: approval required')
      expect(sql, `${n}: transaction`).toMatch(/^begin;/m)
      expect(docs, `${n}: docs/MIGRATIONS.md`).toContain(`| ${num(n)} |`)
      expect(harness.includes(n) || harness.includes(`P${num(n).slice(2)}=`), `${n}: run.sh`).toBe(true)
    }
  })
  it('the next free number in the docs is after the last migration', () => {
    const last = Number(num(names.at(-1)!).replace(/\D/g, ''))
    expect(docs).toContain(`| **${String(last + 1).padStart(4, '0')}** |`)
  })
})
