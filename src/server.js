import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { WebSocketServer } from 'ws'
import { db, one, all, run, token, hashPassword, checkPassword, setting, tableOut, recordOut, autoOut, audit } from './db.js'
import { FIELD_TYPES, TRIGGERS, ACTIONS, setBroadcast, createRecord, updateRecord, postMessage, withAuthor, fire, tickSchedules } from './engine.js'
import { seed } from './seed.js'

const PUBLIC = join(import.meta.dirname, '..', 'public')
const SESSION_DAYS = 14
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status } }
const fail = (status, msg) => { throw new HttpError(status, msg) }

// ---------- auth ----------
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(c => c[0]))
function sessionUser(req) {
  const sid = cookies(req).sid
  if (!sid) return null
  const u = one('SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1', sid, Date.now())
  return u || null
}
const loginAttempts = new Map() // ip -> [count, firstAt]
function throttle(ip) {
  const [n, at] = loginAttempts.get(ip) || [0, Date.now()]
  if (Date.now() - at > 15 * 60000) return loginAttempts.set(ip, [1, Date.now()])
  if (n >= 10) fail(429, 'Too many login attempts. Try again in 15 minutes.')
  loginAttempts.set(ip, [n + 1, at])
}
const admin = u => u.role === 'admin' || fail(403, 'Admins only')

// ---------- access ----------
function channelFor(user, id) {
  const c = one('SELECT * FROM channels WHERE id=?', id) || fail(404, 'Channel not found')
  const member = one('SELECT 1 FROM members WHERE channel_id=? AND user_id=?', c.id, user.id)
  if ((c.is_private || c.is_dm) && !member) fail(404, 'Channel not found')
  return { ...c, member: !!member }
}
const tableById = id => tableOut(one('SELECT * FROM tables WHERE id=?', id)) || fail(404, 'Table not found')

function validFields(fields) {
  if (!Array.isArray(fields) || !fields.length) fail(400, 'At least one field is required')
  const keys = new Set()
  return fields.map(x => {
    const name = String(x.name || '').trim() || fail(400, 'Every field needs a name')
    const key = String(x.key || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || fail(400, `Bad field name ${name}`)
    if (keys.has(key)) fail(400, `Duplicate field ${name}`)
    keys.add(key)
    const type = FIELD_TYPES.includes(x.type) ? x.type : 'text'
    const options = type === 'select' ? (x.options || []).map(String).filter(Boolean) : undefined
    return { key, name, type, ...(options && { options }), ...(options?.includes(x.default) && { default: x.default }) }
  })
}
function validAutomation(b) {
  const trigger = b.trigger || {}
  if (!TRIGGERS.includes(trigger.type)) fail(400, 'Unknown trigger')
  const actions = Array.isArray(b.actions) ? b.actions : []
  if (!actions.length) fail(400, 'Add at least one action')
  for (const a of actions) if (!ACTIONS.includes(a.type)) fail(400, `Unknown action ${a.type}`)
  return { name: String(b.name || 'Automation').slice(0, 120), trigger, actions }
}

// ---------- CSV ----------
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
function parseCsv(text) {
  const rows = [[]]; let cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { rows.at(-1).push(cur); cur = '' }
    else if (ch === '\n') { rows.at(-1).push(cur.replace(/\r$/, '')); cur = ''; rows.push([]) }
    else cur += ch
  }
  rows.at(-1).push(cur.replace(/\r$/, ''))
  return rows.filter(r => r.some(c => c !== ''))
}
const xml = v => String(v ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

// Map an arbitrary JSON payload (portal, website form, Zapier/Make) onto table fields by key or name.
function mapPayload(table, body) {
  const data = {}, extra = []
  const byName = new Map(table.fields.flatMap(f => [[f.key, f.key], [f.name.toLowerCase(), f.key]]))
  for (const [k, v] of Object.entries(body || {})) {
    const key = byName.get(k) || byName.get(k.toLowerCase())
    if (key) data[key] = v; else if (v != null && typeof v !== 'object') extra.push(`${k}: ${v}`)
  }
  const notes = table.fields.find(f => f.type === 'longtext')
  if (notes && extra.length) data[notes.key] = [data[notes.key], extra.join('\n')].filter(Boolean).join('\n')
  return data
}

// ---------- routes ----------
const routes = []
const route = (method, path, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts })

