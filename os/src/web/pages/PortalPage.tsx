import { useState } from 'react'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Wrench } from 'lucide-react'
import { get,post } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader,Loading,ErrorBox,Empty } from '../ui/kit'

const CATS = ['Plumbing', 'Electrical', 'HVAC', 'Appliances', 'Carpentry', 'Painting', 'Cleaning', 'Pest Control', 'Structural', 'Security', 'Common Area', 'Other']

// One page for tenants (request and rate), landlords (approve quotes) and vendors (update work orders). The server limits each to their own records.
export function PortalPage() {
  const toast = useToast(), client = useQueryClient()
  const me = useQuery({ queryKey: ['portal-me'], queryFn: () => get<any>('/api/auth/me') })
  const list = useQuery({ queryKey: ['portal-wo'], queryFn: () => get<{ rows: any[] }>('/api/e/maintenance?pageSize=100'), refetchInterval: 15000 })
  const leases = useQuery({ queryKey: ['portal-leases'], queryFn: () => get<{ rows: any[] }>('/api/e/leases?pageSize=50') })
  const [form, setForm] = useState({ lease_id: 0, category: 'Plumbing', description: '' }), [quote, setQuote] = useState<Record<number, string>>({})
  const pid = me.data?.party_id
  const run = async (fn: () => Promise<unknown>, okMsg: string) => { try { await fn(); toast.ok(okMsg); void client.invalidateQueries({ queryKey: ['portal-wo'] }) } catch (e: any) { toast.error(e.message) } }
  if (list.error) return <ErrorBox error={list.error} />
  if (!list.data) return <Loading />
  return <div className="space-y-4">
    <PageHeader icon={<Wrench size={22} />} title="Service requests" subtitle="Report a problem, approve a quote or update a work order." />
    {!!leases.data?.rows.length && <form className="swk-card p-4 grid gap-2 md:grid-cols-4" onSubmit={e => { e.preventDefault(); void run(() => post('/api/portal/maintenance', { ...form, lease_id: form.lease_id || leases.data!.rows[0].id }), 'Request sent').then(() => setForm(f => ({ ...f, description: '' }))) }}>
      <select className="select" value={form.lease_id || leases.data.rows[0].id} onChange={e => setForm({ ...form, lease_id: Number(e.target.value) })}>{leases.data.rows.map(l => <option key={l.id} value={l.id}>{l._title ?? l.lease_no ?? l.id}</option>)}</select>
      <select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{CATS.map(c => <option key={c}>{c}</option>)}</select>
      <input className="input md:col-span-2" required minLength={5} placeholder="What is the problem?" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
      <button className="btn orange md:col-span-4" type="submit">Send request</button>
    </form>}
    {!list.data.rows.length ? <Empty title="No requests yet" hint="Requests you send or are assigned appear here." /> : list.data.rows.map(m => <article key={m.id} className="swk-card p-4 space-y-2">
      <div className="flex gap-2 items-center"><b className="text-ink">{m.request_no}</b><span className="text-muted text-sm">{m.category} · {m.unit_title}</span><span className="ml-auto text-sm font-semibold">{m.status}</span></div>
      <p className="text-sm">{m.description}</p>
      {m.landlord_approval && m.landlord_approval !== 'Not needed' && <p className="text-xs text-muted">Quote approval: {m.landlord_approval}{m.estimated_cost ? ` · AED ${Math.round(m.estimated_cost).toLocaleString()}` : ''}</p>}
      <div className="flex gap-2 flex-wrap">
        {m.landlord_id === pid && m.landlord_approval === 'Awaiting' && <><button className="btn green sm" onClick={() => void run(() => post(`/api/portal/maintenance/${m.id}/landlord-decision`, { approve: true }), 'Approved')}>Approve quote</button><button className="btn outline sm" onClick={() => void run(() => post(`/api/portal/maintenance/${m.id}/landlord-decision`, { approve: false }), 'Declined')}>Decline</button></>}
        {m.vendor_id === pid && !['Completed', 'Cancelled'].includes(m.status) && <><input className="input" style={{ width: 130 }} placeholder="Quote AED" inputMode="decimal" value={quote[m.id] ?? ''} onChange={e => setQuote({ ...quote, [m.id]: e.target.value })} /><button className="btn outline sm" onClick={() => void run(() => post(`/api/portal/maintenance/${m.id}/vendor-update`, { quote: Number(quote[m.id]) }), 'Quote sent')} disabled={!Number(quote[m.id])}>Send quote</button><button className="btn outline sm" onClick={() => void run(() => post(`/api/portal/maintenance/${m.id}/vendor-update`, { status: 'In Progress' }), 'Updated')}>Start</button><button className="btn green sm" onClick={() => void run(() => post(`/api/portal/maintenance/${m.id}/vendor-update`, { status: 'Completed' }), 'Completed')}>Complete</button></>}
        {m.tenant_id === pid && m.status === 'Completed' && !m.tenant_feedback && <button className="btn outline sm" onClick={() => { const f = window.prompt('How did it go?'); if (f) void run(() => post(`/api/portal/maintenance/${m.id}/feedback`, { feedback: f }), 'Thanks for the feedback') }}>Leave feedback</button>}
      </div>
    </article>)}
  </div>
}
