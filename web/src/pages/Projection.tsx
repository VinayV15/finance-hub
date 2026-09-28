import { useEffect, useRef, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, put } from '../api'
import { Num } from '../components/Viz'
import { money, moneyShort, motionOK, niceDate } from '../format'
import { useFetch, useToast } from '../hooks'
import {
  allocate, earliestAge, extraNeeded, recommendBudgets, resolved, retirementNeed, simulate,
  type Plan, type PlanInputs, type PlanSettings, type YearRow,
} from '../planner'

type Tab = 'retire' | 'goals' | 'worth'

function Slider({ label, value, set, min, max, step, fmt, hint }: {
  label: string; value: number; set: (v: number) => void; min: number; max: number; step: number; fmt: (v: number) => string; hint?: string
}) {
  const pctFill = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
  return (
    <label className="slider">
      <span className="slider-top"><span>{label}</span><b>{fmt(value)}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)}
             style={{ '--fill': `${pctFill}%` } as React.CSSProperties} />
      {hint && <span className="muted small">{hint}</span>}
    </label>
  )
}

const usd = (v: number) => money(v, { cents: false })
const pctF = (v: number) => `${v}%`

function AgeTip({ active, payload }: { active?: boolean; payload?: readonly { payload: YearRow }[] }) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  const w = Object.entries(r.withdrawn).filter(([, v]) => v > 1)
  return (
    <div className="tt"><div className="tt-head">Age {r.age} · {r.year}{r.retired ? ' · retired' : ''}</div>
      {([['k401', '401(k)', 'var(--s-invest)'], ['roth', 'Roth IRA', 'var(--c4)'], ['brokerage', 'Brokerage', 'var(--s-gold)'], ['cash', 'Cash', 'var(--s-income)']] as const).map(([k, l, c]) => (
        <div className="tt-row" key={k}><span><i className="swatch" style={{ background: c }} />{l}</span><b className="num">{usd(r[k])}</b></div>
      ))}
      {r.retired && <div className="tt-row"><span>Living costs this year</span><b className="num">{usd(r.need)}</b></div>}
      {r.ss > 0 && <div className="tt-row"><span>Social Security</span><b className="num pos">+{usd(r.ss)}</b></div>}
      {w.length > 0 && <div className="tt-hint">paid from {w.map(([k, v]) => `${k === 'k401' ? '401(k)' : k} ${moneyShort(v)}`).join(', ')}</div>}
      {r.purchases.length > 0 && <div className="tt-hint">buys: {r.purchases.join(', ')}</div>}
      {r.shortfall > 1 && <div className="tt-hint neg">short {usd(r.shortfall)}</div>}
    </div>
  )
}

