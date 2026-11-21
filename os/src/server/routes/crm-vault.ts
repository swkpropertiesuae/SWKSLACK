import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config, dirs } from '../config'
import { q } from '../db'
import { bad, forbidden, notFound, nowIso, todayStr } from '../util'
import { canAccessCrmVault } from '../../shared/swk-staff-access'
import {
  assignVaultProperties,
  consumeBridgeTwiml,
  getVaultSummary,
  initiateMaskedBridgeCall,
  listAgentAssignedProperties,
  listAssignableAgents,
  listVaultPropertiesForLeadership,
  parseAndImportVaultBuffer,
  sendMaskedWhatsAppRelay,
  unassignVaultProperties,
  updateAgentAssignedProperty,
} from '../domain/crm-vault'
import { getSetting, setSettings } from '../settings'
import { addDoc, deleteDoc, DOC_KINDS, docPage, handoverOverview, isTopCustodian, myDocs, openDoc, readDoc, recallDoc, releaseDocToStaff, releaseToManager } from '../domain/handover'

const visibleFieldsSchema = z.object({
  show_owner_name: z.boolean().optional(),
  show_exact_unit: z.boolean().optional(),
  show_floor: z.boolean().optional(),
  show_deal_value: z.boolean().optional(),
  show_commission: z.boolean().optional(),
  show_expiry: z.boolean().optional(),
  show_playbook: z.boolean().optional(),
  allow_masked_call: z.boolean().optional(),
  allow_masked_whatsapp: z.boolean().optional(),
}).optional()

