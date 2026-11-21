import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import readXlsxFile from 'read-excel-file/node'
import { q, tx } from '../db'
import { encryptSecret, decryptSecret, getSetting } from '../settings'
import { bad, forbidden, HttpError, notFound, nowIso, safeJson } from '../util'
import { notify } from '../notify'
import { sendWhatsApp, normalizePhone } from '../integrations/whatsapp'
import { SWK_STAFF_ACCOUNTS, canAccessCrmVault } from '../../shared/swk-staff-access'
import type { SessionUser } from '../engine'
import { custodyFilter } from './handover'

export interface VisibleFieldsPolicy {
  show_owner_name: boolean
  show_exact_unit: boolean
  show_floor: boolean
  show_deal_value: boolean
  show_commission: boolean
  show_expiry: boolean
  show_playbook: boolean
  allow_masked_call: boolean
  allow_masked_whatsapp: boolean
}

export const DEFAULT_VISIBLE_FIELDS: VisibleFieldsPolicy = {
  show_owner_name: false,
  show_exact_unit: true,
  show_floor: true,
  show_deal_value: true,
  show_commission: false,
  show_expiry: true,
  show_playbook: true,
  allow_masked_call: true,
  allow_masked_whatsapp: true,
}

export const VAULT_STATUSES = [
  'In Vault',
  'Assigned',
  'In Progress',
  'Viewing Scheduled',
  'Offer / MOU',
  'Closed Won',
  'Closed Lost',
  'On Hold',
] as const

export function normalizeVisibleFields(input?: Partial<VisibleFieldsPolicy> | null): VisibleFieldsPolicy {
  return {
    show_owner_name: Boolean(input?.show_owner_name ?? DEFAULT_VISIBLE_FIELDS.show_owner_name),
    show_exact_unit: Boolean(input?.show_exact_unit ?? DEFAULT_VISIBLE_FIELDS.show_exact_unit),
    show_floor: Boolean(input?.show_floor ?? DEFAULT_VISIBLE_FIELDS.show_floor),
    show_deal_value: Boolean(input?.show_deal_value ?? DEFAULT_VISIBLE_FIELDS.show_deal_value),
    show_commission: Boolean(input?.show_commission ?? DEFAULT_VISIBLE_FIELDS.show_commission),
    show_expiry: Boolean(input?.show_expiry ?? DEFAULT_VISIBLE_FIELDS.show_expiry),
    show_playbook: Boolean(input?.show_playbook ?? DEFAULT_VISIBLE_FIELDS.show_playbook),
    allow_masked_call: Boolean(input?.allow_masked_call ?? DEFAULT_VISIBLE_FIELDS.allow_masked_call),
    allow_masked_whatsapp: Boolean(input?.allow_masked_whatsapp ?? DEFAULT_VISIBLE_FIELDS.allow_masked_whatsapp),
  }
}

/** Hard-masks any phone number so agents only see a non-dialable shield tag (never raw digits). */
export function maskPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D+/g, '')
  if (!digits) return ''
  if (digits.length <= 4) return 'MASKED ••••'
  return `MASKED •••• ${digits.slice(-4)}`
}

export function maskEmail(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim()
  if (!s || !s.includes('@')) return ''
  const [local, domain] = s.split('@')
  const prefix = local.slice(0, 1) || '*'
  return `${prefix}***@${domain}`
}

export function phoneHash(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D+/g, '')
  if (!digits) return ''
  return crypto.createHash('sha256').update(digits).digest('hex')
}

export function cleanStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

export function cleanNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

export function cleanInt(v: unknown): number | null {
  const n = cleanNum(v)
  return n === null ? null : Math.round(n)
}

function formatDateCell(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  return cleanStr(v).slice(0, 32)
}

export interface RawVaultPropertyInput {
  external_deal_id: string
  source_dataset: 'cluster_1920' | 'territory_nov2026' | 'custom_import' | 'ejari_dialer_2026'
  source_sheet: string
  suggested_agent?: string
  agent_cluster_territory?: string
  agent_deal_rank?: number | null
  deal_division: string
  dubai_area_community?: string
  primary_area_dld?: string
  master_project?: string
  building_or_project?: string
  exact_unit_door_no?: string
  floor_or_zone?: string
  property_layout_type?: string
  area_sqm?: number | null
  size_sqft?: number | null
  urgency_or_deal_window?: string
  score?: number | null
  target_deal_value_aed?: number | null
  current_or_benchmark_aed?: number | null
  est_agency_commission_aed?: number | null
  event_or_expiry_date?: string
  days_to_event?: number | null
  portal_or_source_status?: string
  owner_name?: string
  owner_entity_type?: string
  owner_nationality?: string
  direct_mobile?: string
  secondary_phone?: string
  email_address?: string
  closing_strategy_playbook?: string
  extra?: Record<string, unknown>
}

export interface RawRouteTrackerInput {
  route_date: string
  cluster_id: string
  territory_captain: string
  assigned_corridor?: string
  total_cluster_units?: number
  morning_towers_scheduled?: string
  makani_0915_checkin?: string
  target_doors_swept?: number
  watchmen_snaggers_onboarded?: number
  qr_serials_issued?: string
  direct_forma_keys_locked?: number
  afternoon_viewings_conducted?: number
  overflow_tenants_routed_80ltv?: number
  ejaris_closed_today?: number
  day21_landlord_equity_pitches?: number
  manager_haseeb_signoff?: string
}

function resolveUserIdByAgentName(agentName: string): number | null {
  const norm = cleanStr(agentName).toLowerCase()
  if (!norm) return null
  const first = norm.split(/\s+/)[0]
  const u = q.get<{ id: number }>(
    `SELECT id FROM users WHERE deleted_at IS NULL AND (lower(name) = ? OR lower(name) LIKE ? OR lower(email) LIKE ?) LIMIT 1`,
    norm,
    `${first}%`,
    `${first}@%`,
  )
  return u?.id ?? null
}

