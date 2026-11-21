/* Lead routing, scoring, pool, mortgage cases, payment plans, matching and leaderboard.  Needs a server on a fresh data directory:  npx tsx tests/growth.ts */
import { QR_PAYLOAD_RE,qrCodeFrom,qrLink } from '../src/shared/qr-payload'
import crypto from 'node:crypto'
import { Api, ok, sec, finish, BASE } from './_api'

async function main() {
  const a = new Api()
  ok('administrator signs in', await a.login())

  sec('Lead routing')
  const roles = (await a.get('/api/e/roles?pageSize=50')).data.rows
  const salesRole = roles.find((r: any) => r.name === 'Sales').id
  const dxb = (await a.get('/api/e/branches')).data.rows[0].id
  const u1 = (await a.post('/api/e/users', { name: 'Rota One', email: 'rota1@a.example', password: 'Manager-Pass-2026!', role_id: salesRole, branch_id: dxb, active: true })).data.id
  const u2 = (await a.post('/api/e/users', { name: 'Rota Two', email: 'rota2@a.example', password: 'Manager-Pass-2026!', role_id: salesRole, branch_id: dxb, active: true })).data.id
  const rule = await a.post('/api/e/lead_routing_rules', { name: 'Bayut to sales', active: true, priority: 1, source: 'Bayut', strategy: 'Round robin', team_roles: 'Sales' })
  ok('routing rule saves', rule.status === 201 || rule.status === 200, rule)
  const mk = async (n: string, extra: any = {}) => (await a.post('/api/e/leads', { company: n, source: 'Bayut', phone: '+9715000000' + Math.floor(Math.random() * 90 + 10), ...extra })).data
  const l1 = await mk('Route A'), l2 = await mk('Route B'), l3 = await mk('Route C')
  const team = (await a.get('/api/e/users?pageSize=100')).data.rows.filter((r: any) => r.role_id === salesRole).map((r: any) => r.id)
  ok('new leads get an owner from the rule', [l1, l2, l3].every(l => team.includes(l.owner_id)), [l1.owner_id, l2.owner_id, l3.owner_id])
  ok('round robin moves to the next person', l1.owner_id !== l2.owner_id && new Set([l1.owner_id, l2.owner_id, l3.owner_id]).size >= 2, [l1.owner_id, l2.owner_id, l3.owner_id])
  ok('both new users are in the rota', team.includes(u1) && team.includes(u2))
  ok('the lead records which rule routed it', /Rule: Bayut to sales/.test(l1.routed_by ?? ''), l1.routed_by)
  ok('a first-response deadline is set', !!l1.sla_due_at, l1)

  sec('Lead score')
  const hot = await mk('Hot Buyer', { email: 'hot@example.com', est_value: 3_000_000, buyer_finance_type: 'Cash Buyer', interest: 'Apartment Sale', destination: 'Marina', marketing_consent: 'Opted in', bedrooms_wanted: 2 })
  const cold = (await a.post('/api/e/leads', { company: 'Cold Contact', source: 'Other' })).data
  ok('rich lead is Hot', hot.score_band === 'Hot' && hot.lead_score > cold.lead_score, [hot.lead_score, hot.score_band])
  ok('thin lead is Cold', cold.score_band === 'Cold', cold)

  sec('Lead pool')
  const claim = await a.post(`/api/leads/${hot.id}/claim`)
  ok('a lead that has an owner cannot be claimed', claim.status === 400, claim)
  const sweep = await a.post('/api/leads/sla-sweep')
  ok('SLA sweep runs', sweep.status === 200 && typeof sweep.data.warned === 'number', sweep)

  sec('Mortgage cases')
  const m0 = await a.post('/api/e/mortgage_cases', { client_name: 'Loan Client', property_value: 2_000_000, loan_amount: 2_500_000 })
  ok('loan above property value is refused', m0.status === 400, m0)
  const m1 = await a.post('/api/e/mortgage_cases', { client_name: 'Loan Client', property_value: 2_000_000, loan_amount: 1_600_000, referral_commission_pct: 0.5 })
  ok('case saves and works out LTV', m1.status < 300 && m1.data.ltv_pct === 80, m1)
  ok('referral commission is worked out', m1.data.referral_commission === Math.round(m1.data.loan_amount * 0.005), m1.data)
  const id = m1.data.id
  const noBank = await a.put(`/api/e/mortgage_cases/${id}`, { ...m1.data, status: 'Submitted to Bank' })
  ok('cannot move past Referred without a bank', noBank.status === 400, noBank)
  const sub = await a.put(`/api/e/mortgage_cases/${id}`, { ...m1.data, bank: 'Mashreq', status: 'Submitted to Bank' })
  ok('submission date is stamped', sub.status === 200 && !!sub.data.submitted_date, sub)
  const dec = await a.put(`/api/e/mortgage_cases/${id}`, { ...sub.data, status: 'Declined' })
  ok('declining needs a reason', dec.status === 400, dec)
  const rec = await a.put(`/api/e/mortgage_cases/${id}`, { ...sub.data, commission_received: true })
  ok('commission cannot be received before disbursement', rec.status === 400, rec)

  sec('Payment plans')
  const p0 = await a.post('/api/e/payment_plan_templates', { name: 'Bad split', booking_pct: 10, construction_pct: 50, handover_pct: 30, post_handover_pct: 0, construction_instalments: 5 })
  ok('a split that is not 100% is refused', p0.status === 400, p0)
  const p1 = await a.post('/api/e/payment_plan_templates', { name: '20/50/30', booking_pct: 20, construction_pct: 50, handover_pct: 30, post_handover_pct: 0, construction_instalments: 5, instalment_gap_months: 3 })
  ok('a good plan saves', p1.status < 300, p1)
  const sch = await a.get(`/api/growth/payment-schedule?plan=${p1.data.id}&price=1000001&start=2026-12-01&handover=2028-12-01`)
  ok('schedule adds up to the price', sch.status === 200 && sch.data.total === 1000001, sch.data)
  ok('schedule has booking, 5 instalments and handover', sch.data.schedule?.length === 7 && sch.data.schedule[0].stage === 'Booking' && sch.data.schedule[6].stage === 'On handover', sch.data.schedule)

  sec('Matching and leaderboard')
  const mt = await a.get(`/api/growth/match/lead/${hot.id}`)
  ok('lead match returns a list', mt.status === 200 && Array.isArray(mt.data.matches), mt)
  const tgt = await a.post('/api/e/agent_targets', { user_id: u1, user_name: 'Rota One', period: new Date().toISOString().slice(0, 7), metric: 'Calls logged', target: 20 })
  ok('a target saves', tgt.status < 300, tgt)
  const lb = await a.get('/api/growth/leaderboard')
  ok('leaderboard lists advisors with points', lb.status === 200 && lb.data.rows.length > 0 && 'points' in lb.data.rows[0], lb)
  ok('leaderboard rejects a bad month', (await a.get('/api/growth/leaderboard?month=nov')).status === 400)

  sec('Team chat')
  const b = new Api(); ok('second user signs in', await b.login('rota1@a.example', 'Manager-Pass-2026!'))
  const th = await a.post('/api/chat/threads', { user_ids: [u1] })
  ok('chat thread starts', th.status === 200 && th.data.id, th)
  ok('same pair reuses the thread', (await a.post('/api/chat/threads', { user_ids: [u1] })).data.id === th.data.id)
  ok('message sends', (await a.post(`/api/chat/threads/${th.data.id}/messages`, { body: 'Hello team' })).status === 200)
  const seen = await b.get(`/api/chat/threads/${th.data.id}/messages`)
  ok('other member reads it', seen.data?.[0]?.body === 'Hello team', seen)
  const c = new Api(); await c.login('rota2@a.example', 'Manager-Pass-2026!')
  ok('non-member cannot read', (await c.get(`/api/chat/threads/${th.data.id}/messages`)).status === 400)

  sec('Drafts and sequences')
  const sq = await a.post('/api/e/followup_sequences', { name: 'Welcome', steps: '0|WhatsApp|Hi {name}, thanks for your enquiry' })
  ok('sequence saves', sq.status < 300, sq)
  ok('bad step is refused', (await a.post('/api/e/followup_sequences', { name: 'Bad', steps: 'x|Fax|hi' })).status === 400)
  const en = await a.post('/api/e/sequence_enrolments', { sequence_id: sq.data.id, lead_id: hot.id })
  ok('lead enrols', en.status < 300 && en.data.status === 'Running', en)
  ok('same lead cannot enrol twice', (await a.post('/api/e/sequence_enrolments', { sequence_id: sq.data.id, lead_id: hot.id })).status === 400)
  const dr = await a.post('/api/e/message_drafts', { channel: 'WhatsApp', to_name: 'Test', to_phone: '+971501112222', body: 'Hello' })
  ok('draft starts pending', dr.data.status === 'Pending approval', dr)
  ok('send before approval is refused', (await a.post(`/api/message-drafts/${dr.data.id}/send`)).status === 400)
  const own = await a.put(`/api/e/message_drafts/${dr.data.id}`, { ...dr.data, status: 'Approved' })
  ok('administrator may approve', own.status === 200, own)

  sec('E-sign')
  const es = await a.post('/api/e/esign_requests', { title: 'Test MOU', document_text: 'I agree to the terms.', signer_name: 'Buyer One' })
  ok('request saves with a fingerprint', es.status < 300 && /^[0-9a-f]{64}$/.test(es.data.document_hash), es)
  const lk = (await a.post(`/api/esign/${es.data.id}/send`)).data.link as string
  const sp = new URL(lk).pathname
  ok('signing page opens without login', (await fetch('http://127.0.0.1:8080' + sp)).status === 200)
  const sg = await fetch('http://127.0.0.1:8080' + sp, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Buyer+One' })
  ok('signing records the signature', sg.status === 200 && (await a.get(`/api/e/esign_requests/${es.data.id}`)).data.status === 'Signed')
  ok('signed link cannot be reused', (await fetch('http://127.0.0.1:8080' + sp, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Other' })).status === 404)

  sec('Search, calendar feed, connectors')
  const ask = await a.get('/api/growth/ask?q=' + encodeURIComponent('2 bed marina under 2.5m'))
  ok('plain-words search is understood', ask.data.understood?.bedrooms === 2 && ask.data.understood?.max_aed === 2_500_000, ask.data)
  ok('presentation needs units', (await a.get('/api/growth/presentation')).status === 400)
  const feed = await a.post('/api/calendar/feed-link')
  const ics = await fetch('http://127.0.0.1:8080' + new URL(feed.data.url).pathname)
  ok('calendar feed is valid ICS', ics.status === 200 && (await ics.text()).startsWith('BEGIN:VCALENDAR'))
  ok('bad feed token is 404', (await fetch('http://127.0.0.1:8080/api/public/calendar/' + 'a'.repeat(48) + '.ics')).status === 404)
  const ig = await a.get('/api/integrations')
  ok('portal connectors are listed', ['meta_leads', 'property_finder', 'bayut_dubizzle', 'madhmoun', 'esign'].every(k => ig.data.sections.some((x: any) => x.key === k)), ig.data.sections?.map((x: any) => x.key))
  await a.put('/api/admin/settings', { meta_enabled: true, meta_verify_token: 'tok123' })
  ok('Meta verify handshake works', (await (await fetch('http://127.0.0.1:8080/api/public/meta-leads?hub.mode=subscribe&hub.verify_token=tok123&hub.challenge=abc')).text()) === 'abc')
  ok('Meta verify rejects a wrong token', (await fetch('http://127.0.0.1:8080/api/public/meta-leads?hub.mode=subscribe&hub.verify_token=no&hub.challenge=abc')).status === 403)

  sec('Forms B and I, HubSpot import')
  const tpls = (await a.get('/api/e/doc_templates?pageSize=200')).data.rows
  ok('Form B and Form I demo templates exist', ['LC-FORM-B', 'LC-FORM-I'].every(c => tpls.some((t: any) => t.code === c)))
  const hs = await a.post('/api/e/leads/import', { csv: 'First Name,Last Name,Email,Phone Number\nAmal,Rashid,amal.r@example.com,+971501119999\n' })
  ok('HubSpot-style columns import as a lead', hs.data.created === 1, hs.data)

  sec('Service portal')
  const prop = await a.post('/api/e/properties', { title: 'Portal Tower', property_type: 'Apartment', department_division: 'Leasing' })
  const unit = prop.status < 300 ? await a.post('/api/e/units', { unit_no: 'P-101', property_id: prop.data.id }) : prop
  const vendor = (await a.post('/api/e/parties', { name: 'Fix-It Vendor', is_vendor: true, status: 'Active' })).data.id
  const landlord = (await a.post('/api/e/parties', { name: 'Portal Landlord', is_landlord: true, status: 'Active' })).data.id
  const wo = await a.post('/api/e/maintenance', { unit_id: unit.data.id, category: 'Plumbing', description: 'Leaking tap', vendor_id: vendor, landlord_id: landlord })
  ok('work order created', wo.status < 300, [prop.status, unit.status, wo])
  const portalRole = roles.find((r: any) => r.name === 'Customer Portal').id
  const mkPortal = async (email: string, party_id: number) => { await a.post('/api/e/users', { name: email, email, password: 'Manager-Pass-2026!', role_id: portalRole, party_id, active: true }); const p = new Api(); await p.login(email, 'Manager-Pass-2026!'); return p }
  const v = await mkPortal('vendor@a.example', vendor), l = await mkPortal('landlord@a.example', landlord), other = await mkPortal('other@a.example', (await a.post('/api/e/parties', { name: 'Other Co', is_vendor: true, status: 'Active' })).data.id)
  ok('vendor sees the work order', (await v.get('/api/e/maintenance')).data.rows?.some((r: any) => r.id === wo.data.id))
  ok('unrelated party sees nothing', ((await other.get('/api/e/maintenance')).data.rows ?? []).length === 0)
  { const x = await other.post(`/api/portal/maintenance/${wo.data.id}/vendor-update`, { status: 'Completed' }); ok('unrelated party cannot update it', x.status === 400, x) }
  ok('vendor sends a quote', (await v.post(`/api/portal/maintenance/${wo.data.id}/vendor-update`, { quote: 450 })).status === 200)
  ok('vendor cannot complete before landlord approval', (await v.post(`/api/portal/maintenance/${wo.data.id}/vendor-update`, { status: 'Completed' })).status === 400)
  ok('vendor cannot approve own quote', (await v.post(`/api/portal/maintenance/${wo.data.id}/landlord-decision`, { approve: true })).status === 400)
  ok('landlord approves', (await l.post(`/api/portal/maintenance/${wo.data.id}/landlord-decision`, { approve: true })).status === 200)
  ok('vendor completes', (await v.post(`/api/portal/maintenance/${wo.data.id}/vendor-update`, { status: 'Completed' })).status === 200)
  ok('staff-only chat is closed to portal users', (await v.get('/api/chat/threads')).status === 403)

  sec('Inspection app')
  const it = await a.post('/api/e/inspection_templates', { name: 'Move-in', kind: 'Move-in', items: 'Living room\nKitchen' })
  const ins = await a.post('/api/e/inspections', { unit_id: unit.data.id, template_id: it.data.id, inspection_type: 'Move-In', scheduled_at: '2026-11-17T10:00', status: 'In Progress' })
  ok('inspection starts from a template', ins.status < 300, ins)
  const res = JSON.stringify([{ name: 'Living room', state: 'ok', note: '', photos: [] }, { name: 'Kitchen', state: 'issue', note: 'Cracked tile', photos: [] }])
  const sv = await a.put(`/api/e/inspections/${ins.data.id}`, { results: res, signature: 'data:image/png;base64,AAAA', signed_name: 'Tenant', status: 'Requires Action', findings: 'Kitchen: Cracked tile', version: ins.data.version })
  ok('results and signature save', sv.status === 200, sv)
  ok('results read back', JSON.parse((await a.get(`/api/e/inspections/${ins.data.id}`)).data.results)[1].note === 'Cracked tile')

  sec('Attendance: office Wi-Fi only, live camera code, device keys')
  const cfg = (await a.get('/api/public/reception-qr/wifi-config')).data
  ok('office Wi-Fi is hardcoded to the XAVIER BUSINESS network', cfg.ssid === 'XAVIER BUSINESS' && cfg.gateway_ip === '192.168.0.1', cfg)
  const hm = new Api(); await hm.login('haseeb@swk.properties', 'SWK@Manager2026')
  const PW = 'Manager-Pass-2026!'
  const mkKey = () => { const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); const j = kp.publicKey.export({ format: 'jwk' }) as any; return { priv: kp.privateKey, pub: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } } }
  const keyA = mkKey(), keyB = mkKey()
  const checkin = async (email: string, key: ReturnType<typeof mkKey>, payload: string, extra: any = {}, headers: Record<string, string> = {}) => {
    const ch = extra.challenge ?? (await (await fetch(BASE + '/api/public/reception-qr/challenge', { headers })).json()).challenge
    const sig = crypto.sign('sha256', Buffer.from(`${ch}.${payload}`), { key: key.priv, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    const res = await fetch(BASE + '/api/public/reception-qr/scan-login-checkin', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password: PW, qr_payload: payload, challenge: ch, device_pub: key.pub, device_sig: sig, device_name: 'Test phone', ...extra.body }) })
    return { status: res.status, data: await res.json().catch(() => ({})), challenge: ch }
  }
  const code = async () => (await hm.get('/api/swk-ops/reception-token')).data.token as string
  // fixed code (default): the same every time, printable, and the Owner or Manager can replace it
  const tf = await code()
  ok('the default code is fixed: same every time and not a link', /^SWK2\.[A-Za-z0-9_-]{43}$/.test(tf) && !/https?:/.test(tf) && (await code()) === tf, tf)
  ok('the check-in page camera accepts the fixed code the server issues', QR_PAYLOAD_RE.test(tf), tf)
  ok('the QR is a link a normal phone camera can open, and the page reads the code back from it', qrLink('https://os.swk.properties', tf) === `https://os.swk.properties/reception-qr#c=${tf}` && qrCodeFrom(qrLink('https://os.swk.properties/', tf)) === tf && qrCodeFrom(tf) === tf && qrCodeFrom('#c=' + tf) === tf)
  ok('anything that is not a reception code is ignored by the page', qrCodeFrom('https://example.com/#c=abc') === '' && qrCodeFrom('SWK2.short') === '' && qrCodeFrom('') === '')
  ok('other staff cannot regenerate the reception code', (await b.post('/api/swk-ops/reception-token/regenerate', {})).status === 403)
  const regen = (await hm.post('/api/swk-ops/reception-token/regenerate', {})).data.token as string
  ok('regenerating gives a different fixed code', regen !== tf && (await code()) === regen && regen.startsWith('SWK2.'))
  ok('the rotating mode can be switched on', (await hm.post('/api/swk-ops/reception-token/mode', { mode: 'rotating' })).data.mode === 'rotating')
  const t1 = await code()
  ok('the check-in page camera accepts the rotating code the server issues', QR_PAYLOAD_RE.test(t1), t1)
  ok('the rotating code is encrypted text, not a link', /^SWK1\.[A-Za-z0-9_-]{40,200}$/.test(t1) && !/https?:/.test(t1), t1)
  ok('every code is different', (await code()) !== t1)
  ok('other staff cannot open the reception code', (await b.get('/api/swk-ops/reception-token')).status === 403)
  ok('the administrator (admin@swk.properties) can open the reception code', (await a.get('/api/swk-ops/reception-token')).status === 200)
  const pubCur = JSON.stringify((await a.get('/api/public/reception-qr/current')).data) + JSON.stringify(cfg)
  ok('public pages never carry the code, the stand code or the office address', !/SWK[12]\.|STAND|lifelong|allowed_public_ips|"public_ips"/.test(pubCur), pubCur.slice(0, 200))
  const imp = (await a.post('/api/e/users', { name: 'Mohammad Haseeb', email: 'imposter@a.example', password: PW, role_id: salesRole, branch_id: dxb, active: true })).data
  const impApi = new Api(); await impApi.login('imposter@a.example', PW)
  ok('a person with the Manager name but another email cannot open, regenerate or switch the code', !!imp.id && (await impApi.get('/api/swk-ops/reception-token')).status === 403 && (await impApi.post('/api/swk-ops/reception-token/regenerate', {})).status === 403 && (await impApi.post('/api/swk-ops/reception-token/mode', { mode: 'rotating' })).status === 403)
  const early = await checkin('rota1@a.example', keyA, t1)
  ok('check-in is off until the office network is locked', early.status === 403 && /not set up/i.test(early.data.error ?? ''), early)
  ok('the Manager cannot lock the office network (Admin only)', (await hm.post('/api/swk-ops/attendance-setup', { lock_current_ip: true })).status === 403)
  const lock = await a.post('/api/swk-ops/attendance-setup', { lock_current_ip: true })
  ok('the Admin locks the office network', lock.status === 200 && lock.data.office_ip_locked === true, lock)
  ok('the office network is locked once: a second lock is refused until it is cleared', (await a.post('/api/swk-ops/attendance-setup', { lock_current_ip: true })).status === 409)
  await hm.put('/api/admin/settings', { office_wifi_public_ips: '' })
  ok('the Manager cannot clear the locked network through the general settings either', String((await a.get('/api/swk-ops/attendance-setup')).data.public_ips ?? '') !== '')
  const off = await checkin('rota1@a.example', keyA, await code(), {}, { 'cf-connecting-ip': '203.0.113.77' })
  ok('any other network is refused (mobile data, other Wi-Fi)', off.status === 403 && /office/i.test(off.data.error ?? ''), off)
  ok('a made-up code is refused', (await checkin('rota1@a.example', keyA, 'SWK1.' + 'A'.repeat(60))).status === 400)
  ok('a plain link or text is refused', (await checkin('rota1@a.example', keyA, 'https://os.swk.properties')).status === 400)
  const ch0 = (await (await fetch(BASE + '/api/public/reception-qr/challenge')).json()).challenge
  const noProof = await fetch(BASE + '/api/public/reception-qr/scan-login-checkin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rota1@a.example', password: PW, qr_payload: await code(), challenge: ch0 }) })
  ok('a request without a device proof is refused', noProof.status === 400)
  const newDev = await checkin('rota1@a.example', keyA, await code())
  ok('a new device must be approved first', newDev.status === 403 && /device/i.test(newDev.data.error ?? ''), newDev)
  const pend = (await hm.get('/api/swk-ops/attendance-control')).data.devices.find((d: any) => d.status === 'Pending')
  ok('the manager sees the waiting device', !!pend)
  ok('other staff cannot approve devices', (await b.post(`/api/swk-ops/attendance-control/device/${pend.id}`, { approve: true })).status === 403)
  await hm.post(`/api/swk-ops/attendance-control/device/${pend.id}`, { approve: true })
  const good = await checkin('rota1@a.example', keyA, await code())
  ok('office network + live code + own device + password works', good.status === 200 && good.data.verification_summary?.verified_by === 'Office Wi-Fi', good.data)
  const dubaiNow = Date.parse(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Dubai' }).slice(0, 16).replace(' ', 'T') + 'Z')
  ok('the check-in time is the Dubai wall clock, not UTC', Math.abs(Date.parse(String(good.data.event?.check_in_at) + 'Z') - dubaiNow) < 3 * 60_000 && Math.abs(Date.parse(String(good.data.verification_summary?.timestamp_gst) + 'Z') - dubaiNow) < 3 * 60_000, [good.data.event?.check_in_at, good.data.verification_summary?.timestamp_gst])
  ok('the connection IP is recorded', !!good.data.event?.client_ip && !!good.data.event?.device_id, good.data.event)
  const again = await checkin('rota1@a.example', keyA, await code())
  ok('checking in twice does not duplicate the record', again.status === 200 && again.data.already_checked_in === true && again.data.event.id === good.data.event.id, again.data)
  const stolen = await checkin('rota2@a.example', keyA, await code())
  ok('one device cannot be used by two people', stolen.status === 403 && /another person|one device/i.test(stolen.data.error ?? ''), stolen)
  const replay = await checkin('rota1@a.example', keyA, await code(), { challenge: good.challenge })
  ok('a used challenge cannot be replayed', replay.status === 400, replay)
  const secondDev = await checkin('rota1@a.example', keyB, await code())
  ok('a second device for the same person waits for approval', secondDev.status === 403, secondDev)
  const toApprove = (await hm.get('/api/swk-ops/attendance-control')).data.devices.filter((d: any) => d.status === 'Pending')
  for (const d of toApprove) await hm.post(`/api/swk-ops/attendance-control/device/${d.id}`, { approve: true })
  const second = await checkin('rota1@a.example', keyB, await code())
  ok('even when approved, a person checks in from one device per day', second.status === 403 && /different device/i.test(second.data.error ?? ''), second)
  for (let i = 0; i < 6; i++) await fetch(BASE + '/api/public/reception-qr/scan-login-checkin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rota2@a.example', password: 'wrong-' + i }) })
  const still = new Api(); ok('wrong check-in passwords never lock the person out', await still.login('rota2@a.example', PW))
  ok('check-in does not sign the phone in to the OS', (await fetch(BASE + '/api/auth/me')).status === 401)
  const fresh = (await a.post('/api/e/users', { name: 'Fresh Staff', email: 'fresh@a.example', password: PW, role_id: salesRole, branch_id: dxb, active: true, must_change_password: true })).data
  const keyC = mkKey()
  const mc = await checkin('fresh@a.example', keyC, await code())
  ok('a temporary password cannot check in until it is changed', !!fresh.id && mc.status === 403 && /password/i.test(mc.data.error ?? ''), mc)
  // back to the fixed code: a person can check in with it, the old rotating and replaced fixed codes no longer work
  await new Promise(r => setTimeout(r, 62_000)) // the check-in route allows 20 requests a minute per IP
  const fx = (await hm.post('/api/swk-ops/reception-token/mode', { mode: 'fixed' })).data.token as string
  const u3 = (await a.post('/api/e/users', { name: 'Rota Three', email: 'rota3@a.example', password: PW, role_id: salesRole, branch_id: dxb, active: true })).data
  const keyD = mkKey()
  ok('in fixed mode a rotating code is refused', !!u3.id && (await checkin('rota3@a.example', keyD, t1)).status === 400)
  await checkin('rota3@a.example', keyD, fx)
  for (const d of (await hm.get('/api/swk-ops/attendance-control')).data.devices.filter((x: any) => x.status === 'Pending')) await hm.post(`/api/swk-ops/attendance-control/device/${d.id}`, { approve: true })
  const fxIn = await checkin('rota3@a.example', keyD, fx)
  ok('the fixed code works with the office network, own device and password', fxIn.status === 200 && fxIn.data.verification_summary?.verified_by === 'Office Wi-Fi', fxIn.data)
  const fx2 = (await hm.post('/api/swk-ops/reception-token/regenerate', {})).data.token as string
  ok('after regenerating, the old printed code is refused', fx2 !== fx && (await checkin('rota3@a.example', keyD, fx)).status === 400)
  const cleared = await a.post('/api/swk-ops/attendance-setup', { clear_ips: true })
  ok('clearing the locked network switches check-in off', cleared.data.office_ip_locked === false, cleared.data)

  const pulse = await a.get('/api/dashboard/pulse')
  ok('the dashboard pulse returns seven days and a feed', pulse.status === 200 && pulse.data.leads?.length === 7 && Array.isArray(pulse.data.feed), pulse.data)
  ok('portal accounts cannot read the pulse', (await new Api().get('/api/dashboard/pulse')).status === 401)

  sec('Live notifications')
  const ac = new AbortController()
  const stream = await fetch(BASE + '/api/notifications/stream', { headers: { cookie: b.cookie, 'x-swk-client': 'web' }, signal: ac.signal })
  ok('the notification stream opens', stream.status === 200 && /event-stream/.test(stream.headers.get('content-type') ?? ''), stream.status)
  const reader = stream.body!.getReader(); let got = ''
  const readLoop = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; got += new TextDecoder().decode(value) } } catch { /* aborted */ } })()
  const th2 = await a.post('/api/chat/threads', { user_ids: [u1] })
  await a.post(`/api/chat/threads/${th2.data.id}/messages`, { body: 'Live ping test' })
  for (let i = 0; i < 30 && !/Live ping test/.test(got); i++) await new Promise(r => setTimeout(r, 100))
  ok('a new notification arrives on the open stream within seconds', /event: notification/.test(got) && /Live ping test/.test(got), got.slice(0, 300))
  ac.abort(); await readLoop
  ok('the stream needs a sign-in', (await fetch(BASE + '/api/notifications/stream')).status === 401)
  finish()
}
main().catch(e => { console.error(e); process.exit(1) })