export function Projection() {
  const { data, reload } = useFetch<PlanInputs>('/api/plan')
  const toast = useToast()
  const [tab, setTab] = useState<Tab>(() => { const t = new URLSearchParams(location.search).get('tab'); return t === 'goals' || t === 'worth' ? t : 'retire' })
  const [draft, setDraft] = useState<Partial<PlanSettings>>({})
  const [birth, setBirth] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!data) return <div className="empty">Loading…</div>

  const settings = { ...data.settings, ...draft }
  const p: Plan = resolved(data, settings)
  const set = (k: keyof PlanSettings) => (v: number) => {
    setDraft((d) => ({ ...d, [k]: v }))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { api('/api/plan', { method: 'PUT', body: JSON.stringify({ [k]: v }) }).catch(() => {}) }, 600)
  }
  const reset = async () => { await put('/api/plan', Object.fromEntries(Object.keys(data.settings).filter((k) => k !== 'birth_year').map((k) => [k, null]))); setDraft({}); reload(); toast('Back to your own numbers.') }

  if (!p.birth_year) return (
    <>
      <div className="page-head"><div><h1>Plan</h1><div className="muted small">Retirement, goals, and where your money is heading.</div></div></div>
      <div className="card onboard">
        <h2>First, what year were you born?</h2>
        <p className="muted">Retirement accounts open up at 59½ and Medicare at 65, so the plan needs your age. It stays on this computer.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label className="field" style={{ width: 160 }}>Birth year<input className="input" inputMode="numeric" value={birth} onChange={(e) => setBirth(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="1994" /></label>
          <button className="btn primary" disabled={birth.length !== 4} onClick={async () => { await put('/api/plan', { birth_year: +birth }); reload() }}>Start my plan</button>
        </div>
      </div>
    </>
  )

  const y0 = +data.today.slice(0, 4)
  const age0 = y0 - p.birth_year
  const sim = simulate(data, p)
  const early = earliestAge(data, p)
  const earlyLow = earliestAge(data, p, { returnShift: -2 })
  const extra = sim.success ? 0 : extraNeeded(data, p, p.retire_age)
  const planSaves = p.cash_monthly + p.brokerage_monthly + p.roth_yearly / 12
  const available = (data.avg.take_home_month ?? data.avg.income_month) - data.avg.spend_month
  const retireYear = p.birth_year + p.retire_age

  // ----- goals & budget -----
  const retireNeed = retirementNeed(data, p, p.retire_age)
  const goalDemands = data.goals
    .filter((g) => g.type !== 'roth' && g.type !== 'investing' && g.type !== 'mortgage' && (g.monthly_needed || 0) > 0)
    .map((g) => ({ key: g.id, name: g.name, deadline: g.target_date, monthly: g.monthly_needed || 0, kind: 'goal' as const }))
  const alloc = allocate(available, [...goalDemands, { key: 'retire', name: `Retire at ${p.retire_age}`, deadline: `${retireYear}-01-01`, monthly: retireNeed ?? 0, kind: 'retirement' as const }])
  const rec = alloc.gap > 0 ? recommendBudgets(data.categories, alloc.gap) : null
  const retireFunded = alloc.demands.find((d) => d.kind === 'retirement')?.funded ?? 0
  const ageIfShort = alloc.gap > 0 ? earliestAge(data, { ...p, cash_monthly: 0, roth_yearly: Math.min(retireFunded * 12, data.roth_limit), brokerage_monthly: Math.max(retireFunded - data.roth_limit / 12, 0) }) : null
  const applyBudgets = async () => {
    if (!rec) return
    try { await put('/api/budget', Object.fromEntries(rec.rows.map((r) => [r.category, r.budget]))); toast(`Set ${rec.rows.length} budgets. See them on the Budget page.`) }
    catch (e) { toast((e as Error).message, true) }
  }

  const chart = sim.rows.map((r) => ({ ...r, cashPos: Math.max(r.cash, 0) }))
  const hero = sim.success
    ? { ok: true, big: `You can retire at ${early ?? p.retire_age}`, sub: early != null && early < p.retire_age ? `In ${p.birth_year + early}, ${p.retire_age - early} years sooner than your target of ${p.retire_age}.` : `Your target of ${p.retire_age} (${retireYear}) works.` }
    : { ok: false, big: early ? `Earliest retirement: ${early}` : 'Not on track yet', sub: `At ${p.retire_age} the money runs out at ${sim.runsOutAge}.${extra != null ? ` Invest ${usd(extra)}/mo more to make ${p.retire_age} work.` : ''}` }

  return (
    <>
      <div className="page-head">
        <div><h1>Plan</h1><div className="muted small">In today's dollars. An illustration to plan with, not a guarantee or financial advice.</div></div>
        <div className="seg">
          <button className={tab === 'retire' ? 'on' : ''} onClick={() => setTab('retire')}>Retirement</button>
          <button className={tab === 'goals' ? 'on' : ''} onClick={() => setTab('goals')}>Goals & budget</button>
          <button className={tab === 'worth' ? 'on' : ''} onClick={() => setTab('worth')}>Net worth</button>
        </div>
      </div>

      {tab === 'retire' && (
        <>
          <div className={`tile hero plan-hero${hero.ok ? '' : ' warn'}`}>
            <div className="label">Age {age0} today · planning to age {p.plan_to_age}</div>
            <div className="value">{hero.big}</div>
            <div className="hero-delta">{hero.sub}</div>
            <div className="hero-foot">
              <div><b>{earlyLow ?? '75+'}</b>if returns are 2% lower</div>
              <div><b>{usd(sim.needAtRetire)}</b>a year to live on at {p.retire_age}</div>
              <div><b>{sim.success ? usd(sim.endLiquid) : '—'}</b>left at {p.plan_to_age}</div>
            </div>
          </div>

          <div className="grid proj-grid section">
            <div className="card">
              <div className="group-head"><h2>Your accounts by age</h2>
                <div className="legend" style={{ margin: 0 }}>
                  <span><i className="swatch" style={{ background: 'var(--s-invest)' }} />401(k)</span><span><i className="swatch" style={{ background: 'var(--c4)' }} />Roth IRA</span>
                  <span><i className="swatch" style={{ background: 'var(--s-gold)' }} />Brokerage</span><span><i className="swatch" style={{ background: 'var(--s-income)' }} />Cash</span>
                </div></div>
              <div className="line-key">
                <span><i className="lk solid" />you retire at {p.retire_age}</span>
                {p.retire_age < 60 && <span><i className="lk dashed" />59½: 401(k) and Roth growth open up</span>}
                {sim.runsOutAge && <span className="neg"><i className="lk dotted" />money runs out at {sim.runsOutAge}</span>}
              </div>
              <ResponsiveContainer width="100%" height={330}>
                <ComposedChart data={chart} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}>
                  <defs>{[['pl-401', 'var(--s-invest)'], ['pl-roth', 'var(--c4)'], ['pl-brok', 'var(--s-gold)'], ['pl-cash', 'var(--s-income)']].map(([id, c]) => (
                    <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: c, stopOpacity: 0.9 }} /><stop offset="100%" style={{ stopColor: c, stopOpacity: 0.4 }} /></linearGradient>))}</defs>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <XAxis dataKey="age" tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} minTickGap={16} />
                  <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={58} />
                  <Tooltip content={(t) => <AgeTip active={t.active} payload={t.payload as unknown as { payload: YearRow }[]} />} cursor={{ stroke: 'var(--line-strong)' }} />
                  <ReferenceLine x={p.retire_age} stroke="var(--text)" strokeWidth={2} />
                  {p.retire_age < 60 && <ReferenceLine x={60} stroke="var(--text-2)" strokeDasharray="5 4" strokeWidth={1.5} />}
                  {sim.runsOutAge && <ReferenceLine x={sim.runsOutAge} stroke="var(--bad)" strokeWidth={2} strokeDasharray="2 3" />}
                  <Area dataKey="cashPos" stackId="a" stroke="var(--s-income)" fill="url(#pl-cash)" type="monotone" isAnimationActive={motionOK} animationDuration={700} />
                  <Area dataKey="brokerage" stackId="a" stroke="var(--s-gold)" fill="url(#pl-brok)" type="monotone" isAnimationActive={motionOK} animationDuration={700} />
                  <Area dataKey="roth" stackId="a" stroke="var(--c4)" fill="url(#pl-roth)" type="monotone" isAnimationActive={motionOK} animationDuration={700} />
                  <Area dataKey="k401" stackId="a" stroke="var(--s-invest)" fill="url(#pl-401)" type="monotone" isAnimationActive={motionOK} animationDuration={700} />
                </ComposedChart>
              </ResponsiveContainer>
              {p.retire_age < 60 && (
                <div className={`note ${sim.success ? '' : 'warn-note'}`} style={{ marginTop: 10 }}>
                  <b>The years before 59½:</b> from {p.retire_age} to 59½ you can only spend cash, brokerage, and the {usd(Math.min(data.buckets.roth_basis, data.buckets.roth))}+ you've put into the Roth yourself.
                  At {p.retire_age} that's about <b>{usd(sim.accessibleAtRetire)}</b> usable vs <b>{usd(sim.lockedAtRetire)}</b> locked in the 401(k) and Roth growth.
                </div>
              )}
            </div>

            <div className="card plan-controls">
              <h2>Your plan</h2>
              <Slider label="Retire at" value={p.retire_age} set={set('retire_age')} min={Math.max(age0 + 1, 35)} max={75} step={1} fmt={(v) => `age ${v}`} hint={`${p.birth_year + p.retire_age}`} />
              <h3>Saving each month / year</h3>
              <Slider label="To savings (cash)" value={p.cash_monthly} set={set('cash_monthly')} min={0} max={4000} step={50} fmt={usd} hint={`you've averaged ${usd(Math.max(data.avg.saved_month - data.avg.invested_month, 0))}/mo lately`} />
              <Slider label="To brokerage (stocks)" value={p.brokerage_monthly} set={set('brokerage_monthly')} min={0} max={4000} step={50} fmt={usd} hint={`lately ${usd(data.avg.brokerage_month)}/mo`} />
              <Slider label="Roth IRA per year" value={p.roth_yearly} set={set('roth_yearly')} min={0} max={data.roth_limit} step={250} fmt={usd} hint={`limit ${usd(data.roth_limit)} · ${usd(data.roth_this_year)} in so far this year`} />
              <Slider label="401(k) per year, you + match" value={p.k401_yearly} set={set('k401_yearly')} min={0} max={data.k401_limit + 15000} step={250} fmt={usd} hint={`your pay settings: ${usd(data.k401_yearly)}`} />
              <div className={`plan-check ${planSaves > available + 25 ? 'over' : ''}`}>
                This plan saves <b>{usd(planSaves)}/mo</b> from take-home. You take home {usd(data.avg.take_home_month ?? data.avg.income_month)} and spend {usd(data.avg.spend_month)}, leaving <b>{usd(available)}/mo</b>.
                {planSaves > available + 25 && <> That's {usd(planSaves - available)} more than you have, so trim spending (see Goals & budget).</>}
              </div>
              <h3>Returns (average per year, before inflation)</h3>
              <Slider label="Stocks: 401(k), Roth, brokerage" value={p.stock_return} set={set('stock_return')} min={2} max={11} step={0.5} fmt={pctF} hint="US stock-heavy portfolios have averaged about 7–10% over long periods" />
              <Slider label="Savings account interest" value={p.cash_apy ?? 0} set={set('cash_apy')} min={0} max={6} step={0.05} fmt={pctF} hint={`your cash actually earned ${data.cash_apy}% over the last 12 months`} />
              <Slider label="Home value growth, after inflation" value={p.home_growth ?? 0} set={set('home_growth')} min={-2} max={6} step={0.25} fmt={pctF} hint="your area area's long-run pace, from the price index" />
              <Slider label="Inflation" value={p.inflation} set={set('inflation')} min={1} max={5} step={0.25} fmt={pctF} />
              <h3>Life in retirement</h3>
              <Slider label="Spending vs. today" value={p.spend_change_pct} set={set('spend_change_pct')} min={-40} max={40} step={5} fmt={(v) => `${v > 0 ? '+' : ''}${v}%`}
                      hint={`today ${usd(data.avg.spend_year)}/yr in your area${data.mortgage ? `; the ${usd(data.mortgage.pi_monthly * 12)}/yr mortgage payment stops after ${data.mortgage.payoff.slice(0, 4)}` : ''}. Moving somewhere cheaper? Try −20%.`} />
              <Slider label="Health insurance before 65, per year" value={p.healthcare_yearly} set={set('healthcare_yearly')} min={0} max={20000} step={500} fmt={usd} hint="your employer covers this now; Medicare starts at 65" />
              <Slider label="Social Security per month" value={p.ss_monthly} set={set('ss_monthly')} min={0} max={4500} step={50} fmt={usd} hint="0 = don't count on it. Get your estimate at ssa.gov/myaccount" />
              {p.ss_monthly > 0 && <Slider label="Social Security starts at" value={p.ss_age} set={set('ss_age')} min={62} max={70} step={1} fmt={(v) => `age ${v}`} />}
              <Slider label="Plan until age" value={p.plan_to_age} set={set('plan_to_age')} min={80} max={105} step={1} fmt={(v) => `${v}`} />
              <details className="plan-more"><summary>Taxes & cushion</summary>
                <Slider label="Tax on 401(k) withdrawals" value={p.tax_401k} set={set('tax_401k')} min={0} max={30} step={1} fmt={pctF} />
                <Slider label="Tax on brokerage withdrawals" value={p.tax_brokerage} set={set('tax_brokerage')} min={0} max={20} step={1} fmt={pctF} />
                <Slider label="Cash cushion kept in retirement" value={p.cash_floor_months} set={set('cash_floor_months')} min={0} max={24} step={1} fmt={(v) => `${v} months`} />
              </details>
              <button className="link-btn" onClick={reset}>Reset to my numbers</button>
            </div>
          </div>
        </>
      )}

      {tab === 'goals' && (
        <>
          <div className="tiles">
            <div className="tile"><div className="label">You can save each month</div><div className="value"><Num v={available} /></div><div className="sub">take-home minus your average spending</div></div>
            <div className="tile"><div className="label">Your goals need</div><div className="value"><Num v={alloc.demands.reduce((s, d) => s + d.monthly, 0)} /></div><div className="sub">per month, all goals + retiring at {p.retire_age}</div></div>
            <div className="tile"><div className="label">{alloc.gap > 0 ? 'Short by' : 'Left over'}</div><div className={`value ${alloc.gap > 0 ? 'neg' : 'pos'}`}><Num v={alloc.gap > 0 ? alloc.gap : alloc.surplus} /></div><div className="sub">per month</div></div>
          </div>

          <div className="card">
            <div className="group-head"><h2>Funding order</h2><span className="muted small">soonest deadline first; retirement gets the rest</span></div>
            {alloc.demands.map((d, i) => {
              const full = d.funded >= d.monthly - 1
              return (
                <div key={d.key} className="fund-row">
                  <span className="fund-n">{i + 1}</span>
                  <div className="fund-main"><b>{d.name}</b><span className="muted small">{d.kind === 'retirement' ? `least you'd need to save to retire in ${retireYear}` : d.deadline ? `by ${niceDate(d.deadline)}` : 'no deadline'}</span></div>
                  <div className="fund-bar"><span style={{ width: `${d.monthly ? Math.min(d.funded / d.monthly, 1) * 100 : 100}%` }} className={full ? 'ok' : 'short'} /></div>
                  <div className="fund-amt"><b>{usd(d.funded)}</b><span className="muted small">of {usd(d.monthly)}/mo</span></div>
                </div>
              )
            })}
            {data.goals.length === 0 && <p className="muted small">Add goals (a trip, a car, an emergency fund) on the Goals page and they'll show up here.</p>}
          </div>

          {rec ? (
            <div className="card section">
              <div className="group-head"><h2>Budgets that fund everything</h2>
                <button className="btn primary small" disabled={!rec.rows.length} onClick={applyBudgets}>Use these budgets</button></div>
              <p className="muted small" style={{ marginTop: -4 }}>Trims flexible categories (up to 35% each, bigger ones more) to free {usd(alloc.gap)}/mo. Housing, bills, health, and loans are left alone.</p>
              <table className="data"><thead><tr><th>Category</th><th className="r">You average</th><th className="r">Recommended</th><th className="r">Frees up</th></tr></thead>
                <tbody>{rec.rows.map((r) => <tr key={r.category}><td>{r.category}</td><td className="r">{usd(r.avg)}</td><td className="r"><b>{usd(r.budget)}</b></td><td className="r pos">{usd(r.avg - r.budget)}</td></tr>)}</tbody></table>
              {rec.unmet > 1 && <p className="note" style={{ marginTop: 10 }}>Even with these cuts you're {usd(rec.unmet)}/mo short. Without more room, retirement moves to about <b>age {ageIfShort ?? '75+'}</b>, or push a goal's date later on the Goals page.</p>}
            </div>
          ) : (
            <div className="card section">
              <h2>You're covered</h2>
              <p className="muted">Everything is funded with {usd(alloc.surplus)}/mo to spare.{alloc.surplus > 50 && (() => { const a = earliestAge(data, p, { extraMonthly: alloc.surplus }); return a && a < (early ?? 99) ? ` Investing it would let you retire at ${a} instead of ${early}.` : '' })()}</p>
            </div>
          )}
        </>
      )}

      {tab === 'worth' && <NetWorthTab rows={sim.rows} p={p} />}
    </>
  )
}

