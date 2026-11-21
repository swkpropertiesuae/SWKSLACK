import { useEffect,useRef,useState } from 'react'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { MessageSquare,Plus,Send,Users,MessageCircle,Mail } from 'lucide-react'
import { get,post } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader,Loading,ErrorBox } from '../ui/kit'
import { cls,fmtIsoStamp } from '../lib/format'

type Thread = { id: number; kind: string; title: string; unread: number; last: { body: string; created_at: string } | null }
type Msg = { id: number; user_id: number; name: string; body: string; created_at: string }

export function ChatPage() {
  const toast = useToast(), client = useQueryClient()
  const threads = useQuery({ queryKey: ['chat-threads'], queryFn: () => get<Thread[]>('/api/chat/threads'), refetchInterval: 6000 })
  const people = useQuery({ queryKey: ['chat-people'], queryFn: () => get<{ id: number; name: string }[]>('/api/chat/people') })
  const me = useQuery({ queryKey: ['me-id'], queryFn: () => get<any>('/api/auth/me') })
  const [sel, setSel] = useState<number | null>(null), [text, setText] = useState(''), [picking, setPicking] = useState(false), [chosen, setChosen] = useState<number[]>([]), [title, setTitle] = useState('')
  const msgs = useQuery({ queryKey: ['chat-msgs', sel], enabled: !!sel, queryFn: () => get<Msg[]>(`/api/chat/threads/${sel}/messages`), refetchInterval: 3000 })
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView() }, [msgs.data?.length, sel])
  useEffect(() => { if (!sel && threads.data?.length) setSel(threads.data[0].id) }, [threads.data, sel])
  if (threads.error) return <ErrorBox error={threads.error} />
  if (!threads.data) return <Loading />
  const myId = me.data?.id
  const send = async () => { if (!sel || !text.trim()) return; const t = text; setText(''); try { await post(`/api/chat/threads/${sel}/messages`, { body: t }); void msgs.refetch(); void client.invalidateQueries({ queryKey: ['chat-threads'] }) } catch (e: any) { setText(t); toast.error(e.message) } }
  const start = async () => { if (!chosen.length) return; try { const r = await post<{ id: number }>('/api/chat/threads', { user_ids: chosen, title: chosen.length > 1 ? title : undefined }); setPicking(false); setChosen([]); setTitle(''); setSel(r.id); void client.invalidateQueries({ queryKey: ['chat-threads'] }) } catch (e: any) { toast.error(e.message) } }
  const cur = threads.data.find(t => t.id === sel)
  return <div className="space-y-4">
    <PageHeader icon={<MessageSquare size={22} />} title="Team chat" subtitle="Message colleagues one-to-one or in groups. For clients use WhatsApp or E-mail." actions={<><Link className="btn outline" to="/whatsapp"><MessageCircle />Client WhatsApp</Link><Link className="btn outline" to="/email"><Mail />Client e-mail</Link><button className="btn green" onClick={() => setPicking(true)}><Plus />New chat</button></>} />
    <div className="swk-card grid md:grid-cols-[300px_1fr]" style={{ minHeight: 520 }}>
      <aside className="border-r border-line overflow-auto" style={{ maxHeight: 640 }}>
        {picking && <div className="p-3 border-b border-line space-y-2"><b className="text-ink text-sm">Choose people</b><div className="max-h-48 overflow-auto space-y-1">{people.data?.map(p => <label key={p.id} className="flex gap-2 text-sm items-center"><input type="checkbox" checked={chosen.includes(p.id)} onChange={e => setChosen(c => e.target.checked ? [...c, p.id] : c.filter(x => x !== p.id))} />{p.name}</label>)}</div>{chosen.length > 1 && <input className="input" placeholder="Group name" value={title} onChange={e => setTitle(e.target.value)} />}<div className="flex gap-2"><button className="btn green sm" onClick={() => void start()} disabled={!chosen.length}>Start</button><button className="btn ghost sm" onClick={() => setPicking(false)}>Cancel</button></div></div>}
        {!threads.data.length && !picking && <p className="p-4 text-muted text-sm">No conversations yet. Start one with New chat.</p>}
        {threads.data.map(t => <button key={t.id} onClick={() => setSel(t.id)} className={cls('w-full text-start px-4 py-3 border-0 border-b border-line bg-transparent cursor-pointer', sel === t.id ? 'bg-[var(--champ-soft)]' : 'hover:bg-[var(--hover)]')}><div className="flex items-center gap-2">{t.kind === 'group' && <Users size={14} />}<b className="text-sm text-ink truncate">{t.title}</b>{t.unread > 0 && <span className="ml-auto text-[11px] font-bold text-white bg-[var(--ember)] rounded-full px-1.5">{t.unread}</span>}</div>{t.last && <div className="text-xs text-muted truncate">{t.last.body}</div>}</button>)}
      </aside>
      <section className="flex flex-col min-h-0">
        {!cur ? <div className="m-auto text-muted text-sm">Select or start a conversation.</div> : <>
          <header className="px-4 py-3 border-b border-line"><b className="text-ink">{cur.title}</b></header>
          <div className="flex-1 overflow-auto p-4 space-y-2" style={{ maxHeight: 480 }}>
            {msgs.data?.map(m => { const mine = m.user_id === myId; return <div key={m.id} className={cls('flex', mine && 'justify-end')}><div className={cls('max-w-[75%] rounded-2xl px-3 py-2 text-sm', mine ? 'bg-[var(--ink)] text-[var(--card)]' : 'bg-[var(--soft)] text-ink')}>{!mine && <div className="text-[11px] font-semibold opacity-70">{m.name}</div>}<div className="whitespace-pre-wrap break-words">{m.body}</div><div className="text-[10px] opacity-60 mt-0.5">{fmtIsoStamp(m.created_at)}</div></div></div> })}
            <div ref={end} />
          </div>
          <form className="p-3 border-t border-line flex gap-2" onSubmit={e => { e.preventDefault(); void send() }}><input className="input flex-1" placeholder="Write a message…" value={text} onChange={e => setText(e.target.value)} maxLength={4000} /><button className="btn orange" type="submit" disabled={!text.trim()}><Send />Send</button></form>
        </>}
      </section>
    </div>
  </div>
}
