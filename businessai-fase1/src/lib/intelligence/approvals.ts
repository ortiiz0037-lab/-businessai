/**
 * Benchmark-based model approvals (Delivery 11).
 *
 * The router's production policy is the provisional, conservative one in
 * registry.ts. It changes only when a PERSON commits an approval to
 * approvals.json (code review) that cites a benchmark report with:
 *   - mode 'real' (a run against the provider, never the local double),
 *   - a passed release gate (no critical failure, every category above its threshold),
 *   - the suite version and the report's SHA-256,
 *   - who approved it and when.
 * Even then the router uses the approvals only with ASSISTANT_ROUTER_POLICY=benchmark.
 * Simulated results can never approve a model; nothing here is automatic.
 */
import raw from '@/lib/intelligence/approvals.json'
import { findModel } from '@/lib/intelligence/registry'
import type { Tier } from '@/lib/intelligence/types'

export type Approval = {
  model: string
  tiers: Tier[]
  report: { suite_version: string; mode: 'real'; run_id: string; sha256: string; gate_passed: true; date: string }
  approved_by: string
  approved_at: string
}
const TIERS: Tier[] = ['P0', 'P1', 'P2', 'P3']
const DAY = /^\d{4}-\d{2}-\d{2}/

export function validateApprovals(input: unknown): { approvals: Approval[]; rejected: { model: string; reason: string }[] } {
  const approvals: Approval[] = []
  const rejected: { model: string; reason: string }[] = []
  for (const a of Array.isArray(input) ? input : []) {
    const x = a as Partial<Approval>
    const model = String(x?.model ?? '?')
    const reason =
      !findModel(model) ? 'unregistered_model'
      : !Array.isArray(x.tiers) || !x.tiers.length || x.tiers.some((t) => !TIERS.includes(t)) ? 'invalid_tiers'
      : x.report?.mode !== 'real' ? 'not_a_real_run'
      : x.report?.gate_passed !== true ? 'gate_not_passed'
      : !/^[0-9a-f]{64}$/.test(String(x.report?.sha256 ?? '')) || !x.report?.suite_version || !x.report?.run_id || !DAY.test(String(x.report?.date ?? '')) ? 'incomplete_report_reference'
      : !x.approved_by || !DAY.test(String(x.approved_at ?? '')) ? 'missing_human_approval'
      : null
    if (reason) rejected.push({ model, reason })
    else approvals.push(x as Approval)
  }
  return { approvals, rejected }
}

export const APPROVALS = validateApprovals(raw)
