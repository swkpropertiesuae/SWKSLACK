import crypto from 'node:crypto'
import { q } from '../db'
import { bad,nowIso,nowLocal } from '../util'
import { createRecord,getDef,SYSTEM_CTX } from '../engine'
import { notify } from '../notify'
import { queueEmail } from '../mailer'
import { sendWhatsApp } from '../integrations/whatsapp'
import type { Hooks } from '../hooks'


// ---------------------------------------------------------------- sequences
export function parseSteps(text: string) {
  return String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((l, i) => {
    const [d, ch, ...msg] = l.split('|'), days = Number(d), channel = (ch ?? '').trim(), message = msg.join('|').trim()
    if (!Number.isFinite(days) || days < 0 || !['WhatsApp', 'Email'].includes(channel) || !message) throw bad(`Step ${i + 1} must look like  1|WhatsApp|Your message`)
    return { days, channel, message }
  })
}
export const sequenceHooks: Hooks = { beforeSave({ rec }) { if (!parseSteps(rec.steps).length) throw bad('Add at least one step') } }

const countFor = (id: number) => {
  q.run(`UPDATE followup_sequences SET enrolled = (SELECT COUNT(*) FROM sequence_enrolments WHERE sequence_id = ? AND deleted_at IS NULL), replied = (SELECT COUNT(*) FROM sequence_enrolments WHERE sequence_id = ? AND status = 'Replied' AND deleted_at IS NULL) WHERE id = ?`, id, id, id)
}
export const enrolmentHooks: Hooks = {
  beforeSave({ rec, isNew }) {
    const seq = q.get(`SELECT steps FROM followup_sequences WHERE id = ? AND deleted_at IS NULL`, rec.sequence_id)
    if (!seq) throw bad('Sequence not found')
    const lead = q.get(`SELECT company FROM leads WHERE id = ? AND deleted_at IS NULL`, rec.lead_id)
    if (!lead) throw bad('Lead not found')
    rec.lead_name = lead.company
    if (isNew) {
      if (q.get(`SELECT 1 AS x FROM sequence_enrolments WHERE sequence_id = ? AND lead_id = ? AND status = 'Running' AND deleted_at IS NULL`, rec.sequence_id, rec.lead_id)) throw bad('This lead is already in the sequence')
      rec.next_step = 0; rec.status = 'Running'; rec.started_local = nowLocal()
      rec.next_due = new Date(Date.now() + parseSteps(seq.steps)[0].days * 86400_000).toISOString()
    }
  },
  afterSave({ rec }) { countFor(rec.sequence_id) },
}

/** Turns each due step into a message draft. Nothing is sent until a second person approves the draft. */
export function runSequences() {
  let made = 0
  const due = q.all(`SELECT e.*, s.steps, s.active FROM sequence_enrolments e JOIN followup_sequences s ON s.id = e.sequence_id WHERE e.status = 'Running' AND e.deleted_at IS NULL AND e.next_due <= ?`, nowIso())
  for (const e of due) {
    const lead = q.get(`SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL`, e.lead_id)
    const stop = (status: string) => { q.run(`UPDATE sequence_enrolments SET status = ?, next_due = NULL WHERE id = ?`, status, e.id); countFor(e.sequence_id) }
    if (!e.active || !lead || ['Converted', 'Unqualified'].includes(lead.status) || lead.marketing_consent === 'Opted out') { stop('Stopped'); continue }
    const phone = String(lead.phone ?? '').replace(/\D/g, '')
    if (phone && q.get(`SELECT 1 AS x FROM whatsapp_messages WHERE direction = 'in' AND wa_id = ? AND at >= ? LIMIT 1`, phone, e.started_local)) { stop('Replied'); continue }
    const steps = parseSteps(e.steps), step = steps[e.next_step]
    if (!step) { stop('Finished'); continue }
    const text = step.message.replace(/\{name\}/g, String(lead.contact_name || lead.company || '').split(' ')[0])
    createRecord(getDef('message_drafts'), { channel: step.channel, lead_id: lead.id, to_name: lead.contact_name || lead.company, to_phone: lead.phone, to_email: lead.email, subject: step.channel === 'Email' ? 'Following up on your enquiry' : null, body: text, status: 'Pending approval', source: 'Sequence' }, SYSTEM_CTX)
    made++
    const nxt = steps[e.next_step + 1]
    if (nxt) q.run(`UPDATE sequence_enrolments SET next_step = ?, next_due = ? WHERE id = ?`, e.next_step + 1, new Date(Date.now() + (nxt.days - step.days) * 86400_000).toISOString(), e.id)
    else stop('Finished')
    if (lead.owner_id) notify(lead.owner_id, `Follow-up draft waiting: ${lead.company}`, text.slice(0, 80), '/e/message_drafts', 'approval')
  }
  return { drafts: made }
}

// ---------------------------------------------------------------- drafts
export const draftHooks: Hooks = {
  beforeSave({ rec, old, isNew, ctx }) {
    if (rec.channel === 'WhatsApp' && !String(rec.to_phone ?? '').trim()) throw bad('Enter a phone number')
    if (rec.channel === 'Email' && !String(rec.to_email ?? '').trim()) throw bad('Enter an email address')
    if (isNew) { rec.source ||= ctx.user?.name ?? 'Staff'; rec.created_by_id = ctx.user?.id ?? null }
    if (old && rec.status !== old.status) {
      if (['Sent', 'Failed'].includes(rec.status) && !ctx.system) throw bad('Use Send to deliver an approved draft')
      if (['Approved', 'Rejected'].includes(rec.status)) {
        if (!ctx.system && old.status !== 'Pending approval') throw bad('Only drafts waiting for approval can be approved or rejected')
        if (!ctx.system && ctx.user && old.created_by_id && old.created_by_id === ctx.user.id && ctx.user.permissions !== '*') throw bad('Another person must approve a message you wrote')
        rec.approved_by_id = ctx.user?.id ?? null
      }
    }
  },
}
export async function sendDraft(id: number) {
  const d = q.get(`SELECT * FROM message_drafts WHERE id = ? AND deleted_at IS NULL`, id)
  if (!d) throw bad('Draft not found')
  if (d.status !== 'Approved') throw bad('Approve the draft before sending')
  let ok = true, error = ''
  if (d.channel === 'WhatsApp') { const r = await sendWhatsApp(d.to_phone, d.body, { origin: 'draft', lead_id: d.lead_id ?? undefined, name: d.to_name }); ok = r.ok; error = r.error ?? '' }
  else { queueEmail({ to: d.to_email, subject: d.subject || 'Message from SWK Properties', body: d.body, link_entity: 'leads', link_id: d.lead_id ?? undefined }) }
  q.run(`UPDATE message_drafts SET status = ?, sent_at = ?, error = ? WHERE id = ?`, ok ? 'Sent' : 'Failed', nowIso(), error || null, id)
  return { ok, error }
}

// ---------------------------------------------------------------- e-sign
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
export const esignHooks: Hooks = {
  beforeSave({ rec, old }) {
    if (old && ['Signed', 'Declined'].includes(old.status) && rec.document_text !== old.document_text) throw bad('A signed or declined document cannot be edited')
    rec.document_hash = sha(String(rec.document_text ?? ''))
  },
}
export const hashToken = sha
