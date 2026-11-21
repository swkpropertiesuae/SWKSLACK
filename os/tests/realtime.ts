// Real-time change feed, strict daily report + next-day plan, leadership alerts, live roster, AI tool guard.
import { Api, BASE, ok, sec, finish } from './_api'
const a = new Api()
ok('login', await a.login())
const me = (await a.get('/api/auth/me')).data

sec('Change feed')
const head = (await a.get('/api/sync/changes')).data
ok('head returned', Number.isInteger(head.seq) && head.events.length === 0)
const waiter = a.get(`/api/sync/changes?since=${head.seq}&wait=10`)
const t0 = Date.now(); await new Promise(r => setTimeout(r, 300))
const lead = (await a.post('/api/e/leads', { company: 'Realtime ' + Date.now() })).data
const w = (await waiter).data
ok('long-poll wakes on create within 2s', Date.now() - t0 < 2500 && w.events.some((e: any) => e.entity === 'leads' && e.id === lead.id && e.op === 'create'), w)
ok('events carry no record data', w.events.every((e: any) => Object.keys(e).sort().join() === 'at,entity,id,op,seq'))
await a.put(`/api/e/leads/${lead.id}`, { contact_name: 'X', version: lead.version })
const w2 = (await a.get(`/api/sync/changes?since=${w.seq}`)).data
ok('update event', w2.events.some((e: any) => e.entity === 'leads' && e.op === 'update'))
ok('bad cursor resets', (await a.get('/api/sync/changes?since=99999999')).data.reset === true)

sec('Daily report strictness + alerts')
let emp = (await a.get('/api/e/employees?pageSize=100')).data.rows.find((e: any) => e.user_id === me.id)
if (!emp) emp = (await a.post('/api/e/employees', { name: me.name, user_id: me.id, email: me.email, designation: 'Staff', status: 'Active' })).data
ok('employee linked', !!emp?.id, emp)
const short = await a.post('/api/mobile/daily-report', { outcomes_narrative: 'too short', next_day_priorities: 'short' })
ok('short report/plan rejected', short.status >= 400, short.data)
const noPlan = await a.post('/api/mobile/daily-report', { outcomes_narrative: 'Closed two viewings and followed up with five hot leads today.', next_day_priorities: '' })
ok('missing next-day plan rejected', noPlan.status >= 400)
const owner = new Api(), mgr = new Api()
ok('owner + manager login', await owner.login('shabib@swk.properties', 'Shabib@swk.properties') && await mgr.login('haseeb@swk.properties', 'SWK@Manager2026'))
const good = await a.post('/api/mobile/daily-report', { outcomes_narrative: 'Closed two viewings and followed up with five hot leads today.', blockers_narrative: '', next_day_priorities: 'Call the three offer clients first, then send two property shortlists.' })
ok('valid report submitted', good.status === 200 && good.data.status === 'Submitted (Frozen)', good.data)
for (const [who, c] of [['Owner', owner], ['Haseeb', mgr]] as const) {
  const n = (await c.get('/api/notifications')).data
  const hit = n.rows.find((x: any) => /Daily report \+ next-day plan submitted/.test(x.title))
  ok(`${who} alerted with today's result and tomorrow's plan`, !!hit && /Tomorrow:/.test(hit.body) && /Today:/.test(hit.body), n.rows?.slice(0, 2))
}
const st = (await a.get('/api/daily/status')).data
ok('status endpoint', st.submitted === true)
const again = await a.post('/api/mobile/daily-report', { outcomes_narrative: 'Another try with enough characters to pass the minimum.', next_day_priorities: 'Plan with enough characters to pass the minimum check ok.' })
ok('frozen report cannot be resubmitted', again.status >= 400)

sec('Live roster')
const live = (await a.get('/api/attendance/live')).data
ok('roster lists employees with state + report status', Array.isArray(live.roster) && live.roster.some((r: any) => r.employee_id === emp.id && r.report_status === 'Submitted (Frozen)'), live)

sec('AI tools')
const ai = await a.post('/api/ai/tool', { tool: 'whatsapp_followup', input: 'Client viewed JVC 1BR yesterday' })
ok('AI tool returns a clear error when no provider is connected', ai.status === 400 && /not connected/i.test(ai.data.error), ai.data)
ok('unknown tool rejected', (await a.post('/api/ai/tool', { tool: 'nope', input: 'hello there' })).status >= 400)
ok('status', (await a.get('/api/ai/tools-status')).data.tools.length >= 8)

sec('Handover manual removed')
const hv = await fetch(BASE + '/handover/SWK_OS_Complete_Software_Handover_And_Staff_Credentials_By_Shameem_Harfath.pdf')
ok('handover files are gone (no PDF/video is served; unknown paths fall through to the app shell)', !/pdf|video/i.test(hv.headers.get('content-type') ?? '') && !(await hv.text()).startsWith('%PDF'))
finish()
