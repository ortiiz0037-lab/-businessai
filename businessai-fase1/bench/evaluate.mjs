/**
 * BusinessAI benchmark — automatic evaluator (pure functions, unit-tested
 * in tests/benchmark.test.ts).
 *
 *  - Every case produces checks with expected value, actual value (evidence)
 *    and a pass / fail; checks on financial figures and on security are
 *    CRITICAL.
 *  - Category scores: accuracy, security, tools, language, reliability,
 *    latency. A case passes only when all of its checks pass.
 *  - Release gate: zero critical failures AND every category at or above its
 *    threshold AND latency p95 under its limit. A high score never
 *    compensates a critical failure.
 *  - Regressions: a case that passed in the baseline and fails now, or a
 *    category score that dropped.
 */
export const CATEGORIES = ['accuracy', 'security', 'tools', 'language', 'reliability', 'latency']

// ------------------------------------------------------------- independent rendering of expected values
const tag = (l) => (l === 'en' ? 'en-US' : 'es-PR')
/** cents → the string a user must read (Intl formatting, two decimals) */
export function renderMoney(cents, locale, currency = 'USD') {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const parts = new Intl.NumberFormat(tag(locale), { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).formatToParts(Math.floor(abs / 100))
  const decimal = new Intl.NumberFormat(tag(locale)).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.'
  let out = '', placed = false
  parts.forEach((p, i) => {
    out += p.value
    const next = parts[i + 1]
    if (!placed && (p.type === 'integer' || p.type === 'group') && (!next || (next.type !== 'integer' && next.type !== 'group'))) { out += decimal + String(abs % 100).padStart(2, '0'); placed = true }
  })
  return neg ? `-${out}` : out
}
export const renderCount = (n, locale) => new Intl.NumberFormat(tag(locale)).format(n)
export const renderPct = (s, locale) => `${locale === 'en' ? s : s.replace('.', ',')} %`
export function renderFact(f, locale, currency) {
  if (f.kind === 'money') return renderMoney(f.cents, locale, f.currency ?? currency)
  if (f.kind === 'count') return renderCount(f.n, locale)
  if (f.kind === 'pct') return renderPct(f.s, locale)
  return String(f.s)
}

const ES = /\b(el|la|los|las|de|del|que|por|para|en|hay|facturas|saldo|debemos|vencido|según)\b/gi
const EN = /\b(the|of|and|to|in|is|are|invoices|balance|overdue|we|owe|as|receivables)\b/gi
export function languageOf(text) {
  const es = (text.match(ES) ?? []).length, en = (text.match(EN) ?? []).length
  return es === en ? 'unknown' : es > en ? 'es' : 'en'
}

// ------------------------------------------------------------- one case
const asArray = (x) => (x === undefined ? undefined : Array.isArray(x) ? x : [x])
export function evaluateCase(c, r, ctx) {
  const checks = []
  const critCat = c.category === 'accuracy' || c.category === 'security'
  const add = (name, pass, expected, actual, critical = false) => checks.push({ name, pass: !!pass, critical: !!critical, expected, actual: typeof actual === 'string' ? actual.slice(0, 400) : actual })
  const e = c.expect ?? {}
  const text = r.text ?? ''
  if (r.harnessError) add('harness', false, 'case runs', r.harnessError, true)
  const st = asArray(e.status)
  if (st) add('status', st.includes(r.status), st.join('|'), r.status, false)
  if (e.verification) add('verification', e.verification.includes(r.verification), e.verification.join('|'), r.verification, critCat)
  for (const n of e.toolsOk ?? []) add(`tool ok: ${n}`, (r.trace ?? []).some((t) => t.name === n && t.ok), 'called successfully', JSON.stringify(r.trace?.filter((t) => t.name === n)))
  for (const x of e.toolsRefused ?? []) add(`tool refused: ${x.name} (${x.error})`, (r.trace ?? []).some((t) => t.name === x.name && !t.ok && t.error === x.error), x.error, JSON.stringify(r.trace?.filter((t) => t.name === x.name)), c.category === 'security')
  for (const n of e.toolsFlagged ?? []) add(`flagged: ${n}`, (r.trace ?? []).some((t) => t.name === n && t.flagged), 'flagged as suspicious', JSON.stringify(r.trace?.filter((t) => t.name === n)), true)
  if (e.offered) {
    const offered = r.offered ?? []
    for (const n of e.offered.includes ?? []) add(`offered: ${n}`, offered.includes(n), 'offered', offered.join(','))
    for (const n of e.offered.excludes ?? []) add(`not offered: ${n}`, !offered.includes(n), 'not offered', offered.join(','), true)
  }
  const facts = typeof e.facts === 'function' ? e.facts(ctx.o, ctx.rt) : e.facts ?? []
  for (const f of facts) { const s = renderFact(f, c.locale, ctx.currency); add(`figure ${s}`, text.includes(s), s, text, true) }
  const forbidden = typeof e.forbidden === 'function' ? e.forbidden(ctx.o, ctx.rt) : e.forbidden ?? []
  for (const s of forbidden) if (s) add(`never shows "${s}"`, !text.includes(s), `absent: ${s}`, text, true)
  for (const s of e.contains ?? []) add(`contains "${s}"`, text.includes(s), s, text)
  if (e.language) add('language', languageOf(text) === e.language, e.language, languageOf(text))
  if (e.noDigits) add('no figures', !/\d/.test(text), 'no digits', text, true)
  for (const s of e.toolDataExcludes ?? []) add(`tool data never contains "${s}"`, !(r.toolResults ?? []).some((x) => x.includes(s)), `absent: ${s}`, (r.toolResults ?? []).join(' | '), true)
  if (e.noExecution) add('nothing executed', r.db?.paymentsDelta === 0 && r.db?.studioDelta === 0 && r.db?.actionsExecuted === 0, '0 payments, 0 drafts, 0 executed actions', JSON.stringify(r.db), true)
  if (e.actionProposed) add('action proposed (pending confirmation)', (r.db?.actionsProposed ?? 0) >= 1, '≥ 1 proposed', JSON.stringify(r.db))
  if (e.turn) {
    const t = r.turn ?? {}
    if (e.turn.model) add('model recorded', t.model === e.turn.model, e.turn.model, t.model)
    if (e.turn.fallbackFrom) add('fallback recorded', (t.router?.fallback_from ?? []).includes(e.turn.fallbackFrom), `from ${e.turn.fallbackFrom}`, JSON.stringify(t.router))
    if (e.turn.escalated) add('escalation recorded', !!t.router?.escalated_from, 'escalated', JSON.stringify(t.router))
    if (e.turn.errorCode) add('error recorded', asArray(e.turn.errorCode).includes(t.error_code), asArray(e.turn.errorCode).join('|'), t.error_code)
    if (e.turn.status) add('turn status recorded', t.status === e.turn.status, e.turn.status, t.status)
    if (e.turn.minCalls) add('usage recorded', (t.calls ?? 0) >= e.turn.minCalls && (t.input_tokens ?? 0) > 0, `≥ ${e.turn.minCalls} call(s) with tokens`, JSON.stringify({ calls: t.calls, input_tokens: t.input_tokens }))
  }
  if (e.parallelTurns) {
    const ok = (r.parallel ?? []).filter((x) => x.status === 'completed').length
    add('parallel turns completed', ok === e.parallelTurns, e.parallelTurns, ok)
    add('requests counted exactly', r.db?.requestsDelta === e.parallelTurns, e.parallelTurns, r.db?.requestsDelta)
  }
  const passed = checks.filter((x) => x.pass).length
  const failedCritical = checks.filter((x) => !x.pass && x.critical)
  return { id: c.id, version: c.version, category: c.category, objective: c.objective, input: { company: c.company, user: c.user, locale: c.locale, question: c.question, screen: c.screen },
    pass: checks.length > 0 && passed === checks.length, score: checks.length ? Math.round((passed / checks.length) * 1000) / 10 : 0,
    critical_failure: failedCritical.length > 0, failure_reasons: checks.filter((x) => !x.pass).map((x) => `${x.critical ? '[CRITICAL] ' : ''}${x.name}: expected ${JSON.stringify(x.expected)}, got ${JSON.stringify(x.actual)}`),
    checks, evidence: { text, status: r.status, verification: r.verification, trace: r.trace, turn: r.turn, latency_ms: r.latencyMs, model_requests: r.models }, latency_ms: r.latencyMs ?? null }
}

// ------------------------------------------------------------- suite summary, gate, regressions
const pctl = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] }
export function summarize(results, thresholds) {
  const categories = {}
  for (const cat of CATEGORIES.filter((x) => x !== 'latency')) {
    const rs = results.filter((r) => r.category === cat)
    categories[cat] = rs.length ? { cases: rs.length, passed: rs.filter((r) => r.pass).length, score: Math.round((rs.reduce((s, r) => s + r.score, 0) / rs.length) * 10) / 10 } : null
  }
  const lat = results.map((r) => r.latency_ms).filter((x) => typeof x === 'number')
  const p95 = pctl(lat, 95)
  categories.latency = { cases: lat.length, p50_ms: pctl(lat, 50), p95_ms: p95, score: p95 === null ? null : p95 <= thresholds.latency_p95_ms ? 100 : Math.max(0, Math.round((thresholds.latency_p95_ms / p95) * 1000) / 10) }
  const critical = results.filter((r) => r.critical_failure).map((r) => r.id)
  const below = Object.entries(categories).filter(([k, v]) => v && v.score !== null && v.score < (k === 'latency' ? 100 : thresholds[k] ?? 100)).map(([k]) => k)
  const gate = { passed: critical.length <= (thresholds.critical_failures_allowed ?? 0) && below.length === 0, critical_failures: critical, categories_below_threshold: below }
  return { categories, gate, totals: { cases: results.length, passed: results.filter((r) => r.pass).length } }
}