route('POST', '/api/login', ({ body, req, res }) => {
  throttle(req.socket.remoteAddress)
  const u = one('SELECT * FROM users WHERE email=? AND active=1', String(body.email || '').toLowerCase().trim())
  if (!u || !checkPassword(body.password || '', u.pass_hash)) fail(401, 'Wrong email or password')
  const sid = token()
  run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', sid, u.id, Date.now() + SESSION_DAYS * 864e5)
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1' ? '; Secure' : ''
  res.setHeader('set-cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`)
  return { id: u.id, email: u.email, name: u.name, role: u.role }
}, { public: true })
route('POST', '/api/logout', ({ req, res }) => {
  run('DELETE FROM sessions WHERE token=?', cookies(req).sid || '')
  res.setHeader('set-cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  return { ok: true }
})
route('GET', '/api/me', ({ user }) => user)
route('POST', '/api/me/password', ({ user, body }) => {
  const u = one('SELECT pass_hash FROM users WHERE id=?', user.id)
  if (!checkPassword(body.current || '', u.pass_hash)) fail(400, 'Current password is wrong')
  if (String(body.password || '').length < 8) fail(400, 'Use at least 8 characters')
  run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(body.password), user.id)
  return { ok: true }
})

// Team
route('GET', '/api/users', () => all('SELECT id,email,name,role,active FROM users ORDER BY name'))
route('POST', '/api/users', ({ user, body }) => {
  admin(user)
  const email = String(body.email || '').toLowerCase().trim()
  if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Valid email required')
  if (String(body.password || '').length < 8) fail(400, 'Password needs at least 8 characters')
  if (one('SELECT 1 FROM users WHERE email=?', email)) fail(409, 'That email already has an account')
  const id = run('INSERT INTO users(email,name,role,pass_hash) VALUES(?,?,?,?)', email, String(body.name || email).trim(),
    body.role === 'admin' ? 'admin' : 'member', hashPassword(body.password)).lastInsertRowid
  for (const c of all('SELECT id FROM channels WHERE is_private=0 AND is_dm=0')) run('INSERT OR IGNORE INTO members(channel_id,user_id) VALUES(?,?)', c.id, id)
  audit(user.id, 'create', 'user', id, email)
  return one('SELECT id,email,name,role,active FROM users WHERE id=?', id)
})
route('PATCH', '/api/users/:id', ({ user, body, params }) => {
  admin(user)
  if (Number(params.id) === user.id && (body.active === false || body.role === 'member')) fail(400, 'You cannot demote or deactivate yourself')
  const u = one('SELECT * FROM users WHERE id=?', params.id) || fail(404, 'User not found')
  run('UPDATE users SET name=?, role=?, active=? WHERE id=?', body.name ?? u.name, body.role === 'admin' || body.role === 'member' ? body.role : u.role,
    body.active === undefined ? u.active : body.active ? 1 : 0, u.id)
  if (body.password) { if (String(body.password).length < 8) fail(400, 'Password needs at least 8 characters'); run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(body.password), u.id) }
  if (body.active === false) run('DELETE FROM sessions WHERE user_id=?', u.id)
  audit(user.id, 'update', 'user', u.id)
  return one('SELECT id,email,name,role,active FROM users WHERE id=?', u.id)
})

// Chat (in-house Slack)
route('GET', '/api/channels', ({ user }) => all(`
  SELECT c.*, m.user_id IS NOT NULL AS member,
    (SELECT COUNT(*) FROM messages x WHERE x.channel_id=c.id AND x.parent_id IS NULL AND x.id>COALESCE(m.last_read,0) AND COALESCE(x.user_id,0)<>?) AS unread,
    (SELECT GROUP_CONCAT(u.name, ', ') FROM members mm JOIN users u ON u.id=mm.user_id WHERE mm.channel_id=c.id AND mm.user_id<>?) AS dm_with
  FROM channels c LEFT JOIN members m ON m.channel_id=c.id AND m.user_id=?
  WHERE (c.is_private=0 AND c.is_dm=0) OR m.user_id IS NOT NULL ORDER BY c.is_dm, c.name`, user.id, user.id, user.id))
