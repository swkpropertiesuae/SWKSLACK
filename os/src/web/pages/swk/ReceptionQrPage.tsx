import { useEffect,useRef,useState } from 'react'
import { canPrintReceptionQr } from '@shared/swk-staff-access'
import { qrCodeFrom } from '@shared/qr-payload'
import jsQR from 'jsqr'
import { CheckCircle2,Eye,EyeOff,Loader2,Lock,Mail,ScanLine,Wifi,WifiOff } from 'lucide-react'
import { get,post } from '../../lib/api'
import { useMeta } from '../../lib/meta'
import { signProof } from '../../lib/deviceKey'

type Net = { ssid: string; detected_client_ip: string; ip_matches_office: boolean; office_ip_locked?: boolean }
type Step = 'scan' | 'signin' | 'done'

/**
 * Office check-in terminal. Check-in works only on the office Wi-Fi, only by scanning the code on the reception screen with the live camera
 * in this page (there is no upload or gallery option); a phone's normal camera also works, because the QR is a link to this page, and only from this person's own registered phone.
 */
export default function ReceptionQrPage() {
  const { me } = useMeta()
  const [net, setNet] = useState<Net | null>(null)
  const [step, setStep] = useState<Step>('scan')
  const [payload, setPayload] = useState('')
  const [camErr, setCamErr] = useState('')
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [totp, setTotp] = useState(''), [needTotp, setNeedTotp] = useState(false), [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<any>(null)
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const canSetup = canPrintReceptionQr(me)

  // opened from the printed QR with a phone's normal camera: the code arrives in the link (#c=…), so go straight to sign-in
  useEffect(() => {
    const code = qrCodeFrom(window.location.hash)
    if (code) { setPayload(code); setStep('signin'); window.history.replaceState(null, '', window.location.pathname) }
  }, [])

  const loadNet = () => { void get<Net>('/api/public/reception-qr/wifi-config').then(setNet).catch(() => {}) }
  useEffect(loadNet, [])

  // live camera only: frames go straight from the video element to the decoder, nothing is saved or uploaded
  useEffect(() => {
    if (step !== 'scan') return
    let stream: MediaStream | null = null, raf = 0, stopped = false
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCamErr('This browser has no camera access. Open this page in Chrome or Safari over https.'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 } }, audio: false })
        if (stopped) return stream.getTracks().forEach(t => t.stop())
        const v = video.current!; v.srcObject = stream; v.setAttribute('playsinline', 'true'); await v.play()
        const c = canvas.current!, ctx = c.getContext('2d', { willReadFrequently: true })!
        const tick = () => {
          if (stopped) return
          if (v.readyState >= 2 && v.videoWidth) {
            const k = Math.min(1, 640 / v.videoWidth); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k)
            ctx.drawImage(v, 0, 0, c.width, c.height)
            const img = ctx.getImageData(0, 0, c.width, c.height), hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
            const code = hit ? qrCodeFrom(hit.data) : ''
            if (code) { setPayload(code); setStep('signin'); return }
          }
          raf = window.setTimeout(tick, 120)
        }
        tick()
      } catch { setCamErr('Allow the camera for this page. Check-in only works with the live camera.') }
    }
    void start()
    return () => { stopped = true; clearTimeout(raf); stream?.getTracks().forEach(t => t.stop()) }
  }, [step])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const { challenge } = await get<{ challenge: string }>('/api/public/reception-qr/challenge')
      const proof = await signProof(`${challenge}.${payload}`)
      const r = await post<any>('/api/public/reception-qr/scan-login-checkin', { email: email.trim(), password, totp: needTotp ? totp : undefined, qr_payload: payload, challenge, device_pub: proof.pub, device_sig: proof.sig, device_name: navigator.platform || 'Phone' })
      if (r.needsTotp) { setNeedTotp(true); return }
      setResult(r); setStep('done')
    } catch (err: any) {
      const msg = err?.message || 'Check-in failed.'
      setError(msg)
      if (/scan|expired|code|older/i.test(msg)) { setPayload(''); setStep('scan') }
    } finally { setBusy(false) }
  }

  const onOffice = Boolean(net?.office_ip_locked && net?.ip_matches_office)
  return (
    <div className="min-h-screen bg-[#0c2019] text-white flex items-center justify-center p-4">
      <div className="w-full max-w-[420px] rounded-3xl bg-[#112d23] border border-white/10 p-6 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-5">
          <img src="/brand/os/logo-horizontal.png" alt="SWK Properties OS" className="h-14 w-auto" />
          <h1 className="font-display font-bold text-xl m-0 mt-2" style={{ color: '#fff' }}>{step === 'done' ? 'Attendance confirmed' : 'Office check-in'}</h1>
        </div>

        <div className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl border text-[12.5px] mb-4 ${onOffice ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200' : 'bg-rose-500/10 border-rose-500/40 text-rose-200'}`}>
          {onOffice ? <Wifi size={16} /> : <WifiOff size={16} />}
          <div className="leading-snug">{!net ? 'Checking your network…' : !net.office_ip_locked ? 'Check-in is not set up yet. The Owner or Manager must lock the office network.' : onOffice ? <>Connected to the office network (<b>{net.ssid}</b>)</> : <>Not on the office Wi-Fi. Connect to <b>{net.ssid}</b> to check in. Mobile data is not accepted.</>}</div>
        </div>

        {error && <div role="alert" className="mb-4 px-3.5 py-2.5 rounded-2xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium">{error}</div>}

        {step === 'scan' && (
          <div className="space-y-3">
            <div className="relative rounded-2xl overflow-hidden bg-black aspect-square border border-white/10">
              <video ref={video} muted playsInline className="w-full h-full object-cover" />
              <canvas ref={canvas} className="hidden" />
              <div className="absolute inset-6 border-2 border-[#0d5a48]/80 rounded-2xl pointer-events-none" />
              <ScanLine className="absolute left-1/2 top-3 -translate-x-1/2 text-[#0d5a48]" size={20} />
            </div>
            <p className="text-xs text-[#dad2c9] m-0">{camErr || 'Point the camera at the code on the reception screen. It scans by itself. There is no photo or file option.'}</p>
          </div>
        )}

        {step === 'signin' && (
          <form onSubmit={e => void submit(e)} className="space-y-3.5">
            <p className="text-xs text-emerald-300 m-0">Code read. Sign in within 90 seconds.</p>
            <div>
              <label htmlFor="qr-email" className="block text-xs font-semibold text-[#dad2c9] mb-1.5">Email</label>
              <div className="relative flex items-center"><Mail size={16} className="absolute left-3.5 text-[#aca093]" />
                <input id="qr-email" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@swk.properties" className="w-full h-11 pl-10 pr-3 rounded-xl bg-white/[.06] border border-white/15 text-white text-sm outline-none focus:border-[#0d5a48]" /></div>
            </div>
            <div>
              <label htmlFor="qr-pw" className="block text-xs font-semibold text-[#dad2c9] mb-1.5">Password</label>
              <div className="relative flex items-center"><Lock size={16} className="absolute left-3.5 text-[#aca093]" />
                <input id="qr-pw" type={show ? 'text' : 'password'} required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="w-full h-11 pl-10 pr-10 rounded-xl bg-white/[.06] border border-white/15 text-white text-sm outline-none focus:border-[#0d5a48]" />
                <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-3 bg-transparent border-0 text-[#aca093] cursor-pointer">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
            </div>
            {needTotp && <input inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="Authenticator code" value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, ''))} className="w-full h-11 px-3 rounded-xl bg-white/[.06] border border-white/15 text-white text-sm outline-none" />}
            <button type="submit" disabled={busy || !onOffice} className="w-full h-12 rounded-xl border-0 bg-[#0d5a48] text-white font-bold cursor-pointer disabled:opacity-50 inline-flex items-center justify-center gap-2">{busy ? <><Loader2 size={16} className="animate-spin" />Checking…</> : 'Check in'}</button>
            <button type="button" onClick={() => { setPayload(''); setStep('scan') }} className="w-full bg-transparent border-0 text-xs text-[#dad2c9] underline cursor-pointer">Scan again</button>
          </form>
        )}

        {step === 'done' && result && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-emerald-300 font-semibold"><CheckCircle2 size={20} />{result.already_checked_in ? 'You were already checked in today.' : 'You are checked in.'}</div>
            <div className="rounded-2xl bg-white/[.05] border border-white/10 p-3.5 space-y-1.5 text-[13px]">
              <Row k="Name" v={result.employee?.name} />
              <Row k="Time" v={String(result.verification_summary?.timestamp_gst || '').slice(0, 16).replace('T', ' ')} />
              <Row k="Status" v={result.verification_summary?.is_late ? `Late (+${result.verification_summary.late_minutes} min)` : 'On time'} />
              <Row k="Network" v={`${result.verification_summary?.office_wifi_ssid} · ${result.verification_summary?.client_ip}`} />
            </div>
          </div>
        )}

        {canSetup && <SetupPanel onChange={loadNet} />}
      </div>
    </div>
  )
}

