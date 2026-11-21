import crypto from 'node:crypto'
import { q } from '../db'
import { HttpError,nowIso } from '../util'
import { getSetting,setSettings } from '../settings'
import { verifyPassword } from '../auth'

// ---------------------------------------------------------------- encrypted, rotating reception QR payload
const STEP_MS = 30_000
const VALID_STEPS = 3 // current 30 s window plus the two before it: about 90 s to scan and sign in
function secret(): string {
  let s = String(getSetting('qr_token_secret') || '')
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSettings({ qr_token_secret: s }) }
  return s
}
const key = () => crypto.createHash('sha256').update('swk-qr-v1:' + secret()).digest()
const b64u = (b: Buffer) => b.toString('base64url')
/** Fixed mode (default): one code that never changes until the Owner regenerates it, so it can be printed and stuck on the wall. Rotating mode: an encrypted code that changes every 30 s. */
const qrMode = () => (String(getSetting('qr_mode') || 'fixed') === 'rotating' ? 'rotating' : 'fixed')
const fixedToken = () => 'SWK2.' + crypto.createHmac('sha256', key()).update('fixed:' + (Number(getSetting('qr_fixed_version')) || 1)).digest('base64url')
/** Makes every printed fixed code useless and returns the new one (use it if a photo of the code leaks). */
export function regenerateFixedQr() { setSettings({ qr_fixed_version: (Number(getSetting('qr_fixed_version')) || 1) + 1 }); return fixedToken() }
export function setQrMode(mode: string) { setSettings({ qr_mode: mode === 'rotating' ? 'rotating' : 'fixed' }) }
/** The rotating code is AES-256-GCM encrypted, so it looks like random text and cannot be read, edited or made up. It is not a link: only the in-app camera can use it. */
export function currentQrToken(now = Date.now()) {
  if (qrMode() === 'fixed') return { token: fixedToken(), expires_in: 600, step_s: 600, mode: 'fixed' as const }
  const w = Math.floor(now / STEP_MS), iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(JSON.stringify({ w, n: crypto.randomBytes(6).toString('hex') })), c.final()])
  return { token: 'SWK1.' + b64u(Buffer.concat([iv, c.getAuthTag(), enc])), expires_in: Math.ceil(((w + 1) * STEP_MS - now) / 1000), step_s: STEP_MS / 1000, mode: 'rotating' as const }
}
export function qrTokenValid(token: unknown, now = Date.now()): boolean {
  const t = String(token ?? '')
  if (qrMode() === 'fixed') {
    const want = Buffer.from(fixedToken()), got = Buffer.from(t)
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }
  const m = /^SWK1\.([A-Za-z0-9_-]{40,200})$/.exec(t)
  if (!m) return false
  try {
    const raw = Buffer.from(m[1], 'base64url')
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28))
    const w = Number(JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()).w), cur = Math.floor(now / STEP_MS)
    return Number.isInteger(w) && cur - w >= 0 && cur - w < VALID_STEPS
  } catch { return false }
}

// ---------------------------------------------------------------- device key: a signature proves this is the same phone, and the key cannot be copied out of it
const challenges = new Map<string, { ip: string; exp: number }>()
export function newChallenge(ip: string) {
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k)
  if (challenges.size > 5000) challenges.clear()
  const c = crypto.randomBytes(24).toString('base64url')
  challenges.set(c, { ip, exp: Date.now() + 120_000 })
  return c
}
/** Consumes the challenge (single use) and returns the device id, or throws. The device id is the hash of the public key, so it cannot be typed in or copied by hand. */
export function verifyDeviceProof(p: { challenge: string; payload: string; pub: any; sig: string }, ip: string): string {
  const c = challenges.get(String(p.challenge))
  challenges.delete(String(p.challenge))
  if (!c || c.exp < Date.now() || c.ip !== ip) throw new HttpError(400, 'The check-in expired. Scan the reception code again.')
  const jwk = p.pub
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new HttpError(400, 'This device cannot prove its identity. Use the SWK OS page on your own phone with a current browser.')
  let ok = false
  try {
    const pk = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' })
    ok = crypto.verify('sha256', Buffer.from(`${p.challenge}.${p.payload}`), { key: pk, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(p.sig), 'base64url'))
  } catch { ok = false }
  if (!ok) throw new HttpError(400, 'Device check failed. Scan the reception code again.')
  return crypto.createHash('sha256').update(`${jwk.x}.${jwk.y}`).digest('hex').slice(0, 40)
}

