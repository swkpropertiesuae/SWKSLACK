// Core domain: records, messages and the automation engine (the in-house Zapier).
import { one, all, run, tableOut, recordOut, msgOut, autoOut, audit } from './db.js'

export const FIELD_TYPES = ['text', 'longtext', 'number', 'select', 'date', 'user', 'email', 'phone', 'url', 'checkbox', 'file']
export const TRIGGERS = ['record.created', 'record.updated', 'record.due', 'message.posted', 'webhook', 'schedule', 'os.event']
export const ACTIONS = ['post_message', 'create_record', 'update_record', 'assign_round_robin', 'notify', 'webhook', 'os_create']

// broadcast(event, channelId?, userIds?): channel events go to members, user events only to those users.
let broadcast = () => {}
export const setBroadcast = fn => { broadcast = fn }

const MAX_DEPTH = 3 // automations can trigger automations, but never loop forever

export function coerce(field, v) {
  if (v === undefined || v === null || v === '') return null
  switch (field.type) {
    case 'number': { const n = Number(String(v).replace(/[, ]/g, '')); return Number.isFinite(n) ? n : null }
    case 'checkbox': return v === true || v === 'true' || v === 1 || v === '1' || v === 'yes'
    case 'user': { const n = Number(v); return Number.isInteger(n) ? n : (one('SELECT id FROM users WHERE email=? OR name=?', v, v)?.id ?? null) }
    case 'select': { const s = String(v).trim(); return (field.options || []).find(o => o.toLowerCase() === s.toLowerCase()) ?? s }
    default: return String(v).slice(0, 20000)
  }
}

export function cleanData(table, data) {
  const out = {}
  for (const f of table.fields) if (f.key in data) out[f.key] = coerce(f, data[f.key])
  return out
}

const userName = id => one('SELECT name FROM users WHERE id=?', id)?.name ?? ''
const recordTitle = (table, rec) => rec.data[table.fields[0]?.key] || `#${rec.id}`

// Dubai calendar date (UTC+4, no DST) for due-date checks.
export const today = (now = Date.now()) => new Date(now + 4 * 3600e3).toISOString().slice(0, 10)

export function notify(userId, text, link = null) {
  if (!userId) return
  const { lastInsertRowid } = run('INSERT INTO notifications(user_id,text,link) VALUES(?,?,?)', userId, String(text).slice(0, 500), link)
  broadcast({ type: 'notification', notification: one('SELECT * FROM notifications WHERE id=?', lastInsertRowid) }, null, [userId])
}

// Tell people when a person field now points at them.
function notifyAssignees(table, rec, before, actorId) {
  for (const f of table.fields.filter(f => f.type === 'user')) {
    const uid = rec.data[f.key]
    if (uid && uid !== actorId && uid !== before?.[f.key])
      notify(uid, `You are now ${f.name.toLowerCase()} of ${table.name}: ${recordTitle(table, rec)}`, `#/t/${table.id}/${rec.id}`)
  }
}

// @first-name, @fullname, @email-local-part; @channel / @here reach every member.
function notifyMentions(msg, channelId) {
  const tokens = [...msg.body.matchAll(/@([\w.-]+)/g)].map(m => m[1].toLowerCase())
  const ch = one('SELECT * FROM channels WHERE id=?', channelId)
  const members = all('SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.channel_id=? AND u.active=1', channelId)
  const everyone = ch.is_dm || tokens.some(t => t === 'channel' || t === 'here')
  const users = everyone ? members : all('SELECT id,name,email FROM users WHERE active=1').filter(u =>
    tokens.some(t => t === u.name.split(/\s+/)[0].toLowerCase() || t === u.name.replace(/\s+/g, '').toLowerCase() || t === u.email.split('@')[0].toLowerCase()))
  const where = ch.is_dm ? 'a direct message' : `#${ch.name}`
  for (const u of users) if (u.id !== msg.user_id) notify(u.id, `${msg.author} in ${where}: ${msg.body.slice(0, 140)}`, `#/c/${channelId}`)
}

const lookup = (k, ctx) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), k in (ctx.data || {}) ? ctx.data : ctx)

// {{field}} templating; user fields render as the person's name.
export function render(tpl, ctx) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = lookup(k, ctx)
    const type = ctx.table?.fields.find(x => x.key === k)?.type
    if (type === 'user' && v) return userName(v)
    if (type === 'number' && typeof v === 'number') return v.toLocaleString('en-US')
    return v ?? ''
  })
}
// A value that is exactly "{{field}}" keeps its raw type (user id, number) when copied between records.
const value = (tpl, ctx) => { const m = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(tpl); return m ? lookup(m[1], ctx) : render(tpl, ctx) }

