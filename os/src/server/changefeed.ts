// Real-time change feed. Every committed create / update / delete (and every notification) is published with a sequence number.
// Clients long-poll GET /api/sync/changes?since=<seq> and refresh the affected screens the moment something changes.
// Events carry NO record data (entity key, id, operation only) so the feed cannot leak content; the client re-reads through the permissioned API.
import { EventEmitter } from 'node:events'
import { inDemo } from './db'

export interface Change { seq: number; entity: string; module: string; id: number; op: 'create' | 'update' | 'delete'; at: string; demo: boolean; uid: number | null }
const BUF: Change[] = []
let seq = 0
const bus = new EventEmitter(); bus.setMaxListeners(0)
const MAX = 4000

export function emitChange(entity: string, module: string, id: number, op: Change['op'], uid: number | null = null) {
  const c: Change = { seq: ++seq, entity, module, id, op, at: new Date().toISOString(), demo: inDemo(), uid }
  BUF.push(c); if (BUF.length > MAX) BUF.splice(0, MAX / 4)
  bus.emit('c', c)
}
export const headSeq = () => seq
export const oldestSeq = () => (BUF[0]?.seq ?? seq + 1)

export function selectChanges(since: number, visible: (c: Change) => boolean): Change[] {
  return BUF.filter(c => c.seq > since && visible(c))
}
/** Resolves with matching events as soon as one exists, or [] after waitMs. */
export function waitForChanges(since: number, visible: (c: Change) => boolean, waitMs: number, aborted: () => boolean): Promise<Change[]> {
  const now = selectChanges(since, visible)
  if (now.length || waitMs <= 0) return Promise.resolve(now)
  return new Promise(resolve => {
    let done = false
    const finish = () => { if (done) return; done = true; clearTimeout(t); clearInterval(chk); bus.off('c', on); resolve(selectChanges(since, visible)) }
    const on = (c: Change) => { if (c.seq > since && visible(c)) finish() }
    const t = setTimeout(finish, waitMs), chk = setInterval(() => { if (aborted()) finish() }, 1000)
    bus.on('c', on)
  })
}