// ---------------------------------------------------------------- check-in sign-in that cannot lock another person out
const fails = new Map<string, { n: number; t: number }>()
const WINDOW_MS = 15 * 60_000, MAX_PER_IP = 8
/** Wrong passwords on this public endpoint count against the caller's IP, not the person's account. */
export function checkPasswordForCheckin(email: string, password: string, ip: string) {
  const f = fails.get(ip)
  if (f && Date.now() - f.t < WINDOW_MS && f.n >= MAX_PER_IP) throw new HttpError(429, 'Too many wrong attempts from this connection. Try again in 15 minutes.')
  const row = q.get(`SELECT id, password_hash, active, must_change_password, locked_until FROM users WHERE lower(email) = ? AND party_id IS NULL AND deleted_at IS NULL`, email.trim().toLowerCase())
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
    const cur = f && Date.now() - f.t < WINDOW_MS ? f : { n: 0, t: Date.now() }
    fails.set(ip, { n: cur.n + 1, t: cur.t })
    throw new HttpError(401, 'Incorrect e-mail or password')
  }
  fails.delete(ip)
  if (row.must_change_password) throw new HttpError(403, 'Sign in to SWK OS once and choose your own password before you can check in.')
  return row.id as number
}

// ---------------------------------------------------------------- device binding
/** A person's phone or computer must be approved by the Owner or Manager before it can check in. Owner and Manager devices approve themselves. */
export function deviceGate(userId: number, deviceId: string, label: string, selfApprove: boolean): 'Approved' | 'Pending' {
  if (!deviceId) throw new HttpError(400, 'This device could not be identified. Reload the page and try again.')
  const owner = q.get(`SELECT user_id FROM staff_devices WHERE device_id = ? AND user_id <> ? LIMIT 1`, deviceId, userId)
  if (owner) throw new HttpError(403, 'This device is registered to another person. Each person must use their own phone.')
  const row = q.get(`SELECT id, status FROM staff_devices WHERE user_id = ? AND device_id = ?`, userId, deviceId)
  if (row) {
    q.run(`UPDATE staff_devices SET last_seen = ? WHERE id = ?`, nowIso(), row.id)
    if (row.status === 'Blocked') throw new HttpError(403, 'This device has been blocked by the Owner or Manager.')
    return row.status === 'Approved' ? 'Approved' : 'Pending'
  }
  const status = selfApprove ? 'Approved' : 'Pending'
  q.run(`INSERT INTO staff_devices (user_id, device_id, label, status, first_seen, last_seen) VALUES (?,?,?,?,?,?)`, userId, deviceId.slice(0, 80), label.slice(0, 80), status, nowIso(), nowIso())
  return status
}

// ---------------------------------------------------------------- GPS sanity
export function distanceM(a: [number, number], b: [number, number]) {
  const rad = (d: number) => d * Math.PI / 180, R = 6371000
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}
/** Reasons a location fix looks wrong: impossible speed since the last fix, or the exact same coordinates again and again. */
export function gpsFlags(userId: number, lat: number, lng: number): string[] {
  const flags: string[] = []
  const prev = q.get(`SELECT gps_lat, gps_lng, created_at FROM attendance_events WHERE user_id = ? AND gps_lat IS NOT NULL AND gps_lat <> '' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, userId)
  if (prev) {
    const hours = (Date.now() - new Date(String(prev.created_at).replace(' ', 'T') + (String(prev.created_at).endsWith('Z') ? '' : 'Z')).getTime()) / 3_600_000
    const km = distanceM([Number(prev.gps_lat), Number(prev.gps_lng)], [lat, lng]) / 1000
    if (hours > 0 && hours < 12 && km > 5 && km / hours > 200) flags.push(`Impossible travel: ${Math.round(km)} km in ${Math.round(hours * 60)} min`)
  }
  const same = q.val<number>(`SELECT COUNT(*) FROM attendance_events WHERE user_id = ? AND gps_lat = ? AND gps_lng = ? AND deleted_at IS NULL`, userId, String(lat), String(lng)) ?? 0
  if (same >= 2) flags.push('Identical coordinates repeated (possible fake GPS)')
  return flags
}
