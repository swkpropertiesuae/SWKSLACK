/** Shape of a reception code: SWK2 is the fixed code, SWK1 the 30-second rotating one. The check-in page uses this to decide what its camera accepts, so it must match what the server issues. */
export const QR_PAYLOAD_RE = /^SWK[12]\.[A-Za-z0-9_-]{40,200}$/

/** What the reception QR contains: a link, so a phone's normal camera opens check-in straight at the sign-in step. The code sits after the # and is never sent to the server in the page request. */
export const qrLink = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/reception-qr#c=${token}`

/** The reception code inside scanned text or a page hash: accepts the link form (…#c=CODE, or just c=CODE) and a bare code; returns '' for anything else. */
export function qrCodeFrom(text: string): string {
  const raw = String(text ?? '').trim()
  const m = /(?:^|[#&])c=([A-Za-z0-9_.-]+)/.exec(raw.includes('#') ? raw.slice(raw.indexOf('#')) : raw)
  const code = m ? m[1] : raw
  return QR_PAYLOAD_RE.test(code) ? code : ''
}