route('POST', '/api/channels', ({ user, body }) => {
  const name = String(body.name || '').toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').slice(0, 60) || fail(400, 'Channel name required')
  if (one('SELECT 1 FROM channels WHERE name=? AND is_dm=0', name)) fail(409, 'Channel already exists')
  const id = run('INSERT INTO channels(name,topic,is_private,created_by) VALUES(?,?,?,?)', name, String(body.topic || ''), body.is_private ? 1 : 0, user.id).lastInsertRowid
  const ids = body.is_private ? [user.id, ...(body.member_ids || []).map(Number)] : all('SELECT id FROM users WHERE active=1').map(u => u.id)
  for (const uid of new Set(ids)) run('INSERT OR IGNORE INTO members(channel_id,user_id) VALUES(?,?)', id, uid)
  broadcast({ type: 'channels' })
  return one('SELECT * FROM channels WHERE id=?', id)
})
route('PATCH', '/api/channels/:id', ({ user, body, params }) => {
  const c = channelFor(user, params.id)
  run('UPDATE channels SET topic=? WHERE id=?', String(body.topic ?? c.topic).slice(0, 250), c.id)
  broadcast({ type: 'channels' })
  return { ok: true }
})
route('POST', '/api/channels/:id/join', ({ user, params }) => {
  const c = channelFor(user, params.id)
  run('INSERT OR IGNORE INTO members(channel_id,user_id) VALUES(?,?)', c.id, user.id)
  return { ok: true }
})
route('POST', '/api/channels/:id/leave', ({ user, params }) => {
  run('DELETE FROM members WHERE channel_id=? AND user_id=?', params.id, user.id)
  return { ok: true }
})
route('POST', '/api/channels/:id/members', ({ user, body, params }) => {
  const c = channelFor(user, params.id)
  if (!c.member) fail(403, 'Join the channel first')
  run('INSERT OR IGNORE INTO members(channel_id,user_id) VALUES(?,?)', c.id, Number(body.user_id))
  broadcast({ type: 'channels' })
  return { ok: true }
})
route('POST', '/api/dm', ({ user, body }) => {
  const other = one('SELECT id,name FROM users WHERE id=? AND active=1', body.user_id) || fail(404, 'User not found')
  const existing = one(`SELECT c.id FROM channels c WHERE c.is_dm=1
    AND EXISTS(SELECT 1 FROM members WHERE channel_id=c.id AND user_id=?) AND EXISTS(SELECT 1 FROM members WHERE channel_id=c.id AND user_id=?)
    AND (SELECT COUNT(*) FROM members WHERE channel_id=c.id)=?`, user.id, other.id, other.id === user.id ? 1 : 2)
  if (existing) return existing
  const id = run('INSERT INTO channels(name,is_dm,is_private,created_by) VALUES(?,1,1,?)', `dm-${user.id}-${other.id}`, user.id).lastInsertRowid
  for (const uid of new Set([user.id, other.id])) run('INSERT INTO members(channel_id,user_id) VALUES(?,?)', id, uid)
  broadcast({ type: 'channels' })
  return { id }
})
route('GET', '/api/channels/:id/messages', ({ user, params, query }) => {
  const c = channelFor(user, params.id)
  const parent = query.get('parent')
  const before = Number(query.get('before')) || 1e15
  const rows = parent
    ? all('SELECT * FROM messages WHERE channel_id=? AND (id=? OR parent_id=?) ORDER BY id', c.id, parent, parent)
    : all('SELECT * FROM messages WHERE channel_id=? AND parent_id IS NULL AND id<? ORDER BY id DESC LIMIT 100', c.id, before).reverse()
  if (!parent && c.member) run('UPDATE members SET last_read=(SELECT COALESCE(MAX(id),0) FROM messages WHERE channel_id=?) WHERE channel_id=? AND user_id=?', c.id, c.id, user.id)
  return rows.map(withAuthor)
})
route('POST', '/api/channels/:id/messages', ({ user, body, params }) => {
  const c = channelFor(user, params.id)
  if (!c.member) run('INSERT INTO members(channel_id,user_id) VALUES(?,?)', c.id, user.id)
  const parent = body.parent_id ? one('SELECT id FROM messages WHERE id=? AND channel_id=?', body.parent_id, c.id) || fail(404, 'Thread not found') : null
  const msg = postMessage(c.id, body.body, { userId: user.id, parentId: parent?.id ?? null })
  run('UPDATE members SET last_read=? WHERE channel_id=? AND user_id=?', msg.id, c.id, user.id)
  if (parent) broadcast({ type: 'message.update', message: withAuthor(one('SELECT * FROM messages WHERE id=?', parent.id)) }, c.id)
  return msg
})
const ownMessage = (user, id) => {
  const m = one('SELECT * FROM messages WHERE id=?', id) || fail(404, 'Message not found')
  channelFor(user, m.channel_id)
  return m
}
route('PATCH', '/api/messages/:id', ({ user, body, params }) => {
  const m = ownMessage(user, params.id)
  if (m.user_id !== user.id) fail(403, 'You can only edit your own messages')
  const text = String(body.body || '').trim() || fail(400, 'Message is empty')
  run('UPDATE messages SET body=?, edited_at=CURRENT_TIMESTAMP WHERE id=?', text.slice(0, 10000), m.id)
  const out = withAuthor(one('SELECT * FROM messages WHERE id=?', m.id))
  broadcast({ type: 'message.update', message: out }, m.channel_id)
  return out
})
route('DELETE', '/api/messages/:id', ({ user, params }) => {
  const m = ownMessage(user, params.id)
  if (m.user_id !== user.id && user.role !== 'admin') fail(403, 'You can only delete your own messages')
  run('DELETE FROM messages WHERE id=? OR parent_id=?', m.id, m.id)
  audit(user.id, 'delete', 'message', m.id, m.body.slice(0, 200))
  broadcast({ type: 'message.delete', id: m.id, channel_id: m.channel_id, parent_id: m.parent_id }, m.channel_id)
  return { ok: true }
})
route('POST', '/api/messages/:id/react', ({ user, body, params }) => {
  const m = ownMessage(user, params.id)
  const emoji = String(body.emoji || '').slice(0, 16) || fail(400, 'Emoji required')
  const r = JSON.parse(m.reactions)
  const who = new Set(r[emoji] || [])
  who.has(user.id) ? who.delete(user.id) : who.add(user.id)
  who.size ? (r[emoji] = [...who]) : delete r[emoji]
  run('UPDATE messages SET reactions=? WHERE id=?', JSON.stringify(r), m.id)
  const out = withAuthor(one('SELECT * FROM messages WHERE id=?', m.id))
  broadcast({ type: 'message.update', message: out }, m.channel_id)
  return out
})
route('GET', '/api/search', ({ user, query }) => {
  const q = `%${String(query.get('q') || '').trim()}%`
  if (q.length < 4) return { messages: [], records: [] }
  const messages = all(`SELECT m.* FROM messages m JOIN channels c ON c.id=m.channel_id
    LEFT JOIN members mm ON mm.channel_id=c.id AND mm.user_id=?
    WHERE m.body LIKE ? AND ((c.is_private=0 AND c.is_dm=0) OR mm.user_id IS NOT NULL) ORDER BY m.id DESC LIMIT 30`, user.id, q).map(withAuthor)
  const records = all('SELECT r.*, t.name AS table_name FROM records r JOIN tables t ON t.id=r.table_id WHERE r.data LIKE ? ORDER BY r.id DESC LIMIT 30', q).map(recordOut)
  return { messages, records }
})