/** Upserts a batch of CRM vault properties inside a transaction (encrypts phone/email at rest). */
export function upsertVaultProperties(rows: RawVaultPropertyInput[]): { inserted: number; updated: number; total: number } {
  const now = nowIso()
  let inserted = 0
  let updated = 0
  tx(() => {
    for (const r of rows) {
      if (!r.external_deal_id) continue
      const directMobile = cleanStr(r.direct_mobile)
      const secPhone = cleanStr(r.secondary_phone)
      const email = cleanStr(r.email_address)
      const existing = q.get<{ id: number }>(`SELECT id FROM crm_vault_properties WHERE external_deal_id = ?`, r.external_deal_id)
      const encMobile = directMobile ? encryptSecret(directMobile) : null
      const maskedMobile = directMobile ? maskPhone(directMobile) : null
      const hashMobile = directMobile ? phoneHash(directMobile) : null
      const encSec = secPhone ? encryptSecret(secPhone) : null
      const maskedSec = secPhone ? maskPhone(secPhone) : null
      const encEmail = email ? encryptSecret(email) : null
      const maskedEmail = email ? maskEmail(email) : null
      const extraJson = r.extra && Object.keys(r.extra).length ? JSON.stringify(r.extra) : null

      if (existing) {
        q.run(
          `UPDATE crm_vault_properties SET
            source_dataset = ?, source_sheet = ?, suggested_agent = ?, agent_cluster_territory = ?,
            agent_deal_rank = ?, deal_division = ?, dubai_area_community = ?, primary_area_dld = ?,
            master_project = ?, building_or_project = ?, exact_unit_door_no = ?, floor_or_zone = ?,
            property_layout_type = ?, area_sqm = ?, size_sqft = ?, urgency_or_deal_window = ?,
            score = ?, target_deal_value_aed = ?, current_or_benchmark_aed = ?, est_agency_commission_aed = ?,
            event_or_expiry_date = ?, days_to_event = ?, portal_or_source_status = ?,
            owner_name = ?, owner_entity_type = ?, owner_nationality = ?,
            direct_mobile_enc = COALESCE(?, direct_mobile_enc),
            direct_mobile_masked = COALESCE(?, direct_mobile_masked),
            direct_mobile_hash = COALESCE(?, direct_mobile_hash),
            secondary_phone_enc = COALESCE(?, secondary_phone_enc),
            secondary_phone_masked = COALESCE(?, secondary_phone_masked),
            email_address_enc = COALESCE(?, email_address_enc),
            email_address_masked = COALESCE(?, email_address_masked),
            closing_strategy_playbook = ?, extra_json = ?, updated_at = ?
           WHERE id = ?`,
          r.source_dataset, r.source_sheet, cleanStr(r.suggested_agent) || null, cleanStr(r.agent_cluster_territory) || null,
          r.agent_deal_rank ?? null, r.deal_division, cleanStr(r.dubai_area_community) || null, cleanStr(r.primary_area_dld) || null,
          cleanStr(r.master_project) || null, cleanStr(r.building_or_project) || null, cleanStr(r.exact_unit_door_no) || null, cleanStr(r.floor_or_zone) || null,
          cleanStr(r.property_layout_type) || null, r.area_sqm ?? null, r.size_sqft ?? null, cleanStr(r.urgency_or_deal_window) || null,
          r.score ?? null, r.target_deal_value_aed ?? null, r.current_or_benchmark_aed ?? null, r.est_agency_commission_aed ?? null,
          cleanStr(r.event_or_expiry_date) || null, r.days_to_event ?? null, cleanStr(r.portal_or_source_status) || null,
          cleanStr(r.owner_name) || null, cleanStr(r.owner_entity_type) || null, cleanStr(r.owner_nationality) || null,
          encMobile, maskedMobile, hashMobile,
          encSec, maskedSec,
          encEmail, maskedEmail,
          cleanStr(r.closing_strategy_playbook) || null, extraJson, now, existing.id,
        )
        updated++
      } else {
        q.run(
          `INSERT INTO crm_vault_properties (
            external_deal_id, source_dataset, source_sheet, suggested_agent, agent_cluster_territory,
            agent_deal_rank, deal_division, dubai_area_community, primary_area_dld,
            master_project, building_or_project, exact_unit_door_no, floor_or_zone,
            property_layout_type, area_sqm, size_sqft, urgency_or_deal_window,
            score, target_deal_value_aed, current_or_benchmark_aed, est_agency_commission_aed,
            event_or_expiry_date, days_to_event, portal_or_source_status,
            owner_name, owner_entity_type, owner_nationality,
            direct_mobile_enc, direct_mobile_masked, direct_mobile_hash,
            secondary_phone_enc, secondary_phone_masked,
            email_address_enc, email_address_masked,
            closing_strategy_playbook, extra_json, vault_status, created_at, updated_at, custody
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          r.external_deal_id, r.source_dataset, r.source_sheet, cleanStr(r.suggested_agent) || null, cleanStr(r.agent_cluster_territory) || null,
          r.agent_deal_rank ?? null, r.deal_division, cleanStr(r.dubai_area_community) || null, cleanStr(r.primary_area_dld) || null,
          cleanStr(r.master_project) || null, cleanStr(r.building_or_project) || null, cleanStr(r.exact_unit_door_no) || null, cleanStr(r.floor_or_zone) || null,
          cleanStr(r.property_layout_type) || null, r.area_sqm ?? null, r.size_sqft ?? null, cleanStr(r.urgency_or_deal_window) || null,
          r.score ?? null, r.target_deal_value_aed ?? null, r.current_or_benchmark_aed ?? null, r.est_agency_commission_aed ?? null,
          cleanStr(r.event_or_expiry_date) || null, r.days_to_event ?? null, cleanStr(r.portal_or_source_status) || null,
          cleanStr(r.owner_name) || null, cleanStr(r.owner_entity_type) || null, cleanStr(r.owner_nationality) || null,
          encMobile, maskedMobile, hashMobile,
          encSec, maskedSec,
          encEmail, maskedEmail,
          cleanStr(r.closing_strategy_playbook) || null, extraJson, 'In Vault', now, now,
          r.source_dataset === 'ejari_dialer_2026' ? 'admin' : null, // chain of custody: Admin releases to the Manager
        )
        inserted++
      }
    }
  })
  return { inserted, updated, total: inserted + updated }
}

export function upsertRouteTrackerRows(rows: RawRouteTrackerInput[]): { inserted: number; updated: number; total: number } {
  const now = nowIso()
  let inserted = 0
  let updated = 0
  tx(() => {
    for (const r of rows) {
      if (!r.route_date || !r.cluster_id) continue
      const uid = resolveUserIdByAgentName(r.territory_captain)
      const existing = q.get<{ id: number }>(
        `SELECT id FROM crm_vault_route_tracker WHERE route_date = ? AND cluster_id = ?`,
        r.route_date,
        r.cluster_id,
      )
      if (existing) {
        q.run(
          `UPDATE crm_vault_route_tracker SET
            territory_captain = ?, assigned_user_id = COALESCE(?, assigned_user_id), assigned_corridor = ?,
            total_cluster_units = ?, morning_towers_scheduled = ?, makani_0915_checkin = ?,
            target_doors_swept = ?, watchmen_snaggers_onboarded = ?, qr_serials_issued = ?,
            direct_forma_keys_locked = ?, afternoon_viewings_conducted = ?, overflow_tenants_routed_80ltv = ?,
            ejaris_closed_today = ?, day21_landlord_equity_pitches = ?, manager_haseeb_signoff = ?, updated_at = ?
           WHERE id = ?`,
          r.territory_captain, uid, r.assigned_corridor ?? null,
          r.total_cluster_units ?? 0, r.morning_towers_scheduled ?? null, r.makani_0915_checkin ?? 'Pending',
          r.target_doors_swept ?? 0, r.watchmen_snaggers_onboarded ?? 0, r.qr_serials_issued ?? null,
          r.direct_forma_keys_locked ?? 0, r.afternoon_viewings_conducted ?? 0, r.overflow_tenants_routed_80ltv ?? 0,
          r.ejaris_closed_today ?? 0, r.day21_landlord_equity_pitches ?? 0, r.manager_haseeb_signoff ?? 'Pending', now, existing.id,
        )
        updated++
      } else {
        q.run(
          `INSERT INTO crm_vault_route_tracker (
            route_date, cluster_id, territory_captain, assigned_user_id, assigned_corridor,
            total_cluster_units, morning_towers_scheduled, makani_0915_checkin,
            target_doors_swept, watchmen_snaggers_onboarded, qr_serials_issued,
            direct_forma_keys_locked, afternoon_viewings_conducted, overflow_tenants_routed_80ltv,
            ejaris_closed_today, day21_landlord_equity_pitches, manager_haseeb_signoff,
            created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          r.route_date, r.cluster_id, r.territory_captain, uid, r.assigned_corridor ?? null,
          r.total_cluster_units ?? 0, r.morning_towers_scheduled ?? null, r.makani_0915_checkin ?? 'Pending',
          r.target_doors_swept ?? 0, r.watchmen_snaggers_onboarded ?? 0, r.qr_serials_issued ?? null,
          r.direct_forma_keys_locked ?? 0, r.afternoon_viewings_conducted ?? 0, r.overflow_tenants_routed_80ltv ?? 0,
          r.ejaris_closed_today ?? 0, r.day21_landlord_equity_pitches ?? 0, r.manager_haseeb_signoff ?? 'Pending',
          now, now,
        )
        inserted++
      }
    }
  })
  return { inserted, updated, total: inserted + updated }
}

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  const s = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cur); cur = ''
    } else if (ch === '\r') {
      continue
    } else if (ch === '\n') {
      row.push(cur); rows.push(row); row = []; cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

/** Parses an uploaded .xlsx or .csv Buffer (SWK 1920 Cluster Master, Territories Nov2026, individual Agent 320 sheets, or Daily Route CSV). */
// ---------------------------------------------------------------- SWK 7 Desks Ejari 0–60D dialer workbooks
const ejBlank = (v: unknown) => { const s = v == null ? '' : String(v).trim(); return s === '—' || s === '-' ? '' : s }
const ejNum = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return ejBlank(v) && Number.isFinite(n) ? n : null }
const ejInt = (v: unknown) => { const n = ejNum(v); return n == null ? null : Math.round(n) }
const ejDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : ejBlank(v).slice(0, 32))
const ej = { blank: ejBlank, num: ejNum, int: ejInt, date: ejDate }
const EJARI_DIVISION: Record<string, string> = {
  '1_FINISHING_NEXT_0_TO_30_DAYS': 'EJARI_FINISHING_0_30D',
  '2_FINISHING_NEXT_31_TO_60_DAYS': 'EJARI_FINISHING_31_60D',
}

