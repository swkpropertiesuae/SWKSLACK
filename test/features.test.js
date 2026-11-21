import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

process.env.DB_FILE = ':memory:'
process.env.FILES_DIR = mkdtempSync(join(tmpdir(), 'hub-files-'))
process.env.ADMIN_EMAIL = 'admin@test.local'
process.env.ADMIN_PASSWORD = 'secret-pass-1'
process.env.OS_WEBHOOK_SECRET = 'os-secret'
const { start } = await import('../src/server.js')
const { tickSchedules, today } = await import('../src/engine.js')

let server, base
const jar = { admin: '', agent: '' }
async function api(who, method, path, body, { headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method, headers: { cookie: jar[who], ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0]
  const type = res.headers.get('content-type') || ''
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() }
}
const tables = async () => Object.fromEntries((await api('admin', 'GET', '/api/tables')).data.map(t => [t.name, t]))
const channels = async who => Object.fromEntries((await api(who, 'GET', '/api/channels')).data.map(c => [c.name, c]))
let agentId

before(async () => {
  server = await start(0); base = `http://localhost:${server.address().port}`
  await api('admin', 'POST', '/api/login', { email: 'admin@test.local', password: 'secret-pass-1' })
  agentId = (await api('admin', 'POST', '/api/users', { email: 'sara.k@test.local', name: 'Sara Khan', password: 'agent-pass-1' })).data.id
  await api('agent', 'POST', '/api/login', { email: 'sara.k@test.local', password: 'agent-pass-1' })
})
after(() => server.close())

test('file upload: stored, served, unsafe types forced to download', async () => {
  const png = await api('admin', 'POST', '/api/files?name=plan.png', undefined, { headers: { 'content-type': 'image/png' }, raw: Buffer.from([137, 80, 78, 71]) })
  assert.equal(png.status, 200)
  const get = await fetch(base + png.data.url, { headers: { cookie: jar.admin } })
  assert.equal(get.headers.get('content-type'), 'image/png')
  assert.match(get.headers.get('content-disposition'), /^inline/)
  const html = await api('admin', 'POST', '/api/files?name=x.html', undefined, { headers: { 'content-type': 'text/html' }, raw: '<script>alert(1)</script>' })
  const h = await fetch(base + html.data.url, { headers: { cookie: jar.admin } })
  assert.equal(h.headers.get('content-type'), 'application/octet-stream')
  assert.match(h.headers.get('content-disposition'), /^attachment/)
  assert.equal((await fetch(base + html.data.url)).status, 401, 'files need sign-in')
  assert.equal((await api('admin', 'POST', '/api/files?name=a.txt', undefined, { headers: { 'content-type': 'text/plain' }, raw: 'hi' })).status, 415, 'text/plain POST is a CSRF vector')
})