// Tables (in-house Airtable / Monday / CRM / PropSpace)
route('GET', '/api/tables', () => all(`SELECT t.*, (SELECT COUNT(*) FROM records r WHERE r.table_id=t.id) AS count FROM tables t ORDER BY kind, name`).map(tableOut))
route('POST', '/api/tables', ({ user, body }) => {
  const name = String(body.name || '').trim() || fail(400, 'Name required')
  const fields = validFields(body.fields || [{ name: 'Name' }, { name: 'Status', type: 'select', options: ['To do', 'Doing', 'Done'] }])
  const kind = ['base', 'board', 'crm', 'listings'].includes(body.kind) ? body.kind : 'base'
  const groupField = fields.find(f => f.type === 'select')
  if (groupField?.options.length && !groupField.default) groupField.default = groupField.options[0]
  const group = groupField?.key ?? null
  const id = run('INSERT INTO tables(name,kind,icon,fields,group_field) VALUES(?,?,?,?,?)', name, kind, String(body.icon || ''), JSON.stringify(fields), group).lastInsertRowid
  audit(user.id, 'create', 'table', id, name)
  broadcast({ type: 'tables' })
  return tableById(id)
})
route('PATCH', '/api/tables/:id', ({ user, body, params }) => {
  const t = tableById(params.id)
  const fields = body.fields ? validFields(body.fields) : t.fields
  const group = body.group_field !== undefined ? body.group_field : t.group_field
  if (group && !fields.some(f => f.key === group && f.type === 'select')) fail(400, 'Group-by must be a select field')
  run('UPDATE tables SET name=?, icon=?, fields=?, group_field=? WHERE id=?', String(body.name ?? t.name), String(body.icon ?? t.icon), JSON.stringify(fields), group || null, t.id)
  audit(user.id, 'update', 'table', t.id)
  broadcast({ type: 'tables' })
  return tableById(t.id)
})
route('DELETE', '/api/tables/:id', ({ user, params }) => {
  admin(user)
  const t = tableById(params.id)
  run('DELETE FROM tables WHERE id=?', t.id)
  audit(user.id, 'delete', 'table', t.id, t.name)
  broadcast({ type: 'tables' })
  return { ok: true }
})
route('GET', '/api/tables/:id/records', ({ params }) => all('SELECT * FROM records WHERE table_id=? ORDER BY id DESC', tableById(params.id).id).map(recordOut))
route('POST', '/api/tables/:id/records', ({ user, body, params }) => createRecord(tableById(params.id).id, body.data || {}, user.id))
route('PATCH', '/api/records/:id', ({ user, body, params }) => updateRecord(Number(params.id), body.data || {}, user.id))
route('DELETE', '/api/records/:id', ({ user, params }) => {
  const r = one('SELECT * FROM records WHERE id=?', params.id) || fail(404, 'Record not found')
  run('DELETE FROM records WHERE id=?', r.id)
  audit(user.id, 'delete', 'record', r.id, r.data.slice(0, 500))
  broadcast({ type: 'record.delete', id: r.id, table_id: r.table_id })
  return { ok: true }
})
route('GET', '/api/tables/:id/export.csv', ({ params, res }) => {
  const t = tableById(params.id)
  const users = Object.fromEntries(all('SELECT id,name FROM users').map(u => [u.id, u.name]))
  const lines = [t.fields.map(f => csvCell(f.name)).join(',')]
  for (const r of all('SELECT * FROM records WHERE table_id=? ORDER BY id', t.id).map(recordOut))
    lines.push(t.fields.map(f => csvCell(f.type === 'user' ? users[r.data[f.key]] : r.data[f.key])).join(','))
  res.setHeader('content-disposition', `attachment; filename="${t.name.replace(/[^\w-]+/g, '_')}.csv"`)
  return { raw: lines.join('\n'), type: 'text/csv; charset=utf-8' }
})
route('POST', '/api/tables/:id/import', ({ user, params, raw }) => {
  const t = tableById(params.id)
  const [head, ...rows] = parseCsv(raw)
  if (!head) fail(400, 'Empty CSV')
  const keys = head.map(h => t.fields.find(f => f.name.toLowerCase() === h.trim().toLowerCase() || f.key === h.trim())?.key)
  if (!keys.some(Boolean)) fail(400, 'No CSV column matches a field name')
  db.exec('BEGIN')
  try {
    for (const r of rows) createRecord(t.id, Object.fromEntries(keys.map((k, i) => [k, r[i]]).filter(([k]) => k)), user.id)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return { imported: rows.length }
}, { rawBody: true })

// Automations (in-house Zapier) — admin only, because webhook actions reach the network.
route('GET', '/api/automations', () => all('SELECT * FROM automations ORDER BY id').map(autoOut))
route('POST', '/api/automations', ({ user, body }) => {
  admin(user)
  const a = validAutomation(body)
  const id = run('INSERT INTO automations(name,enabled,trigger,actions) VALUES(?,?,?,?)', a.name, body.enabled === false ? 0 : 1, JSON.stringify(a.trigger), JSON.stringify(a.actions)).lastInsertRowid
  audit(user.id, 'create', 'automation', id, a.name)
  return autoOut(one('SELECT * FROM automations WHERE id=?', id))
})
route('PATCH', '/api/automations/:id', ({ user, body, params }) => {
  admin(user)
  const cur = autoOut(one('SELECT * FROM automations WHERE id=?', params.id)) || fail(404, 'Automation not found')
  const a = validAutomation({ ...cur, ...body })
  run('UPDATE automations SET name=?, enabled=?, trigger=?, actions=? WHERE id=?', a.name, (body.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.actions), cur.id)
  audit(user.id, 'update', 'automation', cur.id)
  return autoOut(one('SELECT * FROM automations WHERE id=?', cur.id))
})
route('DELETE', '/api/automations/:id', ({ user, params }) => { admin(user); run('DELETE FROM automations WHERE id=?', params.id); audit(user.id, 'delete', 'automation', Number(params.id)); return { ok: true } })
route('GET', '/api/automations/:id/runs', ({ params }) => all('SELECT * FROM automation_runs WHERE automation_id=? ORDER BY id DESC LIMIT 50', params.id))

// Inbound webhooks + portal feeds
route('GET', '/api/hooks', ({ user }) => { admin(user); return { hooks: all('SELECT * FROM hooks ORDER BY id'), feed_key: setting('feed_key') } })
route('POST', '/api/hooks', ({ user, body }) => {
  admin(user)
  if (!body.table_id && !body.channel_id) fail(400, 'Pick a table, a channel, or both')
  const id = run('INSERT INTO hooks(token,name,table_id,channel_id) VALUES(?,?,?,?)', token(), String(body.name || 'Webhook'), body.table_id || null, body.channel_id || null).lastInsertRowid
  return one('SELECT * FROM hooks WHERE id=?', id)
})
route('DELETE', '/api/hooks/:id', ({ user, params }) => { admin(user); run('DELETE FROM hooks WHERE id=?', params.id); return { ok: true } })
route('POST', '/hooks/:token', ({ body, params }) => {
  const h = one('SELECT * FROM hooks WHERE token=?', params.token) || fail(404, 'Unknown webhook')
  let record = null
  if (h.table_id) record = createRecord(h.table_id, mapPayload(tableById(h.table_id), body), null)
  if (h.channel_id) postMessage(h.channel_id, body.text || body.message || '```' + JSON.stringify(body, null, 1).slice(0, 3000) + '```', { botName: h.name })
  fire('webhook', { hook_id: h.id, body, data: body, record })
  return { ok: true, record_id: record?.id ?? null }
}, { public: true })
route('GET', '/feeds/:id', ({ params, query }) => {
  if (query.get('key') !== setting('feed_key')) fail(403, 'Bad feed key')
  const t = tableById(String(params.id).replace(/\.xml$/, ''))
  const users = Object.fromEntries(all('SELECT id,name,email FROM users').map(u => [u.id, u]))
  const items = all('SELECT * FROM records WHERE table_id=? ORDER BY id', t.id).map(recordOut).filter(r => String(r.data.status || '').toLowerCase() === 'published')
  const body = items.map(r => {
    const d = r.data, agent = users[d.agent] || {}
    const photos = String(d.photos || '').split(/[\s,]+/).filter(Boolean).map(u => `<url>${xml(u)}</url>`).join('')
    return `<property last_update="${xml(r.updated_at)}"><reference_number>${xml(d.reference || 'SWK-' + r.id)}</reference_number>` +
      `<offering_type>${d.purpose === 'Rent' ? 'RR' : 'RS'}</offering_type><property_type>${xml(d.type)}</property_type>` +
      `<price>${xml(d.price)}</price><city>Dubai</city><community>${xml(d.community)}</community><property_name>${xml(d.building)}</property_name>` +
      `<title_en>${xml(d.title)}</title_en><description_en>${xml(d.description)}</description_en><size>${xml(d.size_sqft)}</size>` +
      `<bedroom>${xml(d.bedrooms)}</bedroom><bathroom>${xml(d.bathrooms)}</bathroom><permit_number>${xml(d.permit)}</permit_number>` +
      `<agent><name>${xml(agent.name)}</name><email>${xml(agent.email)}</email></agent><photo>${photos}</photo></property>`
  }).join('\n')
  return { raw: `<?xml version="1.0" encoding="UTF-8"?>\n<list count="${items.length}">\n${body}\n</list>`, type: 'application/xml; charset=utf-8' }
}, { public: true })
route('GET', '/api/audit', ({ user }) => { admin(user); return all('SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200') })
route('GET', '/api/meta', () => ({ field_types: FIELD_TYPES, triggers: TRIGGERS, actions: ACTIONS }))

// ---------- server ----------
async function readBody(req) {
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > 2e6) fail(413, 'Body too large'); chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8')
}

