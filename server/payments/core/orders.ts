import { run } from '../../db.js';
import { id, now } from '../../core.js';

/** Same row shape as marketplace `appendOrderEvent` (kept here to avoid an import cycle with the marketplace router). */
export function insertOrderEvent(orderId: string, actorId: string, kind: 'purchased' | 'completed', body = '') {
  run(`INSERT INTO order_events (id,order_id,actor_id,kind,body,order_version,created_at)
    SELECT ?,id,?,?,?,version,? FROM orders WHERE id=?`, id(), actorId, kind, body, now(), orderId);
}
