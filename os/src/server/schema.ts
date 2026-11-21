import crypto from 'node:crypto'
import { db,q,qi,tx,isPg,columnsOf,tableExists } from './db'
import { ENTITY_LIST } from '../shared/entities'
import type { EntityDef,FieldDef } from '../shared/types'
import { nowIso } from './util'

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_system_tables',
    sql: `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT NOT NULL, ip TEXT, user_agent TEXT
    );
    CREATE INDEX ix_sessions_user ON sessions(user_id);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, user_name TEXT, entity TEXT NOT NULL, record_id INTEGER, record_label TEXT,
      action TEXT NOT NULL, changes TEXT, ip TEXT
    );
    CREATE INDEX ix_audit_entity ON audit_log(entity, record_id);
    CREATE INDEX ix_audit_at ON audit_log(at);
    CREATE TABLE login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, email TEXT, user_id INTEGER, success INTEGER NOT NULL, reason TEXT, ip TEXT, user_agent TEXT
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, body TEXT, link TEXT,
      read_at TEXT, created_at TEXT NOT NULL, dedupe_key TEXT
    );
    CREATE INDEX ix_notif_user ON notifications(user_id, read_at);
    CREATE UNIQUE INDEX ux_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE INDEX ix_comments_rec ON comments(entity, record_id);
    CREATE TABLE record_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_id INTEGER NOT NULL, ref_type TEXT NOT NULL, ref_value TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL
    );
    CREATE INDEX ix_refs_rec ON record_refs(entity, record_id);
    CREATE INDEX ix_refs_val ON record_refs(ref_value);
    CREATE TABLE record_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_id INTEGER NOT NULL, tag TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL,
      UNIQUE(entity, record_id, tag)
    );
    CREATE TABLE record_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_id INTEGER NOT NULL, to_entity TEXT NOT NULL, to_id INTEGER NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL,
      UNIQUE(entity, record_id, to_entity, to_id)
    );
    CREATE TABLE record_likes (
      entity TEXT NOT NULL, record_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity, record_id, user_id)
    );
    CREATE TABLE video_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_id INTEGER NOT NULL, room TEXT NOT NULL, url TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL
    );
    CREATE INDEX ix_video_rec ON video_calls(entity, record_id);
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT, updated_at TEXT );
    CREATE TABLE sequences ( key TEXT PRIMARY KEY, value INTEGER NOT NULL );
    CREATE TABLE webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id INTEGER NOT NULL, event TEXT NOT NULL, status INTEGER, ok INTEGER, response TEXT, at TEXT NOT NULL
    );
    CREATE TABLE job_tracking_tokens ( job_id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL );
    `,
  },
  { id: '002_job_controls', sql: `
    CREATE TABLE job_closure_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, submitted_by INTEGER NOT NULL, submitted_at TEXT NOT NULL, verified_by INTEGER, verified_at TEXT, fingerprint TEXT);
    CREATE INDEX ix_closure_job ON job_closure_evidence(job_id);
    CREATE TABLE job_reopen_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, reason TEXT NOT NULL, requested_by INTEGER NOT NULL, requested_at TEXT NOT NULL, status TEXT NOT NULL, decided_by INTEGER, decided_at TEXT, decision_reason TEXT);
    CREATE UNIQUE INDEX ix_reopen_pending ON job_reopen_requests(job_id) WHERE status='Pending';
    CREATE TABLE approval_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_id INTEGER NOT NULL, requested_by INTEGER NOT NULL, requested_at TEXT NOT NULL, status TEXT NOT NULL, decided_by INTEGER, decided_at TEXT, reason TEXT);
    CREATE UNIQUE INDEX ix_approval_pending ON approval_requests(entity,record_id) WHERE status='Pending';
  ` },
  { id: '003_email_drafts', sql: `
    CREATE TABLE email_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, from_addr TEXT NOT NULL DEFAULT '', to_addr TEXT NOT NULL DEFAULT '', cc_addr TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE INDEX ix_email_drafts_user ON email_drafts(user_id, updated_at);
  ` },
  { id: '004_swk_one_android', sql: `
    CREATE TABLE mobile_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      employee_id INTEGER,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      model TEXT,
      manufacturer TEXT,
      os_version TEXT,
      app_version TEXT,
      biometric_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'Trusted',
      last_ip TEXT,
      last_seen_at TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      UNIQUE(user_id, device_id)
    );
    CREATE INDEX ix_mob_dev_user ON mobile_devices(user_id, status);
    CREATE TABLE reception_qr_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_code TEXT NOT NULL UNIQUE,
      short_code TEXT NOT NULL,
      branch_id INTEGER,
      office_network_hint TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      scans_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER
    );
    CREATE INDEX ix_qr_tok_exp ON reception_qr_tokens(expires_at);
    CREATE TABLE duty_location_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_session_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      device_id TEXT,
      points_json TEXT NOT NULL,
      points_count INTEGER NOT NULL DEFAULT 1,
      last_lat TEXT,
      last_lng TEXT,
      accuracy_m REAL,
      battery_pct INTEGER,
      network_type TEXT,
      recorded_at TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX ix_duty_batch_session ON duty_location_batches(field_session_id, received_at);
    CREATE TABLE workday_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      employee_id INTEGER,
      work_date TEXT NOT NULL,
      presence_mode TEXT NOT NULL DEFAULT 'Office Work',
      break_started_at TEXT,
      break_minutes INTEGER NOT NULL DEFAULT 0,
      checklist_json TEXT,
      onboarding_json TEXT,
      exit_json TEXT,
      handover_to_user_id INTEGER,
      handover_notes TEXT,
      safety_confirmed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, work_date)
    );
    CREATE TABLE property_key_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_tag TEXT NOT NULL,
      property_id INTEGER,
      building_name TEXT NOT NULL,
      unit_no TEXT NOT NULL,
      action TEXT NOT NULL,
      holder_user_id INTEGER NOT NULL,
      employee_id INTEGER,
      viewing_id INTEGER,
      notes TEXT,
      logged_at TEXT NOT NULL
    );
    CREATE INDEX ix_key_logs_prop ON property_key_logs(building_name, unit_no, logged_at);
    CREATE TABLE offline_sync_queue_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      device_id TEXT,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      queued_at TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
  ` },
  { id: '005_swk_overhaul', sql: `
    CREATE TABLE portal_syndication_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER,
      mandate_id INTEGER,
      portal_name TEXT NOT NULL,
      department_division TEXT,
      action TEXT NOT NULL,
      feed_status TEXT NOT NULL DEFAULT 'Active',
      external_listing_ref TEXT,
      synced_by INTEGER,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX ix_portal_syn_prop ON portal_syndication_logs(property_id, portal_name);
    CREATE TABLE late_contemptor_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      user_id INTEGER,
      work_date TEXT NOT NULL,
      rolling_late_count INTEGER NOT NULL,
      late_dates_json TEXT NOT NULL,
      alerted_owner INTEGER NOT NULL DEFAULT 1,
      alerted_manager INTEGER NOT NULL DEFAULT 1,
      coaching_task_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(employee_id, work_date)
    );
    CREATE INDEX ix_contemptor_emp ON late_contemptor_alerts(employee_id, work_date);
    CREATE INDEX ix_login_events_user ON login_events(user_id);
  ` },
  { id: '006_import_batches', sql: `
    CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      created INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      imported_by INTEGER,
      imported_at TEXT NOT NULL,
      UNIQUE(entity, file_hash)
    );
  ` },
  { id: '007_lead_source_events', sql: `
    CREATE TABLE lead_source_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      lead_id INTEGER,
      new_lead INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  ` },
  { id: '008_links_and_invites', sql: `
    ALTER TABLE job_tracking_tokens ADD COLUMN expires_at TEXT;
    ALTER TABLE job_tracking_tokens ADD COLUMN revoked_at TEXT;
    CREATE TABLE user_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
  ` },
  { id: '009_team_chat', sql: `
    CREATE TABLE chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      kind TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE chat_members (
      thread_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, user_id)
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX chat_messages_thread ON chat_messages(thread_id, id);
  ` },
  { id: '010_staff_devices', sql: `
    CREATE TABLE staff_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      decided_by INTEGER,
      UNIQUE(user_id, device_id)
    );
  ` },
  { id: '011_crm_vault', sql: `
    CREATE TABLE crm_vault_properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_deal_id TEXT NOT NULL UNIQUE,
      source_dataset TEXT NOT NULL,
      source_sheet TEXT NOT NULL,
      suggested_agent TEXT,
      agent_cluster_territory TEXT,
      agent_deal_rank INTEGER,
      deal_division TEXT NOT NULL,
      dubai_area_community TEXT,
      primary_area_dld TEXT,
      master_project TEXT,
      building_or_project TEXT,
      exact_unit_door_no TEXT,
      floor_or_zone TEXT,
      property_layout_type TEXT,
      area_sqm REAL,
      size_sqft REAL,
      urgency_or_deal_window TEXT,
      score REAL,
      target_deal_value_aed REAL,
      current_or_benchmark_aed REAL,
      est_agency_commission_aed REAL,
      event_or_expiry_date TEXT,
      days_to_event INTEGER,
      portal_or_source_status TEXT,
      owner_name TEXT,
      owner_entity_type TEXT,
      owner_nationality TEXT,
      direct_mobile_enc TEXT,
      direct_mobile_masked TEXT,
      direct_mobile_hash TEXT,
      secondary_phone_enc TEXT,
      secondary_phone_masked TEXT,
      email_address_enc TEXT,
      email_address_masked TEXT,
      closing_strategy_playbook TEXT,
      extra_json TEXT,
      vault_status TEXT NOT NULL DEFAULT 'In Vault',
      assigned_user_id INTEGER,
      assigned_by_user_id INTEGER,
      assigned_at TEXT,
      visible_fields_json TEXT,
      agent_notes TEXT,
      agent_outcome TEXT,
      last_contacted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX ix_crm_vault_dataset ON crm_vault_properties(source_dataset, deal_division);
    CREATE INDEX ix_crm_vault_assigned ON crm_vault_properties(assigned_user_id, vault_status);
    CREATE INDEX ix_crm_vault_suggested ON crm_vault_properties(suggested_agent, vault_status);
    CREATE INDEX ix_crm_vault_community ON crm_vault_properties(dubai_area_community);
    CREATE INDEX ix_crm_vault_phone_hash ON crm_vault_properties(direct_mobile_hash);

    CREATE TABLE crm_vault_route_tracker (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_date TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      territory_captain TEXT NOT NULL,
      assigned_user_id INTEGER,
      assigned_corridor TEXT,
      total_cluster_units INTEGER DEFAULT 0,
      morning_towers_scheduled TEXT,
      makani_0915_checkin TEXT DEFAULT 'Pending',
      target_doors_swept INTEGER DEFAULT 0,
      watchmen_snaggers_onboarded INTEGER DEFAULT 0,
      qr_serials_issued TEXT,
      direct_forma_keys_locked INTEGER DEFAULT 0,
      afternoon_viewings_conducted INTEGER DEFAULT 0,
      overflow_tenants_routed_80ltv INTEGER DEFAULT 0,
      ejaris_closed_today INTEGER DEFAULT 0,
      day21_landlord_equity_pitches INTEGER DEFAULT 0,
      manager_haseeb_signoff TEXT DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(route_date, cluster_id)
    );
    CREATE INDEX ix_crm_route_date ON crm_vault_route_tracker(route_date, assigned_user_id);

    CREATE TABLE crm_masked_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_property_id INTEGER NOT NULL,
      agent_user_id INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_call_sid TEXT,
      status TEXT NOT NULL,
      duration_sec INTEGER DEFAULT 0,
      recording_url TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX ix_crm_mcall_prop ON crm_masked_call_logs(vault_property_id, created_at);
    CREATE INDEX ix_crm_mcall_agent ON crm_masked_call_logs(agent_user_id, created_at);
  ` },
  { id: '012_custody_handover', sql: `
    ALTER TABLE crm_vault_properties ADD COLUMN custody TEXT;
    CREATE INDEX ix_crm_vault_custody ON crm_vault_properties(custody, source_dataset);
    CREATE TABLE custody_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      staff_email TEXT,
      contains_contacts INTEGER NOT NULL DEFAULT 0,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      bundle_offset INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'Admin Custody',
      manager_released_at TEXT,
      manager_released_by INTEGER,
      recipient_user_id INTEGER,
      staff_released_at TEXT,
      staff_released_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX ix_custody_docs_recipient ON custody_documents(recipient_user_id, stage);
  ` },
  { id: '013_custody_documents_storage', sql: `
    ALTER TABLE custody_documents ADD COLUMN stored_name TEXT;
    ALTER TABLE custody_documents ADD COLUMN page_names TEXT;
  ` },
]