async function serveStatic(pathname, res) {
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname))
  if (!file.startsWith(PUBLIC)) return false
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(data)
    return true
  } catch { return false }
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'same-origin')
  try {
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(url.pathname)
      if (!m) continue
      const user = sessionUser(req)
      if (!r.public && !user) fail(401, 'Sign in required')
      const ctype = req.headers['content-type'] || ''
      // CSRF: only POST can be sent cross-site without a CORS preflight, so cookie-authenticated POSTs must be JSON or CSV.
      if (!r.public && req.method === 'POST' && !/^(application\/json|text\/csv)/.test(ctype)) fail(415, 'Send JSON')
      const raw = req.method === 'GET' ? '' : await readBody(req)
      let body = {}
      if (!r.rawBody && raw) { try { body = JSON.parse(raw) } catch { fail(400, 'Invalid JSON') } }
      const out = await r.handler({ req, res, user, body, raw, params: m.groups || {}, query: url.searchParams })
      if (out?.raw !== undefined) return res.writeHead(200, { 'content-type': out.type }).end(out.raw)
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? null))
    }
    if (req.method === 'GET' && (await serveStatic(url.pathname, res) || await serveStatic('/', res))) return
    fail(404, 'Not found')
  } catch (e) {
    const status = e.status || (/not found/i.test(e.message) ? 404 : 500)
    if (status === 500) console.error(e)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: status === 500 ? 'Server error' : e.message }))
  }
}