function NetWorthTab({ rows, p }: { rows: YearRow[]; p: Plan }) {
  const data = rows.map((r) => ({ ...r, total: r.liquid + r.home }))
  const at = (n: number) => data[Math.min(n, data.length - 1)]
  const milestones = [250e3, 500e3, 1e6, 2e6, 5e6].map((t) => ({ t, row: data.find((r) => r.total >= t) })).filter((m) => m.row && m.row.year > data[0].year)
  return (
    <>
      <div className="tiles">
        {[10, 20, 30].map((n) => at(n) && <div key={n} className="tile"><div className="label">In {n} years (age {at(n).age})</div><div className="value"><Num v={at(n).total} /></div>
          <div className="sub">{moneyShort(at(n).liquid)} accounts + {moneyShort(at(n).home)} home equity</div></div>)}
      </div>
      <div className="grid two">
        <div className="card">
          <h2>Net worth by age</h2>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <defs><linearGradient id="nw2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.6 }} /><stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} /></linearGradient></defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="age" tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={58} />
              <Tooltip cursor={{ stroke: 'var(--line-strong)' }} content={({ active, payload }) => active && payload?.length ? (() => { const r = payload[0].payload as typeof data[0]; return (
                <div className="tt"><div className="tt-head">Age {r.age} · {r.year}</div>
                  <div className="tt-row"><span>Accounts</span><b className="num">{usd(r.liquid)}</b></div><div className="tt-row"><span>Home equity</span><b className="num">{usd(r.home)}</b></div>
                  <div className="tt-row"><span><b>Net worth</b></span><b className="num">{usd(r.total)}</b></div></div>) })() : null} />
              <ReferenceLine x={p.retire_age} stroke="var(--accent)" strokeDasharray="4 4" />
              <Area dataKey="total" stroke="var(--accent)" strokeWidth={2.5} fill="url(#nw2)" type="monotone" isAnimationActive={motionOK} animationDuration={700} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>Milestones</h2>
          {milestones.map((m) => <div key={m.t} className="row"><div className="row-main"><div className="row-title">{moneyShort(m.t)} net worth</div></div><div className="row-amt">age {m.row!.age} · {m.row!.year}</div></div>)}
          <div className="row"><div className="row-main"><div className="row-title">Retire</div></div><div className="row-amt">age {p.retire_age}</div></div>
          <p className="muted small">Includes home equity. The home grows at {p.home_growth?.toFixed(1)}% a year after inflation (set on the Retirement tab, from the your area area's long-run pace).</p>
        </div>
      </div>
    </>
  )
}
