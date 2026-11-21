import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const file = process.env.DB_FILE || 'data/hub.db'
if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
export const db = new DatabaseSync(file)
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY, name TEXT NOT NULL, topic TEXT DEFAULT '', is_dm INTEGER DEFAULT 0,
  is_private INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS members(channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  last_read INTEGER DEFAULT 0, PRIMARY KEY(channel_id, user_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER, bot_name TEXT, parent_id INTEGER, body TEXT NOT NULL, reactions TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, edited_at TEXT);
CREATE INDEX IF NOT EXISTS msg_ch ON messages(channel_id, parent_id, id);
CREATE TABLE IF NOT EXISTS tables(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'base', icon TEXT DEFAULT '',
  fields TEXT NOT NULL DEFAULT '[]', group_field TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}', created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS rec_t ON records(table_id, id);
CREATE TABLE IF NOT EXISTS automations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  trigger TEXT NOT NULL, actions TEXT NOT NULL DEFAULT '[]', state TEXT DEFAULT '{}', last_run_at INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS automation_runs(id INTEGER PRIMARY KEY, automation_id INTEGER REFERENCES automations(id) ON DELETE CASCADE,
  status TEXT, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hooks(id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, table_id INTEGER, channel_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER, detail TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);`)

export const one = (sql, ...a) => db.prepare(sql).get(...a)
export const all = (sql, ...a) => db.prepare(sql).all(...a)
export const run = (sql, ...a) => db.prepare(sql).run(...a)
export const token = (n = 24) => randomBytes(n).toString('base64url')

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`
}
export function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(String(pw), salt, 64))
}
export function setting(key, fallback) {
  const r = one('SELECT value FROM settings WHERE key=?', key)
  if (r) return r.value
  if (fallback !== undefined) run('INSERT INTO settings(key,value) VALUES(?,?)', key, fallback)
  return fallback
}

// Row shapers: JSON columns out as objects.
export const tableOut = t => t && { ...t, fields: JSON.parse(t.fields) }
export const recordOut = r => r && { ...r, data: JSON.parse(r.data) }
export const msgOut = m => m && { ...m, reactions: JSON.parse(m.reactions) }
export const autoOut = a => a && { ...a, enabled: !!a.enabled, trigger: JSON.parse(a.trigger), actions: JSON.parse(a.actions), state: JSON.parse(a.state) }
export const audit = (user_id, action, entity, entity_id, detail = '') =>
  run('INSERT INTO audit(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)', user_id ?? null, action, entity, entity_id ?? null, detail)
