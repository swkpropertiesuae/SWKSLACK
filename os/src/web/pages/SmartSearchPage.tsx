import { useState } from 'react'
import { Search,FileText } from 'lucide-react'
import { get } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader,ErrorBox } from '../ui/kit'

type Hit = { id: number; unit_no: string; title: string; bedrooms: number | null; area_sqft: number | null; price_aed: number; sub_community?: string }

export function SmartSearchPage() {
  const toast = useToast()
  const [text, setText] = useState(''), [hits, setHits] = useState<Hit[] | null>(null), [picked, setPicked] = useState<number[]>([]), [client, setClient] = useState(''), [err, setErr] = useState<Error | null>(null)
  const run = async () => { setErr(null); try { setHits((await get<{ results: Hit[] }>('/api/growth/ask?q=' + encodeURIComponent(text))).results); setPicked([]) } catch (e: any) { setErr(e) } }
  const present = () => { if (!picked.length) return toast.error('Tick at least one unit'); window.open(`/api/growth/presentation?units=${picked.join(',')}&client=${encodeURIComponent(client)}`, '_blank') }
  return <div className="space-y-4">
    <PageHeader icon={<Search size={22} />} title="Smart search" subtitle='Try "2 bed marina under 2.5m" or "studio for rent jvc under 60k". Tick units to make a printable buyer shortlist.' />
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void run() }}><input className="input flex-1" value={text} onChange={e => setText(e.target.value)} placeholder="Describe what the client wants" maxLength={200} /><button className="btn orange" type="submit"><Search />Search</button></form>
    {err && <ErrorBox error={err} />}
    {hits && <div className="swk-card p-4">
      {!hits.length ? <p className="text-muted">No available units match.</p> : <>
        <div className="flex gap-2 mb-3"><input className="input" style={{ maxWidth: 260 }} placeholder="Client name (optional)" value={client} onChange={e => setClient(e.target.value)} /><button className="btn green" onClick={present}><FileText />Buyer shortlist</button></div>
        <table className="w-full text-sm"><thead><tr><th></th><th>Property</th><th>Unit</th><th>Beds</th><th>Size</th><th>Price (AED)</th></tr></thead><tbody>{hits.map(h => <tr key={h.id}><td><input type="checkbox" checked={picked.includes(h.id)} onChange={e => setPicked(p => e.target.checked ? [...p, h.id] : p.filter(x => x !== h.id))} /></td><td>{h.title}</td><td>{h.unit_no}</td><td>{h.bedrooms ?? ''}</td><td>{h.area_sqft ?? ''}</td><td>{h.price_aed ? Math.round(h.price_aed).toLocaleString() : ''}</td></tr>)}</tbody></table></>}
    </div>}
  </div>
}