const Row = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between gap-3"><span className="text-[#aca093]">{k}</span><span className="font-semibold text-right">{v}</span></div>

function SetupPanel({ onChange }: { onChange: () => void }) {
  const [msg, setMsg] = useState(''), [control, setControl] = useState<{ devices: any[] } | null>(null)
  const load = () => { void get<any>('/api/swk-ops/attendance-control').then(setControl).catch(() => {}) }
  useEffect(load, [])
  const decide = async (id: number, approve: boolean) => { try { setControl(await post<any>(`/api/swk-ops/attendance-control/device/${id}`, { approve })) } catch (e: any) { setMsg(e?.message || 'Could not save.') } }
  return (
    <div className="mt-5 rounded-2xl border border-white/15 bg-white/[.04] p-3 text-xs text-[#dad2c9] space-y-2">
      <div className="font-semibold text-white">Attendance control (Owner / Manager)</div>
      <div>The office network is locked by the Admin in Settings, Attendance Wi-Fi.</div>
      {msg && <div>{msg}</div>}
      <a href="/reception-display" className="inline-block text-[#c4efd9] underline">Open the reception code screen</a>
      {!!control?.devices.length && (
        <div className="space-y-1">
          <div className="font-semibold text-white">Devices</div>
          {control.devices.map(d => (
            <div key={d.id} className="flex items-center gap-2"><span className="flex-1">{d.name} · {String(d.label || 'phone').slice(0, 24)} · <b>{d.status}</b></span>
              {d.status !== 'Approved' && <button type="button" className="px-2 py-1 rounded-lg bg-emerald-600 text-white border-0 cursor-pointer" onClick={() => void decide(d.id, true)}>Approve</button>}
              {d.status !== 'Blocked' && <button type="button" className="px-2 py-1 rounded-lg bg-white/10 text-white border border-white/20 cursor-pointer" onClick={() => void decide(d.id, false)}>Block</button>}</div>
          ))}
        </div>
      )}
    </div>
  )
}
