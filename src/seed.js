// First-boot workspace for SWK Properties: CRM, listings, a work board, channels and starter automations.
import { one, run, hashPassword, token } from './db.js'

const f = (key, name, type = 'text', options) => ({ key, name, type, ...(options && { options }) })
const DEPTS = ['Off-Plan', 'Secondary', 'Leasing']

export function seed() {
  if (one('SELECT id FROM users LIMIT 1')) return null
  const email = process.env.ADMIN_EMAIL || 'admin@swk.local'
  const password = process.env.ADMIN_PASSWORD || token(9)
  const admin = run("INSERT INTO users(email,name,role,pass_hash) VALUES(?,?,'admin',?)", email, 'Admin', hashPassword(password)).lastInsertRowid

  const table = (name, kind, icon, fields, group) => {
    const g = fields.find(x => x.key === group)
    g.default = g.options[0] // new records start in the first board column, e.g. Leads → New
    return run('INSERT INTO tables(name,kind,icon,fields,group_field) VALUES(?,?,?,?,?)', name, kind, icon, JSON.stringify(fields), group).lastInsertRowid
  }

  const leads = table('Leads', 'crm', '🎯', [
    f('name', 'Name'), f('phone', 'Phone', 'phone'), f('email', 'Email', 'email'),
    f('source', 'Source', 'select', ['Bayut', 'Dubizzle', 'Property Finder', 'Website', 'WhatsApp', 'Referral', 'Walk-in']),
    f('department', 'Department', 'select', DEPTS), f('budget', 'Budget (AED)', 'number'),
    f('stage', 'Stage', 'select', ['New', 'Contacted', 'Qualified', 'Viewing', 'Offer', 'Won', 'Lost']),
    f('owner', 'Owner', 'user'), f('next_follow_up', 'Next follow-up', 'date'), f('notes', 'Notes', 'longtext'),
  ], 'stage')
  const deals = table('Deals', 'crm', '🤝', [
    f('title', 'Deal'), f('client', 'Client'), f('department', 'Department', 'select', DEPTS),
    f('value', 'Deal value (AED)', 'number'), f('commission', 'Gross commission (AED)', 'number'),
    f('stage', 'Stage', 'select', ['EOI / Booking', 'SPA / Form F', 'NOC / Ejari', 'Transfer', 'Closed', 'Withdrawn']),
    f('owner', 'Owner', 'user'), f('close_date', 'Close date', 'date'),
  ], 'stage')
  const listings = table('Listings', 'listings', '🏠', [
    f('reference', 'Reference'), f('title', 'Title'), f('purpose', 'Purpose', 'select', ['Sale', 'Rent']),
    f('type', 'Type', 'select', ['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Office', 'Retail', 'Plot']),
    f('community', 'Community'), f('building', 'Building'), f('bedrooms', 'Bedrooms', 'number'), f('bathrooms', 'Bathrooms', 'number'),
    f('size_sqft', 'Size (sqft)', 'number'), f('price', 'Price (AED)', 'number'), f('permit', 'Trakheesi permit'),
    f('agent', 'Agent', 'user'), f('status', 'Status', 'select', ['Draft', 'Published', 'Under offer', 'Sold / Rented', 'Archived']),
    f('description', 'Description', 'longtext'), f('photos', 'Photo URLs (comma separated)', 'longtext'),
  ], 'status')
  table('Marketing & Ops', 'board', '📋', [
    f('item', 'Item'), f('owner', 'Owner', 'user'), f('status', 'Status', 'select', ['To do', 'Working on it', 'Stuck', 'Done']),
    f('priority', 'Priority', 'select', ['Low', 'Medium', 'High']), f('due', 'Due', 'date'),
  ], 'status')

  const ch = {}
  for (const [name, topic] of [['general', 'Company-wide'], ['leads', 'New leads from every portal, auto-assigned'],
    ['offplan', 'Dept 01 — Off-plan sales'], ['secondary', 'Dept 02 — Secondary market'], ['leasing', 'Dept 03 — Leasing']]) {
    ch[name] = run('INSERT INTO channels(name,topic,created_by) VALUES(?,?,?)', name, topic, admin).lastInsertRowid
    run('INSERT INTO members(channel_id,user_id) VALUES(?,?)', ch[name], admin)
  }

  const hook = run('INSERT INTO hooks(token,name,table_id) VALUES(?,?,?)', token(), 'Portal & website leads', leads).lastInsertRowid
  const auto = (name, trigger, actions) => run('INSERT INTO automations(name,trigger,actions) VALUES(?,?,?)', name, JSON.stringify(trigger), JSON.stringify(actions))
  auto('Lead router', { type: 'record.created', table_id: leads }, [
    { type: 'assign_round_robin', field: 'owner' },
    { type: 'post_message', channel_id: ch.leads, text: 'New {{source}} lead: *{{name}}* {{phone}} — {{department}}, budget AED {{budget}}. Owner: {{owner}}' },
  ])
  auto('Won lead → deal', { type: 'record.updated', table_id: leads, field: 'stage', equals: 'Won' }, [
    { type: 'create_record', table_id: deals, data: { title: '{{name}} — {{department}}', client: '{{name}}', department: '{{department}}', value: '{{budget}}', stage: 'EOI / Booking', owner: '{{owner}}' } },
    { type: 'post_message', channel_id: ch.general, text: '🎉 {{owner}} won {{name}} ({{department}}). Deal file opened.' },
  ])
  auto('Listing published', { type: 'record.updated', table_id: listings, field: 'status', equals: 'Published' }, [
    { type: 'post_message', channel_id: ch.secondary, text: 'Live on portals: {{reference}} {{title}}, {{community}} — AED {{price}} ({{agent}})' },
  ])
  run('INSERT INTO settings(key,value) VALUES(?,?)', 'feed_key', token(16))
  return { email, password, hook }
}
