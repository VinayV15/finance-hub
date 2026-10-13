// Accuracy checks: is the 401(k) getting what your pay settings say, and is the data itself clean (duplicates,
// unmatched transfers, stale syncs, stuck pending charges, unknown transfers, gaps).
import { all, getMeta, scalar } from './db.ts'
import { EMPLOYER_RE, FROM, accountKind, planDataSince, dataCoverage, isWorkplace, payBreakdown, payHistory, paycheckDates, settingsOn } from './analytics.ts'
import { addDays, diffDays, round, sum, today } from './util.ts'


/** Per payday: what your pay settings say should reach the 401(k) (your % + match) vs. what the plan received. */
export async function retirementCheck() {
  const plans = (await all(`SELECT a.account_id, a.name, a.institution, a.subtype, a.balance FROM accounts a
      WHERE a.type='investment' AND ${isWorkplace()}`))
  if (!plans.length) return { linked: false, plans: [], paydays: [], ytd: null, issues: [] }
  const ids = plans.map((p) => p.account_id)
  const t0 = today(), year = t0.slice(0, 4)
  const deposits = await all(`SELECT t.date, t.name, -t.amount AS amount, t.account_id FROM transactions t JOIN txn_class k USING(txn_id)
      WHERE t.account_id IN (${ids.map(() => '?').join(',')}) AND k.kind='invest_contribution' AND t.amount < 0 ORDER BY t.date`, ids)
  const first = deposits[0]?.date ?? null
  const history = await payHistory()
  const since = await planDataSince()
  const days = since ? (await paycheckDates(since)).filter((d) => d <= t0) : []
  const used = new Set<number>()
  const paydays = []
  for (const d of days) {
    const h = settingsOn(d, history)
    const b = h ? await payBreakdown(h) : null
    // deposits usually land 0-7 days after payday
    const mine: any[] = deposits.map((x, i) => ({ ...x, i }) as any).filter((x) => !used.has(x.i) && diffDays(x.date, d) >= -2 && diffDays(x.date, d) <= 8)
    mine.forEach((x) => used.add(x.i))
    const emp = sum(mine.filter((x) => EMPLOYER_RE.test(x.name || '')).map((x) => x.amount))
    const total = sum(mine.map((x) => x.amount))
    const split = mine.some((x) => EMPLOYER_RE.test(x.name || ''))
    const expYours = b?.per_paycheck.retirement ?? null, expMatch = b?.per_paycheck.employer_match ?? null
    const expected = expYours != null && expMatch != null ? expYours + expMatch : null
    const gap = expected != null ? round(total - expected, 2) : null
    paydays.push({
      date: d, expected_yours: expYours, expected_match: expMatch, expected: expected != null ? round(expected, 2) : null,
      actual: round(total, 2), actual_yours: split ? round(total - emp, 2) : null, actual_match: split ? round(emp, 2) : null,
      gap, status: expected == null ? 'unknown' : !mine.length ? (diffDays(t0, d) <= 7 ? 'pending' : 'missing') : Math.abs(gap!) <= Math.max(2, expected * 0.03) ? 'ok' : 'off',
      deposits: mine.map((x) => ({ date: x.date, name: x.name, amount: round(x.amount, 2) })),
    })
  }
  const unmatched = deposits.filter((_, i) => !used.has(i)).map((x) => ({ date: x.date, name: x.name, amount: round(x.amount, 2) }))
  const ytdDeposits = deposits.filter((x) => x.date >= `${year}-01-01`)
  const ytdEmployer = sum(ytdDeposits.filter((x) => EMPLOYER_RE.test(x.name || '')).map((x) => x.amount))
  const splitKnown = ytdDeposits.some((x) => EMPLOYER_RE.test(x.name || ''))
  const ytdTotal = sum(ytdDeposits.map((x) => x.amount))
  const ytdExpected = sum(paydays.filter((p) => p.date >= `${year}-01-01` && p.expected != null).map((p) => p.expected!))
  const issues: string[] = []
  const off = paydays.filter((p) => p.status === 'off' || p.status === 'missing')
  if (off.length) issues.push(`${off.length} payday${off.length > 1 ? 's' : ''} where the 401(k) deposit doesn't match your pay settings (${off.map((p) => p.date).slice(-3).join(', ')}).`)
  if (paydays.length && paydays.every((p) => p.status === 'off') && ytdExpected) {
    const ratio = ytdTotal / ytdExpected
    issues.push(`Deposits run about ${round(ratio * 100)}% of what your settings expect. Check your contribution % and match on the Income page.`)
  }
  return {
    linked: true,
    plans: plans.map((p) => ({ ...p, kind: accountKind(p.subtype) })),
    paydays: paydays.reverse(), unmatched,
    ytd: { total: round(ytdTotal, 2), yours: splitKnown ? round(ytdTotal - ytdEmployer, 2) : null, match: splitKnown ? round(ytdEmployer, 2) : null, expected: round(ytdExpected, 2), split_known: splitKnown },
    first_deposit: first, issues,
  }
}