test('@mention and assignment create notifications', async () => {
  const { general } = await channels('admin')
  await api('admin', 'POST', `/api/channels/${general.id}/messages`, { body: '@sara please call the Marina buyer' })
  let n = (await api('agent', 'GET', '/api/notifications')).data
  assert.equal(n.unread, 1)
  assert.match(n.items[0].text, /Admin in #general: @sara/)

  const { Leads } = await tables()
  const lead = (await api('admin', 'POST', `/api/tables/${Leads.id}/records`, { data: { name: 'Omar R', owner: agentId } })).data
  n = (await api('agent', 'GET', '/api/notifications')).data
  assert.match(n.items[0].text, /owner of Leads: Omar R/)
  assert.equal(n.items[0].link, `#/t/${Leads.id}/${lead.id}`)
  await api('agent', 'POST', '/api/notifications/read', {})
  assert.equal((await api('agent', 'GET', '/api/notifications')).data.unread, 0)
})

test('record comments notify the owner and show history', async () => {
  const { Leads } = await tables()
  const lead = (await api('admin', 'POST', `/api/tables/${Leads.id}/records`, { data: { name: 'Lina M', owner: agentId } })).data
  await api('admin', 'PATCH', `/api/records/${lead.id}`, { data: { stage: 'Contacted' } })
  await api('admin', 'POST', `/api/records/${lead.id}/comments`, { body: 'Client wants a sea view' })
  const act = (await api('agent', 'GET', `/api/records/${lead.id}/activity`)).data
  assert.equal(act.comments[0].author, 'Admin')
  assert.deepEqual(act.history.map(h => h.action), ['create', 'update'])
  assert.match((await api('agent', 'GET', '/api/notifications')).data.items[0].text, /commented on Leads: Lina M/)
})

test('pins and dashboard', async () => {
  const { general } = await channels('admin')
  const m = (await api('admin', 'POST', `/api/channels/${general.id}/messages`, { body: 'Office closed Sunday' })).data
  await api('admin', 'POST', `/api/messages/${m.id}/pin`, {})
  assert.deepEqual((await api('agent', 'GET', `/api/channels/${general.id}/pins`)).data.map(x => x.id), [m.id])

  const d = (await api('agent', 'GET', '/api/dashboard')).data
  const leads = d.pipelines.find(p => p.table === 'Leads')
  assert.equal(leads.money, 'Budget (AED)')
  assert.ok(leads.groups.find(g => g.name === 'New').count >= 1)
  assert.ok(d.mine.some(x => x.title === 'Omar R'), 'records assigned to me')
})

test('record.due fires once per record per day', async () => {
  const { Leads } = await tables()
  const lead = (await api('admin', 'POST', `/api/tables/${Leads.id}/records`, { data: { name: 'Due Today', owner: agentId, next_follow_up: today() } })).data
  tickSchedules(); tickSchedules()
  const hits = (await api('agent', 'GET', '/api/notifications')).data.items.filter(n => n.text.startsWith('Follow up today: Due Today'))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].link, `#/t/${Leads.id}/${lead.id}`)
})

test('SWK OS events need a valid signature and reach #swk-os', async () => {
  const body = JSON.stringify({ event: 'leads.created', at: 'now', data: { lead_no: 'L2600001', company: 'Emaar Client' } })
  const post = sig => fetch(`${base}/os/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swk-signature': sig }, body })
  assert.equal((await post('sha256=bad')).status, 401)
  assert.equal((await post('sha256=' + createHmac('sha256', 'os-secret').update(body).digest('hex'))).status, 200)
  const ch = await channels('admin')
  const msgs = (await api('admin', 'GET', `/api/channels/${ch['swk-os'].id}/messages`)).data
  assert.match(msgs.at(-1).body, /SWK OS · leads.created · L2600001 Emaar Client/)
  assert.equal((await api('admin', 'GET', '/api/os')).data.events[0].event, 'leads.created')
})

test('os_create pushes a qualified lead into SWK OS with the API key', async () => {
  const got = []
  const mock = createServer((req, res) => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{}') }) })
  await new Promise(ok => mock.listen(0, ok))
  process.env.OS_API_URL = `http://localhost:${mock.address().port}`
  process.env.OS_API_KEY = 'osk_test'
  const autos = (await api('admin', 'GET', '/api/automations')).data
  const push = autos.find(a => a.name === 'Qualified lead → SWK OS')
  await api('admin', 'PATCH', `/api/automations/${push.id}`, { enabled: true })
  const { Leads } = await tables()
  const lead = (await api('admin', 'POST', `/api/tables/${Leads.id}/records`, { data: { name: 'Hamad A', phone: '+971555', budget: 3000000 } })).data
  await api('admin', 'PATCH', `/api/records/${lead.id}`, { data: { stage: 'Qualified' } })
  for (let i = 0; i < 50 && !got.length; i++) await new Promise(r => setTimeout(r, 20))
  mock.close()
  assert.equal(got[0].url, '/api/e/leads')
  assert.equal(got[0].auth, 'Bearer osk_test')
  assert.equal(got[0].body.company, 'Hamad A')
  assert.equal(got[0].body.est_value, 3000000)
  assert.equal(got[0].body.status, 'Qualified')
})