export function createRecord(tableId, data, userId, depth = 0) {
  const table = tableOut(one('SELECT * FROM tables WHERE id=?', tableId))
  if (!table) throw new Error('table not found')
  const clean = cleanData(table, data)
  for (const f of table.fields) if (clean[f.key] == null && f.default != null) clean[f.key] = f.default
  const { lastInsertRowid } = run('INSERT INTO records(table_id,data,created_by) VALUES(?,?,?)', tableId, JSON.stringify(clean), userId ?? null)
  const rec = recordOut(one('SELECT * FROM records WHERE id=?', lastInsertRowid))
  audit(userId, 'create', 'record', rec.id, table.name)
  broadcast({ type: 'record', record: rec })
  notifyAssignees(table, rec, null, userId)
  fire('record.created', { table, record: rec, data: rec.data }, depth)
  return rec
}

export function updateRecord(id, patch, userId, depth = 0) {
  const before = recordOut(one('SELECT * FROM records WHERE id=?', id))
  if (!before) throw new Error('record not found')
  const table = tableOut(one('SELECT * FROM tables WHERE id=?', before.table_id))
  const data = { ...before.data, ...cleanData(table, patch) }
  run('UPDATE records SET data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', JSON.stringify(data), id)
  const rec = recordOut(one('SELECT * FROM records WHERE id=?', id))
  const changed = Object.keys(data).filter(k => JSON.stringify(data[k]) !== JSON.stringify(before.data[k]))
  if (changed.length) {
    audit(userId, 'update', 'record', id, changed.join(','))
    broadcast({ type: 'record', record: rec })
    notifyAssignees(table, rec, before.data, userId)
    fire('record.updated', { table, record: rec, data: rec.data, changed, before: before.data }, depth)
  }
  return rec
}

export function postMessage(channelId, body, { userId = null, botName = null, parentId = null } = {}, depth = 0) {
  const text = String(body ?? '').trim().slice(0, 10000)
  if (!text) throw new Error('empty message')
  const { lastInsertRowid } = run('INSERT INTO messages(channel_id,user_id,bot_name,parent_id,body) VALUES(?,?,?,?,?)',
    channelId, userId, botName, parentId, text)
  const msg = withAuthor(one('SELECT * FROM messages WHERE id=?', lastInsertRowid))
  broadcast({ type: 'message', message: msg }, channelId)
  if (userId) notifyMentions(msg, channelId)
  if (!botName) fire('message.posted', { message: msg, text, channel_id: channelId, user: msg.author }, depth)
  return msg
}

export function withAuthor(m) {
  const o = msgOut(m)
  o.author = o.bot_name || userName(o.user_id)
  o.reply_count = one('SELECT COUNT(*) c FROM messages WHERE parent_id=?', o.id).c
  return o
}

function matches(t, event, ctx) {
  if (t.type !== event) return false
  if (event === 'record.created' || event === 'record.updated') {
    if (Number(t.table_id) !== ctx.table.id) return false
    if (event === 'record.updated' && t.field && !ctx.changed.includes(t.field)) return false
    if (t.field && t.equals != null && t.equals !== '' && String(ctx.data[t.field] ?? '').toLowerCase() !== String(t.equals).toLowerCase()) return false
    return true
  }
  if (event === 'message.posted') {
    if (t.channel_id && Number(t.channel_id) !== ctx.channel_id) return false
    return !t.keyword || ctx.text.toLowerCase().includes(String(t.keyword).toLowerCase())
  }
  if (event === 'webhook') return Number(t.hook_id) === ctx.hook_id
  if (event === 'os.event') return eventMatches(t.event || '*', ctx.event)
  return event === 'schedule'
}

// Same pattern rules as SWK OS webhooks: "*", "leads.created", "leads.*", comma lists.
export const eventMatches = (spec, event) => String(spec).split(',').map(x => x.trim()).filter(Boolean)
  .some(x => x === '*' || x === event || (x.endsWith('*') && event.startsWith(x.slice(0, -1))))

export function fire(event, ctx, depth = 0) {
  if (depth >= MAX_DEPTH) return
  for (const a of all('SELECT * FROM automations WHERE enabled=1').map(autoOut))
    if (matches(a.trigger, event, ctx)) runAutomation(a, ctx, depth + 1)
}

export function runAutomation(a, ctx, depth = 1) {
  const log = []
  try {
    for (const act of a.actions) log.push(runAction(a, act, ctx, depth))
    run('INSERT INTO automation_runs(automation_id,status,detail) VALUES(?,?,?)', a.id, 'ok', log.join('; '))
  } catch (e) {
    run('INSERT INTO automation_runs(automation_id,status,detail) VALUES(?,?,?)', a.id, 'error', [...log, e.message].join('; '))
  }
  run('UPDATE automations SET last_run_at=? WHERE id=?', Date.now(), a.id)
}

// Fire-and-forget POST: a slow receiver must not block the request that triggered it. The result lands in the run log.
function postJson(a, label, url, body, headers = {}) {
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    .then(async res => run('INSERT INTO automation_runs(automation_id,status,detail) VALUES(?,?,?)', a.id, res.ok ? 'ok' : 'error', `${label} ${res.status} ${res.ok ? '' : (await res.text()).slice(0, 200)}`))
    .catch(e => run('INSERT INTO automation_runs(automation_id,status,detail) VALUES(?,?,?)', a.id, 'error', `${label} ${e.message}`))
}

