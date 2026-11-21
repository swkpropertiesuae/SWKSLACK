import { useEffect, useState, useCallback } from 'react'
import { api, get, post } from '../../lib/api'
import { useToast } from '../../lib/toast'
import { HandoverCustody } from './HandoverCustody'
import {
  ShieldCheck, Lock, PhoneCall, Upload, Users, Building2, Search,
  CheckSquare, Square, Send, RefreshCw, MapPinned, History, Settings2, X,
} from 'lucide-react'

const AED = (v: any) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '—'
  return `AED ${Math.round(n).toLocaleString('en-AE')}`
}

const DEFAULT_POLICY = {
  show_owner_name: false,
  show_exact_unit: true,
  show_floor: true,
  show_deal_value: true,
  show_commission: false,
  show_expiry: true,
  show_playbook: true,
  allow_masked_call: true,
  allow_masked_whatsapp: true,
}

export default function CrmVaultPage() {
  const toast = useToast()
  const [tab, setTab] = useState<'custody' | 'vault' | 'routes' | 'calls' | 'setup'>(() => (new URLSearchParams(window.location.search).get('tab') === 'custody' ? 'custody' : 'vault'))
  const [summary, setSummary] = useState<any>(null)
  const [filters, setFilters] = useState<{ suggested_agents: string[]; divisions: string[]; communities: string[] }>({
    suggested_agents: [], divisions: [], communities: [],
  })
  const [agents, setAgents] = useState<any[]>([])

  // Vault list state
  const [q, setQ] = useState('')
  const [dataset, setDataset] = useState('all')
  const [suggestedAgent, setSuggestedAgent] = useState('all')
  const [assignedFilter, setAssignedFilter] = useState('all')
  const [division, setDivision] = useState('all')
  const [community, setCommunity] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [hasPhone, setHasPhone] = useState('all')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  // Selection & Assign modal
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [assignOpen, setAssignOpen] = useState(false)
  const [targetAgentId, setTargetAgentId] = useState('')
  const [policy, setPolicy] = useState(DEFAULT_POLICY)
  const [busy, setBusy] = useState(false)

  // Routes, Calls, Bridge Settings, Import
  const [routes, setRoutes] = useState<any[]>([])
  const [routeCaptain, setRouteCaptain] = useState('all')
  const [callLogs, setCallLogs] = useState<any[]>([])
  const [bridge, setBridge] = useState<any>({
    masked_call_provider: 'none',
    masked_call_caller_id: '',
    masked_call_twilio_sid: '',
    masked_call_twilio_token: '',
    masked_call_webhook_url: '',
    masked_call_webhook_secret: '',
    masked_call_record: true,
  })
  const [uploading, setUploading] = useState(false)

  const loadMeta = useCallback(async () => {
    try {
      const [s, f, a] = await Promise.all([
        get('/api/crm-vault/summary'),
        get('/api/crm-vault/filters'),
        get('/api/crm-vault/agents'),
      ])
      setSummary(s)
      setFilters(f)
      setAgents(a.agents || [])
    } catch (e: any) {
      toast.error(e.message || 'Could not load CRM Vault summary')
    }
  }, [toast])

  const loadVault = useCallback(async () => {
    setLoading(true)
    try {
      const res = await get('/api/crm-vault/properties', {
        q: q.trim() || undefined,
        dataset,
        suggested_agent: suggestedAgent,
        assigned_user_id: assignedFilter,
        division,
        community,
        status: statusFilter,
        has_phone: hasPhone,
        page,
        pageSize: 50,
      })
      setRows(res.rows || [])
      setTotal(res.total || 0)
    } catch (e: any) {
      toast.error(e.message || 'Could not load vault properties')
    } finally {
      setLoading(false)
    }
  }, [q, dataset, suggestedAgent, assignedFilter, division, community, statusFilter, hasPhone, page, toast])

  const loadRoutes = useCallback(async () => {
    try {
      const res = await get('/api/crm-vault/routes', { captain: routeCaptain })
      setRoutes(res.rows || [])
    } catch (e: any) { toast.error(e.message) }
  }, [routeCaptain, toast])

  const loadCalls = useCallback(async () => {
    try {
      const res = await get('/api/crm-vault/call-logs')
      setCallLogs(res.rows || [])
    } catch (e: any) { toast.error(e.message) }
  }, [toast])

  const loadBridge = useCallback(async () => {
    try {
      const res = await get('/api/crm-vault/bridge-settings')
      setBridge((b: any) => ({ ...b, ...res, masked_call_twilio_token: '', masked_call_webhook_secret: '' }))
    } catch (e: any) { toast.error(e.message) }
  }, [toast])

  useEffect(() => { loadMeta() }, [loadMeta])
  useEffect(() => { if (tab === 'vault') loadVault() }, [tab, loadVault])
  useEffect(() => { if (tab === 'routes') loadRoutes() }, [tab, loadRoutes])
  useEffect(() => { if (tab === 'calls') loadCalls() }, [tab, loadCalls])
  useEffect(() => { if (tab === 'setup') loadBridge() }, [tab, loadBridge])

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectPage = () => {
    const allOnPage = rows.length > 0 && rows.every(r => selected.has(r.id))
    setSelected(prev => {
      const next = new Set(prev)
      for (const r of rows) {
        if (allOnPage) next.delete(r.id)
        else next.add(r.id)
      }
      return next
    })
  }

  const handleAssign = async () => {
    if (!targetAgentId) return toast.error('Choose an agent to assign to')
    setBusy(true)
    try {
      const res = await post('/api/crm-vault/assign', {
        property_ids: Array.from(selected),
        agent_user_id: Number(targetAgentId),
        visible_fields: policy,
      })
      toast.ok(`Assigned ${res.assigned} properties to ${res.agent.name} (phone numbers hard-masked)`)
      setSelected(new Set())
      setAssignOpen(false)
      loadVault()
      loadMeta()
    } catch (e: any) {
      toast.error(e.message || 'Assignment failed')
    } finally {
      setBusy(false)
    }
  }

  const handleUnassign = async () => {
    if (!selected.size) return
    setBusy(true)
    try {
      const res = await post('/api/crm-vault/unassign', { property_ids: Array.from(selected) })
      toast.ok(`Returned ${res.unassigned} properties back to Leadership Vault`)
      setSelected(new Set())
      loadVault()
      loadMeta()
    } catch (e: any) {
      toast.error(e.message || 'Unassign failed')
    } finally {
      setBusy(false)
    }
  }

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return
    setUploading(true)
    try {
      const fd = new FormData()
      for (const f of Array.from(fileList)) fd.append('file', f)
      const res = await fetch('/api/crm-vault/import', {
        method: 'POST',
        body: fd,
        headers: { 'x-swk-client': 'web' },
        credentials: 'same-origin',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Import failed')
      toast.ok(`Imported ${data.properties?.total || 0} properties & ${data.routes?.total || 0} route rows from ${data.files_processed} file(s)`)
      loadMeta()
      loadVault()
    } catch (e: any) {
      toast.error(e.message || 'Import failed')
    } finally {
      setUploading(false)
    }
  }

  const saveBridge = async () => {
    setBusy(true)
    try {
      await post('/api/crm-vault/bridge-settings', bridge)
      toast.ok('Hard-Masked Bridge Calling settings saved')
      loadMeta()
      loadBridge()
    } catch (e: any) {
      toast.error(e.message || 'Could not save bridge settings')
    } finally {
      setBusy(false)
    }
  }

  const signOffRoute = async (id: number, current: string) => {
    try {
      const next = current === 'Signed Off' ? 'Pending' : 'Signed Off'
      await api('PATCH', `/api/crm-vault/routes/${id}`, { manager_haseeb_signoff: next })
      toast.ok(`Route #${id} marked ${next}`)
      loadRoutes()
    } catch (e: any) { toast.error(e.message) }
  }

  const totals = summary?.totals || {}
  const totalPages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="p-5 max-w-[1600px] mx-auto space-y-5">
      {/* Header Banner */}
      <div className="rounded-2xl bg-[#0e261d] text-white p-5 border border-[#c8a962]/30 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#d4b672]">
            <ShieldCheck className="w-4 h-4" /> Leadership Eyes Only · Admin, Shabib &amp; Haseeb
          </div>
          <h1 className="text-2xl font-bold mt-1" style={{ color: "#fff" }}>SWK Master CRM Property Vault &amp; Hard-Masked Dispatch</h1>
          <p className="text-xs text-emerald-100/80 mt-1">
            Full unmasked inventory, owner contacts &amp; territory playbooks. Dispatch selected deals to agents with strict field-level visibility — owner phone numbers are permanently hard-masked from agent screens and phone call history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${summary?.bridge_configured ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200' : 'bg-amber-500/20 border-amber-400/40 text-amber-200'}`}>
            <Lock className="w-3.5 h-3.5 inline mr-1" />
            {summary?.bridge_configured ? `Masked Call Bridge: ${String(summary.bridge_provider).toUpperCase()}` : 'Masked Call Bridge: Setup Required'}
          </span>
          <button onClick={() => { loadMeta(); if (tab === 'vault') loadVault() }} className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label: 'Total Vault Units', value: Number(totals.total_properties || 0).toLocaleString(), sub: `${totals.cluster_1920_count || 0} Direct · ${totals.territory_1680_count || 0} Territory` },
          { label: 'Direct Phone Contacts', value: Number(totals.with_direct_phone || 0).toLocaleString(), sub: 'AES-256 Encrypted at Rest' },
          { label: 'Dispatched to Agents', value: Number(totals.assigned_count || 0).toLocaleString(), sub: `${totals.unassigned_count || 0} Still in Vault` },
          { label: 'Pipeline Volume', value: AED(totals.total_deal_volume_aed), sub: 'Combined Target Value' },
          { label: 'Est. Commission Pool', value: AED(totals.total_commission_pool_aed), sub: 'Agency Fee Potential' },
          { label: 'Daily Routes / Masked Calls', value: `${summary?.route_tracker_count || 0} / ${summary?.masked_calls_count || 0}`, sub: 'Audit Trackers & Bridge Logs' },
        ].map((k, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k.label}</div>
            <div className="text-lg font-extrabold text-slate-900 mt-1 truncate">{k.value}</div>
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        {[
          { id: 'custody', label: 'Custody & Handover', icon: ShieldCheck },
          { id: 'vault', label: `Master Vault (${totals.total_properties || 0})`, icon: Building2 },
          { id: 'routes', label: `Daily Route & Audit Tracker (${summary?.route_tracker_count || 0})`, icon: MapPinned },
          { id: 'calls', label: `Masked Call & WA Logs (${summary?.masked_calls_count || 0})`, icon: History },
          { id: 'setup', label: 'Import Excel & Masked Bridge Setup', icon: Settings2 },
        ].map(t => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${active ? 'bg-[#0e261d] text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            >
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'custody' && <HandoverCustody onChanged={loadMeta} />}

      {/* TAB 1: MASTER VAULT */}
      {tab === 'vault' && (
        <div className="space-y-3">
          {/* Filters */}
          <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                value={q}
                onChange={e => { setQ(e.target.value); setPage(1) }}
                placeholder="Search building, unit, community, owner, deal ID..."
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 focus:outline-none focus:border-[#0d5a48]"
              />
            </div>
            <select value={dataset} onChange={e => { setDataset(e.target.value); setPage(1) }} className="px-2.5 py-2 text-xs rounded-lg border border-slate-200">
              <option value="all">All Datasets</option>
              <option value="cluster_1920">Cluster 1,920 (Direct Phone)</option>
              <option value="territory_nov2026">Territories 1,680 (DLD Clean-Room)</option>
              <option value="ejari_dialer_2026">Ejari 0–60D Dialer 2026 (7 Desks)</option>
            </select>
            <select value={suggestedAgent} onChange={e => { setSuggestedAgent(e.target.value); setPage(1) }} className="px-2.5 py-2 text-xs rounded-lg border border-slate-200">
              <option value="all">All Excel Territories</option>
              {filters.suggested_agents.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={assignedFilter} onChange={e => { setAssignedFilter(e.target.value); setPage(1) }} className="px-2.5 py-2 text-xs rounded-lg border border-slate-200">
              <option value="all">All Dispatch States</option>
              <option value="unassigned">In Vault (Unassigned)</option>
              <option value="assigned">Dispatched to Agents</option>
              {agents.map(a => <option key={a.id} value={String(a.id)}>Assigned: {a.name}</option>)}
            </select>
            <select value={division} onChange={e => { setDivision(e.target.value); setPage(1) }} className="px-2.5 py-2 text-xs rounded-lg border border-slate-200">
              <option value="all">All Divisions</option>
              {filters.divisions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={hasPhone} onChange={e => { setHasPhone(e.target.value); setPage(1) }} className="px-2.5 py-2 text-xs rounded-lg border border-slate-200">
              <option value="all">Phone: Any</option>
              <option value="yes">With Direct Phone</option>
              <option value="no">No Phone (DLD Ref)</option>
            </select>
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }} className="px-2.5 py-2 text-xs rounded-lg border border-slate-200">
              <option value="all">All Statuses</option>
              {['In Vault', 'Assigned', 'In Progress', 'Viewing Scheduled', 'Offer / MOU', 'Closed Won', 'Closed Lost', 'On Hold'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Bulk Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5">
            <div className="flex items-center gap-3 text-xs">
              <button onClick={toggleSelectPage} className="font-semibold text-slate-700 hover:text-slate-900 flex items-center gap-1.5">
                {rows.length > 0 && rows.every(r => selected.has(r.id)) ? <CheckSquare className="w-4 h-4 text-[#0d5a48]" /> : <Square className="w-4 h-4" />}
                Select Page ({rows.length})
              </button>
              <span className="text-slate-500">Showing <b>{rows.length}</b> of <b>{total.toLocaleString()}</b> properties · Selected: <b>{selected.size}</b></span>
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={!selected.size}
                onClick={() => setAssignOpen(true)}
                className="px-3.5 py-1.5 rounded-lg bg-[#0d5a48] text-white text-xs font-bold disabled:opacity-40 flex items-center gap-1.5"
              >
                <Users className="w-3.5 h-3.5" /> Assign Selected to Agent ({selected.size})
              </button>
              <button
                disabled={!selected.size || busy}
                onClick={handleUnassign}
                className="px-3 py-1.5 rounded-lg bg-slate-200 text-slate-800 text-xs font-bold disabled:opacity-40"
              >
                Return to Vault
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto shadow-xs">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500">
                  <th className="p-2.5 w-8"></th>
                  <th className="p-2.5">Deal / Territory</th>
                  <th className="p-2.5">Property &amp; Unit</th>
                  <th className="p-2.5">Urgency &amp; Window</th>
                  <th className="p-2.5">Value &amp; Fee</th>
                  <th className="p-2.5">Owner &amp; Direct Phone (Leadership Only)</th>
                  <th className="p-2.5">Dispatch &amp; Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr><td colSpan={7} className="p-8 text-center text-slate-500">Loading CRM Vault properties…</td></tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-slate-500">No properties match your filters. Use the <b>Import Excel &amp; Masked Bridge Setup</b> tab to upload Excel/CSV files.</td></tr>
                )}
                {!loading && rows.map(r => (
                  <tr key={r.id} className={`hover:bg-slate-50/80 ${selected.has(r.id) ? 'bg-emerald-50/50' : ''}`}>
                    <td className="p-2.5 align-top">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} className="rounded" />
                    </td>
                    <td className="p-2.5 align-top">
                      <div className="font-mono text-[11px] font-bold text-slate-800">{r.external_deal_id}</div>
                      <div className="text-[11px] text-slate-500">{r.suggested_agent || '—'} · #{r.agent_deal_rank ?? '—'}</div>
                      <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-semibold text-slate-700">{r.deal_division}</span>
                    </td>
                    <td className="p-2.5 align-top max-w-[260px]">
                      <div className="font-bold text-slate-900">{r.building_or_project || '—'}</div>
                      <div className="text-slate-600">{r.dubai_area_community || r.primary_area_dld || '—'}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Unit: <b>{r.exact_unit_door_no || '—'}</b> {r.floor_or_zone ? `· Fl ${r.floor_or_zone}` : ''} · {r.property_layout_type || '—'} {r.size_sqft ? `· ${Math.round(r.size_sqft)} sqft` : ''}
                      </div>
                    </td>
                    <td className="p-2.5 align-top max-w-[220px]">
                      <div className="font-semibold text-amber-800">{r.urgency_or_deal_window || '—'}</div>
                      {r.event_or_expiry_date && <div className="text-[11px] text-slate-500">Event: {r.event_or_expiry_date} ({r.days_to_event ?? '—'}d)</div>}
                      {r.portal_or_source_status && <div className="text-[10px] text-slate-500 truncate">{r.portal_or_source_status}</div>}
                    </td>
                    <td className="p-2.5 align-top whitespace-nowrap">
                      <div className="font-bold text-slate-900">{AED(r.target_deal_value_aed)}</div>
                      <div className="text-[11px] text-emerald-700 font-semibold">Fee: {AED(r.est_agency_commission_aed)}</div>
                    </td>
                    <td className="p-2.5 align-top max-w-[240px]">
                      <div className="font-semibold text-slate-900">{r.owner_name || r.owner_entity_type || '—'}</div>
                      {r.direct_mobile ? (
                        <div className="font-mono text-[11px] font-bold text-[#0d5a48] mt-0.5">{r.direct_mobile}</div>
                      ) : (
                        <div className="text-[11px] text-slate-400">No direct mobile</div>
                      )}
                      {r.secondary_phone && <div className="font-mono text-[10px] text-slate-500">{r.secondary_phone}</div>}
                      {r.email_address && <div className="text-[10px] text-slate-500 truncate">{r.email_address}</div>}
                    </td>
                    <td className="p-2.5 align-top">
                      {r.assigned_user_name ? (
                        <div>
                          <span className="inline-block px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-900 font-bold text-[11px]">
                            {r.assigned_user_name}
                          </span>
                          <div className="text-[11px] text-slate-600 mt-0.5">{r.vault_status}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">Phone: HARD-MASKED</div>
                        </div>
                      ) : (
                        <span className="inline-block px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold text-[11px]">
                          In Vault
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-slate-600">
            <div>Page <b>{page}</b> of <b>{totalPages}</b></div>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white disabled:opacity-40">Previous</button>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white disabled:opacity-40">Next</button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: DAILY ROUTE & AUDIT TRACKER */}
      {tab === 'routes' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <select value={routeCaptain} onChange={e => setRouteCaptain(e.target.value)} className="px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white">
              <option value="all">All Territory Captains</option>
              {['Saifullah', 'Talha Shabbir', 'Shahid', 'Fareed', 'Umar', 'Sanketh'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="text-xs text-slate-500">{routes.length} scheduled daily routes</span>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500">
                  <th className="p-2.5">Date</th>
                  <th className="p-2.5">Cluster &amp; Captain</th>
                  <th className="p-2.5">Corridor &amp; Morning Towers</th>
                  <th className="p-2.5">QR Serials</th>
                  <th className="p-2.5">Target Doors</th>
                  <th className="p-2.5">Haseeb 5:30 PM Sign-Off</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {routes.map(r => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="p-2.5 font-mono font-semibold">{r.route_date}</td>
                    <td className="p-2.5"><b>{r.cluster_id}</b> · {r.territory_captain}</td>
                    <td className="p-2.5">
                      <div className="font-semibold text-slate-800">{r.assigned_corridor}</div>
                      <div className="text-[11px] text-slate-500">{r.morning_towers_scheduled}</div>
                    </td>
                    <td className="p-2.5 font-mono text-[11px]">{r.qr_serials_issued}</td>
                    <td className="p-2.5 font-bold">{r.target_doors_swept}</td>
                    <td className="p-2.5">
                      <button
                        onClick={() => signOffRoute(r.id, r.manager_haseeb_signoff)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${r.manager_haseeb_signoff === 'Signed Off' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}
                      >
                        {r.manager_haseeb_signoff || 'Pending'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: MASKED CALL & WHATSAPP LOGS */}
      {tab === 'calls' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500">
                <th className="p-2.5">Time</th>
                <th className="p-2.5">Agent</th>
                <th className="p-2.5">Property</th>
                <th className="p-2.5">Channel / Provider</th>
                <th className="p-2.5">Status</th>
                <th className="p-2.5">Notes / Call SID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {callLogs.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-slate-500">No masked calls or WhatsApp relays logged yet.</td></tr>
              )}
              {callLogs.map(l => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="p-2.5 font-mono text-[11px]">{String(l.created_at || '').slice(0, 19).replace('T', ' ')}</td>
                  <td className="p-2.5 font-bold">{l.agent_name}</td>
                  <td className="p-2.5">{l.external_deal_id} · {l.building_or_project}</td>
                  <td className="p-2.5">{l.channel} ({l.provider})</td>
                  <td className="p-2.5 font-semibold">{l.status}</td>
                  <td className="p-2.5 text-slate-600">{l.notes} {l.provider_call_sid ? `· ${l.provider_call_sid}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 4: IMPORT EXCEL & MASKED BRIDGE SETUP */}
      {tab === 'setup' && (
        <div className="grid md:grid-cols-2 gap-5">
          {/* Import Excel / CSV */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-center gap-2 font-bold text-slate-900">
              <Upload className="w-4 h-4 text-[#0d5a48]" /> Import CRM Excel / CSV Workbooks
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Upload <code>SWK_6_Agents_1920_Cluster_Closing_Deals_Master.xlsx</code>, <code>SWK_6_Agents_Master_Closing_Territories_Nov2026.xlsx</code>, individual <code>Agent_*_320_Closing_Deals.xlsx</code> workbooks, or <code>swk_6agent_daily_route_and_audit_tracker.csv</code>. Existing deal IDs are updated idempotently, and all phone numbers &amp; emails are AES-256-GCM encrypted in the database.
            </p>
            <label className="block border-2 border-dashed border-slate-300 hover:border-[#0d5a48] rounded-xl p-6 text-center cursor-pointer transition">
              <input
                type="file"
                multiple
                accept=".xlsx,.csv"
                disabled={uploading}
                onChange={e => handleUploadFiles(e.target.files)}
                className="hidden"
              />
              <Upload className="w-6 h-6 text-[#0d5a48] mx-auto mb-2" />
              <div className="text-xs font-bold text-slate-800">{uploading ? 'Importing & Encrypting…' : 'Click to Select .xlsx / .csv Files'}</div>
              <div className="text-[11px] text-slate-500 mt-1">Supports multi-file upload · Max 12 MB per upload</div>
            </label>
          </div>

          {/* Hard-Masked Bridge Calling Configuration */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3.5">
            <div className="flex items-center gap-2 font-bold text-slate-900">
              <PhoneCall className="w-4 h-4 text-[#0d5a48]" /> Hard-Masked Bridge Calling (Zero Phone History Leak)
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              When an agent clicks <b>Call Owner (Masked)</b>, SWKOS initiates a two-leg bridge call from SWK&apos;s official company number to the agent, then connects to the owner server-side. <b>The owner&apos;s real phone number never reaches the agent&apos;s screen, browser, app, SIM, or native call history.</b>
            </p>
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="font-semibold text-slate-700 block mb-1">Bridge Provider</label>
                <select
                  value={bridge.masked_call_provider}
                  onChange={e => setBridge({ ...bridge, masked_call_provider: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200"
                >
                  <option value="none">Disabled (Strict Fail-Closed — Number Stays Hidden)</option>
                  <option value="twilio">Twilio Voice Two-Leg Masked Bridge</option>
                  <option value="webhook">Custom UAE SIP / Ziwo / Etisalat-du PBX Webhook Bridge</option>
                </select>
              </div>
              <div>
                <label className="font-semibold text-slate-700 block mb-1">SWK Company Caller ID (Shown on Agent &amp; Owner Phones)</label>
                <input
                  value={bridge.masked_call_caller_id}
                  onChange={e => setBridge({ ...bridge, masked_call_caller_id: e.target.value })}
                  placeholder="+9714XXXXXXX"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200"
                />
              </div>
              {bridge.masked_call_provider === 'twilio' && (
                <>
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Twilio Account SID</label>
                    <input value={bridge.masked_call_twilio_sid} onChange={e => setBridge({ ...bridge, masked_call_twilio_sid: e.target.value })} placeholder="ACxxxxxxxxxxxxxxxx" className="w-full px-3 py-2 rounded-lg border border-slate-200" />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Twilio Auth Token {bridge.masked_call_twilio_token_set ? '(Saved — leave blank to keep)' : ''}</label>
                    <input type="password" value={bridge.masked_call_twilio_token} onChange={e => setBridge({ ...bridge, masked_call_twilio_token: e.target.value })} placeholder="••••••••" className="w-full px-3 py-2 rounded-lg border border-slate-200" />
                  </div>
                </>
              )}
              {bridge.masked_call_provider === 'webhook' && (
                <>
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">SIP / PBX Bridge Webhook URL</label>
                    <input value={bridge.masked_call_webhook_url} onChange={e => setBridge({ ...bridge, masked_call_webhook_url: e.target.value })} placeholder="https://pbx.swk.properties/api/masked-bridge" className="w-full px-3 py-2 rounded-lg border border-slate-200" />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">HMAC Signing Secret {bridge.masked_call_webhook_secret_set ? '(Saved — leave blank to keep)' : ''}</label>
                    <input type="password" value={bridge.masked_call_webhook_secret} onChange={e => setBridge({ ...bridge, masked_call_webhook_secret: e.target.value })} placeholder="••••••••" className="w-full px-3 py-2 rounded-lg border border-slate-200" />
                  </div>
                </>
              )}
              <label className="flex items-center gap-2 pt-1">
                <input type="checkbox" checked={!!bridge.masked_call_record} onChange={e => setBridge({ ...bridge, masked_call_record: e.target.checked })} />
                <span>Record bridged calls for leadership QA compliance</span>
              </label>
              <button disabled={busy} onClick={saveBridge} className="w-full py-2.5 rounded-xl bg-[#0d5a48] text-white font-bold">
                Save Masked Bridge Configuration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ASSIGN MODAL */}
      {assignOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Dispatch {selected.size} Property Deal(s) to Agent</h3>
              <button onClick={() => setAssignOpen(false)} className="p-1 rounded-lg hover:bg-slate-100"><X className="w-4 h-4" /></button>
            </div>
            <div className="text-xs">
              <label className="font-bold text-slate-700 block mb-1">Select Sales / Leasing Agent</label>
              <select value={targetAgentId} onChange={e => setTargetAgentId(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-slate-300">
                <option value="">-- Choose Agent --</option>
                {agents.map(a => (
                  <option key={a.id} value={String(a.id)}>{a.name} ({a.email})</option>
                ))}
              </select>
            </div>
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-950 flex items-start gap-2">
              <Lock className="w-4 h-4 text-[#0d5a48] shrink-0 mt-0.5" />
              <div>
                <b>Phone Number Hard-Masking (Permanent):</b> The owner&apos;s direct mobile and email are NEVER sent to the agent&apos;s device or phone call log. Agents only interact via server-side Masked Bridge Call or Masked WhatsApp Relay.
              </div>
            </div>
            <div className="space-y-2 text-xs">
              <div className="font-bold text-slate-700">Choose Exactly Which Details the Agent Can See:</div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['show_exact_unit', 'Exact Unit / Door No'],
                  ['show_floor', 'Floor / Zone'],
                  ['show_deal_value', 'Target Deal Value (AED)'],
                  ['show_expiry', 'Event / Expiry Date'],
                  ['show_playbook', 'Closing Strategy Playbook'],
                  ['show_owner_name', 'Owner Name (Off = "Protected Owner")'],
                  ['show_commission', 'Est. Agency Commission (AED)'],
                  ['allow_masked_call', 'Allow Masked Bridge Call'],
                  ['allow_masked_whatsapp', 'Allow Masked WhatsApp Relay'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 p-2 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(policy as any)[key]}
                      onChange={e => setPolicy(p => ({ ...p, [key]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setAssignOpen(false)} className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold">Cancel</button>
              <button disabled={busy || !targetAgentId} onClick={handleAssign} className="px-4 py-2 rounded-xl bg-[#0d5a48] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-40">
                <Send className="w-3.5 h-3.5" /> Confirm Dispatch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