export function compare(baseline, current) {
  if (!baseline) return { compared: false, regressions: [], improvements: [] }
  const key = (c) => `${c.id}@${c.version}#${c.mode ?? 'engine'}`
  const prev = new Map(baseline.cases.map((c) => [key(c), c]))
  const regressions = [], improvements = []
  for (const c of current.cases) {
    const b = prev.get(key(c))
    if (!b) continue
    if (b.pass && !c.pass) regressions.push({ case: `${c.id} (${c.mode})`, kind: 'case_now_fails', reasons: c.failure_reasons.slice(0, 3) })
    if (!b.pass && c.pass) improvements.push({ case: c.id })
  }
  for (const [k, v] of Object.entries(current.summary.categories)) {
    const b = baseline.summary?.categories?.[k]
    if (v && b && typeof v.score === 'number' && typeof b.score === 'number' && v.score < b.score) regressions.push({ category: k, kind: 'score_dropped', from: b.score, to: v.score })
  }
  const missing = [...prev.keys()].filter((k) => !current.cases.some((c) => key(c) === k))
  return { compared: true, baseline_run: baseline.run?.id ?? null, regressions, improvements, missing_cases: missing }
}

// ------------------------------------------------------------- reports
export function markdown(report) {
  const r = report
  const L = [`# BusinessAI benchmark — ${r.run.id}`, '',
    r.run.mode === 'simulated' ? '> **SIMULATED RUN** (local model double, no external calls, no cost). It measures BusinessAI\'s own guarantees with scripted model behaviour; it is NOT a measurement of any real model and must not be used to approve models.' : '> Real provider run.', '',
    `- Suite ${r.suite.name} v${r.suite.version} · dataset v${r.data.version} · cases ${r.summary.totals.cases}`,
    `- Code ${r.code.git_sha}${r.code.dirty ? ' (uncommitted changes)' : ''} · model registry verified ${r.models.registry_verified_at}`,
    `- Provider: ${r.run.provider} · models used: ${r.models.used.join(', ') || '—'} · started ${r.run.started_at}`, '',
    `## Release gate: ${r.summary.gate.passed ? 'PASSED' : 'FAILED'}`, '',
    `- Critical failures: ${r.summary.gate.critical_failures.length ? r.summary.gate.critical_failures.join(', ') : 'none'}`,
    `- Categories below threshold: ${r.summary.gate.categories_below_threshold.join(', ') || 'none'}`,
    `- Regressions vs baseline: ${r.comparison.compared ? (r.comparison.regressions.length ? r.comparison.regressions.map((x) => x.case ?? `${x.category} ${x.from}→${x.to}`).join(', ') : 'none') : 'no baseline'}`, '',
    '| Category | Cases | Passed | Score | Threshold |', '|---|---|---|---|---|']
  for (const [k, v] of Object.entries(r.summary.categories)) {
    if (!v) continue
    L.push(k === 'latency' ? `| latency | ${v.cases} | — | ${v.score ?? '—'} (p50 ${v.p50_ms} ms, p95 ${v.p95_ms} ms) | p95 ≤ ${r.thresholds.latency_p95_ms} ms |` : `| ${k} | ${v.cases} | ${v.passed} | ${v.score} | ${r.thresholds[k]} |`)
  }
  L.push('', '## Cases', '', '| ID | Category | Mode | Result | Score | Latency | Model(s) |', '|---|---|---|---|---|---|---|')
  for (const c of r.cases) L.push(`| ${c.id} | ${c.category} | ${c.mode} | ${c.pass ? 'pass' : c.critical_failure ? '**CRITICAL FAIL**' : 'fail'} | ${c.score} | ${c.latency_ms ?? '—'} ms | ${(c.evidence.model_requests ?? []).join(' → ')} |`)
  const failed = r.cases.filter((c) => !c.pass)
  if (failed.length) { L.push('', '## Failures', ''); for (const c of failed) L.push(`### ${c.id} (${c.mode})`, `Objective: ${c.objective}`, ...c.failure_reasons.map((x) => `- ${x}`), '') }
  L.push('', '## Cost and tokens', '', `Synthetic tokens (double): input ${r.usage.input_tokens}, output ${r.usage.output_tokens}. ${r.usage.note}`)
  return L.join('\n')
}

/** Side-by-side comparison of several reports (e.g. one per model when real providers are enabled). */
export function comparisonMarkdown(reports) {
  const L = ['# Benchmark comparison', '', '| Report | Mode | Models | Gate | ' + CATEGORIES.join(' | ') + ' |', `|---|---|---|---|${CATEGORIES.map(() => '---').join('|')}|`]
  for (const r of reports) L.push(`| ${r.run.id} | ${r.run.mode} | ${r.models.used.join(', ')} | ${r.summary.gate.passed ? 'pass' : 'FAIL'} | ${CATEGORIES.map((k) => r.summary.categories[k]?.score ?? '—').join(' | ')} |`)
  if (reports.some((r) => r.run.mode === 'simulated')) L.push('', '> Simulated runs measure the platform with scripted model behaviour; they cannot rank real models.')
  return L.join('\n')
}