// ---------- realtime ----------
const sockets = new Map() // ws -> user
function broadcast(event, channelId) {
  const allowed = channelId ? new Set(all('SELECT user_id FROM members WHERE channel_id=?', channelId).map(r => r.user_id)) : null
  const pub = channelId ? one('SELECT is_private, is_dm FROM channels WHERE id=?', channelId) : null
  const msg = JSON.stringify(event)
  for (const [ws, u] of sockets)
    if (!allowed || allowed.has(u.id) || (pub && !pub.is_private && !pub.is_dm)) ws.send(msg)
}
setBroadcast(broadcast)

export function start(port = Number(process.env.PORT) || 8080) {
  const created = seed()
  if (created) console.log(`\n  SWK Hub first boot. Admin login: ${created.email} / ${created.password}\n  Change this password after signing in.\n`)
  const server = createServer(handle)
  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => {
    const user = sessionUser(req)
    if (!user) return ws.close(4001, 'unauthorized')
    sockets.set(ws, user)
    ws.on('close', () => sockets.delete(ws))
  })
  const timer = setInterval(() => { try { tickSchedules(); run('DELETE FROM sessions WHERE expires<?', Date.now()) } catch (e) { console.error(e) } }, 60000)
  server.on('close', () => clearInterval(timer))
  return new Promise(ok => server.listen(port, () => { console.log(`SWK Hub on http://localhost:${server.address().port}`); ok(server) }))
}

if (import.meta.url === `file://${process.argv[1]}`) start()