/** System-table DDL is written once in SQLite dialect and adapted for PostgreSQL. */
const ddl = (sql: string) => (isPg
  ? sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY').replace(/\bINTEGER\b/g, 'BIGINT').replace(/\bREAL\b/g, 'DOUBLE PRECISION')
  : sql)
/** SQLite's ROUND() accepts floats; PostgreSQL's only accepts numeric. This keeps the ~70 ROUND() calls in reports working unchanged. */
const PG_COMPAT = `CREATE OR REPLACE FUNCTION round(double precision, integer) RETURNS double precision LANGUAGE sql IMMUTABLE AS 'SELECT round($1::numeric, $2)::double precision'`

const colType = (f: FieldDef): string => {
  switch (f.type) {
    case 'int': case 'ref': case 'bool': case 'money': return isPg ? 'BIGINT' : 'INTEGER'
    case 'number': case 'percent': return isPg ? 'DOUBLE PRECISION' : 'REAL'
    default: return 'TEXT'
  }
}
const storedFields = (def: EntityDef) => def.fields.filter(f => !f.virtual)

const entitySchemaSignature = () => {
  const raw = ENTITY_LIST.map(def => {
    const flds = storedFields(def).map(f => `${f.name}:${colType(f)}:${f.unique ? 'u' : ''}:${f.type === 'ref' || f.name === def.statusField || f.search || (f.type === 'date' && f.list) ? 'i' : ''}`).join(',')
    return `${def.key}(${flds})`
  }).join(';')
  return 'entity_ddl_' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)
}