export default async function crmVaultRoutes(app: FastifyInstance) {
  const requireLeadership = (req: any) => {
    if (!req.user || !canAccessCrmVault(req.user)) {
      throw forbidden('CRM Vault access is restricted exclusively to Owner Shabib, Admin, and Operations Manager Haseeb.')
    }
  }

  // ---------------------------------------------------------------- Custody handover (Admin -> Operations Manager -> staff)
  app.get('/api/handover/overview', async (req) => handoverOverview(req.user!))
  app.post('/api/handover/release-to-manager', async (req) => {
    const b = z.object({ staff_email: z.string().email().nullish() }).parse(req.body ?? {})
    return releaseToManager(req.user!, b.staff_email)
  })
  app.post('/api/handover/docs/:id/release-to-staff', async (req) => releaseDocToStaff(req.user!, Number((req.params as any).id)))
  app.post('/api/handover/docs/:id/recall', async (req) => recallDoc(req.user!, Number((req.params as any).id)))
  app.get('/api/handover/my-docs', async (req) => myDocs(req.user!))
  app.get('/api/handover/docs/:id/read', async (req, reply) => { reply.header('cache-control', 'private, no-store'); return readDoc(req.user!, Number((req.params as any).id)) })
  app.get('/api/handover/docs/:id/file', async (req, reply) => {
    const f = await openDoc(req.user!, Number((req.params as any).id))
    reply.header('content-type', f.mime).header('content-disposition', `inline; filename="${f.name.replace(/[^\w.\- ]+/g, '_')}"`).header('cache-control', 'private, no-store')
    return reply.send(f.body)
  })
  app.get('/api/handover/docs/:id/page/:n', async (req, reply) => {
    const p = req.params as any
    const img = await docPage(req.user!, Number(p.id), Number(p.n))
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, no-store').header('content-disposition', 'inline').send(img)
  })
  app.delete('/api/handover/docs/:id', async (req) => deleteDoc(req.user!, Number((req.params as any).id)))
  // Owner/Admin upload. Fields (kind, staff_email, contains_contacts) apply only to file names the system does not recognise.
  app.post('/api/handover/docs', async (req) => {
    if (!isTopCustodian(req.user)) throw forbidden('Only the Owner or the Admin can upload handover documents.')
    if (!req.isMultipart()) throw bad('Expected a multipart upload')
    const fields: Record<string, string> = {}
    const saved: { name: string; stored: string; mime: string }[] = []
    const dayDir = path.join(dirs.uploads, todayStr().slice(0, 7))
    fs.mkdirSync(dayDir, { recursive: true })
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') { fields[part.fieldname] = String(part.value); continue }
        const name = path.basename(part.filename || 'file').replace(/[^\w.\- ()]+/g, '_').slice(0, 150)
        const ext = path.extname(name).slice(1).toLowerCase()
        if (!['pdf', 'xlsx'].includes(ext)) { part.file.resume(); throw bad(`${name}: only PDF and Excel (.xlsx) files can be uploaded.`) }
        const stored = path.join(todayStr().slice(0, 7), crypto.randomBytes(16).toString('hex') + '.' + ext)
        await pipeline(part.file, fs.createWriteStream(path.join(dirs.uploads, stored)))
        if ((part.file as any).truncated) { fs.rmSync(path.join(dirs.uploads, stored), { force: true }); throw bad(`${name} exceeds the ${config.maxUploadMb} MB limit`) }
        saved.push({ name, stored, mime: part.mimetype })
      }
    } catch (e) { for (const f of saved) fs.rmSync(path.join(dirs.uploads, f.stored), { force: true }); throw e }
    if (!saved.length) throw bad('No file received')
    const kind = (DOC_KINDS as readonly string[]).includes(fields.kind) ? (fields.kind as (typeof DOC_KINDS)[number]) : undefined
    const results = []
    for (const f of saved) {
      try { results.push({ ok: true, ...(await addDoc(req.user!, f, { kind, staff_email: fields.staff_email || null, contains_contacts: fields.contains_contacts === 'true', title: fields.title })) }) }
      catch (e: any) { results.push({ ok: false, name: f.name, error: e?.message ?? String(e) }) }
    }
    return { results }
  })

  // ---------------------------------------------------------------- Leadership Endpoints (Admin, Shabib, Haseeb ONLY)

  app.get('/api/crm-vault/summary', async (req) => {
    requireLeadership(req)
    return getVaultSummary(req.user!)
  })

  app.get('/api/crm-vault/agents', async (req) => {
    requireLeadership(req)
    return { agents: listAssignableAgents(req.user!) }
  })

  app.get('/api/crm-vault/filters', async (req) => {
    requireLeadership(req)
    const suggested = q.all<{ v: string }>(`SELECT DISTINCT suggested_agent AS v FROM crm_vault_properties WHERE suggested_agent IS NOT NULL AND suggested_agent <> '' ORDER BY v`).map(r => r.v)
    const divisions = q.all<{ v: string }>(`SELECT DISTINCT deal_division AS v FROM crm_vault_properties WHERE deal_division IS NOT NULL AND deal_division <> '' ORDER BY v`).map(r => r.v)
    const communities = q.all<{ v: string }>(`SELECT DISTINCT dubai_area_community AS v FROM crm_vault_properties WHERE dubai_area_community IS NOT NULL AND dubai_area_community <> '' ORDER BY v`).map(r => r.v)
    return { suggested_agents: suggested, divisions, communities }
  })

  app.get('/api/crm-vault/properties', async (req) => {
    requireLeadership(req)
    const query = (req.query || {}) as Record<string, string>
    return listVaultPropertiesForLeadership(req.user!, {
      q: query.q,
      dataset: query.dataset,
      suggested_agent: query.suggested_agent,
      assigned_user_id: query.assigned_user_id,
      division: query.division,
      community: query.community,
      status: query.status,
      has_phone: query.has_phone,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 50,
    })
  })

  app.post('/api/crm-vault/assign', async (req) => {
    requireLeadership(req)
    const body = z.object({
      property_ids: z.array(z.number().int().positive()).min(1).max(500),
      agent_user_id: z.number().int().positive(),
      visible_fields: visibleFieldsSchema,
    }).parse(req.body)
    return assignVaultProperties(req.user!, body)
  })

  app.post('/api/crm-vault/unassign', async (req) => {
    requireLeadership(req)
    const body = z.object({
      property_ids: z.array(z.number().int().positive()).min(1).max(500),
    }).parse(req.body)
    return unassignVaultProperties(req.user!, body.property_ids)
  })

  app.get('/api/crm-vault/routes', async (req) => {
    requireLeadership(req)
    const query = (req.query || {}) as Record<string, string>
    const where: string[] = ['1=1']
    const args: any[] = []
    if (query.captain && query.captain !== 'all') { where.push('lower(territory_captain) = ?'); args.push(query.captain.toLowerCase()) }
    if (query.date) { where.push('route_date = ?'); args.push(query.date) }
    const rows = q.all<any>(
      `SELECT * FROM crm_vault_route_tracker WHERE ${where.join(' AND ')} ORDER BY route_date ASC, cluster_id ASC LIMIT 500`,
      ...args,
    )
    return { total: rows.length, rows }
  })

  app.patch('/api/crm-vault/routes/:id', async (req) => {
    requireLeadership(req)
    const id = Number((req.params as any).id)
    if (!Number.isInteger(id) || id <= 0) throw bad('Invalid route id')
    const body = z.object({
      makani_0915_checkin: z.string().max(100).optional(),
      watchmen_snaggers_onboarded: z.number().int().min(0).optional(),
      direct_forma_keys_locked: z.number().int().min(0).optional(),
      afternoon_viewings_conducted: z.number().int().min(0).optional(),
      overflow_tenants_routed_80ltv: z.number().int().min(0).optional(),
      ejaris_closed_today: z.number().int().min(0).optional(),
      day21_landlord_equity_pitches: z.number().int().min(0).optional(),
      manager_haseeb_signoff: z.string().max(100).optional(),
    }).parse(req.body)
    const existing = q.get(`SELECT id FROM crm_vault_route_tracker WHERE id = ?`, id)
    if (!existing) throw notFound('Route tracker row not found')
    q.run(
      `UPDATE crm_vault_route_tracker SET
        makani_0915_checkin = COALESCE(?, makani_0915_checkin),
        watchmen_snaggers_onboarded = COALESCE(?, watchmen_snaggers_onboarded),
        direct_forma_keys_locked = COALESCE(?, direct_forma_keys_locked),
        afternoon_viewings_conducted = COALESCE(?, afternoon_viewings_conducted),
        overflow_tenants_routed_80ltv = COALESCE(?, overflow_tenants_routed_80ltv),
        ejaris_closed_today = COALESCE(?, ejaris_closed_today),
        day21_landlord_equity_pitches = COALESCE(?, day21_landlord_equity_pitches),
        manager_haseeb_signoff = COALESCE(?, manager_haseeb_signoff),
        updated_at = ?
       WHERE id = ?`,
      body.makani_0915_checkin ?? null,
      body.watchmen_snaggers_onboarded ?? null,
      body.direct_forma_keys_locked ?? null,
      body.afternoon_viewings_conducted ?? null,
      body.overflow_tenants_routed_80ltv ?? null,
      body.ejaris_closed_today ?? null,
      body.day21_landlord_equity_pitches ?? null,
      body.manager_haseeb_signoff ?? null,
      nowIso(),
      id,
    )
    return { ok: true, id }
  })

  app.get('/api/crm-vault/call-logs', async (req) => {
    requireLeadership(req)
    const rows = q.all<any>(
      `SELECT l.*, p.external_deal_id, p.building_or_project, p.dubai_area_community, p.direct_mobile_masked
       FROM crm_masked_call_logs l
       LEFT JOIN crm_vault_properties p ON p.id = l.vault_property_id
       ORDER BY l.id DESC
       LIMIT 300`,
    )
    return { total: rows.length, rows }
  })

  app.get('/api/crm-vault/bridge-settings', async (req) => {
    requireLeadership(req)
    return {
      masked_call_provider: String(getSetting('masked_call_provider') || 'none'),
      masked_call_caller_id: String(getSetting('masked_call_caller_id') || ''),
      masked_call_twilio_sid: String(getSetting('masked_call_twilio_sid') || ''),
      masked_call_twilio_token_set: Boolean(getSetting('masked_call_twilio_token')),
      masked_call_webhook_url: String(getSetting('masked_call_webhook_url') || ''),
      masked_call_webhook_secret_set: Boolean(getSetting('masked_call_webhook_secret')),
      masked_call_record: Boolean(getSetting('masked_call_record') ?? true),
    }
  })

  app.post('/api/crm-vault/bridge-settings', async (req) => {
    requireLeadership(req)
    const body = z.object({
      masked_call_provider: z.enum(['none', 'twilio', 'webhook']),
      masked_call_caller_id: z.string().max(40).optional(),
      masked_call_twilio_sid: z.string().max(120).optional(),
      masked_call_twilio_token: z.string().max(200).optional(),
      masked_call_webhook_url: z.string().max(500).optional(),
      masked_call_webhook_secret: z.string().max(200).optional(),
      masked_call_record: z.boolean().optional(),
    }).parse(req.body)
    const patch: Record<string, any> = {
      masked_call_provider: body.masked_call_provider,
      masked_call_caller_id: body.masked_call_caller_id ?? '',
      masked_call_twilio_sid: body.masked_call_twilio_sid ?? '',
      masked_call_webhook_url: body.masked_call_webhook_url ?? '',
      masked_call_record: body.masked_call_record ?? true,
    }
    if (body.masked_call_twilio_token) patch.masked_call_twilio_token = body.masked_call_twilio_token
    if (body.masked_call_webhook_secret) patch.masked_call_webhook_secret = body.masked_call_webhook_secret
    setSettings(patch)
    return { ok: true }
  })

  app.post('/api/crm-vault/import', async (req) => {
    requireLeadership(req)
    const parts = (req as any).parts?.()
    if (!parts) throw bad('Upload an .xlsx or .csv file using multipart/form-data.')
    let propInserted = 0, propUpdated = 0, routeInserted = 0, routeUpdated = 0, filesProcessed = 0
    for await (const part of parts) {
      if (part.type !== 'file') continue
      const chunks: Buffer[] = []
      for await (const chunk of part.file) chunks.push(chunk as Buffer)
      const buf = Buffer.concat(chunks)
      const res = await parseAndImportVaultBuffer(buf, String(part.filename || 'upload.xlsx'))
      propInserted += res.properties.inserted
      propUpdated += res.properties.updated
      routeInserted += res.routes.inserted
      routeUpdated += res.routes.updated
      filesProcessed++
    }
    if (!filesProcessed) throw bad('No files uploaded.')
    return {
      ok: true,
      files_processed: filesProcessed,
      properties: { inserted: propInserted, updated: propUpdated, total: propInserted + propUpdated },
      routes: { inserted: routeInserted, updated: routeUpdated, total: routeInserted + routeUpdated },
    }
  })

  // ---------------------------------------------------------------- Agent Endpoints (Strictly Scoped + Hard-Masked Phones)

  app.get('/api/crm-vault/my-assignments', async (req) => {
    const query = (req.query || {}) as Record<string, string>
    return listAgentAssignedProperties(req.user!, {
      q: query.q,
      status: query.status,
      division: query.division,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 50,
    })
  })

  app.patch('/api/crm-vault/my-assignments/:id', async (req) => {
    const id = Number((req.params as any).id)
    if (!Number.isInteger(id) || id <= 0) throw bad('Invalid property id')
    const body = z.object({
      vault_status: z.string().max(60).optional(),
      agent_notes: z.string().max(4000).optional(),
      agent_outcome: z.string().max(500).optional(),
    }).parse(req.body)
    return updateAgentAssignedProperty(req.user!, id, body)
  })

  app.post('/api/crm-vault/my-assignments/:id/masked-call', async (req) => {
    const id = Number((req.params as any).id)
    if (!Number.isInteger(id) || id <= 0) throw bad('Invalid property id')
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim()
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'os.swk.properties').split(',')[0].trim()
    const baseUrl = process.env.APP_PUBLIC_URL || `${proto}://${host}`
    return initiateMaskedBridgeCall(req.user!, id, baseUrl)
  })

  app.post('/api/crm-vault/my-assignments/:id/masked-whatsapp', async (req) => {
    const id = Number((req.params as any).id)
    if (!Number.isInteger(id) || id <= 0) throw bad('Invalid property id')
    const body = z.object({ message: z.string().trim().min(3).max(1500) }).parse(req.body)
    return sendMaskedWhatsAppRelay(req.user!, id, body.message)
  })

  app.get('/api/crm-vault/my-routes', async (req) => {
    const first = String(req.user!.name || '').trim().split(/\s+/)[0].toLowerCase()
    const rows = q.all<any>(
      `SELECT * FROM crm_vault_route_tracker
       WHERE assigned_user_id = ? OR lower(territory_captain) LIKE ?
       ORDER BY route_date ASC, cluster_id ASC
       LIMIT 100`,
      req.user!.id,
      `${first}%`,
    )
    return { total: rows.length, rows }
  })

  // ---------------------------------------------------------------- Public Signed Single-Use TwiML Callback for Masked Bridge Calling

  const twimlHandler = async (req: any, reply: any) => {
    const xml = consumeBridgeTwiml(String(req.params?.token || ''))
    reply.header('Content-Type', 'application/xml; charset=utf-8').send(xml)
  }
  app.get('/api/public/crm-bridge/twiml/:token', twimlHandler)
  app.post('/api/public/crm-bridge/twiml/:token', twimlHandler)
}
