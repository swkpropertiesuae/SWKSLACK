import { useCallback,useEffect,useState } from 'react'
import QRCode from 'qrcode'
import { QrCode } from 'lucide-react'
import { get,post } from '../lib/api'
import { PageHeader,ErrorBox } from '../ui/kit'
import { qrLink } from '@shared/qr-payload'

type Tok = { token: string; expires_in: number; mode: 'fixed' | 'rotating' }

/** Code for the reception monitor or a printout. Fixed mode shows one code that stays the same every day; rotating mode shows a new encrypted code every 30 seconds. */
export function ReceptionDisplayPage() {
  const [img, setImg] = useState(''), [mode, setMode] = useState<Tok['mode']>('fixed'), [left, setLeft] = useState(0), [err, setErr] = useState<Error | null>(null), [busy, setBusy] = useState(false)
  const show = useCallback(async (t: Tok) => {
    const data = await QRCode.toDataURL(qrLink(window.location.origin, t.token), { width: 520, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
    setImg(data); setMode(t.mode); setLeft(t.expires_in); setErr(null)
  }, [])
  useEffect(() => {
    let stop = false, timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const t = await get<Tok>('/api/swk-ops/reception-token')
        if (stop) return
        await show(t)
        timer = setTimeout(() => void load(), Math.max(3, t.expires_in - 3) * 1000)
      } catch (e: any) { if (!stop) { setErr(e); timer = setTimeout(() => void load(), 10_000) } }
    }
    void load()
    const tick = setInterval(() => setLeft(l => Math.max(0, l - 1)), 1000)
    return () => { stop = true; clearTimeout(timer); clearInterval(tick) }
  }, [show])
  const act = async (path: string, body?: unknown, ask?: string) => {
    if (ask && !window.confirm(ask)) return
    setBusy(true)
    try { await show(await post<Tok>(path, body)) } catch (e: any) { setErr(e) } finally { setBusy(false) }
  }
  return <div className="space-y-4">
    <PageHeader icon={<QrCode size={22} />} title="Reception check-in code" subtitle={mode === 'fixed' ? 'This code is the same every day. Print it and stick it at reception. Staff scan it with their phone camera and sign in.' : 'Leave this open on the reception monitor. Staff open SWK OS check-in on their phone and scan it with the camera.'} />
    {err && <ErrorBox error={err} />}
    <div className="swk-card p-6 grid place-items-center gap-3">
      {img ? <img src={img} alt="Check-in QR code" style={{ width: 'min(70vh, 520px)', maxWidth: '100%', borderRadius: 16, background: '#fff' }} /> : <p className="text-muted">Loading code…</p>}
      {mode === 'rotating' && <p className="text-sm text-muted">New code in {left}s · each code works for about 90 seconds</p>}
      <div className="flex flex-wrap gap-2 print:hidden">
        <button className="btn" onClick={() => window.print()}>Print this code</button>
        {mode === 'fixed' && <button className="btn" disabled={busy} onClick={() => void act('/api/swk-ops/reception-token/regenerate', undefined, 'Make a NEW fixed code? Every printed copy of the old code stops working and you must print the new one.')}>Make a new code (if a photo leaked)</button>}
        <button className="btn" disabled={busy} onClick={() => void act('/api/swk-ops/reception-token/mode', { mode: mode === 'fixed' ? 'rotating' : 'fixed' }, mode === 'fixed' ? 'Switch to the code that changes every 30 seconds? Printed codes stop working.' : 'Switch to the fixed code that never changes? A new fixed code is used.')}>{mode === 'fixed' ? 'Switch to rotating code' : 'Switch to fixed code'}</button>
      </div>
    </div>
  </div>
}
