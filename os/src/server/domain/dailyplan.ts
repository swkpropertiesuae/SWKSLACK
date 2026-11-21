// Daily report + next-day plan accountability: instant leadership alerts, staff reminders, overdue escalation, live attendance roster.
import { q } from '../db'
import { notify } from '../notify'
import { nowLocal, todayStr } from '../util'
import { config } from '../config'

const trim = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
/** Owner (Shabib Siraj) and Operations Manager (Mohammad Haseeb) — resolved by configured e-mail or role, never by a hard-coded id. */
export function leadershipUserIds(): number[] {
  const emails = [config.accounts.ownerEmail, config.accounts.managerEmail, 'shabib@swk.properties', 'haseeb@swk.properties', 'haseeb@swk.property'].map(e => String(e).toLowerCase())
  const rows = q.all<{ id: number }>(`SELECT DISTINCT u.id FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.deleted_at IS NULL AND u.active = 1 AND (lower(u.email) IN (${emails.map(() => '?').join(',')}) OR r.name IN ('Owner','Manager'))`, ...emails)
  return rows.map(r => r.id)
}
export const alertLeadership = (title: string, body: string, link: string, kind: string, dedupe?: string) => {
  for (const id of leadershipUserIds()) notify(id, title, body, link, kind, dedupe ? `${dedupe}:${id}` : undefined)
}

export function alertReportSubmitted(r: any) {
  const who = q.get<any>('SELECT name FROM employees WHERE id = ?', r.employee_id)?.name ?? `Employee #${r.employee_id}`
  alertLeadership(
    `Daily report + next-day plan submitted: ${who}`,
    `${r.report_date}\nToday: ${trim(r.outcomes_narrative, 260)}\nBlockers: ${trim(r.blockers_narrative || 'none', 160)}\nTomorrow: ${trim(r.next_day_priorities, 260)}`,
    `/e/daily_reports/${r.id}`, 'audit', `dr-sub-${r.id}-${r.revision_no ?? 1}`)
}

/** Closing time for the working day: Mon–Fri 19:00, Sat 16:00, Sun none (company working hours). */
export function closingHHMM(day = todayStr()): string | null {
  const dow = new Date(day + 'T12:00:00Z').getUTCDay()
  return dow === 0 ? null : dow === 6 ? '16:00' : '19:00'
}
const addMin = (hhmm: string, m: number) => { const [h, mm] = hhmm.split(':').map(Number), t = h * 60 + mm + m; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }

function missingToday(day: string) {
  return q.all<any>(`SELECT e.id, e.name, e.user_id, e.emp_no FROM employees e WHERE e.status = 'Active' AND e.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.employee_id = e.id AND l.status = 'Approved' AND l.from_date <= ? AND l.to_date >= ? AND l.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM daily_reports d WHERE d.employee_id = e.id AND d.report_date = ? AND d.deleted_at IS NULL AND d.status IN ('Submitted (Frozen)','Approved by Manager','Exemption Logged'))`, day, day, day)
}
/** Run every few minutes. 30 min before closing: remind staff. 30 min after closing: escalate to Owner + Manager, once per day. */
export function dailyPlanSweep(now = nowLocal()) {
  const day = now.slice(0, 10), hhmm = now.slice(11, 16), close = closingHHMM(day)
  if (!close) return { skipped: 'holiday' }
  const out: any = {}
  if (hhmm >= addMin(close, -30) && hhmm < addMin(close, 30)) {
    const miss = missingToday(day)
    for (const m of miss) notify(m.user_id, 'Submit today’s report and tomorrow’s plan', `Closing is at ${close}. Your daily report and next-day plan are due before you leave.`, '/e/daily_reports?new=1', 'task', `dr-remind-${m.id}-${day}`)
    out.reminded = miss.length
  }
  if (hhmm >= addMin(close, 30)) {
    const miss = missingToday(day)
    if (miss.length) {
      alertLeadership(`OVERDUE: ${miss.length} daily report${miss.length > 1 ? 's' : ''} / next-day plan${miss.length > 1 ? 's' : ''} missing (${day})`, miss.map(m => `• ${m.name} (${m.emp_no ?? ''})`).join('\n'), '/e/daily_reports', 'warn', `dr-overdue-${day}`)
      out.escalated = miss.length
    }
  }
  return out
}
export function reportSubmittedOrExempt(userId: number, day = todayStr()): boolean {
  return !!q.get(`SELECT 1 FROM daily_reports d WHERE d.user_id = ? AND d.report_date = ? AND d.deleted_at IS NULL AND d.status IN ('Submitted (Frozen)','Approved by Manager','Exemption Logged')`, userId, day)
}

/** Live roster for Owner / Manager: where every active employee is right now. */
export function liveRoster(day = todayStr()) {
  const emps = q.all<any>(`SELECT id, name, emp_no, user_id FROM employees WHERE status = 'Active' AND deleted_at IS NULL ORDER BY name`)
  const att = new Map(q.all<any>(`SELECT * FROM attendance_events WHERE work_date = ? AND deleted_at IS NULL ORDER BY id`, day).map(a => [a.employee_id, a]))
  const field = new Map(q.all<any>(`SELECT * FROM field_sessions WHERE duty_date = ? AND deleted_at IS NULL AND status IN ('Active (On Duty)','SOS Emergency Active') ORDER BY id`, day).map(f => [f.employee_id, f]))
  const leave = new Set(q.all<any>(`SELECT employee_id FROM leave_requests WHERE status = 'Approved' AND from_date <= ? AND to_date >= ? AND deleted_at IS NULL`, day, day).map(l => l.employee_id))
  const rep = new Map(q.all<any>(`SELECT employee_id, status FROM daily_reports WHERE report_date = ? AND deleted_at IS NULL`, day).map(r => [r.employee_id, r.status]))
  return emps.map(e => {
    const a = att.get(e.id), f = field.get(e.id)
    const state = leave.has(e.id) ? 'On leave' : f ? (f.status.startsWith('SOS') ? 'SOS' : 'In field') : a?.check_in_at && !a.check_out_at ? 'In office' : a?.check_out_at ? 'Checked out' : 'Not checked in'
    return { employee_id: e.id, user_id: e.user_id, name: e.name, emp_no: e.emp_no, state, late_minutes: a?.late_minutes ?? 0, check_in_at: a?.check_in_at ?? null, check_out_at: a?.check_out_at ?? null,
      method: a?.terminal_type ?? null, field: f ? { id: f.id, location: f.assigned_location ?? null, last_lat: f.last_lat ?? null, last_lng: f.last_lng ?? null, last_location_at: f.last_location_at ?? null, scheduled_end: f.scheduled_end } : null,
      report_status: rep.get(e.id) ?? 'Missing' }
  })
}
