import { useEffect,useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion,useInView,useSpring } from 'motion/react'
import { ChevronRight,Activity,UserPlus,CalendarCheck,PhoneCall,FileText } from 'lucide-react'

// Layouts adapted from 21st.dev "Stats Card" (kavikatiyar) and "Activity Timeline" (olewandowski1), rebuilt on this app's styles.

type Point = { day: string; n: number }
const short = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')).slice(0, 2)

function Counter({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null), inView = useInView(ref, { once: true })
  const spring = useSpring(0, { damping: 30, stiffness: 110 })
  useEffect(() => { if (inView) spring.set(value) }, [inView, value, spring])
  useEffect(() => spring.on('change', v => { if (ref.current) ref.current.textContent = Math.round(v).toLocaleString('en-US') }), [spring])
  return <span ref={ref}>0</span>
}

/** A KPI card with a count-up number and seven animated bars; today's bar is highlighted. */
export function PulseCard({ title, icon: Icon, data, to, hint }: { title: string; icon: typeof Activity; data: Point[]; to: string; hint: string }) {
  const total = data.reduce((s, p) => s + p.n, 0), max = Math.max(1, ...data.map(p => p.n)), today = data[data.length - 1]?.n ?? 0
  const prev = data.slice(0, 6).reduce((s, p) => s + p.n, 0) / 6
  const up = today >= prev
  return (
    <motion.div className="swk-pulse" whileHover={{ y: -4 }} transition={{ type: 'spring', stiffness: 320, damping: 22 }}>
      <Link to={to} className="swk-pulse-head"><span className="swk-pulse-ic"><Icon size={16} /></span><span>{title}</span><ChevronRight size={15} className="swk-pulse-go" /></Link>
      <div className="swk-pulse-num"><Counter value={total} /><small>this week</small></div>
      <div className={`swk-pulse-trend ${up ? 'up' : 'down'}`}>{today} today · {hint}</div>
      <div className="swk-pulse-bars" role="img" aria-label={`${title}: ${data.map(p => `${short(p.day)} ${p.n}`).join(', ')}`}>
        {data.map((p, i) => (
          <div key={p.day} className="swk-pulse-col" title={`${p.day}: ${p.n}`}>
            <motion.div className={i === data.length - 1 ? 'swk-pulse-bar hot' : 'swk-pulse-bar'} initial={{ height: '6%' }} animate={{ height: `${Math.max(6, (p.n / max) * 100)}%` }} transition={{ type: 'spring', damping: 16, stiffness: 110, delay: i * 0.06 }} />
            <span>{short(p.day)}</span>
          </div>
        ))}
      </div>
    </motion.div>
  )
}

type Ev = { at: string; who: string; action: string; entity: string; label: string; link: string }
const verb = (a: string) => ({ create: 'created', update: 'updated', delete: 'deleted', post: 'posted', approve: 'approved' } as Record<string, string>)[a] ?? a
const iconFor = (e: string) => /lead/i.test(e) ? UserPlus : /view/i.test(e) ? CalendarCheck : /activit|call/i.test(e) ? PhoneCall : FileText
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso.includes('T') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z').getTime()) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]!.toUpperCase()).join('')

/** Recent changes grouped by day on a rail, each with the person's initials and an icon badge. New rows slide in as they arrive. */
export function ActivityTimeline({ events }: { events: Ev[] }) {
  const dayOf = (iso: string) => iso.slice(0, 10)
  const today = new Date().toISOString().slice(0, 10), yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const groups: { label: string; items: Ev[] }[] = []
  for (const e of events) { const d = dayOf(e.at), label = d === today ? 'Today' : d === yest ? 'Yesterday' : d; const g = groups.find(x => x.label === label); g ? g.items.push(e) : groups.push({ label, items: [e] }) }
  if (!events.length) return <p className="swk-tl-empty">Activity appears here as your team works.</p>
  return (
    <div className="swk-tl">
      {groups.map(g => (
        <div key={g.label}>
          <div className="swk-tl-day">{g.label}</div>
          <ol className="swk-tl-rail">
            {g.items.map((e, i) => { const I = iconFor(e.entity); return (
              <motion.li key={`${e.at}-${e.label}-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                <span className="swk-tl-av">{initials(e.who)}<i><I size={9} /></i></span>
                <Link to={e.link} className="swk-tl-tx"><b>{e.who}</b> {verb(e.action)} {e.entity.toLowerCase()} {e.label ? <b>{e.label}</b> : null}</Link>
                <time>{ago(e.at)}</time>
              </motion.li>) })}
          </ol>
        </div>
      ))}
    </div>
  )
}
