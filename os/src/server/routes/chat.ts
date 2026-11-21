import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { q,tx } from '../db'
import { bad,nowIso } from '../util'
import { notify } from '../notify'
import { idOf } from './helpers'

// Internal team chat. Clients are reached through WhatsApp and e-mail, which already have their own threads.
export default async function (app: FastifyInstance) {
  const me = (req: any) => { if (!req.user || req.user.party_id) throw bad('Staff only'); return req.user.id as number }
  const member = (tid: number, uid: number) => { if (!q.get(`SELECT 1 AS x FROM chat_members WHERE thread_id = ? AND user_id = ?`, tid, uid)) throw bad('Conversation not found') }

  app.get('/api/chat/people', async (req) => { const uid = me(req); return q.all(`SELECT id, name FROM users WHERE active = 1 AND deleted_at IS NULL AND party_id IS NULL AND id <> ? ORDER BY name`, uid) })

  app.get('/api/chat/threads', async (req) => {
    const uid = me(req)
    const rows = q.all(`SELECT t.id, t.title, t.kind, (SELECT MAX(id) FROM chat_messages WHERE thread_id = t.id) AS last_id, m.last_read_id FROM chat_threads t JOIN chat_members m ON m.thread_id = t.id AND m.user_id = ? ORDER BY last_id DESC NULLS LAST, t.id DESC`, uid)
    return rows.map(r => {
      const members = q.all<{ name: string; id: number }>(`SELECT u.id, u.name FROM chat_members c JOIN users u ON u.id = c.user_id WHERE c.thread_id = ?`, r.id)
      const last = r.last_id ? q.get(`SELECT body, created_at FROM chat_messages WHERE id = ?`, r.last_id) : null
      const unread = q.val<number>(`SELECT COUNT(*) FROM chat_messages WHERE thread_id = ? AND id > ? AND user_id <> ?`, r.id, r.last_read_id ?? 0, uid) ?? 0
      return { id: r.id, kind: r.kind, title: r.title || members.filter(x => x.id !== uid).map(x => x.name).join(', ') || 'Just me', members, last, unread }
    })
  })

  app.post('/api/chat/threads', async (req) => {
    const uid = me(req)
    const b = z.object({ title: z.string().max(80).optional(), user_ids: z.array(z.number().int()).min(1).max(30) }).parse(req.body ?? {})
    const ids = [...new Set([uid, ...b.user_ids])]
    const valid = q.all<{ id: number }>(`SELECT id FROM users WHERE active = 1 AND deleted_at IS NULL AND party_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`, ...ids).map(r => r.id)
    if (valid.length !== ids.length) throw bad('Unknown person selected')
    if (ids.length === 2) { // reuse the existing one-to-one conversation
      const dm = q.get(`SELECT t.id FROM chat_threads t WHERE t.kind = 'dm' AND (SELECT COUNT(*) FROM chat_members c WHERE c.thread_id = t.id) = 2 AND EXISTS (SELECT 1 FROM chat_members c WHERE c.thread_id = t.id AND c.user_id = ?) AND EXISTS (SELECT 1 FROM chat_members c WHERE c.thread_id = t.id AND c.user_id = ?)`, ids[0], ids[1])
      if (dm) return { id: dm.id }
    }
    return tx(() => {
      const r = q.run(`INSERT INTO chat_threads (title, kind, created_by, created_at) VALUES (?,?,?,?)`, b.title?.trim() || null, ids.length === 2 ? 'dm' : 'group', uid, nowIso())
      const id = Number((r as any).lastInsertRowid) || q.val<number>(`SELECT MAX(id) FROM chat_threads`)!
      for (const u of ids) q.run(`INSERT INTO chat_members (thread_id, user_id) VALUES (?,?)`, id, u)
      return { id }
    })
  })

  app.get('/api/chat/threads/:id/messages', async (req) => {
    const uid = me(req), tid = idOf((req.params as any).id), after = Number((req.query as any).after) || 0
    member(tid, uid)
    const rows = q.all(`SELECT m.id, m.user_id, u.name, m.body, m.created_at FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT 200`, tid, after).reverse()
    if (rows.length) q.run(`UPDATE chat_members SET last_read_id = ? WHERE thread_id = ? AND user_id = ? AND last_read_id < ?`, rows[rows.length - 1].id, tid, uid, rows[rows.length - 1].id)
    return rows
  })

  app.post('/api/chat/threads/:id/messages', async (req) => {
    const uid = me(req), tid = idOf((req.params as any).id)
    member(tid, uid)
    const b = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body ?? {})
    const r = q.run(`INSERT INTO chat_messages (thread_id, user_id, body, created_at) VALUES (?,?,?,?)`, tid, uid, b.body, nowIso())
    const id = Number((r as any).lastInsertRowid) || q.val<number>(`SELECT MAX(id) FROM chat_messages`)!
    q.run(`UPDATE chat_members SET last_read_id = ? WHERE thread_id = ? AND user_id = ?`, id, tid, uid)
    for (const m of q.all<{ user_id: number }>(`SELECT user_id FROM chat_members WHERE thread_id = ? AND user_id <> ?`, tid, uid)) notify(m.user_id, `${req.user!.name}: ${b.body.slice(0, 60)}`, '', '/chat', 'info')
    return { id }
  })
}
