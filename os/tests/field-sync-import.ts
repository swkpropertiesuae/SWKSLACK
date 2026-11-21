/* Offline sync replay and CSV import idempotency.  Needs a server on a fresh data directory:  npx tsx tests/field-sync-import.ts */
import { Api, ok, sec, finish } from './_api'

async function main() {
  const a = new Api()
  ok('administrator signs in', await a.login())

  sec('Offline sync')
  const key = 'test-' + Date.now() + '-aaaa'
  const act = { key, op: 'create', entity: 'activities', payload: { subject: 'Offline call', activity_type: 'Call' } }
  const r1 = await a.post('/api/sync/actions', { device_id: 'dev-1', actions: [act] })
  ok('first replay is synced', r1.data.results?.[0]?.status === 'synced', r1.data)
  const r2 = await a.post('/api/sync/actions', { device_id: 'dev-1', actions: [act] })
  ok('same key again returns the stored result', r2.data.results?.[0]?.replay === true && r2.data.results[0].id === r1.data.results[0].id, r2.data)
  const count = (await a.get('/api/e/activities?q=Offline%20call')).data.total
  ok('only one record was created', count === 1, count)
  const bad = await a.post('/api/sync/actions', { actions: [{ key: 'test-' + Date.now() + '-bbbb', op: 'create', entity: 'users', payload: {} }] })
  ok('entities outside the allowlist are rejected', bad.data.results?.[0]?.status === 'rejected', bad.data)
  const id = r1.data.results[0].id
  const stale = await a.post('/api/sync/actions', { actions: [{ key: 'test-' + Date.now() + '-cccc', op: 'update', entity: 'activities', id, payload: { subject: 'Changed offline', version: 999 } }] })
  ok('an edit on a stale version is a conflict', stale.data.results?.[0]?.status === 'conflict', stale.data)

  sec('CSV import')
  const csv = 'name\nImport Co One\nImport Co Two\n'
  const i1 = await a.post('/api/e/parties/import', { csv })
  ok('first import creates rows and a batch', i1.data.created === 2 && !!i1.data.batchId, i1.data)
  const i2 = await a.post('/api/e/parties/import', { csv })
  ok('same file again is refused with 409', i2.status === 409, i2)
  const i3 = await a.post('/api/e/parties/import', { csv, dryRun: true })
  ok('dry run is still allowed', i3.status === 200 && i3.data.dryRun === true, i3)
  const i4 = await a.post('/api/e/parties/import', { csv: 'name,status\nBad Status Co,NotAStatus\n', force: false })
  ok('failed rows come back as a CSV with the reason', i4.data.failed === 1 && /import_error/.test(i4.data.failedCsv ?? ''), i4.data)

  sec('Lead intake')
  const hook = (await a.post('/api/integrations/webhook-secret/lead')).data.url as string
  const path = new URL(hook).pathname
  const lead = { external_id: 'form-' + Date.now(), name: 'Web Lead', email: 'web.lead@example.com', phone: '+971501234567', message: 'Interested in a 2BR', source: 'Website' }
  const l1 = await a.post(path, lead)
  ok('first delivery creates a lead', l1.status === 201 && l1.data.new_lead === true, l1)
  const l2 = await a.post(path, lead)
  ok('retried delivery returns the same lead', l2.data.duplicate_delivery === true && l2.data.lead_id === l1.data.lead_id, l2)
  const l3 = await a.post(path, { ...lead, external_id: 'form-other-' + Date.now(), message: 'Second enquiry' })
  ok('a new enquiry from the same phone joins the open lead', l3.data.lead_id === l1.data.lead_id && l3.data.new_lead === false, l3)
  const l4 = await a.post(path.replace(/[^/]+$/, 'wrong'), lead)
  ok('wrong secret is a 404', l4.status === 404, l4)

  sec('Access: links, masking, branch scope, invites')
  const dxb = (await a.get('/api/e/branches')).data.rows[0].id
  const cust = (await a.post('/api/e/parties', { name: 'Link Co', is_customer: true, status: 'Active' })).data.id
  const job = (await a.post('/api/e/jobs', { deal_name: 'Link deal', deal_type: 'Sale', client_id: cust, branch_id: dxb, deal_date: '2026-10-01' })).data.id
  const t1 = (await a.post(`/api/jobs/${job}/tracking-token`)).data
  ok('tracking link works', (await a.call('GET', '/api/public/track/' + t1.token)).status === 200)
  await a.del(`/api/jobs/${job}/tracking-token`)
  ok('revoked tracking link is gone', (await a.call('GET', '/api/public/track/' + t1.token)).status === 404)
  const t2 = (await a.post(`/api/jobs/${job}/tracking-token`)).data
  ok('a new link is issued after revoke', t2.token !== t1.token && (await a.call('GET', '/api/public/track/' + t2.token)).status === 200)

  const roles = (await a.get('/api/e/roles?pageSize=50')).data.rows
  const roleId = roles.find((r: any) => r.name === 'Sales').id
  await a.post('/api/e/users', { name: 'Scoped PM', email: 'scoped@a.example', password: 'Manager-Pass-2026!', role_id: roleId, branch_id: dxb, active: true })
  await a.put('/api/admin/settings', { branch_scoped_roles: 'Sales', masked_fields: 'parties.phone' })
  await a.put(`/api/e/parties/${cust}`, { phone: '+971500000001' })
  const w = new Api(); ok('scoped user signs in', await w.login('scoped@a.example', 'Manager-Pass-2026!'))
  const seen = (await w.get('/api/e/parties?pageSize=50')).data.rows.find((r: any) => r.id === cust)
  ok('masked field shows the placeholder to a non-admin', seen?.phone === '••••', seen)
  ok('administrator still sees the real value', (await a.get(`/api/e/parties/${cust}`)).data.phone === '+971500000001')
  const put = await w.put(`/api/e/parties/${cust}`, { ...seen, name: 'Link Co 2', version: seen.version })
  ok('saving with the placeholder does not overwrite the value', put.status === 200 && (await a.get(`/api/e/parties/${cust}`)).data.phone === '+971500000001', put)

  const br2 = (await a.post('/api/e/branches', { name: 'Abu Dhabi', code: 'AUH' })).data.id
  const otherJob = (await a.post('/api/e/jobs', { deal_name: 'AUH deal', deal_type: 'Sale', client_id: cust, branch_id: br2, deal_date: '2026-10-01' })).data.id
  const jobs = (await w.get('/api/e/jobs?pageSize=50')).data.rows.map((r: any) => r.id)
  ok('branch-scoped role sees its own branch only', jobs.includes(job) && !jobs.includes(otherJob), jobs)
  ok('direct read of another branch record is hidden', (await w.get(`/api/e/jobs/${otherJob}`)).status === 404)

  const uid = (await a.get('/api/e/users?q=scoped@a.example')).data.rows[0].id
  const inv = await a.post(`/api/admin/users/${uid}/invite`)
  ok('administrator can send an invitation', inv.status === 200, inv)
  ok('bad invite token is refused', (await a.post('/api/public/invite/accept', { token: 'x'.repeat(48), password: 'Whatever-Pass-2026!' })).status === 400)
  ok('forgot-password never reveals whether an address exists', (await a.post('/api/public/invite/forgot', { email: 'nobody@example.com' })).data.ok === true)

  sec('Off-plan holds, commercial terms, assignments')
  const prop = (await a.post('/api/e/properties', { title: 'Hold Tower', property_type: 'Apartment', status: 'Off-Plan' })).data.id
  const unit = (await a.post('/api/e/units', { unit_no: 'H-101', property_id: prop, status: 'Available' })).data.id
  const b1 = (await a.post('/api/e/parties', { name: 'Buyer One', is_customer: true, status: 'Active' })).data.id
  const b2 = (await a.post('/api/e/parties', { name: 'Buyer Two', is_customer: true, status: 'Active' })).data.id
  const h1 = (await a.post('/api/e/unit_holds', { unit_id: unit, party_id: b1 })).data
  ok('first hold is Active and reserves the unit', h1.status === 'Active' && (await a.get(`/api/e/units/${unit}`)).data.status === 'Reserved', h1)
  const h2 = (await a.post('/api/e/unit_holds', { unit_id: unit, party_id: b2 })).data
  ok('second buyer queues behind it', h2.status === 'Queued' && h2.queue_position === 1, h2)
  const dup = await a.post('/api/e/unit_holds', { unit_id: unit, party_id: b2 })
  ok('same buyer cannot queue twice', dup.status === 400, dup)
  await a.put(`/api/e/unit_holds/${h1.id}`, { status: 'Released', version: h1.version })
  ok('releasing promotes the next buyer', (await a.get(`/api/e/unit_holds/${h2.id}`)).data.status === 'Active')
  const bad2 = await a.put(`/api/e/unit_holds/${h2.id}`, { status: 'Queued', version: (await a.get(`/api/e/unit_holds/${h2.id}`)).data.version })
  ok('status cannot be set by hand to Queued', bad2.status === 400, bad2)

  const ct = { job_id: job, party_id: cust, data_room_access: 'Granted', nda_status: 'Requested' }
  ok('data room needs a signed NDA', (await a.post('/api/e/commercial_terms', ct)).status === 400)
  const t = (await a.post('/api/e/commercial_terms', { ...ct, nda_status: 'Signed', nda_signed_date: '2026-10-01', commencement_date: '2026-11-01', break_clause_months: 24, break_notice_months: 6 })).data
  ok('break date and notice deadline are calculated', t.break_date === '2028-11-01' && t.break_notice_deadline === '2028-05-01', t)

  const asg = (await a.post('/api/e/offplan_assignments', { unit_id: unit, seller_id: b1, buyer_id: b2 })).data
  const done = await a.put(`/api/e/offplan_assignments/${asg.id}`, { status: 'Completed', version: asg.version })
  ok('assignment cannot complete with an open checklist', done.status === 400 && /Still needed/.test(done.data.error), done)
  const fin = await a.put(`/api/e/offplan_assignments/${asg.id}`, { status: 'Completed', version: asg.version, developer_consent: true, paid_to_date_confirmed: true, fees_paid: true, assignee_approved: true, assignee_kyc_cleared: true, revised_spa_ref: 'OQD-1' })
  ok('assignment completes once everything is confirmed', fin.status === 200, fin)
  finish()
}
main().catch(e => { console.error(e); process.exit(1) })
