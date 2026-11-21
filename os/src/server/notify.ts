import { q } from './db'
import { nowIso } from './util'
import { EventEmitter } from 'node:events'

/** Pushes each new notification to the signed-in person's open pages the moment it is saved. */
import { emitChange } from './changefeed'
export const liveBus = new EventEmitter()
liveBus.setMaxListeners(0)

export function notify(userId: number | null | undefined, title: string, body = '', link = '', kind = 'info', dedupe?: string) {
  if (!userId) return
  try {
    const r = q.run(`INSERT INTO notifications(user_id, kind, title, body, link, created_at, dedupe_key) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, userId, kind, title, body, link, nowIso(), dedupe ?? null)
    if ((r as any)?.changes !== 0) {
      const row = q.get(`SELECT id, kind, title, body, link, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`, userId)
      if (row) { liveBus.emit('u:' + userId, row); emitChange('notifications', '', row.id, 'create', userId) }
    }
  } catch { /* never fail business logic for a notification */ }
}
export function notifyRole(permModule: string, title: string, body = '', link = '', kind = 'approval', dedupe?: string) {
  const users = q.all<{ id: number; permissions: string | null }>(`SELECT u.id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.deleted_at IS NULL AND u.active = 1`)
  for (const u of users) {
    let ok = false
    try { const p = JSON.parse(u.permissions ?? '{}'); ok = p === '*' || (p[permModule] ?? []).some((a: string) => a === 'approve' || a === '*') } catch { /* ignore */ }
    if (ok) notify(u.id, title, body, link, kind, dedupe ? `${dedupe}:${u.id}` : undefined)
  }
}

/** Notify Owner (Shabib Siraj), Manager (Mohammad Haseeb), and BDM/IT Admin (Talha Shabbir). */
export function notifyLeadership(title: string, body = '', link = '', kind = 'audit', dedupe?: string) {
  try {
    const users = q.all<{ id: number }>(`
      SELECT u.id FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.deleted_at IS NULL AND u.active = 1
        AND (r.name IN ('Owner', 'Admin', 'Manager', 'BDM & IT Admin') OR r.permissions = '"*"' OR r.permissions = '*')
    `)
    for (const u of users) {
      notify(u.id, title, body, link, kind, dedupe ? `${dedupe}:${u.id}` : undefined)
    }
  } catch { /* ignore */ }
}
