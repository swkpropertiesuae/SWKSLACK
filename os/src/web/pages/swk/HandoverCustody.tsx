import { useCallback, useEffect, useState } from 'react'
import { del, get, post, upload } from '../../lib/api'
import { SWK_STAFF_ACCOUNTS } from '@shared/swk-staff-access'
import { useToast } from '../../lib/toast'
import { Modal } from '../../ui/kit'
import { FileText, Lock, Send, Undo2, Eye, ShieldCheck, Upload, Trash2 } from 'lucide-react'

const STAGE_TONE: Record<string, string> = {
  'Admin Custody': 'bg-amber-100 text-amber-800',
  'With Manager': 'bg-sky-100 text-sky-800',
  'Released to Staff': 'bg-emerald-100 text-emerald-800',
}
const deskEmail = (desk: string) => SWK_STAFF_ACCOUNTS.find(a => a.email.split('@')[0] === desk.toLowerCase())?.email
const KINDS = ['Personal Playbook', 'Field Guide', 'Calling Booklet', 'Roster Index', 'Other']

/** Chain of custody: Admin Custody -> Operations Manager -> staff (masked leads, personal documents). */
export function HandoverCustody({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { try { setData(await get('/api/handover/overview')) } catch (e: any) { toast.error(e?.message || 'Could not load the handover') } }, [toast])
  useEffect(() => { load() }, [load])

  const act = async (path: string, body?: any, ok?: string) => {
    setBusy(true)
    try { await post(path, body ?? {}); if (ok) toast.ok(ok); await load(); onChanged?.() } catch (e: any) { toast.error(e?.message || 'Action failed') } finally { setBusy(false) }
  }
  const [kind, setKind] = useState('')
  const [staff, setStaff] = useState('')
  const [progress, setProgress] = useState('')
  const uploadFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? [])
    if (!files.length) return
    setBusy(true)
    const failed: string[] = []
    try {
      for (const [i, f] of files.entries()) {
        setProgress(`Uploading ${i + 1} of ${files.length}: ${f.name}`)
        try {
          const r = await upload([f], { kind, staff_email: staff, contains_contacts: kind === 'Calling Booklet' ? 'true' : undefined }, '/api/handover/docs')
          for (const x of r.results) if (!x.ok) failed.push(x.error)
        } catch (e: any) { failed.push(`${f.name}: ${e?.message || 'upload failed'}`) }
      }
      if (failed.length) toast.error(failed.join(' · ')); else toast.ok(`${files.length} document${files.length === 1 ? '' : 's'} added to Admin Custody`)
      await load()
    } finally { setBusy(false); setProgress('') }
  }
  const remove = async (d: any) => {
    if (!window.confirm(`Delete "${d.title}"? The stored file and its pages are removed permanently.`)) return
    setBusy(true)
    try { await del(`/api/handover/docs/${d.id}`); toast.ok('Document deleted'); await load() } catch (e: any) { toast.error(e?.message || 'Delete failed') } finally { setBusy(false) }
  }
  if (!data) return <div className="p-8 text-center text-xs text-slate-500">Loading handover…</div>
  const top = data.can_release_to_manager
  const anyHeld = data.desks.some((d: any) => d.admin_custody > 0) || data.docs.some((d: any) => d.stage === 'Admin Custody')

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-700 leading-relaxed">
        <div className="flex items-center gap-2 font-bold text-[13px] text-slate-900 mb-1.5"><ShieldCheck className="w-4 h-4 text-[#0d5a48]" /> Chain of custody</div>
        <ol className="m-0 pl-4 space-y-0.5">
          <li><b>Admin Custody</b> – Admin reviews the received leads and documents. Nobody else can see them.</li>
          <li><b>With Operations Manager</b> – Admin releases a desk (or everything) to Haseeb.</li>
          <li><b>Staff</b> – Haseeb dispatches leads from the Master Vault with a masking policy, and releases each personal playbook and field guide to its owner. Calling booklets hold client numbers and stay with management.</li>
        </ol>
        {top && anyHeld && <button disabled={busy} onClick={() => act('/api/handover/release-to-manager', {}, 'Everything in Admin Custody released to the Operations Manager')} className="mt-3 px-3 py-2 rounded-lg bg-[#0e261d] text-white font-bold flex items-center gap-1.5 disabled:opacity-50"><Send className="w-3.5 h-3.5" /> Release everything to Operations Manager</button>}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500"><th className="p-2.5">Desk</th><th className="p-2.5 text-right">Admin custody</th><th className="p-2.5 text-right">With manager</th><th className="p-2.5 text-right">Dispatched to staff</th><th className="p-2.5 text-right">Total</th><th className="p-2.5" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.desks.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No handover leads {top ? 'loaded' : 'released to you yet'}.</td></tr>}
            {data.desks.map((d: any) => {
              const email = deskEmail(d.desk)
              return (
                <tr key={d.desk}>
                  <td className="p-2.5 font-bold">{d.desk}</td>
                  <td className="p-2.5 text-right">{Number(d.admin_custody).toLocaleString()}</td>
                  <td className="p-2.5 text-right">{Number(d.with_manager).toLocaleString()}</td>
                  <td className="p-2.5 text-right">{Number(d.dispatched).toLocaleString()}</td>
                  <td className="p-2.5 text-right font-semibold">{Number(d.total).toLocaleString()}</td>
                  <td className="p-2.5 text-right">{top && d.admin_custody > 0 && email && <button disabled={busy} onClick={() => act('/api/handover/release-to-manager', { staff_email: email }, `${d.desk} desk released to the Operations Manager`)} className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold disabled:opacity-50">Release desk</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {top && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs space-y-2.5">
          <div className="font-bold text-[13px] text-slate-900 flex items-center gap-2"><Upload className="w-4 h-4 text-[#0d5a48]" /> Upload documents into Admin Custody</div>
          <p className="m-0 text-slate-600">SWK file names (playbooks, field guides, calling booklets, roster index) are recognised automatically. Dialer workbooks are not stored: their leads are already in the Master Vault. For any other file, choose its type and staff member first. Files are stored in Cloudflare storage; uploading a file with the same name replaces it.</p>
          <div className="flex flex-wrap items-center gap-2">
            <select value={kind} onChange={e => setKind(e.target.value)} className="px-2.5 py-2 rounded-lg border border-slate-200" aria-label="Document type"><option value="">Type: detect from name</option>{KINDS.map(k => <option key={k}>{k}</option>)}</select>
            <select value={staff} onChange={e => setStaff(e.target.value)} className="px-2.5 py-2 rounded-lg border border-slate-200" aria-label="Staff member"><option value="">Staff: detect from name</option>{SWK_STAFF_ACCOUNTS.filter(a => a.roleName !== 'Owner' && a.roleName !== 'Admin').map(a => <option key={a.email} value={a.email}>{a.name}</option>)}</select>
            <label className={`px-3 py-2 rounded-lg bg-[#0e261d] text-white font-bold flex items-center gap-1.5 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}><Upload className="w-3.5 h-3.5" /> Choose files<input type="file" multiple accept=".pdf,.xlsx" className="sr-only" disabled={busy} onChange={e => { uploadFiles(e.target.files); e.target.value = '' }} /></label>
            {progress && <span className="text-slate-500" role="status">{progress}</span>}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500"><th className="p-2.5">Document</th><th className="p-2.5">For</th><th className="p-2.5">Stage</th><th className="p-2.5" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.docs.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">No documents {top ? 'loaded' : 'released to you yet'}.</td></tr>}
            {data.docs.map((d: any) => (
              <tr key={d.id}>
                <td className="p-2.5"><div className="font-bold flex items-center gap-1.5"><FileText className="w-3.5 h-3.5 text-slate-400" />{d.title}</div><div className="text-[11px] text-slate-500">{d.kind} · {(d.size / 1048576).toFixed(1)} MB{d.contains_contacts ? ' · contains client numbers' : ''}</div></td>
                <td className="p-2.5">{d.recipient_name || d.staff_email || 'Management only'}</td>
                <td className="p-2.5"><span className={`px-2 py-0.5 rounded-full font-bold text-[11px] ${STAGE_TONE[d.stage] ?? ''}`}>{d.stage}</span></td>
                <td className="p-2.5 text-right whitespace-nowrap space-x-1.5">
                  <a href={`/api/handover/docs/${d.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold"><Eye className="w-3.5 h-3.5" /> View</a>
                  {d.stage === 'With Manager' && !d.contains_contacts && d.staff_email && <button disabled={busy} onClick={() => act(`/api/handover/docs/${d.id}/release-to-staff`, {}, 'Released to staff')} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0e261d] text-white font-bold disabled:opacity-50"><Send className="w-3.5 h-3.5" /> Release to staff</button>}
                  {d.contains_contacts ? <span className="inline-flex items-center gap-1 text-[11px] text-slate-500"><Lock className="w-3 h-3" /> Management only</span> : null}
                  {top && d.stage !== 'Admin Custody' && <button disabled={busy} onClick={() => act(`/api/handover/docs/${d.id}/recall`, {}, 'Recalled to Admin Custody')} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold disabled:opacity-50"><Undo2 className="w-3.5 h-3.5" /> Recall</button>}
                  {top && <button disabled={busy} onClick={() => remove(d)} aria-label={`Delete ${d.title}`} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 font-bold disabled:opacity-50"><Trash2 className="w-3.5 h-3.5" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Staff view: documents management released to me, shown page by page exactly as issued (no file, no copy, no print). */
export function MyHandoverDocs() {
  const [docs, setDocs] = useState<any[] | null>(null)
  const [reading, setReading] = useState<any>(null)
  const toast = useToast()
  useEffect(() => { get<any[]>('/api/handover/my-docs').then(setDocs).catch(() => setDocs([])) }, [])
  const open = async (id: number) => { try { setReading({ id, ...(await get<any>(`/api/handover/docs/${id}/read`)) }) } catch (e: any) { toast.error(e?.message || 'Could not open the document') } }
  if (!docs?.length) return null
  const block = (e: { preventDefault: () => void }) => e.preventDefault()
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="font-bold text-[13px] text-slate-900 mb-2 flex items-center gap-2"><FileText className="w-4 h-4 text-[#0d5a48]" /> My documents</div>
      <ul className="m-0 p-0 list-none divide-y divide-slate-100 text-xs">
        {docs.map(d => <li key={d.id} className="py-2 flex items-center justify-between gap-3"><span><b>{d.title}</b><span className="text-slate-500"> · {d.kind}</span></span><button onClick={() => open(d.id)} className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold">View</button></li>)}
      </ul>
      <Modal open={!!reading} onClose={() => setReading(null)} title={reading?.title ?? ''} width={860}>
        {reading && (
          <div className="relative swk-protected select-none" onCopy={block} onCut={block} onContextMenu={block} onDragStart={block}>
            <style>{'@media print { .swk-protected { display: none !important } }'}</style>
            <p className="m-0 mb-3 text-[11px] text-slate-500 flex items-center gap-1.5"><Lock className="w-3 h-3" /> View copy for {reading.watermark}. Do not copy, photograph or share.</p>
            <div className="relative max-h-[72vh] overflow-y-auto space-y-3 bg-slate-100 p-2 rounded-lg">
              {Array.from({ length: reading.pages }, (_, i) => (
                <div key={i} className="relative overflow-hidden">
                  <img src={`/api/handover/docs/${reading.id}/page/${i + 1}`} alt={`Page ${i + 1} of ${reading.pages}`} loading="lazy" draggable={false} className="block w-full h-auto bg-white shadow-sm" />
                  <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col justify-around items-center opacity-[0.22] mix-blend-difference text-white text-[15px] font-bold -rotate-[24deg]">{Array.from({ length: 6 }, (_, k) => <div key={k} className="whitespace-nowrap">{reading.watermark}</div>)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
