import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { get, post } from '../lib/api'
import { ErrorBox, Loading } from '../ui/kit'
import { useToast } from '../lib/toast'

/** Admin only: the office network is locked once; changing it means clearing it first, then locking again from the new office network. */
export function OfficeWifiLock() {
  const toast = useToast(), qc = useQueryClient(), [busy, setBusy] = useState(false)
  const q = useQuery({ queryKey: ['office-wifi'], queryFn: () => get<any>('/api/swk-ops/attendance-setup') })
  if (q.error) return <ErrorBox error={q.error} />
  if (!q.data) return <Loading />
  const c = q.data, locked = !!c.office_ip_locked
  const act = async (body: any, done: string) => {
    setBusy(true)
    try { await post('/api/swk-ops/attendance-setup', body); toast.ok(done); await qc.invalidateQueries({ queryKey: ['office-wifi'] }) } catch (e: any) { toast.error(e?.message || 'Could not save') } finally { setBusy(false) }
  }
  return (
    <div className="md:col-span-2 space-y-3 text-sm">
      <div>Status: <b>{locked ? 'Locked' : 'Not locked: nobody can check in yet'}</b></div>
      {locked && <div>Locked network: <code>{c.public_ips}</code></div>}
      <div className="text-muted">You are on: <code>{c.detected_client_ip}</code>{locked ? (c.ip_matches_office ? ' (the locked office network)' : ' (not the locked office network)') : ''}</div>
      <div className="flex gap-2 flex-wrap">
        {!locked && <button type="button" className="btn green" disabled={busy} onClick={() => void act({ lock_current_ip: true }, 'Office network locked')}>Lock this network as the office</button>}
        {locked && <button type="button" className="btn outline" disabled={busy} onClick={() => { if (window.confirm('Clear the office network? Check-in stops for everyone until you lock the new one.')) void act({ clear_ips: true }, 'Office network cleared') }}>Clear to change the network</button>}
      </div>
      <p className="text-xs text-muted m-0">Lock it once, from a device on the office Wi-Fi. Only the Admin can lock, clear or change it. To move offices, clear it here, then open Settings from the new office and lock again.</p>
    </div>
  )
}
