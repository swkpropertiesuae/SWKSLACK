import { post } from './api';

/** Field work (inspections, viewings, visits, snags, activities) saved while offline waits here and is replayed once the device is online.
 *  shortcut: stored as plain JSON in localStorage, not encrypted and not resumable for files; move to IndexedDB + WebCrypto if devices are shared. */
export const OFFLINE_ENTITIES = ['inspections', 'viewings', 'property_visits', 'snagging_items', 'activities']
export interface QueuedAction { key: string; op: 'create' | 'update'; entity: string; id?: number; payload: Record<string, any>; queued_at: string; status: 'pending' | 'conflict' | 'rejected'; error?: string }

const STORE = 'swk.offline.queue'
const DEVICE = 'swk.device.id'
const read = (): QueuedAction[] => { try { return JSON.parse(localStorage.getItem(STORE) || '[]') } catch { return [] } }
const write = (q: QueuedAction[]) => { try { localStorage.setItem(STORE, JSON.stringify(q)) } catch { /* storage full or blocked */ } window.dispatchEvent(new Event('swk:queue')) }
const deviceId = () => { let d = ''; try { d = localStorage.getItem(DEVICE) || ''; if (!d) { d = crypto.randomUUID(); localStorage.setItem(DEVICE, d) } } catch { /* ignore */ } return d }

export const queuedActions = () => read()
export const canQueue = (entity: string) => OFFLINE_ENTITIES.includes(entity) && typeof navigator !== 'undefined' && !navigator.onLine
export function enqueue(a: Omit<QueuedAction, 'key' | 'queued_at' | 'status'>) {
  write([...read(), { ...a, key: crypto.randomUUID(), queued_at: new Date().toISOString(), status: 'pending' }])
}
export function discard(key: string) { write(read().filter(a => a.key !== key)) }

let flushing = false
/** Sends pending actions in order. Synced ones leave the queue; conflicts and rejections stay, with the reason, for a person to review. */
export async function flush() {
  if (flushing || !navigator.onLine) return
  const pending = read().filter(a => a.status === 'pending')
  if (!pending.length) return
  flushing = true
  try {
    const { results } = await post<{ results: { key: string; status: string; error?: string }[] }>('/api/sync/actions', { device_id: deviceId(), actions: pending.map(({ key, op, entity, id, payload, queued_at }) => ({ key, op, entity, id, payload, queued_at })) })
    const byKey = new Map(results.map(r => [r.key, r]))
    write(read().flatMap(a => { const r = byKey.get(a.key); if (!r) return [a]; if (r.status === 'synced') return []; return [{ ...a, status: r.status as QueuedAction['status'], error: r.error }] }))
  } catch { /* still offline or server error: keep everything, retry on the next trigger */ } finally { flushing = false }
}
export function startOfflineSync() {
  window.addEventListener('online', () => void flush())
  void flush()
}
