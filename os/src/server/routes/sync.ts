import type { FastifyInstance } from 'fastify'
import { can } from '../engine'
import { inDemo } from '../db'
import { headSeq, oldestSeq, selectChanges, waitForChanges, type Change } from '../changefeed'

export default async function (app: FastifyInstance) {
  // Long-poll: returns immediately if events exist, otherwise holds up to `wait` seconds (max 25).
  app.get('/api/sync/changes', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const u = req.user!, qs = req.query as any, demo = inDemo()
    const wait = Math.min(25, Math.max(0, Number(qs.wait) || 0)) * 1000
    const head = headSeq()
    if (qs.since === undefined || qs.since === '') return { seq: head, events: [], reset: false }
    const since = Math.max(0, Number(qs.since) || 0)
    if (since > head || since < oldestSeq() - 1) return { seq: head, events: [], reset: true } // server restarted or client fell behind: refresh everything
    const visible = (c: Change) => c.demo === demo && (c.uid == null || c.uid === u.id) && (!c.module || can(u, c.module, 'view'))
    const events = await waitForChanges(since, visible, wait, () => (req.raw as any).destroyed === true)
    return { seq: Math.max(headSeq(), since), events: events.map(({ entity, id, op, seq, at }) => ({ seq, entity, id, op, at })), reset: false }
  })
}
