import { useEffect,useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence,motion,useReducedMotion } from 'motion/react'
import { ArrowRight,Check,Eye,EyeOff,KeyRound,Loader2,Lock,Mail,ShieldCheck } from 'lucide-react'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import { get,post } from '../lib/api'
import { useMeta } from '../lib/meta'

/**
 * SWK OS sign-in. Layout adapted from the "Split Login" block (Hirael, MIT): animated line art beside an editorial form.
 */
const jitter = (i: number) => { const v = Math.sin(i + 1) * 10_000; return v - Math.floor(v) }

function FloatingPaths({ position }: { position: number }) {
  const reduce = useReducedMotion()
  const paths = Array.from({ length: 36 }, (_, i) => ({
    id: i, width: 0.5 + i * 0.03,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position} -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${152 - i * 5 * position} ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${684 - i * 5 * position} ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
  }))
  return (
    <div className="pointer-events-none absolute inset-0">
      <svg className="h-full w-full" style={{ color: '#0d5a48' }} fill="none" viewBox="0 0 696 316">
        {paths.map(p => (
          <motion.path key={p.id} d={p.d} stroke="currentColor" strokeOpacity={0.08 + p.id * 0.025} strokeWidth={p.width}
            initial={{ pathLength: 0.3 }} animate={reduce ? undefined : { pathLength: 1, pathOffset: [0, 1, 0] }}
            transition={{ duration: 20 + jitter(p.id) * 10, repeat: Infinity, ease: 'linear' }} />
        ))}
      </svg>
    </div>
  )
}

export function Login() {
  const { reload } = useMeta()
  const nav = useNavigate()
  const reduce = useReducedMotion()
  const [email, setEmail] = useState(() => localStorage.getItem('swk.remember') || '')
  const [pw, setPw] = useState('')
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const [remember, setRemember] = useState(() => !!localStorage.getItem('swk.remember'))
  const [show, setShow] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [caps, setCaps] = useState(false)
  const [demo, setDemo] = useState<{ enabled: boolean; email: string; password: string } | null>(null)

  useEffect(() => { void get<any>('/api/demo/status').then(setDemo).catch(() => {}) }, [])

  const signIn = async (em: string, pass: string) => {
    setErr(''); setBusy(true)
    try {
      const r = await post<any>('/api/auth/login', { email: em, password: pass, totp: needTotp ? totp : undefined })
      if (r.needsTotp) { setNeedTotp(true); return }
      if (remember && em === email) localStorage.setItem('swk.remember', em)
      else if (!remember) localStorage.removeItem('swk.remember')
      setDone(true)
      await new Promise(res => setTimeout(res, reduce ? 0 : 550))
      await reload()
      nav('/home', { replace: true })
    } catch (e: any) {
      setErr(e.message || 'Sign-in failed. Check your details and try again.')
    } finally { setBusy(false) }
  }
  const submit = (e: React.FormEvent) => { e.preventDefault(); void signIn(email, pw) }
  const rise = (i: number) => reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] as const } }

  return (
    <div className="swk-login2">
      <aside className="swk-login2-aside">
        <div className="swk-login2-fade" aria-hidden />
        <FloatingPaths position={1} />
        <FloatingPaths position={-1} />
        <motion.img {...rise(0)} src="/brand/os/logo-stacked.png" alt="SWK Properties OS" className="swk-login2-logo" />
        <motion.figure {...rise(4)} className="swk-login2-quote">
          <blockquote>Every enquiry, listing and deal in one place, <em>from first call to handover</em>.</blockquote>
          <figcaption>SWK Properties LLC <span aria-hidden>|</span> Dubai</figcaption>
        </motion.figure>
      </aside>

      <main className="swk-login2-main">
        <div className="swk-login2-glow" aria-hidden />
        <div className="swk-login2-panel">
          <motion.img {...rise(0)} src="/brand/os/logo-stacked.png" alt="SWK Properties OS" className="swk-login2-logo-sm" />
          <motion.h1 {...rise(1)}>Welcome back.</motion.h1>
          <motion.p {...rise(2)} className="swk-login2-sub">Sign in to your SWK Properties OS workspace.</motion.p>

          <AnimatePresence>
            {err && <motion.div role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><div className="swk-login2-err">{err}</div></motion.div>}
          </AnimatePresence>

          <form onSubmit={submit} className="swk-login2-form" aria-label="Sign in">
            <motion.div {...rise(3)}>
              <label htmlFor="email">Email address</label>
              <div className="swk-login2-field"><Mail size={17} /><input id="email" type="email" autoComplete="username" required autoFocus={!email} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@swk.properties" /></div>
            </motion.div>
            <motion.div {...rise(4)}>
              <div className="flex items-center justify-between"><label htmlFor="pw">Password</label><a href="/accept-invite" className="swk-login2-link">Forgot password?</a></div>
              <div className="swk-login2-field">
                <Lock size={17} />
                <input id="pw" type={show ? 'text' : 'password'} autoComplete="current-password" required autoFocus={!!email} value={pw} onChange={e => setPw(e.target.value)} onKeyUp={e => setCaps(e.getModifierState?.('CapsLock'))} placeholder="••••••••••" />
                <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </div>
              {caps && <div className="swk-login2-hint">Caps Lock is on</div>}
            </motion.div>

            <AnimatePresence>
              {needTotp && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <label htmlFor="totp">Authenticator code</label>
                  <div className="swk-login2-field"><KeyRound size={17} /><input id="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, ''))} placeholder="6-digit code" style={{ letterSpacing: '.4em' }} /></div>
                  <p className="swk-login2-hint">Open your authenticator app and enter the code for SWK OS.</p>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.label {...rise(5)} className="swk-login2-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Keep me signed in on this device</motion.label>

            <motion.div {...rise(6)}>
              <button type="submit" className="swk-login2-btn" disabled={busy || done}>
                {done ? <><Check size={18} />Welcome</> : busy ? <><Loader2 size={17} className="animate-spin" />Signing in…</> : <>{needTotp ? 'Verify and sign in' : 'Sign in'}<ArrowRight size={17} /></>}
              </button>
            </motion.div>

            {demo?.enabled && <button type="button" className="swk-login2-btn ghost" disabled={busy} onClick={() => void signIn(demo.email, demo.password)}>Explore the demo workspace</button>}
          </form>

          <p className="swk-login2-foot"><ShieldCheck size={14} />Encrypted session · activity is audited · © {new Date().getFullYear()} SWK Properties LLC</p>
        </div>
      </main>
    </div>
  )
}