/** Sheets 03 (all 0–60D), 04 (active seekers) and 05 (vacant) of NN_<Name>_Ejari_30D_60D_Leasing_Dialer_Workbook.xlsx. Sheets 01/02 are subsets of 03. */
function ejariDialerRows(sheet: string, data: unknown[][], filename: string): RawVaultPropertyInput[] {
  const seeker = sheet.startsWith('04_')
  if (!(sheet.startsWith('03_') || seeker || sheet.startsWith('05_'))) return []
  const desk = path.basename(filename).split('_')[0]
  const hdr = (data[0] ?? []).map(c => ej.blank(c))
  const v = (r: unknown[], k: string) => { const i = hdr.indexOf(k); return i < 0 ? undefined : r[i] }
  const out: RawVaultPropertyInput[] = []
  for (const r of data.slice(1)) {
    const id = ej.blank(v(r, 'Forensic_Client_ID'))
    if (!id) continue
    const deskLabel = ej.blank(v(r, 'Assigned_SWK_Leasing_Agent'))
    const agent = (deskLabel.match(/—\s*([^(]+)/)?.[1] ?? '').trim().split(' ')[0]
    const passing = ej.num(v(r, seeker ? 'Current_Or_Target_Rent_AED' : 'Passing_Ejari_Rent_AED'))
    const window = ej.blank(v(r, seeker ? 'Seeker_Cohort' : 'Urgency_Window'))
    out.push({
      external_deal_id: `EJ26-${desk}-${id}`,
      source_dataset: 'ejari_dialer_2026',
      source_sheet: sheet,
      suggested_agent: agent,
      agent_cluster_territory: deskLabel,
      agent_deal_rank: ej.int(ej.blank(v(r, 'Dialer_Call_Seq')).split('-').pop()),
      deal_division: seeker ? 'ACTIVE_UNIT_SEEKER' : sheet.startsWith('05_') ? 'VACANT_RECENTLY_EXPIRED' : (EJARI_DIVISION[window] ?? 'EJARI_FINISHING_0_60D'),
      dubai_area_community: ej.blank(v(r, seeker ? 'Current_Or_Target_Area' : 'Area_DLD_Community')),
      master_project: ej.blank(v(r, 'Master_Project')),
      building_or_project: ej.blank(v(r, seeker ? 'Current_Building_And_Door' : 'Current_Building_Tower')),
      exact_unit_door_no: ej.blank(v(r, 'Exact_Unit_Door_No')),
      floor_or_zone: ej.blank(v(r, 'Floor')),
      property_layout_type: ej.blank(v(r, seeker ? 'Layout_Requirement' : 'Layout_Type')),
      area_sqm: ej.num(v(r, 'Area_SqM')),
      size_sqft: ej.num(v(r, 'Size_SqFt')),
      urgency_or_deal_window: window,
      target_deal_value_aed: ej.num(v(r, 'DLD_2026_Market_Rent_AED')),
      current_or_benchmark_aed: passing,
      est_agency_commission_aed: passing == null ? null : Math.round(passing * 0.05),
      event_or_expiry_date: ej.date(v(r, seeker ? 'Lease_Expiry_Or_Inquiry_Date' : 'Ejari_Expiry_Date')),
      days_to_event: ej.int(v(r, seeker ? 'Days_To_Move_Window' : 'Days_Until_Expiry')),
      portal_or_source_status: ej.blank(v(r, 'Portal_Listing_Status')),
      owner_name: ej.blank(v(r, 'Client_Full_Name')),
      owner_entity_type: ej.blank(v(r, 'Entity_Type')),
      owner_nationality: ej.blank(v(r, 'Nationality')),
      direct_mobile: ej.blank(v(r, 'Direct_Mobile_WhatsApp')),
      secondary_phone: ej.blank(v(r, 'Secondary_Phone')),
      email_address: ej.blank(v(r, 'Email_Address')),
      closing_strategy_playbook: ej.blank(v(r, 'Leasing_First_Show_Playbook')),
      extra: Object.fromEntries(Object.entries({
        dialer_seq: ej.blank(v(r, 'Dialer_Call_Seq')),
        dld_property_id: ej.blank(v(r, 'DLD_Property_ID')),
        unit_match_precision: ej.blank(v(r, 'Unit_Match_Precision')),
        dld_2026_audit: ej.blank(v(r, 'DLD_2026_Tx_And_Renewal_Audit')),
        under_market_pct: ej.num(v(r, 'Under_Market_Discount_Pct')),
        rera_increase_pct: ej.num(v(r, 'RERA_Statutory_Increase_Pct')),
        rera_rent_shock_aed: ej.num(v(r, 'RERA_Annual_Rent_Shock_AED')),
        arbitrage: ej.blank(v(r, 'Arbitrage_Classification')),
        doors_held: ej.int(v(r, 'Client_Portfolio_Doors_Held')),
        rent_roll_aed: ej.num(v(r, 'Client_Total_Annual_Rent_Roll_AED')),
        capacity_tier: ej.blank(v(r, 'Client_Capacity_Tier')),
        matched_units: ej.blank(v(r, 'First_Show_Matched_Available_Leasing_Units')),
      }).filter(([, x]) => x !== '' && x != null)),
    })
  }
  return out
}

export async function parseAndImportVaultBuffer(buf: Buffer, filename: string): Promise<{ properties: { inserted: number; updated: number; total: number }; routes: { inserted: number; updated: number; total: number } }> {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) {
    const rows = parseCsvLines(buf.toString('utf8'))
    if (rows.length < 2) return { properties: { inserted: 0, updated: 0, total: 0 }, routes: { inserted: 0, updated: 0, total: 0 } }
    const hdr = rows[0].map(c => c.trim())
    if (hdr.includes('Cluster_ID') && hdr.includes('Territory_Captain')) {
      const idx = (k: string) => hdr.indexOf(k)
      const parsed: RawRouteTrackerInput[] = rows.slice(1).map(r => ({
        route_date: cleanStr(r[idx('Date')]),
        cluster_id: cleanStr(r[idx('Cluster_ID')]),
        territory_captain: cleanStr(r[idx('Territory_Captain')]),
        assigned_corridor: cleanStr(r[idx('Assigned_Corridor')]),
        total_cluster_units: cleanInt(r[idx('Total_Cluster_Units')]) ?? 0,
        morning_towers_scheduled: cleanStr(r[idx('Morning_Towers_Scheduled_4')]),
        makani_0915_checkin: cleanStr(r[idx('Makani_0915_CheckIn_Verified')]) || 'Pending',
        target_doors_swept: cleanInt(r[idx('Target_Doors_Swept_Today')]) ?? 0,
        watchmen_snaggers_onboarded: cleanInt(r[idx('Watchmen_Snaggers_Onboarded')]) ?? 0,
        qr_serials_issued: cleanStr(r[idx('QR_Serials_Issued')]),
        direct_forma_keys_locked: cleanInt(r[idx('Direct_FormA_Keys_Locked')]) ?? 0,
        afternoon_viewings_conducted: cleanInt(r[idx('Afternoon_Viewings_Conducted')]) ?? 0,
        overflow_tenants_routed_80ltv: cleanInt(r[idx('Overflow_Tenants_Routed_to_80LTV')]) ?? 0,
        ejaris_closed_today: cleanInt(r[idx('Ejaris_Closed_Today')]) ?? 0,
        day21_landlord_equity_pitches: cleanInt(r[idx('Day21_Landlord_Equity_Pitches_Flagged')]) ?? 0,
        manager_haseeb_signoff: cleanStr(r[idx('Manager_Haseeb_530PM_SignOff')]) || 'Pending',
      }))
      return { properties: { inserted: 0, updated: 0, total: 0 }, routes: upsertRouteTrackerRows(parsed) }
    }
    throw bad('Unrecognised CSV columns. Expected SWK Daily Route & Audit Tracker CSV.')
  }

  const sheets = await readXlsxFile(buf)
  const props: RawVaultPropertyInput[] = []

  for (const sheetObj of sheets) {
    const sheet = String(sheetObj.sheet || '')
    if (sheet.startsWith('00_') || sheet === '07_All_300_Commercial_6_Agents') continue
    const rawRows = sheetObj.data
    if (rawRows.length < 2) continue
    const hdr = rawRows[0].map((c: unknown) => cleanStr(c))
    const col = (name: string) => hdr.indexOf(name)

    // Format 3: SWK 7 Desks Ejari 0–60D dialer workbook (new leads land in Admin Custody)
    if (hdr.includes('Forensic_Client_ID') && hdr.includes('Dialer_Call_Seq')) {
      props.push(...ejariDialerRows(sheet, rawRows as unknown[][], filename))
      continue
    }

    // Format 1: SWK_6_Agents_1920_Cluster_Closing_Deals_Master & Agent_*_320_Closing_Deals
    if (hdr.includes('Assigned_SWK_Agent') && hdr.includes('Deal_Division')) {
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i]
        const agent = cleanStr(r[col('Assigned_SWK_Agent')])
        const rank = cleanInt(r[col('Agent_Deal_Rank')])
        const division = cleanStr(r[col('Deal_Division')])
        if (!agent && !division) continue
        const extId = `CL1920-${agent.toUpperCase().slice(0, 4)}-${String(rank ?? i).padStart(4, '0')}`
        props.push({
          external_deal_id: extId,
          source_dataset: 'cluster_1920',
          source_sheet: sheet,
          suggested_agent: agent,
          agent_cluster_territory: cleanStr(r[col('Agent_Cluster_Territory')]),
          agent_deal_rank: rank,
          deal_division: division,
          dubai_area_community: cleanStr(r[col('Dubai_Area_Community')]),
          primary_area_dld: cleanStr(r[col('Primary_Area_DLD')]),
          building_or_project: cleanStr(r[col('Building_Or_Project')]),
          exact_unit_door_no: cleanStr(r[col('Exact_Unit_Door_No')]),
          floor_or_zone: cleanStr(r[col('Floor_Or_Zone')]),
          property_layout_type: cleanStr(r[col('Property_Layout_Type')]),
          area_sqm: cleanNum(r[col('Area_SqM')]),
          size_sqft: cleanNum(r[col('Size_SqFt')]),
          urgency_or_deal_window: cleanStr(r[col('Urgency_Or_Deal_Window')]),
          target_deal_value_aed: cleanNum(r[col('Target_Deal_Value_AED')]),
          current_or_benchmark_aed: cleanNum(r[col('Current_Or_Benchmark_AED')]),
          est_agency_commission_aed: cleanNum(r[col('Est_Agency_Commission_AED')]),
          event_or_expiry_date: formatDateCell(r[col('Event_Or_Expiry_Date')]),
          days_to_event: cleanInt(r[col('Days_To_Event')]),
          portal_or_source_status: cleanStr(r[col('Portal_Or_Source_Status')]),
          owner_name: cleanStr(r[col('Owner_Or_Decision_Maker_Name')]),
          owner_entity_type: cleanStr(r[col('Owner_Entity_Type')]),
          owner_nationality: cleanStr(r[col('Owner_Nationality')]),
          direct_mobile: cleanStr(r[col('Direct_Mobile')]),
          secondary_phone: cleanStr(r[col('Secondary_Phone')]),
          email_address: cleanStr(r[col('Email_Address')]),
          closing_strategy_playbook: cleanStr(r[col('Closing_Strategy_Playbook')]),
        })
      }
      continue
    }

    // Format 2A: SWK_6_Agents_Master_Closing_Territories_Nov2026 -> 01_All_930_Res_Leasing_60D
    if (hdr.includes('Deal_ID') && hdr.includes('Target_Annual_Rent_AED')) {
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i]
        const dealId = cleanStr(r[col('Deal_ID')])
        if (!dealId) continue
        props.push({
          external_deal_id: `TERR-${dealId}`,
          source_dataset: 'territory_nov2026',
          source_sheet: sheet,
          suggested_agent: cleanStr(r[col('Agent')]),
          agent_deal_rank: cleanInt(r[col('Rank')]),
          deal_division: 'TERRITORY_RES_LEASING_60D',
          dubai_area_community: cleanStr(r[col('Area_Community')]),
          master_project: cleanStr(r[col('Master_Project')]),
          building_or_project: cleanStr(r[col('Building_Tower')]),
          exact_unit_door_no: cleanStr(r[col('Exact_Unit_Door')]),
          floor_or_zone: cleanStr(r[col('Floor')]),
          property_layout_type: cleanStr(r[col('Layout')]),
          size_sqft: cleanNum(r[col('Size_SqFt')]),
          urgency_or_deal_window: cleanStr(r[col('0_60D_Window_Status')]),
          score: cleanNum(r[col('Score')]),
          target_deal_value_aed: cleanNum(r[col('Target_Annual_Rent_AED')]),
          current_or_benchmark_aed: cleanNum(r[col('Prior_Ejari_Rent_AED')]),
          est_agency_commission_aed: cleanNum(r[col('Est_5Pct_Fee_AED')]),
          portal_or_source_status: cleanStr(r[col('Listing_Status')]),
          owner_entity_type: cleanStr(r[col('Landlord_Segment_CleanRoom')]),
          closing_strategy_playbook: cleanStr(r[col('RERA_Compliant_Closing_Playbook')]),
          extra: {
            sub_stream: cleanStr(r[col('Sub_Stream')]),
            doors_in_same_bldg: cleanInt(r[col('Doors_In_Same_Bldg')]),
            permit_or_dld_ref: cleanStr(r[col('Permit_or_DLD_Ref')]),
          },
        })
      }
      continue
    }

    // Format 2B: SWK_6_Agents_Master_Closing_Territories_Nov2026 -> 02_All_270_Commercial_60D
    if (hdr.includes('Deal_ID') && hdr.includes('Commercial_SubType')) {
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i]
        const dealId = cleanStr(r[col('Deal_ID')])
        if (!dealId) continue
        props.push({
          external_deal_id: `TERR-${dealId}`,
          source_dataset: 'territory_nov2026',
          source_sheet: sheet,
          suggested_agent: cleanStr(r[col('Agent')]),
          agent_deal_rank: cleanInt(r[col('Rank')]),
          deal_division: 'TERRITORY_COMMERCIAL_60D',
          dubai_area_community: cleanStr(r[col('Area_District')]),
          building_or_project: cleanStr(r[col('Building_or_Precinct')]),
          exact_unit_door_no: cleanStr(r[col('Unit_or_Ejari_Ref')]),
          property_layout_type: cleanStr(r[col('Commercial_SubType')]),
          size_sqft: cleanNum(r[col('Size_SqFt')]),
          urgency_or_deal_window: cleanStr(r[col('0_60D_Availability_Status')]),
          score: cleanNum(r[col('Score')]),
          target_deal_value_aed: cleanNum(r[col('Annual_Rent_AED')]),
          est_agency_commission_aed: cleanNum(r[col('Est_7.5Pct_Fee_AED')]),
          closing_strategy_playbook: cleanStr(r[col('Commercial_Closing_Playbook')]),
          extra: {
            source_engine: cleanStr(r[col('Source_Engine')]),
            rent_psf_aed: cleanNum(r[col('Rent_PSF_AED')]),
            nearest_metro: cleanStr(r[col('Nearest_Metro')]),
          },
        })
      }
      continue
    }

    // Format 2C: SWK_6_Agents_Master_Closing_Territories_Nov2026 -> 03_All_480_Secondary_Sales
    if (hdr.includes('Deal_ID') && hdr.includes('Asking_Price_AED')) {
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i]
        const dealId = cleanStr(r[col('Deal_ID')])
        if (!dealId) continue
        props.push({
          external_deal_id: `TERR-${dealId}`,
          source_dataset: 'territory_nov2026',
          source_sheet: sheet,
          suggested_agent: cleanStr(r[col('Agent')]),
          agent_deal_rank: cleanInt(r[col('Rank')]),
          deal_division: 'TERRITORY_SECONDARY_SALES',
          dubai_area_community: cleanStr(r[col('Community')]),
          building_or_project: cleanStr(r[col('Building_Tower')]),
          exact_unit_door_no: cleanStr(r[col('Resolved_Door_or_Stack')]),
          property_layout_type: cleanStr(r[col('Beds')]) ? `${cleanStr(r[col('Beds')])} B/R` : '',
          size_sqft: cleanNum(r[col('Size_SqFt')]),
          urgency_or_deal_window: cleanStr(r[col('Mandate_Urgency')]),
          score: cleanNum(r[col('Score')]),
          target_deal_value_aed: cleanNum(r[col('Asking_Price_AED')]),
          current_or_benchmark_aed: cleanNum(r[col('DLD_AVM_Comp_AED')]),
          est_agency_commission_aed: cleanNum(r[col('Est_2Pct_Sale_Plus_DSA_AED')]),
          portal_or_source_status: cleanStr(r[col('Trakheesi_Permit')]),
          closing_strategy_playbook: cleanStr(r[col('Secondary_&_Betterway_Relay_Playbook')]),
          extra: {
            resolution_method: cleanStr(r[col('Resolution_Method')]),
            ask_vs_avm_pct: cleanNum(r[col('Ask_vs_AVM_Pct')]),
            est_annual_rent_aed: cleanNum(r[col('Est_Annual_Rent_AED')]),
            ltv80_monthly_emi_aed: cleanNum(r[col('80LTV_Monthly_EMI_AED')]),
            rent_covers_emi: cleanStr(r[col('Rent_Covers_EMI')]),
            dom: cleanInt(r[col('DOM')]),
            forma_days_left: cleanInt(r[col('FormA_Days_Left')]),
            holding_agency_cobroke: cleanStr(r[col('Holding_Agency_CoBroke')]),
          },
        })
      }
    }
  }

  return {
    properties: upsertVaultProperties(props),
    routes: { inserted: 0, updated: 0, total: 0 },
  }
}

