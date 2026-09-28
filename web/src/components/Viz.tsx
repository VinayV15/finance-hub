import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { money, motionOK, pct } from '../format'

/** Counts from the previous value to the new one (from 0 on first show). Instant when reduced motion is on. */
export function useCountUp(target: number, ms = 750) {
  const [v, setV] = useState(motionOK ? 0 : target)
  const from = useRef(motionOK ? 0 : target)
  useEffect(() => {
    if (!motionOK) { setV(target); return }
    const start = performance.now(), a = from.current
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const e = 1 - Math.pow(1 - t, 3) // ease-out
      setV(a + (target - a) * e)
      if (t < 1) raf = requestAnimationFrame(step)
      else from.current = target
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); from.current = target }
  }, [target, ms])
  return v
}

/** A money amount that counts up. Renders "—" while there's no value yet. */
export function Num({ v, sign = false, cents = false }: { v: number | null | undefined; sign?: boolean; cents?: boolean }) {
  const n = useCountUp(v ?? 0)
  if (v == null) return <>—</>
  return <>{money(cents ? n : Math.round(n), { cents, sign })}</>
}

/** Small trend line with a soft fill. Hover shows the value at that point. */
export function Sparkline({ values, labels, color = 'var(--accent)', height = 36, format = (n: number) => money(n, { cents: false }) }: {
  values: number[]; labels?: string[]; color?: string; height?: number; format?: (n: number) => string
}) {
  const id = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  if (values.length < 2) return null
  const W = 120, H = height, pad = 3
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number) => (i / (values.length - 1)) * W
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - pad * 2)
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)))))
  }
  const hi = hover ?? values.length - 1
  return (
    <div className="spark" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} onMouseMove={onMove} aria-hidden>
        <defs>
          <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.35 }} />
            <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#sp${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && <line x1={x(hi)} x2={x(hi)} y1={0} y2={H} stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="spark-dot" style={{ left: `${(x(hi) / W) * 100}%`, top: y(values[hi]), background: color }} />
      {hover != null && <span className="spark-tip">{labels?.[hi] ? `${labels[hi]}: ` : ''}{format(values[hi])}</span>}
    </div>
  )
}

