import { useState } from 'react';
import { post } from '../lib/api';

/** Public page for invitation and password-reset links. With ?token it sets a password; without one it asks for the email to send a reset link to. */
export function AcceptInvite() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [msg, setMsg] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      if (token) { await post('/api/public/invite/accept', { token, password }); setMsg('Password saved. You can sign in now.') }
      else { await post('/api/public/invite/forgot', { email }); setMsg('If that address belongs to an account, a reset link is on its way.') }
    } catch (x: any) { setErr(x.message || 'Something went wrong') } finally { setBusy(false) }
  }
  return (
    <main style={{ maxWidth: 380, margin: '12vh auto', padding: '0 16px', fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: 22 }}>{token ? 'Set your password' : 'Forgot your password?'}</h1>
      {msg ? <p>{msg} <a href="/">Go to sign in</a></p> : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          {token
            ? <input type="password" required minLength={8} autoComplete="new-password" placeholder="New password" value={password} onChange={e => setPassword(e.target.value)} />
            : <input type="email" required autoComplete="email" placeholder="Work email" value={email} onChange={e => setEmail(e.target.value)} />}
          {err && <div role="alert" style={{ color: '#8f1325' }}>{err}</div>}
          <button className="btn green" disabled={busy}>{token ? 'Save password' : 'Email me a reset link'}</button>
        </form>
      )}
    </main>
  )
}
