import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { q,tx } from '../db'
import { createRecord,getDef,getRecord,patchRecord,SYSTEM_CTX,assertCan } from '../engine'
import { bad,todayStr } from '../util'
import { body,idOf,need } from './helpers'
import { convertLead,convertQuoteToJob,reviseQuote,sendQuote } from '../domain/sales'
import { approvalAction } from '../domain/finance'
import { claimLead,sweepLeadSla,leaderboard,matchUnitsForLead,matchLeadsForUnit,buildSchedule } from '../domain/growth'

export default async function (app: FastifyInstance) {
  const qid = (req: any) => idOf(req.params.id)

  app.post('/api/quotes/:id/send', async (req) => { need(req, 'sales', 'edit'); const b = z.object({ to: z.string().email().optional(), message: z.string().max(3000).optional() }).parse(req.body ?? {}); return tx(() => sendQuote(qid(req), b.to, b.message, req.ctx)) })
  app.post('/api/quotes/:id/convert', async (req) => { need(req, 'sales', 'edit'); need(req, 'sales', 'create'); return tx(() => convertQuoteToJob(qid(req), req.ctx)) })
  app.post('/api/quotes/:id/revise', async (req) => { need(req, 'sales', 'create'); return tx(() => reviseQuote(qid(req), req.ctx)) })
  app.post('/api/quotes/:id/accept', async (req) => {
    need(req, 'sales', 'edit')
    const id = qid(req); const qt = getRecord(getDef('quotations'), id, req.ctx, { children: false })
    if (['Pending', 'Rejected'].includes(qt.approval_status)) throw bad('Margin approval is required first')
    if (!['Sent', 'Approved'].includes(qt.status)) throw bad('Only sent quotations can be accepted')
    return patchRecord(getDef('quotations'), id, { status: 'Accepted' }, req.ctx)
  })
  app.post('/api/quotes/:id/reject', async (req) => {
    need(req, 'sales', 'edit')
    const b = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})
    return patchRecord(getDef('quotations'), qid(req), { status: 'Rejected', rejection_reason: b.reason ?? null }, req.ctx)
  })
  app.post('/api/leads/:id/claim', async (req) => { need(req, 'crm', 'edit'); if (!req.user) throw bad('Sign in'); return tx(() => claimLead(idOf((req.params as any).id), req.user!.id)) })
  app.post('/api/leads/sla-sweep', async (req) => { need(req, 'crm', 'edit'); return tx(() => sweepLeadSla()) })
  app.get('/api/growth/leaderboard', async (req) => { need(req, 'crm', 'view'); return leaderboard(String((req.query as any).month || todayStr().slice(0, 7))) })
  app.get('/api/growth/match/lead/:id', async (req) => { need(req, 'crm', 'view'); return { matches: matchUnitsForLead(idOf((req.params as any).id)) } })
  app.get('/api/growth/match/unit/:id', async (req) => { need(req, 'properties', 'view'); return { matches: matchLeadsForUnit(idOf((req.params as any).id)) } })
  app.get('/api/growth/payment-schedule', async (req) => {
    need(req, 'properties', 'view')
    const b = z.object({ plan: z.coerce.number().int(), price: z.coerce.number().positive(), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), handover: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query)
    const plan = q.get(`SELECT * FROM payment_plan_templates WHERE id = ? AND deleted_at IS NULL`, b.plan)
    if (!plan) throw bad('Payment plan not found')
    if (b.handover < b.start) throw bad('Handover cannot be before the start date')
    return { plan: plan.name, ...buildSchedule(plan, b.price, b.start, b.handover) }
  })
  app.post('/api/leads/:id/convert', async (req) => { need(req, 'crm', 'create'); return tx(() => convertLead(idOf((req.params as any).id), req.ctx)) })
  app.post('/api/opportunities/:id/quote', async (req) => {
    need(req, 'sales', 'create')
    const o = getRecord(getDef('opportunities'), idOf((req.params as any).id), req.ctx, { children: false })
    const M2SVC: Record<string, string> = { 'Property Management': 'Property management', 'Apartment Lease': 'Lease commission', 'Villa Lease': 'Lease commission', 'Commercial Lease': 'Lease commission', 'Off-Plan Sale': 'Off-Plan purchase' }
    const service = M2SVC[o.mode] ?? (String(o.mode ?? '').includes('Sale') ? 'Sale commission' : 'Valuation')
    const quote = createRecord(getDef('quotations'), { customer_id: o.party_id, contact_id: o.contact_id, salesperson_id: o.owner_id ?? req.user!.id, mode: service, opportunity_id: o.id, quote_date: todayStr(), notes: `Opportunity ${o.opp_no}: ${o.title}${o.destination ? ` · Target area: ${o.destination}` : ''}` }, req.ctx)
    if (o.stage === 'Prospecting' || o.stage === 'Qualification') patchRecord(getDef('opportunities'), o.id, { stage: 'Quotation' }, req.ctx)
    return quote
  })

  // generic approvals (bills, payments, quotations, purchase orders)
  app.post('/api/approvals/:entity/:id/:action', async (req) => {
    const p = req.params as any
    if (!['bills', 'payments', 'quotations', 'purchase_orders'].includes(p.entity)) throw bad('Approvals are not used for this record type')
    if (!['request', 'approve', 'reject'].includes(p.action)) throw bad('Unknown action')
    const def = getDef(p.entity)
    assertCan(req.ctx, def.module, p.action === 'request' ? 'edit' : 'view')
    const b = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})
    return tx(() => approvalAction(p.entity, idOf(p.id), p.action, b.reason, req.ctx))
  })
  void body; void SYSTEM_CTX
}
