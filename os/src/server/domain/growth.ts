import { q } from '../db'
import { bad,nowIso,todayStr } from '../util'
import { notify,notifyLeadership } from '../notify'
import { getSetting } from '../settings'
import type { Hooks } from '../hooks'

const num = (v: any) => Number(v) || 0
const minutes = (key: string, fallback: number) => (num(getSetting(key)) > 0 ? num(getSetting(key)) : fallback)

// ------------------------------------------------------------------ lead scoring
export function scoreLead(l: Record<string, any>) {
  let s = 0
  if (l.phone) s += 15
  if (l.email) s += 10
  if (num(l.est_value) > 0) s += 10
  if (num(l.est_value) >= 200_000_000) s += 10 // 2M AED in fils
  if (['Referral', 'Existing customer'].includes(l.source)) s += 15
  else if (['Property Finder', 'Bayut', 'Dubizzle', 'Portal enquiry', 'Inbound call', 'WhatsApp'].includes(l.source)) s += 8
  if (['Cash Buyer', 'Mortgage Pre-Approved'].includes(l.buyer_finance_type)) s += 15
  if (l.marketing_consent === 'Opted in') s += 5
  if (l.interest) s += 5
  if (l.destination) s += 5
  if (l.bedrooms_wanted != null && l.bedrooms_wanted !== '') s += 5
  if (l.status === 'Contacted') s += 5
  if (l.status === 'Qualified') s += 20
  const score = Math.min(100, s)
  return { score, band: score >= 60 ? 'Hot' : score >= 35 ? 'Warm' : 'Cold' }
}