/** Auto-loads encrypted CRM Vault seed bundle (`data-seed/crm-vault.enc.bin`) when SWK_CRM_VAULT_KEY is configured. */
export function loadEncryptedVaultSeedIfConfigured(): { loaded: boolean; properties: number; routes: number; reason?: string } {
  const keyHex = String(process.env.SWK_CRM_VAULT_KEY || '').trim()
  const seedPath = path.resolve(process.cwd(), 'data-seed', 'crm-vault.enc.bin')
  if (!keyHex) return { loaded: false, properties: 0, routes: 0, reason: 'SWK_CRM_VAULT_KEY not set' }
  if (!fs.existsSync(seedPath)) return { loaded: false, properties: 0, routes: 0, reason: 'seed file not present' }
  const existingCount = q.val<number>(`SELECT COUNT(*) FROM crm_vault_properties`) ?? 0
  if (existingCount >= 3500) return { loaded: false, properties: existingCount, routes: q.val<number>(`SELECT COUNT(*) FROM crm_vault_route_tracker`) ?? 0, reason: 'already seeded' }

  const key = /^[0-9a-f]{64}$/i.test(keyHex)
    ? Buffer.from(keyHex, 'hex')
    : crypto.createHash('sha256').update(keyHex).digest()
  const raw = fs.readFileSync(seedPath)
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const gz = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const payload = JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as {
    properties: RawVaultPropertyInput[]
    routes: RawRouteTrackerInput[]
  }
  const p = upsertVaultProperties(payload.properties || [])
  const r = upsertRouteTrackerRows(payload.routes || [])
  return { loaded: true, properties: p.total, routes: r.total }
}