type Check = { id: string; level: 'ok' | 'info' | 'warn' | 'bad'; title: string; detail: string; items?: any[]; link?: { to: string; params?: Record<string, string> } }

export async function health() {
  const t0 = today()
  const checks: Check[] = []
  const since = addDays(t0, -180)

  // 1. Bank logins
  const items = await all('SELECT item_id, institution, status, error, last_synced FROM items')
  const broken = items.filter((i) => i.status && i.status !== 'ok')
  const stale = items.filter((i) => i.status === 'ok' && (!i.last_synced || Date.now() - new Date(i.last_synced).getTime() > 2.5 * 864e5))
  checks.push(broken.length
    ? { id: 'logins', level: 'bad', title: `${broken.length} bank login${broken.length > 1 ? 's need' : ' needs'} you to sign in again`, detail: broken.map((i) => `${i.institution}: ${i.error || i.status}`).join(' · '), link: { to: '/accounts' } }
    : stale.length
      ? { id: 'logins', level: 'warn', title: `${stale.length} login${stale.length > 1 ? 's haven\'t' : ' hasn\'t'} synced in over 2 days`, detail: stale.map((i) => i.institution).join(', '), link: { to: '/accounts' } }
      : { id: 'logins', level: 'ok', title: `All ${items.length} bank logins are working`, detail: `Last full sync ${(await getMeta('last_sync') || '').slice(0, 10) || 'never'}` })

  // 2. Possible duplicate charges: same account, name, and amount within 3 days
  const dups = await all(`SELECT a.txn_id, a.date, a.name, a.amount, b.txn_id AS other_id, b.date AS other_date, ac.name AS account
      FROM transactions a JOIN transactions b ON a.account_id=b.account_id AND a.amount=b.amount AND lower(a.name)=lower(b.name)
        AND a.txn_id < b.txn_id AND abs(a.date::date - b.date::date) <= 3
      JOIN txn_class ka ON ka.txn_id=a.txn_id JOIN txn_class kb ON kb.txn_id=b.txn_id
      LEFT JOIN accounts ac ON ac.account_id=a.account_id
      WHERE a.pending=0 AND b.pending=0 AND a.date >= ? AND a.amount > 5 AND ka.flow='spend' AND kb.flow='spend'
      ORDER BY a.date DESC LIMIT 20`, [since])
  checks.push(dups.length
    ? { id: 'duplicates', level: 'warn', title: `${dups.length} possible double charge${dups.length > 1 ? 's' : ''}`, detail: 'Same merchant, same amount, same account within 3 days. Usually two real purchases; worth a glance.', items: dups }
    : { id: 'duplicates', level: 'ok', title: 'No double charges spotted', detail: 'Checked the last 6 months.' })

  // 3. Transfers and card payments with no matching other side (both accounts are linked)
  const unpaired = await all(`SELECT t.txn_id, t.date, t.name, t.amount, a.name AS account, k.kind ${FROM}
      WHERE k.flow='transfer' AND k.pair_id IS NULL AND k.kind IN ('card_payment','internal') AND t.date >= ? AND t.date <= ?
        AND t.pending=0 AND t.source != 'import' ORDER BY t.date DESC LIMIT 25`, [since, addDays(t0, -5)])
  checks.push(unpaired.length
    ? { id: 'unpaired', level: 'warn', title: `${unpaired.length} transfer${unpaired.length > 1 ? 's' : ''} or card payment${unpaired.length > 1 ? 's' : ''} with no matching side`, detail: 'Each move between your accounts should show up in both. A missing side can mean an account isn\'t linked, or a payment counted as spending.', items: unpaired }
    : { id: 'unpaired', level: 'ok', title: 'Every transfer and card payment has both sides', detail: 'Money moving between your accounts is never counted twice.' })

  // 4. Money to/from accounts the app doesn't know (counted as spending/income)
  const ext = await all(`SELECT t.txn_id, t.date, t.name, t.amount, a.name AS account, k.flow ${FROM}
      WHERE k.kind='external_transfer' AND t.date >= ? ORDER BY abs(t.amount) DESC LIMIT 20`, [since])
  if (ext.length) checks.push({ id: 'external', level: 'info', title: `${ext.length} transfer${ext.length > 1 ? 's' : ''} to or from unknown accounts`, detail: `Counted as ${ext.some((e) => e.flow === 'spend') ? 'spending' : 'income'} until you say otherwise. If one is your own account, mark it as a transfer.`, items: ext, link: { to: '/transactions', params: { q: '' } } })

  // 5. Review queue
  const review = await scalar('SELECT COUNT(*) FROM txn_class WHERE review=1')
  checks.push(review ? { id: 'review', level: 'info', title: `${review} transaction${review > 1 ? 's' : ''} to check`, detail: 'The app wasn\'t sure how to count these.', link: { to: '/review' } }
    : { id: 'review', level: 'ok', title: 'Nothing waiting for review', detail: 'Every transaction is classified.' })

  // 6. Pending charges stuck for over 10 days
  const stuck = await all(`SELECT t.txn_id, t.date, t.name, t.amount, a.name AS account FROM transactions t LEFT JOIN accounts a USING(account_id)
      WHERE t.pending=1 AND t.date < ? ORDER BY t.date LIMIT 20`, [addDays(t0, -10)])
  if (stuck.length) checks.push({ id: 'pending', level: 'warn', title: `${stuck.length} pending charge${stuck.length > 1 ? 's' : ''} older than 10 days`, detail: 'Usually a hold that was released; they fall off on the next sync. If they stay, the bank may have changed the transaction.', items: stuck })

  // 7. Balances that stopped updating
  const staleBal = await all(`SELECT name, institution, updated_at, source FROM accounts WHERE source='plaid' AND updated_at < ?`, [new Date(Date.now() - 3 * 864e5).toISOString()])
  if (staleBal.length) checks.push({ id: 'balances', level: 'warn', title: `${staleBal.length} balance${staleBal.length > 1 ? 's' : ''} not updated in 3+ days`, detail: staleBal.map((a) => `${a.institution} ${a.name}`).join(', '), link: { to: '/accounts' } })
  const manual = await all(`SELECT name, institution, updated_at FROM accounts WHERE source IN ('manual','venmo') AND updated_at < ?`, [new Date(Date.now() - 45 * 864e5).toISOString()])
  if (manual.length) checks.push({ id: 'manual', level: 'info', title: `${manual.length} hand-entered balance${manual.length > 1 ? 's' : ''} over 45 days old`, detail: manual.map((a) => a.name).join(', '), link: { to: '/accounts' } })

  // 8. History coverage: new accounts vs. real gaps
  const cov = await dataCoverage()
  const fresh = cov.filter((c) => c.opened)
  if (fresh.length) checks.push({ id: 'new-accounts', level: 'ok', title: `${fresh.length} new account${fresh.length > 1 ? 's' : ''} (history starts when ${fresh.length > 1 ? 'they were' : 'it was'} opened)`, detail: fresh.map((c) => `${c.institution} ${c.name}: since ${c.opened}`).join(' · ') })
  const empty = cov.filter((c) => !c.n && c.source === 'plaid')
  if (empty.length) checks.push({ id: 'no-history', level: 'info', title: `${empty.length} linked account${empty.length > 1 ? 's have' : ' has'} no transactions yet`, detail: empty.map((c) => `${c.institution} ${c.name}`).join(', ') })

  // 9. 401(k) deposits vs. pay settings
  const rc = await retirementCheck()
  if (rc.linked) {
    const off = rc.paydays.filter((p: any) => p.status === 'off' || p.status === 'missing')
    checks.push(off.length
      ? { id: '401k', level: 'warn', title: `401(k) deposits don't match your pay settings on ${off.length} payday${off.length > 1 ? 's' : ''}`, detail: rc.issues.join(' '), link: { to: '/income' } }
      : rc.paydays.length
        ? { id: '401k', level: 'ok', title: '401(k) deposits match your pay settings', detail: `${rc.paydays.length} paydays checked.`, link: { to: '/income' } }
        : { id: '401k', level: 'info', title: 'Waiting for the first 401(k) deposit after linking', detail: "Earlier paydays come from your pay settings; each new payday's deposit gets checked as it arrives.", link: { to: '/income' } })
  }

  // 10. Uncategorized spending ("Other")
  const other = await all(`SELECT t.txn_id, t.date, t.name, t.amount, a.name AS account ${FROM}
      WHERE k.flow='spend' AND k.category IN ('Other','') AND t.date >= ? ORDER BY t.amount DESC LIMIT 15`, [since])
  if (other.length) checks.push({ id: 'other', level: 'info', title: `${other.length} purchase${other.length > 1 ? 's' : ''} filed under "Other"`, detail: 'Give them a category so budgets and charts are complete.', items: other })

  const order = { bad: 0, warn: 1, info: 2, ok: 3 }
  checks.sort((a, b) => order[a.level] - order[b.level])
  return { checks, score: { ok: checks.filter((c) => c.level === 'ok').length, total: checks.length } }
}
