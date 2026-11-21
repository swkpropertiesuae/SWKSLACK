import { useEffect, useState, useCallback } from 'react'
import { api, get, post } from '../../lib/api'
import { useToast } from '../../lib/toast'
import { MyHandoverDocs } from './HandoverCustody'
import { Lock, PhoneCall, MessageCircle, MapPinned, Building2, RefreshCw, Save, ShieldCheck } from 'lucide-react'

const AED = (v: any) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return null
  return `AED ${Math.round(n).toLocaleString('en-AE')}`
}

const STATUSES = ['Assigned', 'In Progress', 'Viewing Scheduled', 'Offer / MOU', 'Closed Won', 'Closed Lost', 'On Hold']

export default function MyAssignedDealsPage() {
  const toast = useToast()
  const [tab, setTab] = useState<'deals' | 'routes'>('deals')
  const [rows, setRows] = useState<any[]>([])
  const [routes, setRoutes] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [notesDraft, setNotesDraft] = useState<Record<number, string>>({})
  const [statusDraft, setStatusDraft] = useState<Record<number, string>>({})
  const [waOpenId, setWaOpenId] = useState<number | null>(null)
  const [waText, setWaText] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)

  const loadDeals = useCallback(async () => {
    setLoading(true)
    try {
      const res = await get('/api/crm-vault/my-assignments', {
        q: q.trim() || undefined,
        status: statusFilter,
        pageSize: 100,
      })
      setRows(res.rows || [])
    } catch (e: any) {
      toast.error(e.message || 'Could not load your assigned deals')
    } finally {
      setLoading(false)
    }
  }, [q, statusFilter, toast])

  const loadRoutes = useCallback(async () => {
    try {
      const res = await get('/api/crm-vault/my-routes')
      setRoutes(res.rows || [])
    } catch (e: any) { toast.error(e.message) }
  }, [toast])

  useEffect(() => {
    if (tab === 'deals') loadDeals()
    else loadRoutes()
  }, [tab, loadDeals, loadRoutes])

  const triggerMaskedCall = async (id: number) => {
    setBusyId(id)
    try {
      const res = await post(`/api/crm-vault/my-assignments/${id}/masked-call`, {})
      toast.ok(res.message || 'Masked Bridge Call initiated — answer SWK Office call on your phone')
      loadDeals()
    } catch (e: any) {
      toast.error(e.message || 'Could not start masked call')
    } finally {
      setBusyId(null)
    }
  }

  const sendMaskedWa = async (id: number) => {
    if (!waText.trim()) return
    setBusyId(id)
    try {
      await post(`/api/crm-vault/my-assignments/${id}/masked-whatsapp`, { message: waText })
      toast.ok('Masked WhatsApp message relayed via SWK Properties official account')
      setWaOpenId(null)
      setWaText('')
      loadDeals()
    } catch (e: any) {
      toast.error(e.message || 'Could not send masked WhatsApp')
    } finally {
      setBusyId(null)
    }
  }

  const saveUpdate = async (row: any) => {
    setBusyId(row.id)
    try {
      await api('PATCH', `/api/crm-vault/my-assignments/${row.id}`, {
        vault_status: statusDraft[row.id] ?? row.vault_status,
        agent_notes: notesDraft[row.id] ?? row.agent_notes ?? '',
      })
      toast.ok('Deal progress updated')
      loadDeals()
    } catch (e: any) {
      toast.error(e.message || 'Update failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="p-5 max-w-6xl mx-auto space-y-5">
      <MyHandoverDocs />
      <div className="rounded-2xl bg-[#0e261d] text-white p-5 border border-[#c8a962]/30 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-[#d4b672]">
            <ShieldCheck className="w-4 h-4" /> SWK Agent Dispatch · Hard-Masked Privacy Mode
          </div>
          <h1 className="text-xl font-bold mt-1">My Assigned Property Deals</h1>
          <p className="text-xs text-emerald-100/80 mt-1">
            Only properties dispatched to you by Management appear here. Owner phone numbers are hard-masked — use <b>Call Owner (Masked Bridge)</b> or <b>Masked WhatsApp</b> to contact owners without exposing numbers in your phone history.
          </p>
        </div>
        <button onClick={() => tab === 'deals' ? loadDeals() : loadRoutes()} className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setTab('deals')} className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${tab === 'deals' ? 'bg-[#0e261d] text-white' : 'bg-slate-100 text-slate-700'}`}>
          <Building2 className="w-3.5 h-3.5" /> Assigned Deals ({rows.length})
        </button>
        <button onClick={() => setTab('routes')} className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${tab === 'routes' ? 'bg-[#0e261d] text-white' : 'bg-slate-100 text-slate-700'}`}>
          <MapPinned className="w-3.5 h-3.5" /> My Daily Routes ({routes.length})
        </button>
      </div>

      {tab === 'deals' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search building, community, deal ID..."
              className="flex-1 min-w-[220px] px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white"
            />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white">
              <option value="all">All Statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {loading && <div className="p-8 text-center text-xs text-slate-500">Loading your assigned deals…</div>}
          {!loading && rows.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-500">
              No properties have been dispatched to you yet. Once Admin, Shabib, or Haseeb assigns deals to your queue, they will appear here automatically.
            </div>
          )}

          <div className="grid gap-3">
            {rows.map(r => (
              <div key={r.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700">{r.external_deal_id}</span>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800">{r.deal_division}</span>
                      <span className="text-[11px] font-semibold text-amber-800">{r.urgency_or_deal_window}</span>
                    </div>
                    <h3 className="text-base font-bold text-slate-900 mt-1">{r.building_or_project || 'Property'} · {r.dubai_area_community}</h3>
                    <div className="text-xs text-slate-600 mt-0.5">
                      Unit: <b>{r.exact_unit_door_no}</b>
                      {r.floor_or_zone ? ` · Floor ${r.floor_or_zone}` : ''}
                      {r.property_layout_type ? ` · ${r.property_layout_type}` : ''}
                      {r.size_sqft ? ` · ${Math.round(r.size_sqft)} sqft` : ''}
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      Owner: <b>{r.owner_name}</b>
                      {AED(r.target_deal_value_aed) ? ` · Target: ${AED(r.target_deal_value_aed)}` : ''}
                      {AED(r.est_agency_commission_aed) ? ` · Est. Fee: ${AED(r.est_agency_commission_aed)}` : ''}
                      {r.event_or_expiry_date ? ` · Event: ${r.event_or_expiry_date}` : ''}
                    </div>
                  </div>

                  {/* Hard-Masked Contact Actions */}
                  <div className="flex flex-col items-end gap-1.5">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 text-[#d4b672] font-mono text-[11px] font-bold">
                      <Lock className="w-3 h-3" /> {r.phone_masked}
                    </span>
                    <div className="flex gap-1.5">
                      {r.can_call_masked && (
                        <button
                          disabled={busyId === r.id}
                          onClick={() => triggerMaskedCall(r.id)}
                          className="px-3 py-1.5 rounded-lg bg-[#0d5a48] hover:bg-[#0a4638] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <PhoneCall className="w-3.5 h-3.5" /> Call Owner (Masked)
                        </button>
                      )}
                      {r.can_whatsapp_masked && (
                        <button
                          disabled={busyId === r.id}
                          onClick={() => setWaOpenId(waOpenId === r.id ? null : r.id)}
                          className="px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 text-xs font-bold flex items-center gap-1.5"
                        >
                          <MessageCircle className="w-3.5 h-3.5" /> Masked WhatsApp
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {r.closing_strategy_playbook && (
                  <div className="rounded-xl bg-amber-50/70 border border-amber-200/80 p-2.5 text-xs text-amber-950">
                    <b>Closing Playbook:</b> {r.closing_strategy_playbook}
                  </div>
                )}

                {waOpenId === r.id && (
                  <div className="rounded-xl bg-emerald-50/70 border border-emerald-200 p-3 space-y-2">
                    <div className="text-[11px] font-bold text-emerald-900">Send via SWK Official WhatsApp Business (Owner number stays hidden)</div>
                    <textarea
                      value={waText}
                      onChange={e => setWaText(e.target.value)}
                      rows={2}
                      placeholder="Hello, I am calling from SWK Properties regarding your unit..."
                      className="w-full p-2 text-xs rounded-lg border border-emerald-300 bg-white"
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setWaOpenId(null)} className="px-3 py-1.5 rounded-lg text-xs border border-slate-200 bg-white">Cancel</button>
                      <button disabled={busyId === r.id} onClick={() => sendMaskedWa(r.id)} className="px-3 py-1.5 rounded-lg bg-[#0d5a48] text-white text-xs font-bold">Send Masked WhatsApp</button>
                    </div>
                  </div>
                )}

                {/* Agent Status & Notes */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                  <select
                    value={statusDraft[r.id] ?? r.vault_status}
                    onChange={e => setStatusDraft(s => ({ ...s, [r.id]: e.target.value }))}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 font-semibold"
                  >
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <input
                    value={notesDraft[r.id] ?? r.agent_notes ?? ''}
                    onChange={e => setNotesDraft(n => ({ ...n, [r.id]: e.target.value }))}
                    placeholder="Add call outcome, viewing date, landlord feedback..."
                    className="flex-1 min-w-[200px] px-3 py-1.5 text-xs rounded-lg border border-slate-200"
                  />
                  <button
                    disabled={busyId === r.id}
                    onClick={() => saveUpdate(r)}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" /> Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'routes' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500">
                <th className="p-2.5">Date</th>
                <th className="p-2.5">Cluster</th>
                <th className="p-2.5">Corridor &amp; Morning Towers</th>
                <th className="p-2.5">QR Serials</th>
                <th className="p-2.5">Target Doors</th>
                <th className="p-2.5">Haseeb Sign-Off</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {routes.map(r => (
                <tr key={r.id}>
                  <td className="p-2.5 font-mono font-semibold">{r.route_date}</td>
                  <td className="p-2.5 font-bold">{r.cluster_id}</td>
                  <td className="p-2.5">
                    <div className="font-semibold">{r.assigned_corridor}</div>
                    <div className="text-[11px] text-slate-500">{r.morning_towers_scheduled}</div>
                  </td>
                  <td className="p-2.5 font-mono text-[11px]">{r.qr_serials_issued}</td>
                  <td className="p-2.5 font-bold">{r.target_doors_swept}</td>
                  <td className="p-2.5">{r.manager_haseeb_signoff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