// ---------------------------------------------------------------- Leadership Queries (Admin, Shabib, Haseeb ONLY)

export function getVaultSummary(user: SessionUser) {
  if (!canAccessCrmVault(user)) throw forbidden('CRM Vault is restricted exclusively to Owner Shabib, Admin, and Operations Manager Haseeb.')
  const totals = q.get<any>(`
    SELECT
      COUNT(*) AS total_properties,
      SUM(CASE WHEN source_dataset = 'cluster_1920' THEN 1 ELSE 0 END) AS cluster_1920_count,
      SUM(CASE WHEN source_dataset = 'territory_nov2026' THEN 1 ELSE 0 END) AS territory_1680_count,
      SUM(CASE WHEN direct_mobile_enc IS NOT NULL AND direct_mobile_enc <> '' THEN 1 ELSE 0 END) AS with_direct_phone,
      SUM(CASE WHEN assigned_user_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned_count,
      SUM(CASE WHEN assigned_user_id IS NULL THEN 1 ELSE 0 END) AS unassigned_count,
      COALESCE(SUM(target_deal_value_aed), 0) AS total_deal_volume_aed,
      COALESCE(SUM(est_agency_commission_aed), 0) AS total_commission_pool_aed
    FROM crm_vault_properties p WHERE 1=1${custodyFilter(user)}
  `)
  const bySuggested = q.all<any>(`
    SELECT
      COALESCE(suggested_agent, 'Unassigned') AS agent,
      COUNT(*) AS total,
      SUM(CASE WHEN assigned_user_id IS NOT NULL THEN 1 ELSE 0 END) AS dispatched,
      SUM(CASE WHEN direct_mobile_enc IS NOT NULL AND direct_mobile_enc <> '' THEN 1 ELSE 0 END) AS with_phone,
      COALESCE(SUM(target_deal_value_aed), 0) AS volume_aed,
      COALESCE(SUM(est_agency_commission_aed), 0) AS commission_aed
    FROM crm_vault_properties p WHERE 1=1${custodyFilter(user)}
    GROUP BY COALESCE(suggested_agent, 'Unassigned')
    ORDER BY total DESC
  `)
  const routeCount = q.val<number>(`SELECT COUNT(*) FROM crm_vault_route_tracker`) ?? 0
  const callCount = q.val<number>(`SELECT COUNT(*) FROM crm_masked_call_logs`) ?? 0
  const bridgeProvider = String(getSetting('masked_call_provider') || 'none')
  const bridgeConfigured = (bridgeProvider === 'twilio' && !!getSetting('masked_call_twilio_sid') && !!getSetting('masked_call_twilio_token') && !!getSetting('masked_call_caller_id'))
    || (bridgeProvider === 'webhook' && !!getSetting('masked_call_webhook_url'))
  return {
    totals: totals ?? {},
    by_suggested_agent: bySuggested,
    route_tracker_count: routeCount,
    masked_calls_count: callCount,
    bridge_provider: bridgeProvider,
    bridge_configured: bridgeConfigured,
    whatsapp_relay_configured: Boolean(getSetting('wa_enabled') && getSetting('wa_access_token') && getSetting('wa_phone_number_id')),
  }
}