/** Circular progress. `pace` draws a tick where even progress would be today (0-1). */
export function Ring({ value, pace, size = 64, stroke = 7, color = 'var(--accent)', children, label }: {
  value: number; pace?: number | null; size?: number; stroke?: number; color?: string; children?: ReactNode; label?: string
}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r
  const shown = useCountUp(Math.max(0, Math.min(1, value)), 900)
  const tick = pace != null && pace > 0 && pace < 1 ? pace * 2 * Math.PI - Math.PI / 2 : null
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label ?? `${pct(value)} done`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-sunk)" strokeWidth={stroke} />
        {shown > 0.005 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={`${shown * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
        {tick != null && (
          <line x1={size / 2 + (r - stroke / 2 - 2) * Math.cos(tick)} y1={size / 2 + (r - stroke / 2 - 2) * Math.sin(tick)}
                x2={size / 2 + (r + stroke / 2 + 2) * Math.cos(tick)} y2={size / 2 + (r + stroke / 2 + 2) * Math.sin(tick)}
                stroke="var(--text)" strokeWidth={2} strokeLinecap="round" />
        )}
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  )
}

export interface FlowNode { label: string; amount: number; color: string; onClick?: () => void; note?: string }

/** Where the money went: sources on the left flow into one "your money" bar, then out to where it ended up.
 *  Ribbon thickness = dollars. Hover a ribbon for its amount; click one to see its transactions. */
export function MoneyFlow({ sources, outs }: { sources: FlowNode[]; outs: FlowNode[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const total = sources.reduce((s, n) => s + n.amount, 0)
  if (total <= 0 || !outs.length) return <div className="empty">Nothing flowed in this range.</div>
  const MIN = 24 // small streams still get room for their label
  const W = 900, nodeW = 12, gap = 10, H = Math.max(380, Math.max(outs.length, sources.length) * (MIN + gap + 8))
  const xL = 170, xM = W / 2 - nodeW / 2, xR = W - 250
  const stack = (nodes: FlowNode[]) => {
    const avail = H - gap * (nodes.length - 1)
    const small = nodes.filter((n) => (n.amount / total) * avail < MIN)
    const k = (avail - small.length * MIN) / Math.max(total - small.reduce((t, n) => t + n.amount, 0), 1)
    let y = 0
    return nodes.map((n) => { const h = (n.amount / total) * avail < MIN ? MIN : n.amount * k; const r = { ...n, y, h }; y += h + gap; return r })
  }
  const L = stack(sources), R = stack(outs)
  const scale = (H - gap * (Math.max(outs.length, sources.length) - 1)) / total // middle bar: true proportions
  const midH = total * scale, midY = (H - midH) / 2
  const band = (x1: number, a0: number, a1: number, x2: number, b0: number, b1: number) => {
    const m = (x1 + x2) / 2
    return `M${x1},${a0} C${m},${a0} ${m},${b0} ${x2},${b0} L${x2},${b1} C${m},${b1} ${m},${a1} ${x1},${a1} Z`
  }
  // where each stream enters / leaves the middle bar
  const offs = (nodes: FlowNode[]) => nodes.map((_, i) => midY + nodes.slice(0, i).reduce((t, n) => t + n.amount * scale, 0))
  const inAt = offs(sources), outAt = offs(outs)
  const share = (n: number) => pct(n / total)
  return (
    <div className="flow">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Money flow from income to where it went">
        <defs>
          {[...L, ...R].map((n, i) => (
            <linearGradient key={i} id={`fl${i}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" style={{ stopColor: i < L.length ? n.color : 'var(--accent)', stopOpacity: 0.55 }} />
              <stop offset="100%" style={{ stopColor: i < L.length ? 'var(--accent)' : n.color, stopOpacity: 0.55 }} />
            </linearGradient>
          ))}
        </defs>
        {L.map((n, i) => {
          const d = band(xL + nodeW, n.y, n.y + n.h, xM, inAt[i], inAt[i] + n.amount * scale)
          return <path key={`l${i}`} d={d} fill={`url(#fl${i})`} className={`ribbon${hover && hover !== n.label ? ' dim' : ''}`}
                       onMouseEnter={() => setHover(n.label)} onMouseLeave={() => setHover(null)} onClick={n.onClick}
                       style={{ cursor: n.onClick ? 'pointer' : 'default' }}><title>{`${n.label}: ${money(n.amount, { cents: false })}`}</title></path>
        })}
        {R.map((n, i) => {
          const d = band(xM + nodeW, outAt[i], outAt[i] + n.amount * scale, xR, n.y, n.y + n.h)
          return <path key={`r${i}`} d={d} fill={`url(#fl${L.length + i})`} className={`ribbon${hover && hover !== n.label ? ' dim' : ''}`}
                       onMouseEnter={() => setHover(n.label)} onMouseLeave={() => setHover(null)} onClick={n.onClick}
                       style={{ cursor: n.onClick ? 'pointer' : 'default' }}><title>{`${n.label}: ${money(n.amount, { cents: false })} (${share(n.amount)})`}</title></path>
        })}
        <rect x={xM} y={midY} width={nodeW} height={midH} rx={5} fill="var(--accent)" />
        {L.map((n, i) => (
          <g key={`ln${i}`} className="flow-label">
            <rect x={xL} y={n.y} width={nodeW} height={n.h} rx={4} fill={n.color} />
            <text x={xL - 10} y={n.y + n.h / 2 + (n.h >= 40 ? -4 : 5)} textAnchor="end" className="fl-name">{n.label}{n.h < 40 && <tspan className="fl-amt">{`  ${money(n.amount, { cents: false })}`}</tspan>}</text>
            {n.h >= 40 && <text x={xL - 10} y={n.y + n.h / 2 + 13} textAnchor="end" className="fl-amt">{money(n.amount, { cents: false })}</text>}
          </g>
        ))}
        {R.map((n, i) => (
          <g key={`rn${i}`} className={`flow-label${n.onClick ? ' clickable' : ''}`} onClick={n.onClick}>
            <rect x={xR} y={n.y} width={nodeW} height={n.h} rx={4} fill={n.color} />
            <text x={xR + nodeW + 10} y={n.y + n.h / 2 + (n.h >= 40 ? -4 : 5)} className="fl-name">{n.label}</text>
            {n.h >= 40 && <text x={xR + nodeW + 10} y={n.y + n.h / 2 + 13} className="fl-amt">{money(n.amount, { cents: false })} · {share(n.amount)}</text>}
            {n.h < 40 && <text x={W - 4} y={n.y + n.h / 2 + 5} textAnchor="end" className="fl-amt">{money(n.amount, { cents: false })}</text>}
          </g>
        ))}
      </svg>
    </div>
  )
}

/** Stable color for a category or merchant avatar (fixed slots for the big categories, hashed otherwise). */
const FIXED_CAT: Record<string, number> = {
  Housing: 1, 'Food & Drink': 2, Shopping: 3, Transportation: 4, Entertainment: 5, 'Bills & Utilities': 6, Services: 7,
}
export function catColor(name: string) {
  let i = FIXED_CAT[name]
  if (!i) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; i = (h % 7) + 1 }
  return `var(--c${i})`
}
