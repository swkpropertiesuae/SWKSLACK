import { useCallback,useEffect,useRef,useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence,motion } from 'motion/react'
import { Bell,CheckCircle2,AlertTriangle,ShieldAlert,X } from 'lucide-react'
import { get } from '../lib/api'

type N = { id: number; kind: string; title: string; body?: string; link?: string; created_at: string }
const ICON: Record<string, typeof Bell> = { approval: ShieldAlert, audit: ShieldAlert, warn: AlertTriangle, success: CheckCircle2, info: Bell }

/**
 * Pop-up notifications that appear the moment something happens, with no refresh. A server-sent stream delivers them instantly;
 * a 15-second check runs as well in case a network or proxy blocks the stream, and each notification shows once.
 */
export function LiveNotifications() {
  const [items, setItems] = useState<N[]>([])
  const seen = useRef<number>(-1)
  const nav = useNavigate(), qc = useQueryClient()

  const handle = useCallback((n: N, silent = false) => {
    if (n.id <= seen.current) return
    seen.current = n.id
    void qc.invalidateQueries({ queryKey: ['notifications'] })
    void qc.invalidateQueries({ queryKey: ['pulse'] })
    if (silent) return
    setItems(a => [n, ...a].slice(0, 4))
    window.setTimeout(() => setItems(a => a.filter(x => x.id !== n.id)), 8000)
  }, [qc])

  useEffect(() => {
    let es: EventSource | null = null, stopped = false
    // remember where we are so only new notifications pop up
    void get<{ rows: N[] }>('/api/notifications').then(r => { const top = Math.max(0, ...r.rows.map(x => x.id)); if (seen.current < top) seen.current = top }).catch(() => {})
    if (typeof EventSource !== 'undefined') {
      es = new EventSource('/api/notifications/stream')
      es.addEventListener('notification', e => { try { handle(JSON.parse((e as MessageEvent).data)) } catch { /* ignore */ } })
    }
    const poll = window.setInterval(() => {
      if (stopped || document.hidden) return
      void get<{ rows: N[] }>('/api/notifications').then(r => [...r.rows].sort((a, b) => a.id - b.id).forEach(n => handle(n))).catch(() => {})
    }, 15000)
    return () => { stopped = true; es?.close(); clearInterval(poll) }
  }, [handle])

  const open = (n: N) => { setItems(a => a.filter(x => x.id !== n.id)); if (n.link) nav(n.link) }
  return (
    <div className="swk-live-stack no-print" aria-live="polite" aria-label="New notifications">
      <AnimatePresence initial={false}>
        {items.map(n => { const I = ICON[n.kind] ?? Bell; return (
          <motion.div key={n.id} layout initial={{ opacity: 0, x: 48, scale: .96 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 48, scale: .96 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }} className="swk-live-card" role="status">
            <button type="button" className="swk-live-body" onClick={() => open(n)}>
              <span className="swk-live-ic"><I size={18} /></span>
              <span className="swk-live-tx"><b>{n.title}</b>{n.body ? <small>{n.body}</small> : null}<em>{n.link ? 'Tap to open' : 'Just now'}</em></span>
            </button>
            <button type="button" className="swk-live-x" aria-label="Dismiss" onClick={() => setItems(a => a.filter(x => x.id !== n.id))}><X size={14} /></button>
          </motion.div>) })}
      </AnimatePresence>
    </div>
  )
}
