import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_FILE = ':memory:'
process.env.ADMIN_EMAIL = 'admin@test.local'
process.env.ADMIN_PASSWORD = 'secret-pass-1'
const { start } = await import('../src/server.js')

let server, base, cookie = ''
const api = async (method, path, body, { headers = {}, raw } = {}) => {
  const res = await fetch(base + path, {
    method, headers: { cookie, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

before(async () => { server = await start(0); base = `http://localhost:${server.address().port}` })
after(() => server.close())

const tables = async () => Object.fromEntries((await api('GET', '/api/tables')).data.map(t => [t.name, t]))
const channels = async () => Object.fromEntries((await api('GET', '/api/channels')).data.map(c => [c.name, c]))

test('auth guards and login', async () => {
  assert.equal((await api('GET', '/api/me')).status, 401)
  assert.equal((await api('POST', '/api/login', { email: 'admin@test.local', password: 'nope' })).status, 401)
  const ok = await api('POST', '/api/login', { email: 'admin@test.local', password: 'secret-pass-1' })
  assert.equal(ok.status, 200); assert.equal(ok.data.role, 'admin')
  // CSRF guard: a form-encoded write is refused even with a valid cookie
  assert.equal((await api('POST', '/api/channels', undefined, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'name=x' })).status, 415)
})

test('team, channels, threads, reactions, DMs', async () => {
  const u = await api('POST', '/api/users', { email: 'agent@test.local', name: 'Agent One', password: 'agent-pass-1' })
  assert.equal(u.status, 200)
  const { general } = await channels()
  const m = await api('POST', `/api/channels/${general.id}/messages`, { body: 'Morning team' })
  assert.equal(m.data.author, 'Admin')
  const reply = await api('POST', `/api/channels/${general.id}/messages`, { body: 'On it', parent_id: m.data.id })
  assert.equal(reply.data.parent_id, m.data.id)
  const r = await api('POST', `/api/messages/${m.data.id}/react`, { emoji: '👍' })
  assert.deepEqual(r.data.reactions, { '👍': [1] })
  const top = (await api('GET', `/api/channels/${general.id}/messages`)).data
  assert.equal(top.find(x => x.id === m.data.id).reply_count, 1)
  const dm = await api('POST', '/api/dm', { user_id: u.data.id })
  assert.equal((await api('POST', '/api/dm', { user_id: u.data.id })).data.id, dm.data.id, 'DM is reused')
  const priv = await api('POST', '/api/channels', { name: 'Owners Only', is_private: true })
  assert.equal(priv.data.name, 'owners-only')
  assert.equal((await api('GET', '/api/search?q=Morning')).data.messages.length, 1)
})

test('lead webhook → record, round-robin owner, #leads alert', async () => {
  const { Leads } = await tables()
  const hook = (await api('GET', '/api/hooks')).data.hooks[0]
  const res = await fetch(`${base}/hooks/${hook.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ali Hassan', Phone: '+971500000001', source: 'bayut', department: 'Off-Plan', budget: '2,500,000', utm: 'spring' }),
  })
  const { record_id } = await res.json()
  const rec = (await api('GET', `/api/tables/${Leads.id}/records`)).data.find(r => r.id === record_id)
  assert.equal(rec.data.source, 'Bayut', 'select value normalised')
  assert.equal(rec.data.budget, 2500000)
  assert.ok(rec.data.owner, 'owner assigned')
  assert.match(rec.data.notes, /utm: spring/, 'unmapped keys land in notes')
  const { leads } = await channels()
  const msgs = (await api('GET', `/api/channels/${leads.id}/messages`)).data
  assert.match(msgs.at(-1).body, /New Bayut lead: \*Ali Hassan\*.*2,500,000/)
  assert.equal(msgs.at(-1).author, 'Lead router')
})

test('won lead opens a deal; CSV round-trip', async () => {
  const { Leads, Deals } = await tables()
  const lead = (await api('POST', `/api/tables/${Leads.id}/records`, { data: { name: 'Sara K', department: 'Leasing', budget: 120000 } })).data
  await api('PATCH', `/api/records/${lead.id}`, { data: { stage: 'Won' } })
  const deals = (await api('GET', `/api/tables/${Deals.id}/records`)).data
  const deal = deals.find(d => d.data.client === 'Sara K')
  assert.equal(deal.data.stage, 'EOI / Booking')
  assert.equal(deal.data.value, 120000)
  assert.equal(typeof deal.data.owner, 'number', 'owner copied as user id')

  const csv = (await api('GET', `/api/tables/${Deals.id}/export.csv`)).data
  assert.match(csv, /^Deal,Client/)
  const imp = await api('POST', `/api/tables/${Deals.id}/import`, undefined, { headers: { 'content-type': 'text/csv' }, raw: 'Deal,Deal value (AED),Stage\n"Villa, Palm",9000000,Transfer\n' })
  assert.equal(imp.data.imported, 1)
  const v = (await api('GET', `/api/tables/${Deals.id}/records`)).data.find(d => d.data.title === 'Villa, Palm')
  assert.equal(v.data.value, 9000000)
})

test('listings feed only exposes published units and needs the key', async () => {
  const { Listings } = await tables()
  await api('POST', `/api/tables/${Listings.id}/records`, { data: { reference: 'SWK-S-1', title: 'Marina 2BR', status: 'Published', price: 2100000, purpose: 'Sale' } })
  await api('POST', `/api/tables/${Listings.id}/records`, { data: { reference: 'SWK-S-2', title: 'Draft <unit>', status: 'Draft' } })
  const key = (await api('GET', '/api/hooks')).data.feed_key
  assert.equal((await fetch(`${base}/feeds/${Listings.id}.xml?key=wrong`)).status, 403)
  const xml = await (await fetch(`${base}/feeds/${Listings.id}.xml?key=${key}`)).text()
  assert.match(xml, /<reference_number>SWK-S-1<\/reference_number>/)
  assert.doesNotMatch(xml, /SWK-S-2/)
})

test('custom base, keyword automation, member limits', async () => {
  const t = await api('POST', '/api/tables', { name: 'Developers', fields: [{ name: 'Name' }, { name: 'Tier', type: 'select', options: ['A', 'B'] }] })
  assert.equal(t.data.group_field, 'tier')
  const { general } = await channels()
  const a = await api('POST', '/api/automations', {
    name: 'Ticket bot', trigger: { type: 'message.posted', keyword: '#todo' },
    actions: [{ type: 'create_record', table_id: t.data.id, data: { name: '{{text}}', tier: 'B' } }],
  })
  assert.equal(a.status, 200)
  await api('POST', `/api/channels/${general.id}/messages`, { body: '#todo call Emaar' })
  const recs = (await api('GET', `/api/tables/${t.data.id}/records`)).data
  assert.equal(recs[0].data.name, '#todo call Emaar')
  assert.equal((await api('GET', `/api/automations/${a.data.id}/runs`)).data[0].status, 'ok')

  await api('POST', '/api/login', { email: 'agent@test.local', password: 'agent-pass-1' })
  assert.equal((await api('POST', '/api/automations', { name: 'x', trigger: { type: 'schedule' }, actions: [{ type: 'webhook', url: 'http://127.0.0.1' }] })).status, 403)
  assert.equal((await api('DELETE', `/api/tables/${t.data.id}`)).status, 403)
  const ch = await channels()
  assert.ok(!ch['owners-only'], 'private channel hidden from non-members')
})
