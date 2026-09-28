// Accounts Plaid can't reach (port of manual.py): Venmo (statement CSV import) and hand-entered balances.
import { one, run, scalar, setMeta, transaction, upsertTxn } from './db.ts'
import { nowIso } from './util.ts'
import * as classify from './classify.ts'

export const VENMO_ACCOUNT_ID = 'venmo'

/** '- $1,234.50' -> -1234.5 ; '' -> null */
function money(s: string | undefined) {
  s = (s || '').trim()
  if (!s) return null
  const neg = s.startsWith('-') || s.startsWith('(')
  const n = s.replace(/[^0-9.]/g, '')
  if (!n) return null
  const v = parseFloat(n)
  return neg ? -v : v
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); rows.push(row); row = []; cur = ''
    } else cur += ch
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

async function sha1(s: string) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Venmo > Me > Settings > Statements > Download CSV. Returns count of transactions imported. */
export async function importVenmoCsv(raw: Uint8Array) {
  const text = new TextDecoder('utf-8').decode(raw).replace(/^﻿/, '')
  const rows = parseCsv(text)
  const headerIdx = rows.findIndex((r) => r.includes('Datetime') && r.includes('Amount (total)'))
  if (headerIdx < 0) throw new Error("That doesn't look like a Venmo statement CSV (no 'Datetime' / 'Amount (total)' columns).")
  const header = rows[headerIdx]
  const col: Record<string, number> = {}
  header.forEach((name, i) => { if (name && !(name in col)) col[name] = i })
  const get = (r: string[], name: string) => { const i = col[name]; return i != null && i < r.length ? r[i] : '' }

  let count = 0, endingBalance: number | null = null, latest: string | null = null
  await transaction(async (tx) => {
    for (const r of rows.slice(headerIdx + 1)) {
      const end = money(get(r, 'Ending Balance'))
      if (end != null) endingBalance = end
      let txnId = get(r, 'ID').trim()
      const when = get(r, 'Datetime').trim()
      const amount = money(get(r, 'Amount (total)'))
      if (!when || amount == null) continue
      if (!txnId) txnId = (await sha1(r.join('|'))).slice(0, 16)
      latest = latest == null || when.slice(0, 10) > latest ? when.slice(0, 10) : latest
      const who = (amount < 0 ? get(r, 'To') : get(r, 'From')).trim()
      const note = get(r, 'Note').trim()
      const vtype = get(r, 'Type').trim()
      const name = who && note ? `${who} — ${note}` : who || note || vtype
      await upsertTxn({
        txn_id: `venmo-${txnId}`, account_id: VENMO_ACCOUNT_ID, date: when.slice(0, 10), name,
        amount: -amount, category: vtype, pending: 0, detailed: null, raw_primary: null, source: 'venmo', // Plaid sign: + = out
        txn_type: vtype, funding_source: (get(r, 'Funding Source') || get(r, 'Destination')).trim() || null, counterparty: who || null,
      }, tx)
      count++
    }
  })
  // Only the newest statement sets the balance, so importing an old month never rolls it back.
  const asofRow = await one("SELECT value FROM meta WHERE key='venmo_balance_asof'")
  const asof = asofRow ? asofRow.value : await scalar('SELECT MAX(date) FROM transactions WHERE account_id=? AND date > ?', [VENMO_ACCOUNT_ID, latest || ''])
  const newest = !!latest && (!asof || latest >= asof)
  if (newest) await setMeta('venmo_balance_asof', latest!)
  const existing = await one('SELECT balance FROM accounts WHERE account_id=?', [VENMO_ACCOUNT_ID])
  if (count && (newest || !existing)) {
    const balance = endingBalance != null && newest ? endingBalance : existing ? existing.balance : 0
    await upsertAccount({ account_id: VENMO_ACCOUNT_ID, item_id: null, source: 'venmo', institution: 'Venmo', name: 'Venmo balance', mask: null,
      type: 'depository', subtype: 'venmo', balance, available: balance, currency: 'USD', updated_at: nowIso() })
  }
  await classify.run()
  return count
}

const ACCT_COLS = ['account_id', 'item_id', 'source', 'institution', 'name', 'mask', 'type', 'subtype', 'balance', 'available', 'currency', 'updated_at']
export async function upsertAccount(a: Record<string, any>, tx?: any) {
  await run(`INSERT INTO accounts (${ACCT_COLS.join(', ')}) VALUES (${ACCT_COLS.map(() => '?').join(', ')})
    ON CONFLICT(account_id) DO UPDATE SET ${ACCT_COLS.slice(1).map((k) => `${k}=excluded.${k}`).join(', ')}`, ACCT_COLS.map((k) => a[k] ?? null), tx)
}

export async function upsertManual(name: string, institution: string, type: string, balance: number, accountId?: string | null) {
  accountId = accountId || `manual-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
  await upsertAccount({ account_id: accountId, item_id: null, source: 'manual', institution, name, mask: null, type, subtype: 'manual',
    balance, available: null, currency: 'USD', updated_at: nowIso() })
  return accountId
}

export async function deleteManual(accountId: string) {
  await run("DELETE FROM accounts WHERE account_id=? AND source IN ('manual','venmo')", [accountId])
  await run('DELETE FROM transactions WHERE account_id=?', [accountId])
}
