import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import { q, tx } from '../db'
import { dirs } from '../config'
import { openStored, persistUpload, removeStored, useR2 } from '../integrations/storage'
import { bad, forbidden, notFound, nowIso } from '../util'
import { notify } from '../notify'
import { canAccessCrmVault, canOpenEmployeeRecords, SWK_STAFF_ACCOUNTS } from '../../shared/swk-staff-access'
import type { SessionUser } from '../engine'

/**
 * Controlled handover of lead data and staff documents (chain of custody):
 *   1. Admin Custody   – leads imported (CRM Vault → Import) and documents uploaded by the Admin; only Owner and Admin see them.
 *   2. With Manager    – Owner/Admin release a desk (or everything) to the Operations Manager.
 *   3. Staff           – the Manager dispatches leads with a masking policy (CRM Vault assign) and
 *                        releases each personal document to its named staff member.
 * Documents that carry client phone numbers (calling booklets) never leave management:
 * staff receive those leads only through the masked CRM Vault queue.
 */
export const DOC_KINDS = ['Personal Playbook', 'Field Guide', 'Calling Booklet', 'Roster Index', 'Other'] as const
export interface HandoverDocMeta {
  title: string
  kind: (typeof DOC_KINDS)[number]
  staff_email: string | null
  contains_contacts: boolean
}

function staffEmail(name: string): string | null {
  const first = name.toLowerCase().replace(/^muhammad\s+/, '').split(/[\s_]+/)[0]
  return SWK_STAFF_ACCOUNTS.find(a => a.email.split('@')[0] === first)?.email ?? null
}

/** Recognises SWK file names (SWK_Playbook_<Name>_..., SWK_<Name>.pdf, NN_<Name>_..._Calling_Booklet.pdf …). */
export function guessDocMeta(name: string): HandoverDocMeta | null {
  let m: RegExpMatchArray | null
  if ((m = name.match(/^SWK_Playbook_(Muhammad_)?([A-Za-z]+)_(.+)\.pdf$/i))) return { title: `Personal Playbook – ${m[2]}: ${m[3].replace(/_/g, ' ')}`, kind: 'Personal Playbook', staff_email: staffEmail(m[2]), contains_contacts: false }
  if ((m = name.match(/^SWK_([A-Za-z]+)\.pdf$/i))) return { title: `Field Guide – ${m[1]}`, kind: 'Field Guide', staff_email: staffEmail(m[1]), contains_contacts: false }
  if ((m = name.match(/^\d\d_([A-Za-z]+)(_Shabbir)?_Ejari_30D_60D_Leasing_Calling_Booklet\.pdf$/i))) return { title: `Ejari 0–60D Calling Booklet – ${m[1]}`, kind: 'Calling Booklet', staff_email: staffEmail(m[1]), contains_contacts: true }
  if (/^00_SWK_7_Desks_.*Master_Roster_Index\.xlsx$/i.test(name)) return { title: '7 Desks Master Roster Index', kind: 'Roster Index', staff_email: null, contains_contacts: false }
  return null
}

export const HANDOVER_DATASET = 'ejari_dialer_2026'

export const isTopCustodian = (u: SessionUser | null | undefined) => canOpenEmployeeRecords(u as any)
/** Rows in Admin Custody are hidden from everyone except Owner and Admin. */
export const custodyFilter = (u: SessionUser, alias = 'p') => (isTopCustodian(u) ? '' : ` AND (${alias}.custody IS NULL OR ${alias}.custody <> 'admin')`)


const audit = (u: SessionUser, action: string, label: string, changes: unknown) =>
  q.run(`INSERT INTO audit_log(at, user_id, user_name, entity, record_id, record_label, action, changes) VALUES (?,?,?,?,?,?,?,?)`, nowIso(), u.id, u.name, 'custody_handover', null, label, action, JSON.stringify(changes))

