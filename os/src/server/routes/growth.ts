import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { q } from '../db'
import { bad,nowIso,fromCents } from '../util'
import { getSetting } from '../settings'
import { z } from 'zod'
import { createRecord,getDef,patchRecord,SYSTEM_CTX } from '../engine'
import { idOf,need } from './helpers'
import { sendDraft,hashToken } from '../domain/followups'

const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (cents: number) => 'AED ' + Math.round(fromCents(cents)).toLocaleString('en-US')
const page = (title: string, inner: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1c1c1c}h1{font-size:24px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;background:#f5f5f2;padding:16px;border-radius:12px}button{background:#ff5b1f;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:16px;cursor:pointer}input{padding:10px;border:1px solid #bbb;border-radius:8px;width:100%;box-sizing:border-box;margin:8px 0 14px}.ghost{background:#eee;color:#1c1c1c}</style>${inner}`

/** Reads phrases like "2 bed marina under 2.5m" into filters. */
export function parseAsk(text: string) {
  const t = text.toLowerCase()
  const bed = /studio/.test(t) ? 0 : Number(/(\d+)\s*(?:bed|br|bhk|bedroom)/.exec(t)?.[1] ?? NaN)
  const pm = /(?:under|below|max|up to|budget)\s*(?:aed\s*)?([\d.,]+)\s*(m|mn|million|k)?/.exec(t)
  let max = pm ? Number(pm[1].replace(/,/g, '')) : NaN
  if (pm?.[2]) max *= /^k/.test(pm[2]) ? 1_000 : 1_000_000
  const words = t.replace(/(\d+\s*(?:bed|br|bhk|bedroom)s?|studio|(?:under|below|max|up to|budget)\s*(?:aed\s*)?[\d.,]+\s*(?:m|mn|million|k)?|for (?:rent|sale)|apartments?|villas?|units?|in|at|near|with|a|an|the)/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 2)
  return { bedrooms: Number.isFinite(bed) ? bed : null, max_aed: Number.isFinite(max) ? max : null, words, rent: /rent|lease/.test(t) }
}

const WO_STATUS = ['In Progress', 'Awaiting Parts', 'Completed']
export default async function (app: FastifyInstance) {
  // ---- tenant / landlord / vendor portal. All three see only maintenance records that name their own party.
  const party = (req: any) => { need(req, 'dashboard', 'view', { portal: true }); if (!req.user?.party_id) throw bad('Portal accounts only'); return req.user.party_id as number }
  const note = (id: number, uid: number, text: string) => q.run(`INSERT INTO comments(entity, record_id, user_id, body, created_at) VALUES ('maintenance', ?, ?, ?, ?)`, id, uid, text, nowIso())
  app.post('/api/portal/maintenance', async (req) => {
    const pid = party(req)
    const b = z.object({ lease_id: z.number().int(), category: z.string().max(40), description: z.string().trim().min(5).max(2000), priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional() }).parse(req.body ?? {})
    const lease = q.get(`SELECT id, unit_id, landlord_id FROM leases WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, b.lease_id, pid)
    if (!lease) throw bad('Lease not found')
    const rec = createRecord(getDef('maintenance'), { lease_id: lease.id, unit_id: lease.unit_id, tenant_id: pid, landlord_id: lease.landlord_id ?? null, category: b.category, description: b.description, priority: b.priority ?? 'Medium', status: 'Reported' }, SYSTEM_CTX)
    return { id: rec.id, request_no: rec.request_no }
  })
  app.post('/api/portal/maintenance/:id/vendor-update', async (req) => {
    const pid = party(req), id = idOf((req.params as any).id)
    const b = z.object({ status: z.enum(WO_STATUS as [string, ...string[]]).optional(), quote: z.number().min(0).max(10_000_000).optional(), note: z.string().max(1000).optional() }).parse(req.body ?? {})
    const m = q.get(`SELECT id, status FROM maintenance WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL`, id, pid)
    if (!m) throw bad('Work order not found')
    if (b.status === 'Completed' && q.get(`SELECT 1 AS x FROM maintenance WHERE id = ? AND landlord_approval = 'Awaiting'`, id)) throw bad('Wait for the landlord to approve the quote first')
    const patch: Record<string, any> = {}
    if (b.status) patch.status = b.status
    if (b.quote != null) { patch.estimated_cost = b.quote; patch.landlord_approval = 'Awaiting'; patch.requires_approval = true }
    if (Object.keys(patch).length) patchRecord(getDef('maintenance'), id, patch, SYSTEM_CTX)
    if (b.note) note(id, req.user!.id, `Vendor: ${b.note}`)
    return { ok: true }
  })
  app.post('/api/portal/maintenance/:id/landlord-decision', async (req) => {
    const pid = party(req), id = idOf((req.params as any).id)
    const b = z.object({ approve: z.boolean() }).parse(req.body ?? {})
    if (!q.get(`SELECT 1 AS x FROM maintenance WHERE id = ? AND landlord_id = ? AND landlord_approval = 'Awaiting' AND deleted_at IS NULL`, id, pid)) throw bad('Nothing waiting for your approval')
    patchRecord(getDef('maintenance'), id, { landlord_approval: b.approve ? 'Approved' : 'Declined' }, SYSTEM_CTX)
    note(id, req.user!.id, b.approve ? 'Landlord approved the quote' : 'Landlord declined the quote')
    return { ok: true }
  })
  app.post('/api/portal/maintenance/:id/feedback', async (req) => {
    const pid = party(req), id = idOf((req.params as any).id)
    const b = z.object({ feedback: z.string().trim().min(2).max(1000) }).parse(req.body ?? {})
    if (!q.get(`SELECT 1 AS x FROM maintenance WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, id, pid)) throw bad('Request not found')
    patchRecord(getDef('maintenance'), id, { tenant_feedback: b.feedback }, SYSTEM_CTX)
    return { ok: true }
  })

  app.post('/api/message-drafts/:id/send', async (req) => { need(req, 'crm', 'edit'); return sendDraft(idOf((req.params as any).id)) })

  app.get('/api/growth/ask', async (req) => {
    need(req, 'properties', 'view')
    const text = String((req.query as any).q ?? '').slice(0, 200)
    if (!text.trim()) throw bad('Type what you are looking for')
    const f = parseAsk(text)
    const rows = q.all(`SELECT u.id, u.unit_no, u.bedrooms, u.area_sqft, u.sale_price, u.rent_annual, p.title, p.sub_community, p.building_name FROM units u JOIN properties p ON p.id = u.property_id WHERE u.deleted_at IS NULL AND u.status = 'Available'`)
    const hits = rows.map(u => {
      const price = f.rent ? u.rent_annual : u.sale_price
      if (f.bedrooms != null && Number(u.bedrooms) !== f.bedrooms) return null
      if (f.max_aed != null && price > 0 && price > f.max_aed * 100) return null
      const place = `${u.title} ${u.sub_community ?? ''} ${u.building_name ?? ''}`.toLowerCase()
      const hit = f.words.filter(w => place.includes(w)).length
      if (f.words.length && !hit) return null
      return { ...u, price_aed: price / 100, score: hit }
    }).filter(Boolean).sort((a: any, b: any) => b.score - a.score).slice(0, 25)
    return { understood: f, results: hits }
  })

  // Printable branded shortlist for a buyer.
  app.get('/api/growth/presentation', async (req, reply) => {
    need(req, 'properties', 'view')
    const ids = String((req.query as any).units ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 30)
    if (!ids.length) throw bad('Choose at least one unit')
    const client = esc(String((req.query as any).client ?? '').slice(0, 80))
    const units = q.all(`SELECT u.*, p.title, p.sub_community, p.building_name FROM units u JOIN properties p ON p.id = u.property_id WHERE u.deleted_at IS NULL AND u.id IN (${ids.map(() => '?').join(',')})`, ...ids)
    const rows = units.map(u => `<tr><td><b>${esc(u.title)}</b><br>${esc(u.unit_no)} · ${esc(u.sub_community ?? u.building_name ?? '')}</td><td>${esc(u.bedrooms ?? '')} bed</td><td>${esc(u.area_sqft ?? '')} sq ft</td><td>${u.sale_price ? money(u.sale_price) : u.rent_annual ? money(u.rent_annual) + ' / yr' : ''}</td><td>${u.floor_plan_url ? `<a href="${esc(u.floor_plan_url)}">Floor plan</a> ` : ''}${u.virtual_tour_url ? `<a href="${esc(u.virtual_tour_url)}">Virtual tour</a>` : ''}</td></tr>`).join('')
    return reply.type('text/html; charset=utf-8').send(page('Property shortlist', `<h1>${esc(getSetting('company_name') || 'SWK Properties')}</h1><p>${client ? `Prepared for ${client}. ` : ''}${new Date().toISOString().slice(0, 10)}</p><table><tr><th>Property</th><th>Beds</th><th>Size</th><th>Price</th><th></th></tr>${rows}</table><p><small>Prices and availability are subject to change and do not form an offer.</small></p><p><button onclick="print()">Print / save PDF</button></p>`))
  })

  // ---- e-sign
  app.post('/api/esign/:id/send', async (req) => {
    need(req, 'documents', 'edit')
    const id = idOf((req.params as any).id), r = q.get(`SELECT status FROM esign_requests WHERE id = ? AND deleted_at IS NULL`, id)
    if (!r) throw bad('Request not found')
    if (['Signed', 'Declined'].includes(r.status)) throw bad(`This request is already ${r.status.toLowerCase()}`)
    const token = crypto.randomBytes(24).toString('hex')
    const link = `${String(process.env.BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/+$/, '')}/api/public/sign/${token}`
    q.run(`UPDATE esign_requests SET status = 'Sent', sign_token_hash = ?, sign_link = ? WHERE id = ?`, hashToken(token), link, id)
    return { link }
  })
  const find = (token: string) => (/^[0-9a-f]{48}$/.test(token) ? q.get(`SELECT * FROM esign_requests WHERE sign_token_hash = ? AND deleted_at IS NULL`, hashToken(token)) : null)
  app.get('/api/public/sign/:token', async (req, reply) => {
    const r = find((req.params as any).token)
    if (!r) return reply.status(404).type('text/html').send(page('Not found', '<h1>Link not found</h1>'))
    if (r.status !== 'Sent') return reply.type('text/html').send(page(r.title, `<h1>${esc(r.title)}</h1><p>This document is ${esc(r.status.toLowerCase())}.</p>`))
    return reply.type('text/html; charset=utf-8').send(page(r.title, `<h1>${esc(r.title)}</h1><pre>${esc(r.document_text)}</pre><p><small>Fingerprint ${esc(r.document_hash)}</small></p><form method="post"><label>Type your full name to sign<input name="name" required maxlength="120" autocomplete="name"></label><button>I agree and sign</button> <button class="ghost" name="decline" value="1" formnovalidate>Decline</button></form>`))
  })
  app.post('/api/public/sign/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = find((req.params as any).token)
    if (!r || r.status !== 'Sent') return reply.status(404).type('text/html').send(page('Not available', '<h1>This link is no longer valid</h1>'))
    const b = (req.body ?? {}) as any
    if (b.decline) { q.run(`UPDATE esign_requests SET status = 'Declined' WHERE id = ?`, r.id); return reply.type('text/html').send(page('Declined', '<h1>Declined</h1>')) }
    const name = String(b.name ?? '').trim()
    if (name.length < 3) return reply.status(400).type('text/html').send(page('Name needed', '<h1>Type your full name to sign</h1>'))
    q.run(`UPDATE esign_requests SET status = 'Signed', signed_at = ?, signed_name = ?, signed_ip = ? WHERE id = ?`, nowIso(), name.slice(0, 120), req.ip, r.id)
    return reply.type('text/html').send(page('Signed', `<h1>Thank you, ${esc(name)}</h1><p>Your signature on "${esc(r.title)}" has been recorded.</p>`))
  })
}