export function listVaultPropertiesForLeadership(
  user: SessionUser,
  params: {
    q?: string
    dataset?: string
    suggested_agent?: string
    assigned_user_id?: string
    division?: string
    community?: string
    status?: string
    has_phone?: string
    page?: number
    pageSize?: number
  },
) {
  if (!canAccessCrmVault(user)) throw forbidden('CRM Vault is restricted exclusively to Owner Shabib, Admin, and Operations Manager Haseeb.')
  const where: string[] = ['1=1']
  const args: any[] = []
  if (params.dataset && params.dataset !== 'all') { where.push('p.source_dataset = ?'); args.push(params.dataset) }
  if (params.suggested_agent && params.suggested_agent !== 'all') { where.push('lower(p.suggested_agent) = ?'); args.push(params.suggested_agent.toLowerCase()) }
  if (params.assigned_user_id === 'unassigned') { where.push('p.assigned_user_id IS NULL') }
  else if (params.assigned_user_id === 'assigned') { where.push('p.assigned_user_id IS NOT NULL') }
  else if (params.assigned_user_id && /^\d+$/.test(params.assigned_user_id)) { where.push('p.assigned_user_id = ?'); args.push(Number(params.assigned_user_id)) }
  if (params.division && params.division !== 'all') { where.push('p.deal_division = ?'); args.push(params.division) }
  if (params.community && params.community !== 'all') { where.push('p.dubai_area_community = ?'); args.push(params.community) }
  if (params.status && params.status !== 'all') { where.push('p.vault_status = ?'); args.push(params.status) }
  if (params.has_phone === 'yes') { where.push(`p.direct_mobile_enc IS NOT NULL AND p.direct_mobile_enc <> ''`) }
  else if (params.has_phone === 'no') { where.push(`(p.direct_mobile_enc IS NULL OR p.direct_mobile_enc = '')`) }
  if (params.q && params.q.trim()) {
    const like = `%${params.q.trim().toLowerCase()}%`
    where.push(`(lower(COALESCE(p.building_or_project,'')) LIKE ? OR lower(COALESCE(p.dubai_area_community,'')) LIKE ? OR lower(COALESCE(p.exact_unit_door_no,'')) LIKE ? OR lower(COALESCE(p.owner_name,'')) LIKE ? OR lower(COALESCE(p.external_deal_id,'')) LIKE ? OR lower(COALESCE(p.direct_mobile_masked,'')) LIKE ?)`)
    args.push(like, like, like, like, like, like)
  }

  const page = Math.max(1, Number(params.page) || 1)
  const pageSize = Math.min(200, Math.max(10, Number(params.pageSize) || 50))
  const offset = (page - 1) * pageSize
  const whereSql = where.join(' AND ') + custodyFilter(user)

  const total = q.val<number>(`SELECT COUNT(*) FROM crm_vault_properties p WHERE ${whereSql}`, ...args) ?? 0
  const rows = q.all<any>(
    `SELECT p.*, u.name AS assigned_user_name, u.email AS assigned_user_email
     FROM crm_vault_properties p
     LEFT JOIN users u ON u.id = p.assigned_user_id
     WHERE ${whereSql}
     ORDER BY CASE WHEN p.assigned_user_id IS NULL THEN 0 ELSE 1 END, COALESCE(p.agent_deal_rank, 999999), p.id
     LIMIT ? OFFSET ?`,
    ...args,
    pageSize,
    offset,
  )

  const decryptedRows = rows.map(row => ({
    ...row,
    direct_mobile: row.direct_mobile_enc ? decryptSecret(row.direct_mobile_enc) : '',
    secondary_phone: row.secondary_phone_enc ? decryptSecret(row.secondary_phone_enc) : '',
    email_address: row.email_address_enc ? decryptSecret(row.email_address_enc) : '',
    direct_mobile_enc: undefined,
    secondary_phone_enc: undefined,
    email_address_enc: undefined,
    visible_fields: normalizeVisibleFields(safeJson(row.visible_fields_json, null)),
    extra: safeJson(row.extra_json, {}),
  }))

  return { total, page, pageSize, rows: decryptedRows }
}

export function assignVaultProperties(
  user: SessionUser,
  payload: { property_ids: number[]; agent_user_id: number; visible_fields?: Partial<VisibleFieldsPolicy> },
) {
  if (!canAccessCrmVault(user)) throw forbidden('Only Owner Shabib, Admin, and Manager Haseeb can assign CRM Vault properties.')
  if (!payload.property_ids.length) throw bad('Select at least one property to assign.')
  const targetUser = q.get<{ id: number; name: string; email: string }>(
    `SELECT id, name, email FROM users WHERE id = ? AND deleted_at IS NULL AND active = 1`,
    payload.agent_user_id,
  )
  if (!targetUser) throw notFound('Target agent account not found.')

  const policy = normalizeVisibleFields(payload.visible_fields)
  const policyJson = JSON.stringify(policy)
  const now = nowIso()

  const held = q.val<number>(`SELECT COUNT(*) FROM crm_vault_properties WHERE custody = 'admin' AND id IN (${payload.property_ids.map(() => '?').join(',')})`, ...payload.property_ids) ?? 0
  if (held) throw bad(`${held} of the selected leads are still in Admin Custody. The Admin must release them to the Operations Manager before they can be dispatched to staff.`)

  let updated = 0
  tx(() => {
    for (const id of payload.property_ids) {
      const res = q.run(
        `UPDATE crm_vault_properties
         SET assigned_user_id = ?, assigned_by_user_id = ?, assigned_at = ?, visible_fields_json = ?,
             vault_status = CASE WHEN vault_status = 'In Vault' THEN 'Assigned' ELSE vault_status END,
             updated_at = ?
         WHERE id = ?`,
        targetUser.id, user.id, now, policyJson, now, id,
      )
      updated += res.changes
    }
    q.run(
      `INSERT INTO audit_log(at, user_id, user_name, entity, record_id, record_label, action, changes) VALUES (?,?,?,?,?,?,?,?)`,
      now, user.id, user.name, 'crm_vault_properties', payload.property_ids[0] ?? null,
      `Assigned ${updated} vault properties to ${targetUser.name}`,
      'assign',
      JSON.stringify({ count: updated, agent_user_id: targetUser.id, agent_name: targetUser.name, visible_fields: policy }),
    )
  })

  notify(
    targetUser.id,
    `${updated} new ${updated === 1 ? 'property' : 'properties'} assigned to you`,
    `${user.name} dispatched ${updated} deal${updated === 1 ? '' : 's'} to your My Assigned Deals queue (phone numbers are hard-masked for security).`,
    '/my-deals',
    'info',
  )
  return { ok: true, assigned: updated, agent: targetUser, visible_fields: policy }
}

export function unassignVaultProperties(user: SessionUser, propertyIds: number[]) {
  if (!canAccessCrmVault(user)) throw forbidden('Only Owner Shabib, Admin, and Manager Haseeb can unassign CRM Vault properties.')
  if (!propertyIds.length) throw bad('Select at least one property.')
  const now = nowIso()
  let updated = 0
  tx(() => {
    for (const id of propertyIds) {
      const res = q.run(
        `UPDATE crm_vault_properties
         SET assigned_user_id = NULL, assigned_by_user_id = NULL, assigned_at = NULL, visible_fields_json = NULL,
             vault_status = 'In Vault', updated_at = ?
         WHERE id = ?`,
        now, id,
      )
      updated += res.changes
    }
  })
  return { ok: true, unassigned: updated }
}

export function listAssignableAgents(user: SessionUser) {
  if (!canAccessCrmVault(user)) throw forbidden('Restricted to leadership.')
  return q.all<any>(
    `SELECT u.id, u.name, u.email, e.phone, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN employees e ON e.user_id = u.id AND e.deleted_at IS NULL
     WHERE u.deleted_at IS NULL AND u.active = 1 AND u.party_id IS NULL
     ORDER BY u.name`,
  )
}

// ---------------------------------------------------------------- Agent Zero-Exposure Views

/**
 * STRICT ZERO-EXPOSURE PROJECTION FOR AGENTS:
 * Never queries or returns direct_mobile_enc, secondary_phone_enc, or email_address_enc.
 * Strips every field not explicitly allowed by Leadership in visible_fields_json.
 */
