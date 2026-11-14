import { describe, expect, it, vi } from 'vitest'
import { fetchUsage, isBlocked, strongestNotice, usageNotice, type UsageRow } from '@/lib/billing/usage'
import { billingErrorCode } from '@/lib/billing/state'

const row = (over: Partial<UsageRow>): UsageRow =>
  ({ metric: 'clients', used: 0, max_allowed: 10, percent: 0, level: 'ok', resets_at: null, ...over })

describe('usage notices (levels decided by the database)', () => {
  it('no message below 80 % or when unlimited', () => {
    expect(usageNotice(row({ used: 7, percent: 70, level: 'ok' }))).toBeNull()
    expect(usageNotice(row({ max_allowed: null, percent: null, level: 'unlimited' }))).toBeNull()
    expect(usageNotice(undefined)).toBeNull()
  })

  it('80 %: first warning, no upgrade push', () => {
    const n = usageNotice(row({ used: 8, percent: 80, level: 'warning' }))!
    expect(n).toMatchObject({ level: 'warning', offerUpgrade: false })
    expect(n.text).toBe('Has usado el 80 % de tu plan: 8 de 10 clientes.')
  })

  it('90 %: second warning offering the upgrade', () => {
    const n = usageNotice(row({ used: 9, percent: 90, level: 'upgrade' }))!
    expect(n).toMatchObject({ level: 'upgrade', offerUpgrade: true })
    expect(n.text).toMatch(/cerca del límite \(90 %\).*Mejora tu plan/)
  })

  it('100 %: blocked, says data is not modified, shows when documents reset', () => {
    const n = usageNotice(row({ metric: 'documents', used: 10, percent: 100, level: 'blocked', resets_at: '2026-12-01T04:00:00Z' }))!
    expect(n).toMatchObject({ level: 'blocked', offerUpgrade: true })
    expect(n.text).toContain('Alcanzaste el límite de tu plan: 10 de 10 documentos de este periodo')
    expect(n.text).toContain('Tus datos no se modifican')
    expect(n.text).toContain('se reinicia el 1 de diciembre')
  })

  it('picks the most severe notice and detects blocking per metric', () => {
    const rows = [
      row({ metric: 'clients', used: 8, percent: 80, level: 'warning' }),
      row({ metric: 'documents', used: 10, percent: 100, level: 'blocked' }),
      row({ metric: 'members', used: 1, max_allowed: 3, percent: 33, level: 'ok' }),
    ]
    expect(strongestNotice(rows)?.metric).toBe('documents')
    expect(isBlocked(rows, 'documents')).toBe(true)
    expect(isBlocked(rows, 'clients')).toBe(false)
    expect(strongestNotice([row({ level: 'ok' })])).toBeNull()
  })
})

describe('fetchUsage', () => {
  it('normalises numbers from the RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ metric: 'clients', used: '9', max_allowed: '10', percent: '90', level: 'upgrade', resets_at: null }], error: null })
    expect(await fetchUsage({ rpc }, 'co')).toEqual([row({ used: 9, percent: 90, level: 'upgrade' })])
    expect(rpc).toHaveBeenCalledWith('company_usage', { target: 'co' })
  })
  it('returns [] when 0011 is not installed (the UI then shows nothing)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await fetchUsage({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } }) }, 'co')).toEqual([])
    expect(await fetchUsage({ rpc: vi.fn().mockRejectedValue(new Error('network')) }, 'co')).toEqual([])
    expect(err).toHaveBeenCalledTimes(1) // only the network error is logged
    err.mockRestore()
  })
})

describe('database limit errors', () => {
  it('maps the member limit error too', () => {
    expect(billingErrorCode({ message: 'PLAN_LIMIT_MEMBERS' })).toBe('limit_members')
  })
})
