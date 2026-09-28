import { useState } from 'react'
import { supabase } from '../cloud'

type Step = 'start' | 'email' | 'code' | 'add-passkey'

/** Sign in with a passkey (your phone passcode or Touch ID unlocks it), or with a 6-digit code emailed to you. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('start')
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('fh.email') || '' } catch { return '' } })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sb = supabase!

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const passkey = () => run(async () => {
    const { error } = await sb.auth.signInWithPasskey()
    if (error) throw new Error(error.message.includes('abort') || error.message.includes('cancel')
      ? 'Passkey sign-in was cancelled. Try again, or use an email code.'
      : "That didn't work. If this device has no passkey yet, sign in with an email code first.")
    onDone()
  })

  const sendCode = () => run(async () => {
    const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } })
    if (error) throw new Error(error.status === 429 ? 'Too many codes sent. Wait a few minutes and try again.' : "Couldn't send a code to that address.")
    try { localStorage.setItem('fh.email', email.trim()) } catch { /* private mode */ }
    setStep('code')
  })

  const verify = () => run(async () => {
    const { error } = await sb.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
    if (error) throw new Error('That code is wrong or expired. Check the newest email, or send a new code.')
    const { data } = await sb.auth.passkey.list()
    if (data && data.length) onDone(); else setStep('add-passkey')
  })

  const addPasskey = () => run(async () => {
    const { error } = await sb.auth.registerPasskey()
    if (error) throw new Error("The passkey wasn't saved. You can add one later from the Accounts page.")
    onDone()
  })

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-mark" aria-hidden />
        <h1>Finance Hub</h1>

        {step === 'start' && (
          <>
            <p className="muted">Sign in to see your money.</p>
            <button className="btn primary big" disabled={busy} onClick={passkey}>Sign in with passkey</button>
            <button className="link-btn" onClick={() => setStep('email')}>Use an email code instead</button>
          </>
        )}

        {step === 'email' && (
          <form onSubmit={(e) => { e.preventDefault(); sendCode() }}>
            <p className="muted">We'll email you a 6-digit code.</p>
            <input className="input big" type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <button className="btn primary big" disabled={busy || !email.trim()}>Send code</button>
            <button type="button" className="link-btn" onClick={() => setStep('start')}>Back</button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={(e) => { e.preventDefault(); verify() }}>
            <p className="muted">Enter the code sent to <b>{email}</b>.</p>
            <input className="input big code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code}
                   onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Code" />
            <button className="btn primary big" disabled={busy || code.length < 6}>Sign in</button>
            <button type="button" className="link-btn" onClick={sendCode} disabled={busy}>Send a new code</button>
          </form>
        )}

        {step === 'add-passkey' && (
          <>
            <p>You're in. Add a passkey so next time you just unlock with this device's passcode or fingerprint, no email needed.</p>
            <button className="btn primary big" disabled={busy} onClick={addPasskey}>Add a passkey</button>
            <button className="link-btn" onClick={onDone}>Not now</button>
          </>
        )}

        {error && <p className="signin-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