export function listAgentAssignedProperties(
  user: SessionUser,
  params: { q?: string; status?: string; division?: string; page?: number; pageSize?: number },
) {
  const where: string[] = ['assigned_user_id = ?']
  const args: any[] = [user.id]
  if (params.status && params.status !== 'all') { where.push('vault_status = ?'); args.push(params.status) }
  if (params.division && params.division !== 'all') { where.push('deal_division = ?'); args.push(params.division) }
  if (params.q && params.q.trim()) {
    const like = `%${params.q.trim().toLowerCase()}%`
    where.push(`(lower(COALESCE(building_or_project,'')) LIKE ? OR lower(COALESCE(dubai_area_community,'')) LIKE ? OR lower(COALESCE(external_deal_id,'')) LIKE ?)`)
    args.push(like, like, like)
  }
  const page = Math.max(1, Number(params.page) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(params.pageSize) || 50))
  const offset = (page - 1) * pageSize
  const whereSql = where.join(' AND ')

  const total = q.val<number>(`SELECT COUNT(*) FROM crm_vault_properties WHERE ${whereSql}`, ...args) ?? 0
  // Explicitly omit all *_enc columns from the SELECT statement!
  const rows = q.all<any>(
    `SELECT id, external_deal_id, source_dataset, deal_division, dubai_area_community, master_project,
            building_or_project, exact_unit_door_no, floor_or_zone, property_layout_type, area_sqm, size_sqft,
            urgency_or_deal_window, score, target_deal_value_aed, current_or_benchmark_aed, est_agency_commission_aed,
            event_or_expiry_date, days_to_event, portal_or_source_status,
            owner_name, owner_entity_type, owner_nationality,
            direct_mobile_masked, secondary_phone_masked, email_address_masked,
            CASE WHEN direct_mobile_enc IS NOT NULL AND direct_mobile_enc <> '' THEN 1 ELSE 0 END AS has_phone,
            closing_strategy_playbook, vault_status, assigned_at, visible_fields_json,
            agent_notes, agent_outcome, last_contacted_at, updated_at
     FROM crm_vault_properties
     WHERE ${whereSql}
     ORDER BY assigned_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    ...args,
    pageSize,
    offset,
  )

  const sanitized = rows.map(row => {
    const policy = normalizeVisibleFields(safeJson(row.visible_fields_json, null))
    return {
      id: row.id,
      external_deal_id: row.external_deal_id,
      deal_division: row.deal_division,
      dubai_area_community: row.dubai_area_community,
      master_project: row.master_project,
      building_or_project: row.building_or_project,
      exact_unit_door_no: policy.show_exact_unit ? row.exact_unit_door_no : 'Hidden by Management',
      floor_or_zone: policy.show_floor ? row.floor_or_zone : null,
      property_layout_type: row.property_layout_type,
      area_sqm: row.area_sqm,
      size_sqft: row.size_sqft,
      urgency_or_deal_window: row.urgency_or_deal_window,
      score: row.score,
      target_deal_value_aed: policy.show_deal_value ? row.target_deal_value_aed : null,
      est_agency_commission_aed: policy.show_commission ? row.est_agency_commission_aed : null,
      event_or_expiry_date: policy.show_expiry ? row.event_or_expiry_date : null,
      days_to_event: policy.show_expiry ? row.days_to_event : null,
      portal_or_source_status: row.portal_or_source_status,
      owner_name: policy.show_owner_name ? row.owner_name : 'Protected Owner',
      owner_entity_type: row.owner_entity_type,
      // HARD MASKED — raw phone number NEVER leaves the server for agents
      phone_masked: row.has_phone ? (row.direct_mobile_masked || 'MASKED ••••') : 'No Phone on File',
      can_call_masked: Boolean(row.has_phone && policy.allow_masked_call),
      can_whatsapp_masked: Boolean(row.has_phone && policy.allow_masked_whatsapp),
      closing_strategy_playbook: policy.show_playbook ? row.closing_strategy_playbook : null,
      vault_status: row.vault_status,
      assigned_at: row.assigned_at,
      agent_notes: row.agent_notes,
      agent_outcome: row.agent_outcome,
      last_contacted_at: row.last_contacted_at,
      visible_fields: policy,
    }
  })

  return { total, page, pageSize, rows: sanitized }
}

export function updateAgentAssignedProperty(
  user: SessionUser,
  propertyId: number,
  patch: { vault_status?: string; agent_notes?: string; agent_outcome?: string },
) {
  const row = q.get<any>(`SELECT id, assigned_user_id, building_or_project, external_deal_id, vault_status FROM crm_vault_properties WHERE id = ?`, propertyId)
  if (!row) throw notFound('Property not found')
  if (row.assigned_user_id !== user.id && !canAccessCrmVault(user)) throw forbidden('This property is not assigned to you.')
  if (patch.vault_status && !(VAULT_STATUSES as readonly string[]).includes(patch.vault_status)) {
    throw bad(`Invalid status: ${patch.vault_status}`)
  }
  const now = nowIso()
  q.run(
    `UPDATE crm_vault_properties
     SET vault_status = COALESCE(?, vault_status),
         agent_notes = COALESCE(?, agent_notes),
         agent_outcome = COALESCE(?, agent_outcome),
         updated_at = ?
     WHERE id = ?`,
    patch.vault_status ?? null,
    patch.agent_notes !== undefined ? String(patch.agent_notes).slice(0, 4000) : null,
    patch.agent_outcome !== undefined ? String(patch.agent_outcome).slice(0, 500) : null,
    now,
    propertyId,
  )
  q.run(
    `INSERT INTO audit_log(at, user_id, user_name, entity, record_id, record_label, action, changes) VALUES (?,?,?,?,?,?,?,?)`,
    now, user.id, user.name, 'crm_vault_properties', propertyId,
    `${row.external_deal_id} (${row.building_or_project || 'Property'})`,
    'agent_update',
    JSON.stringify(patch),
  )
  return { ok: true, id: propertyId }
}

// ---------------------------------------------------------------- Hard-Masked Bridge Calling (Zero Phone History Exposure)

interface BridgeSession {
  ownerPhone: string
  callerId: string
  record: boolean
  logId: number
  expiresAt: number
}

const activeBridgeTokens = new Map<string, BridgeSession>()

function pruneBridgeTokens() {
  const now = Date.now()
  for (const [k, v] of activeBridgeTokens) {
    if (v.expiresAt <= now) activeBridgeTokens.delete(k)
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Consumes a single-use 60-second bridge token and returns TwiML that connects the agent's answered call to the owner's real number via SWK Caller ID. */
export function consumeBridgeTwiml(token: string): string {
  pruneBridgeTokens()
  const sess = activeBridgeTokens.get(token)
  if (!sess) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">This SWK masked call link has expired. Please initiate the call again from SWK OS.</Say><Hangup/></Response>`
  }
  activeBridgeTokens.delete(token)
  const recordAttr = sess.record ? ' record="record-from-answer-dual"' : ''
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">SWK Properties masked bridge. Connecting you to the property owner now.</Say><Dial callerId="${escapeXml(sess.callerId)}"${recordAttr} timeout="30"><Number>${escapeXml(sess.ownerPhone)}</Number></Dial></Response>`
}

function resolveAgentPhone(user: SessionUser): string {
  const emp = q.get<{ phone: string }>(`SELECT phone FROM employees WHERE user_id = ? AND deleted_at IS NULL LIMIT 1`, user.id)
  if (emp?.phone && emp.phone.trim()) return emp.phone.trim()
  const staff = SWK_STAFF_ACCOUNTS.find(a => a.email.toLowerCase() === user.email.toLowerCase())
  return staff?.phone ?? ''
}

function toE164(phone: string): string {
  const digits = normalizePhone(phone)
  return digits ? `+${digits}` : ''
}

/**
 * Initiates a server-side Hard-Masked Bridge Call.
 * The owner's real number is decrypted ONLY in server memory and NEVER sent to the agent's device or phone dialer.
 * The agent's phone call history ONLY ever sees SWK's company caller ID.
 */