// ------------------------------------------------------------------ lead routing
function teamFor(rule: any): number[] {
  const roles = String(rule.team_roles || 'Sales').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  if (!roles.length) return []
  const rows = q.all<{ id: number }>(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND u.deleted_at IS NULL AND u.party_id IS NULL AND lower(r.name) IN (${roles.map(() => '?').join(',')}) ORDER BY u.id`, ...roles)
  return rows.map(r => r.id)
}

/** Picks the person who should own a new lead, or null when no rule matches. Advances the rule's cursor. */
export function pickLeadOwner(lead: Record<string, any>): { userId: number; rule: string } | null {
  const rules = q.all(`SELECT * FROM lead_routing_rules WHERE active = 1 AND deleted_at IS NULL ORDER BY priority, id`)
  for (const rule of rules) {
    if (rule.source && rule.source !== 'Any' && rule.source !== lead.source) continue
    if (rule.department_division && rule.department_division !== 'Any' && rule.department_division !== lead.department_division) continue
    const team = teamFor(rule)
    if (!team.length) continue
    let userId: number
    if (rule.strategy === 'Least open leads') {
      const load = new Map(team.map(id => [id, 0]))
      for (const r of q.all<{ owner_id: number; n: number }>(`SELECT owner_id, COUNT(*) n FROM leads WHERE deleted_at IS NULL AND status IN ('New','Contacted','Qualified') AND owner_id IN (${team.map(() => '?').join(',')}) GROUP BY owner_id`, ...team)) load.set(r.owner_id, r.n)
      userId = [...load.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0]
    } else {
      const next = team.find(id => id > num(rule.last_user_id)) ?? team[0]
      userId = next
    }
    q.run(`UPDATE lead_routing_rules SET last_user_id = ? WHERE id = ?`, userId, rule.id)
    return { userId, rule: rule.name }
  }
  return null
}

export const growthLeadHooks: Hooks = {
  beforeSave({ rec, old, isNew, ctx }) {
    if (isNew && !rec.owner_id && !rec.in_pool) {
      const pick = pickLeadOwner(rec)
      if (pick) { rec.owner_id = pick.userId; rec.routed_by = `Rule: ${pick.rule}` }
      else if (!ctx.system || rec.source) rec.routed_by = 'No routing rule matched'
    }
    if (isNew) rec.sla_due_at = new Date(Date.now() + minutes('lead_sla_minutes', 15) * 60_000).toISOString()
    if (rec.owner_id) rec.in_pool = false
    if (!rec.first_response_at && old && old.status === 'New' && rec.status !== 'New') rec.first_response_at = nowIso()
    const { score, band } = scoreLead(rec)
    rec.lead_score = score; rec.score_band = band
  },
  afterSave({ rec, isNew }) {
    if (isNew && rec.owner_id) notify(rec.owner_id, `New ${rec.score_band ?? ''} lead: ${rec.company}`, `Respond within ${minutes('lead_sla_minutes', 15)} min`, `/e/leads/${rec.id}`, 'info', `lead-new-${rec.id}`)
  },
}

/** Escalates leads nobody has answered: warns leadership past the SLA, then returns the lead to the pool so anyone can claim it. */
export function sweepLeadSla() {
  const now = nowIso()
  const poolAfter = minutes('lead_pool_after_minutes', 60)
  let warned = 0, pooled = 0
  const open = q.all(`SELECT id, lead_no, company, owner_id, sla_due_at, created_at FROM leads WHERE deleted_at IS NULL AND status = 'New' AND first_response_at IS NULL AND COALESCE(in_pool, 0) = 0 AND sla_due_at IS NOT NULL AND sla_due_at < ?`, now)
  for (const l of open) {
    const overdueMin = (Date.now() - new Date(l.sla_due_at).getTime()) / 60_000
    if (overdueMin >= poolAfter) {
      q.run(`UPDATE leads SET owner_id = NULL, in_pool = 1, routed_by = 'Returned to pool: no response' WHERE id = ?`, l.id)
      q.run(`INSERT INTO comments(entity, record_id, user_id, body, created_at) VALUES ('leads', ?, (SELECT MIN(id) FROM users), ?, ?)`, l.id, 'No first response in time. Returned to the lead pool.', now)
      notify(l.owner_id, `Lead moved to pool: ${l.company}`, 'No response within the allowed time', `/e/leads/${l.id}`, 'audit', `lead-pool-${l.id}`)
      pooled++
    } else {
      notify(l.owner_id, `SLA missed: ${l.company}`, 'Respond now or the lead goes to the pool', `/e/leads/${l.id}`, 'audit', `lead-sla-${l.id}`)
      notifyLeadership('Lead SLA missed', `${l.lead_no} ${l.company} has no first response`, `/e/leads/${l.id}`, 'audit', `lead-sla-lead-${l.id}`)
      warned++
    }
  }
  return { warned, pooled }
}

export function claimLead(id: number, userId: number) {
  const l = q.get(`SELECT id, in_pool, owner_id FROM leads WHERE id = ? AND deleted_at IS NULL`, id)
  if (!l) throw bad('Lead not found')
  if (!l.in_pool && l.owner_id) throw bad('This lead already has an owner')
  const claimed = q.run(`UPDATE leads SET owner_id = ?, in_pool = 0, routed_by = 'Claimed from pool', sla_due_at = ? WHERE id = ? AND COALESCE(in_pool, 0) = 1`, userId, new Date(Date.now() + minutes('lead_sla_minutes', 15) * 60_000).toISOString(), id)
  if (!(claimed as any)?.changes) throw bad('Someone else just claimed this lead')
  return { ok: true, lead_id: id }
}

// ------------------------------------------------------------------ mortgage cases
export const mortgageHooks: Hooks = {
  beforeSave({ rec, old }) {
    const value = num(rec.property_value), loan = num(rec.loan_amount)
    if (loan > value && value > 0) throw bad('The loan amount cannot be more than the property value')
    rec.ltv_pct = value > 0 ? Math.round((loan / value) * 1000) / 10 : 0
    rec.referral_commission = Math.round(loan * (num(rec.referral_commission_pct) / 100))
    const st = rec.status, was = old?.status
    if (st !== was) {
      if (['Submitted to Bank', 'Pre-Approved', 'Valuation Done', 'Final Offer Letter', 'Offer Signed', 'Disbursed'].includes(st) && !rec.bank) throw bad('Choose the bank before moving the case past Referred')
      if (st === 'Submitted to Bank') rec.submitted_date ||= todayStr()
      if (st === 'Pre-Approved') rec.preapproval_date ||= todayStr()
      if (st === 'Final Offer Letter') rec.offer_date ||= todayStr()
      if (st === 'Disbursed') rec.disbursed_date ||= todayStr()
      if (['Declined', 'Cancelled'].includes(st) && !String(rec.decline_reason ?? '').trim()) throw bad('Enter the reason the case was declined or cancelled')
      if (was === 'Disbursed' && st !== 'Disbursed') throw bad('A disbursed case cannot be reopened')
    }
    if (rec.commission_received && st !== 'Disbursed') throw bad('Commission can only be marked received after the loan is disbursed')
  },
  afterSave({ rec, old }) {
    if (old && old.status !== rec.status) notify(rec.owner_id, `Mortgage ${rec.case_no}: ${rec.status}`, rec.client_name ?? '', `/e/mortgage_cases/${rec.id}`, 'info')
  },
}

// ------------------------------------------------------------------ payment plans
export const paymentPlanHooks: Hooks = {
  beforeSave({ rec }) {
    const total = num(rec.booking_pct) + num(rec.construction_pct) + num(rec.handover_pct) + num(rec.post_handover_pct)
    if (Math.abs(total - 100) > 0.001) throw bad(`The split must total 100%. It totals ${total}%`)
    if (num(rec.construction_pct) > 0 && num(rec.construction_instalments) < 1) throw bad('Enter how many construction instalments there are')
    if (num(rec.post_handover_pct) > 0 && num(rec.post_handover_months) < 1) throw bad('Enter the post-handover months')
  },
}

/** Builds the dated schedule for a plan. Amounts are in AED, the last line of each stage absorbs rounding. */
export function buildSchedule(plan: any, priceAed: number, startDate: string, handoverDate: string) {
  const out: { stage: string; due: string; pct: number; amount: number }[] = []
  const add = (d: string, m: number) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + m); return t.toISOString().slice(0, 10) }
  const part = (stage: string, due: string[], pct: number) => {
    if (!pct || !due.length) return
    const total = Math.round(priceAed * pct / 100), each = Math.floor(total / due.length)
    due.forEach((d, i) => out.push({ stage, due: d, pct: Math.round(pct / due.length * 100) / 100, amount: i === due.length - 1 ? total - each * (due.length - 1) : each }))
  }
  part('Booking', [startDate], num(plan.booking_pct))
  const n = Math.max(1, num(plan.construction_instalments)), gap = num(plan.instalment_gap_months) || 3
  part('During construction', Array.from({ length: num(plan.construction_pct) ? n : 0 }, (_, i) => add(startDate, gap * (i + 1))), num(plan.construction_pct))
  part('On handover', [handoverDate], num(plan.handover_pct))
  const pm = num(plan.post_handover_months)
  part('Post-handover', Array.from({ length: num(plan.post_handover_pct) ? pm : 0 }, (_, i) => add(handoverDate, i + 1)), num(plan.post_handover_pct))
  const sum = out.reduce((s, r) => s + r.amount, 0)
  return { schedule: out, total: sum, price: priceAed }
}

// ------------------------------------------------------------------ commission holdbacks
export const holdbackHooks: Hooks = {
  beforeSave({ rec, old }) {
    const pct = num(rec.holdback_pct)
    if (pct < 0 || pct > 100) throw bad('Holdback must be between 0 and 100%')
    if (pct > 0 && !rec.holdback_release_date) throw bad('Enter the date the holdback is released')
    rec.holdback_amount = Math.round(num(rec.agent_share) * pct / 100)
    if (rec.holdback_released && !old?.holdback_released && rec.holdback_release_date && rec.holdback_release_date > todayStr()) throw bad('The release date has not arrived yet')
    const gross = num(rec.agent_share) + num(rec.vat_amount) - num(rec.deductions)
    if (pct > 0 && !rec.holdback_released) rec.net_payable = Math.max(0, gross - num(rec.holdback_amount))
  },
}

// ------------------------------------------------------------------ matching with reasons
export function matchUnitsForLead(leadId: number) {
  const l = q.get(`SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL`, leadId)
  if (!l) throw bad('Lead not found')
  const rent = l.department_division === 'Leasing'
  const units = q.all(`SELECT u.id, u.unit_no, u.status, u.bedrooms, u.area_sqft, u.sale_price, u.rent_annual, u.floor_plan_url, p.title AS property_title, p.sub_community, p.building_name, p.address FROM units u JOIN properties p ON p.id = u.property_id WHERE u.deleted_at IS NULL AND u.status = 'Available'`)
  const budget = num(l.est_value), area = String(l.destination || '').toLowerCase()
  return units.map(u => {
    const reasons: string[] = [], concerns: string[] = []
    let score = 0
    const price = num(rent ? u.rent_annual : u.sale_price)
    const place = `${u.sub_community ?? ''} ${u.building_name ?? ''} ${u.address ?? ''} ${u.property_title ?? ''}`.toLowerCase()
    if (area && area.split(/[\s,]+/).filter(w => w.length > 2).some(w => place.includes(w))) { score += 35; reasons.push('Location matches the requested area') }
    else if (area) concerns.push('Outside the requested area')
    if (budget > 0 && price > 0) {
      if (price <= budget) { score += 35; reasons.push('Within budget') }
      else if (price <= budget * 1.1) { score += 15; concerns.push('Up to 10% over budget') }
      else concerns.push('Over budget')
    }
    if (l.bedrooms_wanted != null && l.bedrooms_wanted !== '') {
      if (num(u.bedrooms) === num(l.bedrooms_wanted)) { score += 25; reasons.push(`${u.bedrooms} bedrooms as asked`) }
      else concerns.push(`${u.bedrooms ?? '?'} bedrooms, wanted ${l.bedrooms_wanted}`)
    }
    if (u.floor_plan_url) { score += 5; reasons.push('Floor plan available') }
    return { unit_id: u.id, unit_no: u.unit_no, property: u.property_title, bedrooms: u.bedrooms, area_sqft: u.area_sqft, price_aed: price / 100, score, reasons, concerns }
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 10)
}

export function matchLeadsForUnit(unitId: number) {
  const u = q.get(`SELECT u.*, p.sub_community, p.building_name, p.address, p.title AS property_title FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ? AND u.deleted_at IS NULL`, unitId)
  if (!u) throw bad('Unit not found')
  const place = `${u.sub_community ?? ''} ${u.building_name ?? ''} ${u.address ?? ''} ${u.property_title ?? ''}`.toLowerCase()
  const leads = q.all(`SELECT id, lead_no, company, department_division, destination, est_value, bedrooms_wanted, owner_id FROM leads WHERE deleted_at IS NULL AND status IN ('New','Contacted','Qualified')`)
  return leads.map(l => {
    const rent = l.department_division === 'Leasing'
    const price = num(rent ? u.rent_annual : u.sale_price)
    const reasons: string[] = [], concerns: string[] = []
    let score = 0
    const area = String(l.destination || '').toLowerCase()
    if (area && area.split(/[\s,]+/).filter(w => w.length > 2).some(w => place.includes(w))) { score += 35; reasons.push('Wants this area') }
    if (num(l.est_value) > 0 && price > 0) {
      if (price <= num(l.est_value)) { score += 35; reasons.push('Within their budget') } else if (price <= num(l.est_value) * 1.1) { score += 15; concerns.push('Up to 10% over budget') } else concerns.push('Over budget')
    }
    if (l.bedrooms_wanted != null && l.bedrooms_wanted !== '' && num(u.bedrooms) === num(l.bedrooms_wanted)) { score += 25; reasons.push('Bedrooms match') }
    return { lead_id: l.id, lead_no: l.lead_no, company: l.company, owner_id: l.owner_id, score, reasons, concerns }
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 10)
}

// ------------------------------------------------------------------ leaderboard
export function leaderboard(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('Month must look like 2026-11')
  const from = `${month}-01`, to = `${month}-32`
  const users = q.all<{ id: number; name: string }>(`SELECT id, name FROM users WHERE active = 1 AND deleted_at IS NULL AND party_id IS NULL ORDER BY name`)
  const group = (sql: string, ...a: any[]) => new Map(q.all<{ k: number; n: number }>(sql, ...a).map(r => [r.k, r.n]))
  const converted = group(`SELECT owner_id k, COUNT(*) n FROM leads WHERE deleted_at IS NULL AND status = 'Converted' AND updated_at >= ? AND updated_at < ? GROUP BY owner_id`, from, to)
  const newLeads = group(`SELECT owner_id k, COUNT(*) n FROM leads WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY owner_id`, from, to)
  const calls = group(`SELECT owner_id k, COUNT(*) n FROM activities WHERE deleted_at IS NULL AND type = 'Call' AND status = 'Done' AND start_at >= ? AND start_at < ? GROUP BY owner_id`, from, to)
  const wonN = group(`SELECT owner_id k, COUNT(*) n FROM opportunities WHERE deleted_at IS NULL AND stage = 'Won' AND updated_at >= ? AND updated_at < ? GROUP BY owner_id`, from, to)
  const wonV = group(`SELECT owner_id k, COALESCE(SUM(value),0) n FROM opportunities WHERE deleted_at IS NULL AND stage = 'Won' AND updated_at >= ? AND updated_at < ? GROUP BY owner_id`, from, to)
  const targets = q.all(`SELECT user_id, metric, target FROM agent_targets WHERE period = ? AND deleted_at IS NULL`, month)
  const metric = (id: number): Record<string, number> => ({ 'Leads converted': converted.get(id) ?? 0, 'Calls logged': calls.get(id) ?? 0, 'Deals won': wonN.get(id) ?? 0, 'Won value (AED)': Math.round((wonV.get(id) ?? 0) / 100), 'Viewings held': 0 })
  const viewings = group(`SELECT e.user_id k, COUNT(*) n FROM viewings v JOIN agents a ON a.id = v.agent_id JOIN employees e ON e.id = a.employee_id WHERE v.deleted_at IS NULL AND v.status = 'Completed' AND v.scheduled_at >= ? AND v.scheduled_at < ? GROUP BY e.user_id`, from, to)
  const rows = users.map(u => {
    const m = metric(u.id); m['Viewings held'] = viewings.get(u.id) ?? 0
    const goals = targets.filter(t => t.user_id === u.id).map(t => ({ metric: t.metric, target: t.target, actual: m[t.metric] ?? 0, pct: t.target > 0 ? Math.min(100, Math.round(((m[t.metric] ?? 0) / t.target) * 100)) : 0 }))
    return { user_id: u.id, name: u.name, new_leads: newLeads.get(u.id) ?? 0, ...m, goals, points: m['Deals won'] * 50 + m['Leads converted'] * 20 + m['Viewings held'] * 5 + m['Calls logged'] }
  }).sort((a, b) => b.points - a.points)
  return { month, rows }
}