export function syncSchema() {
  if (isPg) db.exec(PG_COMPAT)
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const done = new Set(q.all<{ id: string }>('SELECT id FROM schema_migrations').map(r => r.id))
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue
    tx(() => { db.exec(ddl(m.sql)); q.run('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)', m.id, nowIso()) })
  }
  const sig = entitySchemaSignature()
  if (isPg && done.has(sig) && tableExists('users') && tableExists('properties')) {
    return
  }
  tx(() => {
    if (isPg) {
      const existingCols = new Map<string, Set<string>>()
      for (const r of q.all<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)) {
        let s = existingCols.get(r.table_name)
        if (!s) { s = new Set(); existingCols.set(r.table_name, s) }
        s.add(r.column_name)
      }
      const stmts: string[] = []
      for (const def of ENTITY_LIST) {
        const t = def.key
        const fields = storedFields(def)
        const have = existingCols.get(t)
        if (!have) {
          const cols = fields.map(f => `${qi(f.name)} ${colType(f)}`)
          stmts.push(`CREATE TABLE ${qi(t)} (
            id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            ${cols.join(',\n            ')}${cols.length ? ',' : ''}
            custom TEXT,
            version BIGINT NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by BIGINT, updated_by BIGINT, deleted_at TEXT
          )`)
        } else {
          for (const f of fields) if (!have.has(f.name)) stmts.push(`ALTER TABLE ${qi(t)} ADD COLUMN ${qi(f.name)} ${colType(f)}`)
        }
        for (const f of fields) {
          if (f.unique) stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${qi(`ux_${t}_${f.name}`)} ON ${qi(t)}(${qi(f.name)}) WHERE deleted_at IS NULL AND ${qi(f.name)} IS NOT NULL AND ${qi(f.name)} <> ''`)
          else if (f.type === 'ref' || f.name === def.statusField || f.search || (f.type === 'date' && f.list)) stmts.push(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${t}_${f.name}`)} ON ${qi(t)}(${qi(f.name)})`)
        }
        stmts.push(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${t}_deleted`)} ON ${qi(t)}(deleted_at)`)
      }
      stmts.push(`CREATE INDEX IF NOT EXISTS ix_attachments_link ON attachments(link_entity, link_id)`)
      stmts.push(`CREATE INDEX IF NOT EXISTS ix_activities_link ON activities(link_entity, link_id)`)
      stmts.push(`CREATE INDEX IF NOT EXISTS ix_tasks_link ON tasks(link_entity, link_id)`)
      stmts.push(`CREATE INDEX IF NOT EXISTS ix_api_keys_hash ON api_keys(key_hash)`)
      stmts.push(`CREATE INDEX IF NOT EXISTS ix_comp_exc_link ON compliance_exceptions(link_entity, link_id)`)
      if (stmts.length) db.exec(stmts.join(';\n'))
      q.run('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET applied_at = excluded.applied_at', sig, nowIso())
      return
    }
    for (const def of ENTITY_LIST) syncEntity(def)
    db.exec(`CREATE INDEX IF NOT EXISTS ix_attachments_link ON attachments(link_entity, link_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS ix_activities_link ON activities(link_entity, link_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS ix_tasks_link ON tasks(link_entity, link_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS ix_api_keys_hash ON api_keys(key_hash)`)
    if (tableExists('compliance_exceptions')) {
      db.exec(`CREATE INDEX IF NOT EXISTS ix_comp_exc_link ON compliance_exceptions(link_entity, link_id)`)
    }
  })
}

function syncEntity(def: EntityDef) {
  const t = def.key
  const exists = tableExists(t)
  const fields = storedFields(def)
  if (!exists) {
    const cols = fields.map(f => `${qi(f.name)} ${colType(f)}`)
    db.exec(`CREATE TABLE ${qi(t)} (
      id ${isPg ? 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      ${cols.join(',\n      ')}${cols.length ? ',' : ''}
      custom TEXT,
      version ${isPg ? 'BIGINT' : 'INTEGER'} NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by ${isPg ? 'BIGINT' : 'INTEGER'}, updated_by ${isPg ? 'BIGINT' : 'INTEGER'}, deleted_at TEXT
    )`)
  } else {
    const have = new Set(columnsOf(t).map(c => c.name))
    for (const f of fields) if (!have.has(f.name)) db.exec(`ALTER TABLE ${qi(t)} ADD COLUMN ${qi(f.name)} ${colType(f)}`)
  }
  for (const f of fields) {
    if (f.unique) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${qi(`ux_${t}_${f.name}`)} ON ${qi(t)}(${qi(f.name)}) WHERE deleted_at IS NULL AND ${qi(f.name)} IS NOT NULL AND ${qi(f.name)} <> ''`)
    else if (f.type === 'ref' || f.name === def.statusField || f.search || (f.type === 'date' && f.list)) db.exec(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${t}_${f.name}`)} ON ${qi(t)}(${qi(f.name)})`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${t}_deleted`)} ON ${qi(t)}(deleted_at)`)
}