function runAction(a, act, ctx, depth) {
  const r = tpl => render(tpl, ctx)
  switch (act.type) {
    case 'post_message':
      postMessage(Number(act.channel_id), r(act.text), { botName: a.name, parentId: null }, depth)
      return 'posted message'
    case 'create_record': {
      const data = Object.fromEntries(Object.entries(act.data || {}).map(([k, v]) => [k, value(v, ctx)]))
      const rec = createRecord(Number(act.table_id), data, null, depth)
      return `created record ${rec.id}`
    }
    case 'update_record': {
      if (!ctx.record) throw new Error('update_record needs a record trigger')
      const set = Object.fromEntries(Object.entries(act.set || {}).map(([k, v]) => [k, value(v, ctx)]))
      Object.assign(ctx.data, updateRecord(ctx.record.id, set, null, depth).data)
      return `updated record ${ctx.record.id}`
    }
    case 'assign_round_robin': {
      if (!ctx.record) throw new Error('assign_round_robin needs a record trigger')
      if (ctx.data[act.field] && !act.overwrite) return `kept ${userName(ctx.data[act.field])}` // already has an owner
      const pool = act.user_ids?.length ? act.user_ids.map(Number)
        : all('SELECT id FROM users WHERE active=1 ORDER BY id').map(u => u.id)
      if (!pool.length) throw new Error('no users to assign')
      const state = one('SELECT state FROM automations WHERE id=?', a.id)
      const s = JSON.parse(state?.state || '{}')
      const idx = ((s.rr ?? -1) + 1) % pool.length
      const next = pool[idx]
      run('UPDATE automations SET state=? WHERE id=?', JSON.stringify({ ...s, rr: idx }), a.id)
      Object.assign(ctx.data, updateRecord(ctx.record.id, { [act.field]: next }, null, depth).data)
      return `assigned ${userName(next)}`
    }
    case 'webhook': {
      const url = new URL(r(act.url))
      if (!/^https?:$/.test(url.protocol)) throw new Error('webhook must be http(s)')
      postJson(a, 'webhook', url, { automation: a.name, record: ctx.record, data: ctx.data, message: ctx.message, table: ctx.table?.name })
      return `webhook queued ${url.host}`
    }
    case 'notify': {
      const uid = Number(value(act.user, ctx)) || null
      if (!uid) throw new Error('notify: no user')
      notify(uid, r(act.text), ctx.record ? `#/t/${ctx.table.id}/${ctx.record.id}` : null)
      return `notified ${userName(uid)}`
    }
    case 'os_create': {
      const base = process.env.OS_API_URL || process.env.OS_URL, key = process.env.OS_API_KEY
      if (!base || !key) throw new Error('SWK OS not connected: set OS_API_URL and OS_API_KEY')
      const entity = String(act.entity || '').replace(/[^a-z_]/g, '') || (() => { throw new Error('os_create: entity required') })()
      const data = Object.fromEntries(Object.entries(act.data || {}).map(([k, v]) => [k, value(v, ctx)]).filter(([, v]) => v != null && v !== ''))
      postJson(a, `SWK OS ${entity}`, new URL(`/api/e/${entity}`, base), data, { authorization: `Bearer ${key}` })
      return `SWK OS ${entity} queued`
    }
    default: throw new Error(`unknown action ${act.type}`)
  }
}

// Called every minute by the server.
export function tickSchedules(now = Date.now()) {
  const day = today(now)
  for (const a of all("SELECT * FROM automations WHERE enabled=1 AND json_extract(trigger,'$.type')='record.due'").map(autoOut)) {
    const table = tableOut(one('SELECT * FROM tables WHERE id=?', a.trigger.table_id))
    const field = a.trigger.field || table?.fields.find(f => f.type === 'date')?.key
    if (!table || !field) continue
    const state = a.state.due_day === day ? a.state : { ...a.state, due_day: day, done: [] }
    const due = all("SELECT * FROM records WHERE table_id=? AND substr(json_extract(data,'$.' || ?),1,10)=?", table.id, field, day).map(recordOut)
    for (const rec of due.filter(r => !state.done.includes(r.id))) {
      state.done.push(rec.id)
      runAutomation(a, { table, record: rec, data: rec.data })
    }
    const latest = JSON.parse(one('SELECT state FROM automations WHERE id=?', a.id).state || '{}') // actions may have saved state too
    run('UPDATE automations SET state=? WHERE id=?', JSON.stringify({ ...latest, due_day: day, done: state.done }), a.id)
  }
  for (const a of all("SELECT * FROM automations WHERE enabled=1 AND json_extract(trigger,'$.type')='schedule'").map(autoOut)) {
    const every = Math.max(1, Number(a.trigger.every_minutes) || 60) * 60000
    if (now - a.last_run_at >= every) runAutomation(a, { now: new Date(now).toISOString() })
  }
}