export async function initiateMaskedBridgeCall(
  user: SessionUser,
  propertyId: number,
  publicBaseUrl: string,
): Promise<{ ok: true; log_id: number; provider: string; call_sid: string; message: string }> {
  const row = q.get<any>(`SELECT * FROM crm_vault_properties WHERE id = ?`, propertyId)
  if (!row) throw notFound('Property not found')
  if (row.assigned_user_id !== user.id && !canAccessCrmVault(user)) {
    throw forbidden('You can only place masked calls for properties assigned to you.')
  }
  const policy = normalizeVisibleFields(safeJson(row.visible_fields_json, null))
  if (!canAccessCrmVault(user) && !policy.allow_masked_call) {
    throw forbidden('Masked calling is disabled for this assignment.')
  }
  if (!row.direct_mobile_enc) throw bad('No phone number on file for this property.')

  const ownerPhone = toE164(decryptSecret(row.direct_mobile_enc))
  if (!ownerPhone) throw bad('Stored phone number could not be normalised.')

  const agentPhone = toE164(resolveAgentPhone(user))
  if (!agentPhone) throw bad('Your staff phone number is not set in HR Employees. Ask Admin or Haseeb to update your phone number.')

  const provider = String(getSetting('masked_call_provider') || 'none').trim().toLowerCase()
  const callerId = toE164(String(getSetting('masked_call_caller_id') || ''))
  const record = Boolean(getSetting('masked_call_record') ?? true)
  const now = nowIso()

  const insertLog = (status: string, prov: string, sid: string | null, notes: string) => {
    const res = q.run(
      `INSERT INTO crm_masked_call_logs(vault_property_id, agent_user_id, agent_name, channel, provider, provider_call_sid, status, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      propertyId, user.id, user.name, 'masked_bridge_call', prov, sid, status, notes, now,
    )
    q.run(`UPDATE crm_vault_properties SET last_contacted_at = ?, updated_at = ? WHERE id = ?`, now, now, propertyId)
    return Number(res.lastInsertRowid)
  }

  if (provider === 'twilio') {
    const sid = String(getSetting('masked_call_twilio_sid') || '').trim()
    const token = String(getSetting('masked_call_twilio_token') || '').trim()
    if (!sid || !token || !callerId) {
      insertLog('Bridge Misconfigured', 'twilio', null, 'Missing Twilio SID, Auth Token, or SWK Caller ID')
      throw new HttpError(409, 'Masked Bridge Calling (Twilio) is not fully configured yet. Ask Admin, Shabib, or Haseeb to set Twilio SID, Token, and SWK Caller ID in Settings. Owner number remains strictly hidden.')
    }
    const bridgeToken = crypto.randomBytes(24).toString('base64url')
    const logId = insertLog('Initiating', 'twilio', null, `Two-leg masked bridge via SWK Caller ID ${callerId}`)
    pruneBridgeTokens()
    activeBridgeTokens.set(bridgeToken, { ownerPhone, callerId, record, logId, expiresAt: Date.now() + 90_000 })

    const twimlUrl = `${publicBaseUrl.replace(/\/+$/, '')}/api/public/crm-bridge/twiml/${bridgeToken}`
    const form = new URLSearchParams({ To: agentPhone, From: callerId, Url: twimlUrl })
    const auth = Buffer.from(`${sid}:${token}`).toString('base64')
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      activeBridgeTokens.delete(bridgeToken)
      q.run(`UPDATE crm_masked_call_logs SET status = ?, notes = ? WHERE id = ?`, 'Failed', String(data?.message || resp.statusText).slice(0, 300), logId)
      throw new HttpError(502, `Masked bridge call failed: ${data?.message || resp.statusText}`)
    }
    q.run(`UPDATE crm_masked_call_logs SET status = ?, provider_call_sid = ? WHERE id = ?`, 'Ringing Agent', String(data.sid || ''), logId)
    return {
      ok: true,
      log_id: logId,
      provider: 'twilio',
      call_sid: String(data.sid || ''),
      message: `SWK Office (${callerId}) is calling your phone now. Answer to connect directly to the owner without exposing their number.`,
    }
  }

  if (provider === 'webhook') {
    const url = String(getSetting('masked_call_webhook_url') || '').trim()
    const secret = String(getSetting('masked_call_webhook_secret') || '').trim()
    if (!url) {
      insertLog('Bridge Misconfigured', 'webhook', null, 'Missing SIP/PBX Bridge Webhook URL')
      throw new HttpError(409, 'Masked Bridge Webhook URL is not configured. Ask Admin, Shabib, or Haseeb to configure it in Settings. Owner number remains strictly hidden.')
    }
    const logId = insertLog('Initiating', 'webhook', null, 'Dispatched to SWK SIP/PBX Masked Bridge')
    const body = JSON.stringify({
      log_id: logId,
      property_ref: row.external_deal_id,
      agent_user_id: user.id,
      agent_name: user.name,
      agent_phone: agentPhone,
      target_phone: ownerPhone,
      caller_id: callerId || undefined,
      record,
    })
    const sig = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : ''
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-SWK-Signature': sig } : {}) },
      body,
    })
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      q.run(`UPDATE crm_masked_call_logs SET status = ?, notes = ? WHERE id = ?`, 'Failed', String(data?.error || resp.statusText).slice(0, 300), logId)
      throw new HttpError(502, `SIP Bridge failed: ${data?.error || resp.statusText}`)
    }
    const sid = String(data?.call_sid || data?.id || `wh-${logId}`)
    q.run(`UPDATE crm_masked_call_logs SET status = ?, provider_call_sid = ? WHERE id = ?`, 'Bridge Connected', sid, logId)
    return {
      ok: true,
      log_id: logId,
      provider: 'webhook',
      call_sid: sid,
      message: 'SWK Masked Bridge is ringing your phone now. Your phone history will only show SWK Office.',
    }
  }

  // Strict fail-closed: NEVER reveal the phone number!
  insertLog('Bridge Not Configured', 'none', null, 'Agent requested masked call; telephony bridge not configured yet')
  throw new HttpError(
    409,
    'Hard-Masked Bridge Calling requires a company VoIP/SIP bridge (Twilio Voice or UAE SIP/Ziwo Webhook) configured in Admin → Settings. For security, the owner phone number is strictly locked and never exposed to agent devices.',
  )
}

/** Sends a WhatsApp message via SWK's official WhatsApp Business API without exposing the owner's phone number to the agent. */
export async function sendMaskedWhatsAppRelay(user: SessionUser, propertyId: number, message: string) {
  const text = cleanStr(message).slice(0, 1500)
  if (!text || text.length < 3) throw bad('Enter a message (at least 3 characters).')
  const row = q.get<any>(`SELECT * FROM crm_vault_properties WHERE id = ?`, propertyId)
  if (!row) throw notFound('Property not found')
  if (row.assigned_user_id !== user.id && !canAccessCrmVault(user)) {
    throw forbidden('You can only message owners of properties assigned to you.')
  }
  const policy = normalizeVisibleFields(safeJson(row.visible_fields_json, null))
  if (!canAccessCrmVault(user) && !policy.allow_masked_whatsapp) {
    throw forbidden('Masked WhatsApp relay is disabled for this assignment.')
  }
  if (!row.direct_mobile_enc) throw bad('No phone number on file for this property.')

  const ownerPhone = decryptSecret(row.direct_mobile_enc)
  const now = nowIso()
  const signedMessage = `${text}\n\n— ${user.name}, SWK Properties LLC (Dubai)`
  const res = await sendWhatsApp(ownerPhone, signedMessage)
  const log = q.run(
    `INSERT INTO crm_masked_call_logs(vault_property_id, agent_user_id, agent_name, channel, provider, provider_call_sid, status, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    propertyId, user.id, user.name, 'masked_whatsapp', 'whatsapp_cloud', null,
    res.ok ? 'Sent' : 'Failed',
    res.ok ? text.slice(0, 300) : String(res.error || 'WhatsApp not configured').slice(0, 300),
    now,
  )
  if (!res.ok) {
    throw new HttpError(409, `Masked WhatsApp Relay could not send: ${res.error || 'WhatsApp Cloud API not configured'}. Owner number remains strictly masked.`)
  }
  q.run(`UPDATE crm_vault_properties SET last_contacted_at = ?, updated_at = ? WHERE id = ?`, now, now, propertyId)
  return { ok: true, log_id: Number(log.lastInsertRowid) }
}
