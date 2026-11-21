import { useEffect,useRef,useState } from 'react'
import { useParams,Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck,Camera,Check } from 'lucide-react'
import { get,put,post } from '../lib/api'
import { enqueue } from '../lib/offlineQueue'
import { useToast } from '../lib/toast'
import { PageHeader,Loading,ErrorBox,Empty } from '../ui/kit'
import { cls } from '../lib/format'

type Item = { name: string; state: 'ok' | 'issue' | 'na' | ''; note: string; photos: string[] }

/** Shrinks a camera photo so a whole checklist stays small enough to save and queue offline. */
async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file), k = Math.min(1, 800 / Math.max(img.width, img.height))
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.6)
}

export function InspectList() {
  const toast = useToast()
  const list = useQuery({ queryKey: ['inspections'], queryFn: () => get<{ rows: any[] }>('/api/e/inspections?pageSize=50') })
  const tpl = useQuery({ queryKey: ['insp-tpl'], queryFn: () => get<{ rows: any[] }>('/api/e/inspection_templates?pageSize=50') })
  const units = useQuery({ queryKey: ['insp-units'], queryFn: () => get<{ rows: any[] }>('/api/e/units?pageSize=100') })
  const [t, setT] = useState(0), [u, setU] = useState(0)
  if (list.error) return <ErrorBox error={list.error} />
  if (!list.data) return <Loading />
  const make = async () => {
    const tm = tpl.data?.rows.find(x => x.id === (t || tpl.data!.rows[0]?.id)); const unit = u || units.data?.rows[0]?.id
    if (!tm || !unit) return toast.error('Add a template and a unit first')
    try { const r = await post<any>('/api/e/inspections', { unit_id: unit, template_id: tm.id, inspection_type: tm.kind === 'Snagging' ? 'Snagging' : tm.kind === 'Move-out' ? 'Move-Out' : tm.kind === 'Periodic' ? 'Periodic' : 'Move-In', scheduled_at: new Date().toISOString().slice(0, 16), status: 'In Progress' }); location.hash = ''; location.assign('/inspect/' + r.id) } catch (e: any) { toast.error(e.message) }
  }
  return <div className="space-y-4">
    <PageHeader icon={<ClipboardCheck size={22} />} title="Inspections" subtitle="Tick each item, add photos and a signature. Works offline and saves when you are back online." />
    <div className="swk-card p-4 flex gap-2 flex-wrap"><select className="select" value={t} onChange={e => setT(Number(e.target.value))}>{tpl.data?.rows.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select><select className="select" value={u} onChange={e => setU(Number(e.target.value))}>{units.data?.rows.map(x => <option key={x.id} value={x.id}>{x.unit_no} · {x.property_title}</option>)}</select><button className="btn orange" onClick={() => void make()}>Start inspection</button></div>
    {!list.data.rows.length ? <Empty title="No inspections yet" hint="Start one from a template." /> : list.data.rows.map(r => <Link key={r.id} to={`/inspect/${r.id}`} className="swk-card p-4 flex gap-3 items-center"><b>{r.inspection_no}</b><span className="text-muted text-sm">{r.unit_title} · {r.inspection_type}</span><span className="ml-auto text-sm font-semibold">{r.status}</span></Link>)}
  </div>
}

export function InspectPage() {
  const { id } = useParams(), toast = useToast()
  const rec = useQuery({ queryKey: ['inspection', id], queryFn: () => get<any>(`/api/e/inspections/${id}`) })
  const [items, setItems] = useState<Item[] | null>(null), [name, setName] = useState(''), [busy, setBusy] = useState(false)
  const pad = useRef<HTMLCanvasElement>(null), drawing = useRef(false), inked = useRef(false)
  useEffect(() => {
    if (!rec.data || items) return
    const saved = rec.data.results ? JSON.parse(rec.data.results) as Item[] : null
    if (saved) return setItems(saved)
    if (!rec.data.template_id) return setItems([])
    void get<any>(`/api/e/inspection_templates/${rec.data.template_id}`).then(t => setItems(String(t.items ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(n => ({ name: n, state: '' as const, note: '', photos: [] }))))
  }, [rec.data, items])
  if (rec.error) return <ErrorBox error={rec.error} />
  if (!rec.data || !items) return <Loading />
  const set = (i: number, patch: Partial<Item>) => setItems(a => a!.map((x, j) => j === i ? { ...x, ...patch } : x))
  const pt = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = pad.current!.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.current!.width / r.width), (e.clientY - r.top) * (pad.current!.height / r.height)] }
  const save = async (done: boolean) => {
    if (done && items.some(x => !x.state)) return toast.error('Mark every item OK, Issue or N/A')
    if (done && (!name.trim() || !inked.current)) return toast.error('Type a name and sign in the box')
    setBusy(true)
    const issues = items.filter(x => x.state === 'issue')
    const payload: Record<string, any> = { results: JSON.stringify(items), status: done ? (issues.length ? 'Requires Action' : 'Completed') : 'In Progress', findings: issues.map(x => `${x.name}: ${x.note}`).join('\n') || undefined, version: rec.data.version }
    if (done) { payload.signature = pad.current!.toDataURL('image/png'); payload.signed_name = name.trim(); payload.completed_date = new Date().toISOString().slice(0, 10) }
    try {
      if (!navigator.onLine) { enqueue({ op: 'update', entity: 'inspections', id: Number(id), payload }); toast.ok('Saved on this phone. It will sync when you are online.') }
      else { await put(`/api/e/inspections/${id}`, payload); toast.ok(done ? 'Inspection completed' : 'Saved'); void rec.refetch() }
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  const done = rec.data.status === 'Completed' || rec.data.status === 'Requires Action'
  return <div className="space-y-4 max-w-3xl">
    <PageHeader icon={<ClipboardCheck size={22} />} title={`${rec.data.inspection_no} · ${rec.data.unit_title ?? ''}`} subtitle={`${rec.data.inspection_type} inspection · ${rec.data.status}`} />
    {!items.length && <Empty title="No checklist" hint="Pick a template when starting the inspection." />}
    {items.map((it, i) => <div key={i} className="swk-card p-4 space-y-2">
      <b className="text-ink">{it.name}</b>
      <div className="flex gap-2">{(['ok', 'issue', 'na'] as const).map(s => <button key={s} disabled={done} onClick={() => set(i, { state: s })} className={cls('btn sm', it.state === s ? (s === 'issue' ? 'red' : 'green') : 'outline')}>{s === 'ok' ? 'OK' : s === 'issue' ? 'Issue' : 'N/A'}</button>)}<label className="btn outline sm cursor-pointer"><Camera size={14} />Photo<input hidden type="file" accept="image/*" capture="environment" disabled={done} onChange={async e => { const f = e.target.files?.[0]; if (f) set(i, { photos: [...it.photos, await shrink(f)].slice(0, 4) }) }} /></label></div>
      <input className="input" placeholder="Note" value={it.note} disabled={done} onChange={e => set(i, { note: e.target.value })} />
      {!!it.photos.length && <div className="flex gap-2 flex-wrap">{it.photos.map((p, k) => <img key={k} src={p} alt="" className="h-20 rounded-lg border border-line" />)}</div>}
    </div>)}
    {!!items.length && (done ? <div className="swk-card p-4"><Check size={16} className="inline" /> Signed by {rec.data.signed_name} {rec.data.signed_at ? `· ${rec.data.signed_at}` : ''}</div> : <div className="swk-card p-4 space-y-2">
      <input className="input" placeholder="Tenant / inspector name" value={name} onChange={e => setName(e.target.value)} />
      <canvas ref={pad} width={600} height={160} className="w-full border border-line rounded-xl bg-white touch-none" onPointerDown={e => { drawing.current = true; const c = pad.current!.getContext('2d')!; const [x, y] = pt(e); c.beginPath(); c.moveTo(x, y) }} onPointerMove={e => { if (!drawing.current) return; const c = pad.current!.getContext('2d')!; c.lineWidth = 2; c.lineCap = 'round'; const [x, y] = pt(e); c.lineTo(x, y); c.stroke(); inked.current = true }} onPointerUp={() => { drawing.current = false }} onPointerLeave={() => { drawing.current = false }} />
      <div className="flex gap-2"><button className="btn outline" disabled={busy} onClick={() => void save(false)}>Save draft</button><button className="btn orange" disabled={busy} onClick={() => void save(true)}>Complete and sign</button><button className="btn ghost" onClick={() => { pad.current!.getContext('2d')!.clearRect(0, 0, 600, 160); inked.current = false }}>Clear signature</button></div>
    </div>)}
  </div>
}
