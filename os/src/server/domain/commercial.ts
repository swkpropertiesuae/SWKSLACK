import { q } from '../db'
import { bad,nowIso } from '../util'
import { notify } from '../notify'
import { getSetting } from '../settings'
import type { Hooks } from '../hooks'

const addMonths = (d: string, m: number) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + m); return t.toISOString().slice(0, 10) }
const unitTitle = (id: number) => q.val<string>(`SELECT unit_no FROM units WHERE id = ? AND deleted_at IS NULL`, id) ?? ''
const holdHours = () => Number(getSetting('unit_hold_hours')) > 0 ? Number(getSetting('unit_hold_hours')) : 48

/** Makes the head of the queue the Active hold for a unit that has none, or frees the unit when nobody is waiting. */
function promoteNext(unitId: number) {
  if (q.get(`SELECT id FROM unit_holds WHERE unit_id = ? AND status = 'Active' AND deleted_at IS NULL`, unitId)) return
  const next = q.get(`SELECT id, party_id FROM unit_holds WHERE unit_id = ? AND status = 'Queued' AND deleted_at IS NULL ORDER BY queue_position, id LIMIT 1`, unitId)
  if (next) {
    q.run(`UPDATE unit_holds SET status = 'Active', queue_position = NULL, hold_until = ? WHERE id = ?`, new Date(Date.now() + holdHours() * 3600_000).toISOString(), next.id)
    notify(q.val<number>(`SELECT created_by FROM unit_holds WHERE id = ?`, next.id), 'Your queued unit hold is now active', `Unit ${unitTitle(unitId)}`, `/e/unit_holds/${next.id}`)
  } else q.run(`UPDATE units SET status = 'Available' WHERE id = ? AND status = 'Reserved'`, unitId)
}

/** Expires Active holds past their time and promotes the next in each queue. Run on a timer and before every new hold. */
export function expireHolds() {
  const due = q.all(`SELECT id, unit_id FROM unit_holds WHERE status = 'Active' AND hold_until < ? AND deleted_at IS NULL`, nowIso())
  for (const h of due) { q.run(`UPDATE unit_holds SET status = 'Expired' WHERE id = ?`, h.id); promoteNext(h.unit_id) }
  return due.length
}

export const unitHoldHooks: Hooks = {
  beforeSave({ rec, old, isNew }) {
    if (isNew) {
      expireHolds()
      const unit = q.get(`SELECT status FROM units WHERE id = ? AND deleted_at IS NULL`, rec.unit_id)
      if (!unit) throw bad('Unit not found')
      if (!['Available', 'Reserved'].includes(unit.status)) throw bad(`This unit is ${unit.status} and cannot be held`)
      if (q.get(`SELECT id FROM unit_holds WHERE unit_id = ? AND party_id = ? AND status IN ('Active','Queued') AND deleted_at IS NULL`, rec.unit_id, rec.party_id)) throw bad('This buyer already has a hold or a place in the queue for this unit')
      const taken = q.get(`SELECT id FROM unit_holds WHERE unit_id = ? AND status = 'Active' AND deleted_at IS NULL`, rec.unit_id)
      if (taken) { rec.status = 'Queued'; rec.queue_position = (q.val<number>(`SELECT MAX(queue_position) FROM unit_holds WHERE unit_id = ? AND status = 'Queued' AND deleted_at IS NULL`, rec.unit_id) ?? 0) + 1; rec.hold_until = null }
      else { rec.status = 'Active'; rec.queue_position = null; rec.hold_until = new Date(Date.now() + holdHours() * 3600_000).toISOString() }
    } else if (old && rec.status !== old.status && !['Converted', 'Released'].includes(rec.status)) {
      throw bad('Holds expire and queue on their own. Set a hold to Converted or Released only.')
    }
    rec.unit_title = unitTitle(rec.unit_id)
  },
  afterSave({ rec, old, isNew }) {
    if (isNew && rec.status === 'Active') q.run(`UPDATE units SET status = 'Reserved' WHERE id = ? AND status = 'Available'`, rec.unit_id)
    if (!isNew && old?.status === 'Active' && rec.status === 'Released') promoteNext(rec.unit_id)
  },
}

export const commercialTermsHooks: Hooks = {
  beforeSave({ rec }) {
    if (rec.data_room_access === 'Granted' && rec.nda_status !== 'Signed' && rec.nda_status !== 'Not required') throw bad('Data room access needs a signed NDA first')
    if (rec.nda_status === 'Signed' && !rec.nda_signed_date) throw bad('Enter the NDA signed date')
    if (rec.loi_status === 'Signed' && !rec.loi_date) throw bad('Enter the LOI date')
    const brk = Number(rec.break_clause_months) || 0, notice = Number(rec.break_notice_months) || 0
    if (brk && !rec.commencement_date) throw bad('Enter the commencement date to calculate the break date')
    rec.break_date = brk && rec.commencement_date ? addMonths(rec.commencement_date, brk) : null
    rec.break_notice_deadline = rec.break_date ? addMonths(rec.break_date, -notice) : null
    rec.deal_title = q.val<string>(`SELECT deal_name FROM jobs WHERE id = ?`, rec.job_id) ?? ''
  },
}

export const assignmentHooks: Hooks = {
  beforeSave({ rec }) {
    rec.unit_title = unitTitle(rec.unit_id)
    if (rec.status === 'Completed') {
      const missing = [['developer_consent', 'developer consent / NOC'], ['paid_to_date_confirmed', 'developer payments to date'], ['fees_paid', 'assignment fees'], ['assignee_approved', 'developer approval of the assignee'], ['assignee_kyc_cleared', 'assignee KYC']].filter(([k]) => !rec[k]).map(([, l]) => l)
      if (missing.length) throw bad(`Cannot complete the assignment. Still needed: ${missing.join(', ')}`)
      if (!rec.revised_spa_ref) throw bad('Enter the revised SPA / Oqood reference to complete the assignment')
    }
  },
}
