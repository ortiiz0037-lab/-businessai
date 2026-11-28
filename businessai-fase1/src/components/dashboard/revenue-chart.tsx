'use client'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

/**
 * Invoiced vs collected, last 12 months (grouped bars, one y-axis).
 * Palette validated with the dataviz validator (dark mode):
 * blue #2563eb (invoiced) + cyan #0ea5c9 (collected), validated on the dark
 * card surface #111827 — all checks pass,
 * contrast ≥ 3:1. Identity is never color-alone: legend + tooltip + table.
 * Hover (desktop) or tap (iPhone/iPad) a month to see its values.
 */
export const SERIES = { invoiced: '#2563eb', collected: '#0ea5c9' } as const

export type ChartPoint = { key: string; label: string; longLabel: string; invoiced: number; collected: number }

type Labels = { invoiced: string; collected: string; month: string; showTable: string; showChart: string; title: string; summary: string }

const PAD = { top: 16, right: 8, bottom: 28, left: 52 }
const subscribeNever = () => () => {}

/** Rounded-top bar anchored to the baseline (4px data-end radius). */
function barPath(x: number, y: number, w: number, h: number) {
  if (h <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/** 0 → max rounded up to a "nice" value, 4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0]
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  return [0, 1, 2, 3, 4].map((i) => i * step)
}

export function RevenueChart({ points, labels, tag, currency }: {
  points: ChartPoint[]
  labels: Labels
  /** BCP 47 tag for number formatting ('es-PR' / 'en-US'). */
  tag: string
  currency: string
}) {
  const nf = useMemo(() => ({
    money: new Intl.NumberFormat(tag, { style: 'currency', currency }),
    compact: new Intl.NumberFormat(tag, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }),
  }), [tag, currency])
  // Compact currency ("$1 K") is formatted differently by the server's and the browser's ICU data:
  // the axis labels are drawn after hydration only, so the server HTML and the first client render match.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false)
  const [active, setActive] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  // Drawn at the container's real width so text stays 11px on iPhone too.
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(720)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [table])
  const H = W < 480 ? 220 : 260
  const narrow = W < 480
  const ticks = useMemo(() => niceTicks(Math.max(...points.map((p) => Math.max(p.invoiced, p.collected)), 0)), [points])
  const top = ticks[ticks.length - 1] || 1
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const slot = innerW / points.length
  const barW = Math.max(3, Math.min(18, (slot - (narrow ? 4 : 10)) / 2))
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH
  const fmt = (n: number) => nf.money.format(n)
  const shown = active ?? points.length - 1
  const current = points[shown]

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-4 text-xs font-semibold text-slate-400" aria-label={labels.title}>
          <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES.invoiced }} />{labels.invoiced}</li>
          <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES.collected }} />{labels.collected}</li>
        </ul>
        <button type="button" onClick={() => setTable((v) => !v)} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-blue-400 underline underline-offset-4">
          {table ? labels.showChart : labels.showTable}
        </button>
      </div>

      {table ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <caption className="sr-only">{labels.title}</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">{labels.month}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{labels.invoiced}</th>
                <th scope="col" className="py-2 text-right font-semibold">{labels.collected}</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.key} className="border-b border-line">
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">{p.longLabel}</th>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(p.invoiced)}</td>
                  <td className="py-2 text-right tabular-nums text-fg">{fmt(p.collected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {/* Tooltip / readout: the hovered or tapped month (defaults to this month). */}
          <div className="mt-4 flex min-h-11 flex-wrap items-baseline gap-x-5 gap-y-1 rounded-xl bg-white/[0.03] px-3 py-2 text-sm" aria-live="polite">
            <span className="font-semibold text-fg">{current?.longLabel}</span>
            <span className="text-slate-400">{labels.invoiced}: <b className="tabular-nums text-fg">{fmt(current?.invoiced ?? 0)}</b></span>
            <span className="text-slate-400">{labels.collected}: <b className="tabular-nums text-fg">{fmt(current?.collected ?? 0)}</b></span>
          </div>
          <div ref={box} className="mt-2 w-full">
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block h-auto max-w-full touch-manipulation" role="img" aria-label={labels.summary}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null) }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#263449" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="#94a3b8">{hydrated ? nf.compact.format(t) : ''}</text>
              </g>
            ))}
            {points.map((p, i) => {
              const x0 = PAD.left + i * slot + (slot - (barW * 2 + 2)) / 2
              const hi = i === active
              return (
                <g key={p.key}>
                  {hi && <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="#172235" rx={6} />}
                  <path d={barPath(x0, y(p.invoiced), barW, PAD.top + innerH - y(p.invoiced))} fill={SERIES.invoiced} opacity={active === null || hi ? 1 : 0.45} />
                  <path d={barPath(x0 + barW + 2, y(p.collected), barW, PAD.top + innerH - y(p.collected))} fill={SERIES.collected} opacity={active === null || hi ? 1 : 0.45} />
                  {(!narrow || i % 2 === points.length % 2 || hi) && (
                    <text x={PAD.left + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={11} fill={hi ? '#f8fafc' : '#94a3b8'} fontWeight={hi ? 700 : 500}>{p.label}</text>
                  )}
                  {/* Hit target larger than the marks: the whole month column. */}
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH + PAD.bottom} fill="transparent"
                    onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActive(i) }} onPointerDown={() => setActive(i)}>
                    <title>{`${p.longLabel} — ${labels.invoiced}: ${fmt(p.invoiced)} · ${labels.collected}: ${fmt(p.collected)}`}</title>
                  </rect>
                </g>
              )
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="#334155" strokeWidth={1} />
          </svg>
          </div>
        </>
      )}
    </div>
  )
}