const managerUserId = () => q.val<number>(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Manager' AND u.active = 1 AND u.deleted_at IS NULL AND u.party_id IS NULL ORDER BY u.id LIMIT 1`)

export function handoverOverview(u: SessionUser) {
  if (!canAccessCrmVault(u)) throw forbidden('Restricted to Owner, Admin and the Operations Manager.')
  const desks = q.all<any>(
    `SELECT COALESCE(p.suggested_agent, 'Unassigned') AS desk,
       SUM(CASE WHEN p.custody = 'admin' THEN 1 ELSE 0 END) AS admin_custody,
       SUM(CASE WHEN COALESCE(p.custody, 'manager') <> 'admin' AND p.assigned_user_id IS NULL THEN 1 ELSE 0 END) AS with_manager,
       SUM(CASE WHEN p.assigned_user_id IS NOT NULL THEN 1 ELSE 0 END) AS dispatched,
       COUNT(*) AS total
     FROM crm_vault_properties p WHERE p.source_dataset = ?${custodyFilter(u)}
     GROUP BY COALESCE(p.suggested_agent, 'Unassigned') ORDER BY desk`, HANDOVER_DATASET)
  const docs = q.all<any>(
    `SELECT d.id, d.title, d.kind, d.staff_email, d.contains_contacts, d.size, d.stage, d.manager_released_at, d.staff_released_at, u.name AS recipient_name
     FROM custody_documents d LEFT JOIN users u ON u.id = d.recipient_user_id
     ${isTopCustodian(u) ? '' : `WHERE d.stage <> 'Admin Custody'`} ORDER BY d.staff_email, d.kind`)
  return { can_release_to_manager: isTopCustodian(u), desks, docs }
}

/** Owner/Admin: hand a desk (staff_email) or the whole handover to the Operations Manager. */
export function releaseToManager(u: SessionUser, staffEmail?: string | null) {
  if (!isTopCustodian(u)) throw forbidden('Only the Owner or the Admin can release a handover to the Operations Manager.')
  const local = staffEmail ? staffEmail.split('@')[0].toLowerCase() : null
  const now = nowIso()
  let leads = 0, docs = 0
  tx(() => {
    leads = q.run(`UPDATE crm_vault_properties SET custody = 'manager', updated_at = ? WHERE source_dataset = ? AND custody = 'admin'${local ? ` AND lower(suggested_agent) = ?` : ''}`, now, HANDOVER_DATASET, ...(local ? [local] : [])).changes
    docs = q.run(`UPDATE custody_documents SET stage = 'With Manager', manager_released_at = ?, manager_released_by = ?, updated_at = ? WHERE stage = 'Admin Custody'${staffEmail ? ` AND lower(staff_email) = ?` : ''}`, now, u.id, now, ...(staffEmail ? [staffEmail.toLowerCase()] : [])).changes
  })
  if (!leads && !docs) throw bad('Nothing left in Admin Custody for this selection.')
  audit(u, 'release-to-manager', `Released ${leads} leads and ${docs} documents to the Operations Manager${staffEmail ? ` (desk ${staffEmail})` : ''}`, { staffEmail, leads, docs })
  notify(managerUserId(), 'Handover released to you', `${u.name} released ${leads} leads and ${docs} documents${staffEmail ? ` for ${staffEmail}` : ''}. Set the masking policy and dispatch them to staff.`, '/crm-vault?tab=custody', 'approval')
  return { ok: true, leads, docs }
}

/** Manager (or Owner/Admin): give a personal document to its staff member. Contact-bearing files stay with management. */
export function releaseDocToStaff(u: SessionUser, docId: number) {
  if (!canAccessCrmVault(u)) throw forbidden('Restricted to Owner, Admin and the Operations Manager.')
  const d = q.get<any>(`SELECT * FROM custody_documents WHERE id = ?`, docId)
  if (!d) throw notFound('Document not found')
  if (d.contains_contacts) throw bad('This file contains client phone numbers and cannot be given to staff. Dispatch its leads through the CRM Vault, where numbers stay masked.')
  if (d.stage !== 'With Manager') throw bad(d.stage === 'Admin Custody' ? 'The Admin has not released this document to the Operations Manager yet.' : 'This document is already with the staff member.')
  const target = q.get<{ id: number; name: string }>(`SELECT id, name FROM users WHERE lower(email) = ? AND active = 1 AND deleted_at IS NULL`, String(d.staff_email || '').toLowerCase())
  if (!target) throw bad('This document has no active staff recipient.')
  const now = nowIso()
  q.run(`UPDATE custody_documents SET stage = 'Released to Staff', recipient_user_id = ?, staff_released_at = ?, staff_released_by = ?, updated_at = ? WHERE id = ?`, target.id, now, u.id, now, docId)
  audit(u, 'release-to-staff', `${d.title} released to ${target.name}`, { docId, to: target.id })
  notify(target.id, 'New document from management', `${d.title} is now available under My Assigned Deals → My documents.`, '/my-deals', 'info')
  return { ok: true }
}

/** Owner/Admin: pull a document back into Admin Custody from any stage. */
export function recallDoc(u: SessionUser, docId: number) {
  if (!isTopCustodian(u)) throw forbidden('Only the Owner or the Admin can recall a document.')
  const r = q.run(`UPDATE custody_documents SET stage = 'Admin Custody', recipient_user_id = NULL, manager_released_at = NULL, manager_released_by = NULL, staff_released_at = NULL, staff_released_by = NULL, updated_at = ? WHERE id = ?`, nowIso(), docId)
  if (!r.changes) throw notFound('Document not found')
  audit(u, 'recall', `Document ${docId} recalled to Admin Custody`, { docId })
  return { ok: true }
}

export function myDocs(u: SessionUser) {
  // size is omitted: staff only see the reading copy
  return q.all(`SELECT id, title, kind, staff_released_at FROM custody_documents WHERE recipient_user_id = ? AND stage = 'Released to Staff' AND contains_contacts = 0 ORDER BY kind, title`, u.id)
}

/** Owner/Admin: store an uploaded document in Admin Custody (Cloudflare R2 when configured). Re-uploading a name replaces it and returns it to Admin Custody. */
export async function addDoc(u: SessionUser, file: { name: string; stored: string; mime: string }, fallback: Partial<HandoverDocMeta>) {
  const full = path.join(dirs.uploads, file.stored)
  const created: string[] = [file.stored]
  let pagesDir = ''
  try {
    if (!isTopCustodian(u)) throw forbidden('Only the Owner or the Admin can upload handover documents.')
    // Cloudflare Containers wipe the local disk on restart: there, files must go to R2.
    if (process.env.REQUIRE_DATABASE_URL === 'true' && !useR2()) throw bad('Turn on Cloudflare R2 under Settings → Storage before uploading documents. This server\'s disk is wiped on every restart.')
    const pdf = file.name.toLowerCase().endsWith('.pdf')
    const head = fs.readFileSync(full).subarray(0, 4).toString('latin1')
    // Dialer workbooks are not stored: their leads are already in the CRM Vault.
    if (/_Dialer_(Workbook|Master)\./i.test(file.name)) throw bad(`${file.name}: dialer workbooks are not stored. Their leads are already in the CRM Vault.`)
    if (pdf ? head !== '%PDF' : !head.startsWith('PK')) throw bad(`${file.name} is not a valid ${pdf ? 'PDF' : 'Excel'} file.`)
    const meta = guessDocMeta(file.name) ?? (fallback.kind ? { title: fallback.title || file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '), kind: fallback.kind, staff_email: fallback.staff_email || null, contains_contacts: !!fallback.contains_contacts || fallback.kind === 'Calling Booklet' } : null)
    if (!meta) throw bad(`${file.name}: file name not recognised. Choose the document type and staff member, then upload it again.`)
    const size = fs.statSync(full).size
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    const pageNames: string[] = []
    if (pdf && !meta.contains_contacts) {
      // Staff see these page images, exactly as issued; the PDF itself stays with management.
      const rel = path.join(path.dirname(file.stored), crypto.randomBytes(8).toString('hex'))
      fs.mkdirSync(path.join(dirs.uploads, rel), { recursive: true })
      pagesDir = path.join(dirs.uploads, rel)
      execFileSync('pdftoppm', ['-r', '100', '-jpeg', '-jpegopt', 'quality=75', full, path.join(dirs.uploads, rel, 'p')], { timeout: 120_000 })
      for (const n of fs.readdirSync(path.join(dirs.uploads, rel)).sort()) { const kept = await persistUpload(path.join(rel, n), 'image/jpeg'); created.push(kept); pageNames.push(kept) }
      if (useR2()) fs.rmSync(path.join(dirs.uploads, rel), { recursive: true, force: true }) // pages now live in R2
    }
    const stored = await persistUpload(file.stored, file.mime)
    created[0] = stored
    const old = q.get<any>(`SELECT id, stored_name, page_names FROM custody_documents WHERE name = ?`, file.name)
    const now = nowIso()
    if (old) q.run(`UPDATE custody_documents SET title = ?, kind = ?, staff_email = ?, contains_contacts = ?, mime = ?, size = ?, sha256 = ?, stored_name = ?, page_names = ?, stage = 'Admin Custody', recipient_user_id = NULL, manager_released_at = NULL, manager_released_by = NULL, staff_released_at = NULL, staff_released_by = NULL, updated_at = ? WHERE id = ?`, meta.title, meta.kind, meta.staff_email, meta.contains_contacts ? 1 : 0, file.mime, size, sha256, stored, JSON.stringify(pageNames), now, old.id)
    else q.run(`INSERT INTO custody_documents(name, title, kind, staff_email, contains_contacts, mime, size, sha256, bundle_offset, stored_name, page_names, stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,'Admin Custody',?,?)`, file.name, meta.title, meta.kind, meta.staff_email, meta.contains_contacts ? 1 : 0, file.mime, size, sha256, stored, JSON.stringify(pageNames), now, now)
    if (old) await removeDocFiles(old)
    audit(u, 'upload', meta.title, { name: file.name, pages: pageNames.length })
    return { name: file.name, title: meta.title, kind: meta.kind, staff_email: meta.staff_email, pages: pageNames.length, replaced: !!old }
  } catch (e) {
    await Promise.all(created.map(n => removeStored(n)))
    if (pagesDir) fs.rmSync(pagesDir, { recursive: true, force: true })
    throw e
  }
}

async function removeDocFiles(d: { stored_name?: string | null; page_names?: string | null }) {
  const names = [d.stored_name, ...JSON.parse(d.page_names || '[]')].filter(Boolean) as string[]
  await Promise.all(names.map(n => removeStored(n)))
}

/** Owner/Admin: delete a document and its stored files. */
export async function deleteDoc(u: SessionUser, docId: number) {
  if (!isTopCustodian(u)) throw forbidden('Only the Owner or the Admin can delete a handover document.')
  const d = q.get<any>(`SELECT * FROM custody_documents WHERE id = ?`, docId)
  if (!d) throw notFound('Document not found')
  q.run(`DELETE FROM custody_documents WHERE id = ?`, docId)
  await removeDocFiles(d)
  audit(u, 'delete', d.title, { docId })
  return { ok: true }
}

/** Returns the original file only to management, at its current custody stage. */
export async function openDoc(u: SessionUser, docId: number): Promise<{ name: string; mime: string; body: Readable }> {
  const d = q.get<any>(`SELECT * FROM custody_documents WHERE id = ?`, docId)
  if (!d) throw notFound('Document not found')
  // The original file stays with management; staff view the page images (readDoc / docPage).
  const ok = isTopCustodian(u) || (canAccessCrmVault(u) && d.stage !== 'Admin Custody')
  if (!ok) throw forbidden('The original file is held by management. Open the view copy instead.')
  const body = d.stored_name ? await openStored(d.stored_name) : null
  if (!body) throw bad('The stored file is missing. Upload the document again.')
  audit(u, 'download', d.title, { docId })
  return { name: d.name, mime: d.mime, body }
}

function viewable(u: SessionUser, docId: number) {
  const d = q.get<any>(`SELECT * FROM custody_documents WHERE id = ?`, docId)
  if (!d) throw notFound('Document not found')
  const ok = canAccessCrmVault(u) ? isTopCustodian(u) || d.stage !== 'Admin Custody' : d.stage === 'Released to Staff' && d.recipient_user_id === u.id && !d.contains_contacts
  if (!ok) throw forbidden('This document has not been released to you.')
  const pages: string[] = JSON.parse(d.page_names || '[]')
  if (!pages.length) throw bad('No view copy is available for this document.')
  return { d, pages }
}

/** View copy: the original pages as images, watermarked in the viewer with the reader's identity. */
export function readDoc(u: SessionUser, docId: number) {
  const { d, pages } = viewable(u, docId)
  audit(u, 'read', d.title, { docId })
  return { title: d.title, kind: d.kind, pages: pages.length, watermark: `${u.name} · ${u.email} · ${nowIso().slice(0, 10)} · Confidential – SWK Properties` }
}

export async function docPage(u: SessionUser, docId: number, page: number): Promise<Readable> {
  const { pages } = viewable(u, docId)
  const name = pages[page - 1]
  if (!name) throw notFound('Page not found')
  const body = await openStored(name)
  if (!body) throw bad('The stored page is missing. Upload the document again.')
  return body
}
