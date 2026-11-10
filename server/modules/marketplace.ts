import { Router, type Request } from 'express';
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, canManageProject, HttpError, id, notify, now, param, requireUser } from '../core.js';
import { paymentSummary } from '../finance.js';
import { releaseOrderEscrow } from '../payments/escrow.js';
import { paymentMode, type PaymentMode } from '../payments/mode.js';

const router = Router();
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const kinds = z.enum(['software', 'component', 'prototype', 'service', 'concept']);
const listingInput = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(20).max(10000),
  kind: kinds,
  price_cents: z.number().int().min(1).max(10000000),
  license: z.string().trim().min(10).max(5000),
  deliverables: z.string().trim().min(10).max(5000),
  project_id: identifier.nullable().optional(),
}).strict();
const editInput = listingInput.partial().refine((value) => Object.keys(value).length > 0, 'Aucune modification.');
const pageInput = {
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
};
const versionInput = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const revisionNote = z.string().trim().min(10).max(5000)
  .refine((value) => (value.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 5, 'Précisez les corrections attendues.');
type OrderEventKind = 'purchased' | 'delivered' | 'revision_requested' | 'completed' | 'disputed' | 'resumed' | 'refunded';

// Called inside the same transaction as the order transition and its audit.
export function appendOrderEvent(orderId: string, actorId: string, kind: OrderEventKind, body = '') {
  run(`INSERT INTO order_events (id,order_id,actor_id,kind,body,order_version,created_at)
    SELECT ?,id,?,?,?,version,? FROM orders WHERE id=?`, id(), actorId, kind, body, now(), orderId);
}

interface Listing {
  id: string;
  seller_id: string;
  project_id: string | null;
  project_title: string | null;
  title: string;
  description: string;
  kind: z.infer<typeof kinds>;
  price_cents: number;
  license: string;
  deliverables: string;
  status: 'active' | 'archived';
  created_at: string;
  seller_name: string;
  seller_color: string;
  terms_locked: number;
  license_type: 'non_exclusive';
}

interface Order {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  price_cents: number;
  status: 'paid' | 'delivered' | 'completed' | 'disputed' | 'refunded';
  delivery_text: string;
  created_at: string;
  listing_title: string;
  kind: Listing['kind'];
  license: string;
  deliverables: string;
  buyer_name: string;
  seller_name: string;
  version: number;
  revision_requested: number;
  payment_mode: PaymentMode;
}

// Project visibility can change after publication: never return a now-private link.
const listingSelect = `SELECT l.id,l.seller_id,
  CASE WHEN p.visibility='public' THEN p.id ELSE NULL END AS project_id,
  CASE WHEN p.visibility='public' THEN p.title ELSE NULL END AS project_title,
  l.title,l.description,l.kind,l.price_cents,l.license,l.deliverables,l.status,l.created_at,
  u.name AS seller_name,u.avatar_color AS seller_color,
  EXISTS(SELECT 1 FROM orders o WHERE o.listing_id=l.id) AS terms_locked,
  'non_exclusive' AS license_type
  FROM listings l JOIN users u ON u.id=l.seller_id LEFT JOIN projects p ON p.id=l.project_id`;
const orderSelect = `SELECT o.id,o.listing_id,o.buyer_id,o.seller_id,o.price_cents,o.status,o.delivery_text,o.created_at,o.version,o.revision_requested,o.payment_mode,
  l.title AS listing_title,l.kind,l.license,l.deliverables,b.name AS buyer_name,s.name AS seller_name
  FROM orders o JOIN listings l ON l.id=o.listing_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id`;

function pathId(req: Request) {
  return identifier.parse(param(req));
}

function listingById(listingId: string): Listing {
  const listing = one<Listing>(`${listingSelect} WHERE l.id=?`, listingId);
  if (!listing) throw new HttpError(404, 'Offre introuvable.');
  return listing;
}

function participantOrder(orderId: string, userId: string): Order {
  const order = one<Order>(`${orderSelect} WHERE o.id=? AND (o.buyer_id=? OR o.seller_id=?)`, orderId, userId, userId);
  if (!order) throw new HttpError(404, 'Commande introuvable.');
  return order;
}

/** Real-money orders are settled in the ledger (release/refund journals) instead of demo transactions. */
function hasRealSettlement(orderId: string) {
  return !!one("SELECT id FROM ledger_journals WHERE ref_type='order' AND ref_id=? AND kind IN ('order.released','order.refunded')", orderId);
}

function requireVersion(order: Order, version: number) {
  if (order.version !== version) {
    throw new HttpError(409, 'Cette commande a changé : version périmée. Rechargez la commande avant de réessayer.');
  }
}

function validateProject(projectId: string | null | undefined, userId: string) {
  if (!projectId) return;
  const project = one<{ visibility: string }>('SELECT visibility FROM projects WHERE id=?', projectId);
  if (!project || project.visibility !== 'public' || !canManageProject(userId, projectId)) {
    throw new HttpError(403, 'Vous pouvez uniquement associer un projet public que vous gérez.');
  }
}

router.get('/projects', (req, res) => {
  const user = requireUser(req);
  const projects = all<{ id: string; title: string }>(`SELECT p.id,p.title FROM projects p
    WHERE p.visibility='public' AND (p.owner_id=? OR EXISTS (SELECT 1 FROM organization_members om
    WHERE om.organization_id=p.organization_id AND om.user_id=? AND om.role IN ('owner','admin')))
    ORDER BY p.created_at DESC LIMIT 100`, user.id, user.id);
  res.json({ projects });
});

router.get('/listings', (req, res) => {
  const query = z.object({
    q: z.string().trim().max(120).default(''),
    kind: kinds.optional(),
    mine: z.enum(['true', 'false']).default('false'),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    ...pageInput,
  }).parse(req.query);
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (query.mine === 'true') {
    clauses.push('l.seller_id=?');
    values.push(requireUser(req).id);
    if (query.status !== 'all') {
      clauses.push('l.status=?');
      values.push(query.status);
    }
  } else {
    if (query.status !== 'active') throw new HttpError(400, 'Les archives sont réservées au vendeur.');
    clauses.push("l.status='active'");
  }
  if (query.kind) {
    clauses.push('l.kind=?');
    values.push(query.kind);
  }
  if (query.q) {
    const search = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')");
    values.push(search, search);
  }
  const where = clauses.join(' AND ');
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM listings l WHERE ${where}`, ...values)!.total;
  const listings = all<Listing>(`${listingSelect} WHERE ${where} ORDER BY l.created_at DESC,l.id LIMIT ? OFFSET ?`, ...values, query.limit, query.offset);
  res.json({ listings, total, limit: query.limit, offset: query.offset });
});

router.post('/listings', (req, res) => {
  const user = requireUser(req);
  const input = listingInput.parse(req.body);
  const listing = transaction(() => {
    validateProject(input.project_id, user.id);
    const listingId = id();
    run(`INSERT INTO listings (id,seller_id,project_id,title,description,kind,price_cents,license,deliverables)
      VALUES (?,?,?,?,?,?,?,?,?)`, listingId, user.id, input.project_id ?? null, input.title, input.description,
    input.kind, input.price_cents, input.license, input.deliverables);
    audit(user.id, 'marketplace.listing.created', 'listing', listingId, 'Licence non exclusive (V1)');
    return listingById(listingId);
  });
  res.status(201).json({ listing });
});

router.get('/listings/:id', (req, res) => {
  const listing = listingById(pathId(req));
  if (listing.status !== 'active' && listing.seller_id !== req.user?.id &&
    !one('SELECT id FROM orders WHERE listing_id=? AND buyer_id=?', listing.id, req.user?.id ?? '')) {
    throw new HttpError(404, 'Offre introuvable.');
  }
  res.json({ listing });
});

router.patch('/listings/:id', (req, res) => {
  const user = requireUser(req);
  const listingId = pathId(req);
  const input = editInput.parse(req.body);
  const listing = transaction(() => {
    const existing = listingById(listingId);
    if (existing.seller_id !== user.id) throw new HttpError(403, 'Seul le vendeur peut modifier cette offre.');
    // There are no terms snapshot columns: every term stays immutable after the first order.
    if (existing.terms_locked) throw new HttpError(409, 'Les conditions sont figées dès la première commande. Créez une nouvelle offre.');
    validateProject(input.project_id, user.id);
    const entries = Object.entries(input).filter(([, value]) => value !== undefined);
    if (!entries.length) throw new HttpError(400, 'Aucune modification.');
    run(`UPDATE listings SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`,
      ...entries.map(([, value]) => value as SQLInputValue), listingId);
    audit(user.id, 'marketplace.listing.edited', 'listing', listingId);
    return listingById(listingId);
  });
  res.json({ listing });
});

router.post('/listings/:id/archive', (req, res) => {
  const user = requireUser(req);
  const listingId = pathId(req);
  const listing = transaction(() => {
    const existing = listingById(listingId);
    if (existing.seller_id !== user.id) throw new HttpError(403, 'Seul le vendeur peut archiver cette offre.');
    if (existing.status !== 'archived') {
      run("UPDATE listings SET status='archived' WHERE id=?", listingId);
      audit(user.id, 'marketplace.listing.archived', 'listing', listingId);
    }
    return listingById(listingId);
  });
  res.json({ listing });
});

router.post('/listings/:id/buy', (req, res) => {
  const user = requireUser(req);
  const listingId = pathId(req);
  if (paymentMode() !== 'demo') {
    throw new HttpError(409, 'Les achats passent par le paiement sécurisé : utilisez « Acheter » pour choisir un moyen de paiement.');
  }
  const order = transaction(() => {
    const listing = listingById(listingId);
    if (listing.status !== 'active') throw new HttpError(409, 'Cette offre est archivée.');
    if (listing.seller_id === user.id) throw new HttpError(403, 'Vous ne pouvez pas acheter votre propre offre.');
    if (one("SELECT id FROM orders WHERE listing_id=? AND buyer_id=? AND status IN ('paid','delivered','disputed')", listingId, user.id)) {
      throw new HttpError(409, 'Vous avez déjà une commande active pour cette offre. Consultez vos commandes.');
    }
    const orderId = id();
    run("INSERT INTO orders (id,listing_id,buyer_id,seller_id,price_cents,status) VALUES (?,?,?,?,?,'paid')",
      orderId, listingId, user.id, listing.seller_id, listing.price_cents);
    appendOrderEvent(orderId, user.id, 'purchased');
    run("INSERT INTO transactions (id,user_id,order_id,kind,amount_cents,status,mode) VALUES (?,?,?,'purchase',?,'completed','demo')",
      id(), user.id, orderId, listing.price_cents);
    notify(listing.seller_id, 'order', 'Nouvelle commande de démonstration', listing.title, `/marketplace?view=orders&order=${orderId}`);
    audit(user.id, 'demo.marketplace.purchased', 'order', orderId, String(listing.price_cents));
    return participantOrder(orderId, user.id);
  });
  res.status(201).json({ order, mode: 'demo' });
});

router.get('/orders', (req, res) => {
  const user = requireUser(req);
  const query = z.object({ role: z.enum(['buyer', 'seller', 'all']).default('all'), ...pageInput }).parse(req.query);
  const where = query.role === 'buyer' ? 'o.buyer_id=?' : query.role === 'seller' ? 'o.seller_id=?' : '(o.buyer_id=? OR o.seller_id=?)';
  const values = query.role === 'all' ? [user.id, user.id] : [user.id];
  const orders = all<Order>(`${orderSelect} WHERE ${where} ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`, ...values, query.limit, query.offset);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM orders o WHERE ${where}`, ...values)!.total;
  res.json({ orders, total, limit: query.limit, offset: query.offset, payment_summary: paymentSummary(user.id), mode: paymentMode() });
});

router.get('/orders/:id', (req, res) => {
  const user = requireUser(req);
  const order = participantOrder(pathId(req), user.id);
  res.json({ order, mode: order.payment_mode });
});

router.get('/orders/:id/history', (req, res) => {
  const user = requireUser(req);
  const orderId = pathId(req);
  participantOrder(orderId, user.id);
  const query = z.object(pageInput).strict().parse(req.query);
  const events = all(`SELECT id,kind,body,order_version,created_at FROM order_events
    WHERE order_id=? ORDER BY order_version DESC LIMIT ? OFFSET ?`, orderId, query.limit, query.offset);
  const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM order_events WHERE order_id=?', orderId)!.total;
  res.json({ events, total, limit: query.limit, offset: query.offset });
});

router.post('/orders/:id/deliver', (req, res) => {
  const user = requireUser(req);
  const orderId = pathId(req);
  const input = z.object({ version: versionInput, delivery_text: z.string().trim().min(10).max(20000) }).strict().parse(req.body);
  const order = transaction(() => {
    const existing = participantOrder(orderId, user.id);
    if (existing.seller_id !== user.id) throw new HttpError(403, 'Seul le vendeur peut livrer cette commande.');
    requireVersion(existing, input.version);
    if (existing.status !== 'paid') throw new HttpError(409, 'Cette commande ne peut plus être livrée.');
    if (existing.revision_requested && input.delivery_text.replace(/\s+/g, ' ') === existing.delivery_text.trim().replace(/\s+/g, ' ')) {
      throw new HttpError(409, 'La nouvelle livraison doit intégrer des corrections : son contenu doit changer.');
    }
    run("UPDATE orders SET status='delivered',delivery_text=?,revision_requested=0,version=version+1 WHERE id=?", input.delivery_text, orderId);
    appendOrderEvent(orderId, user.id, 'delivered', input.delivery_text);
    notify(existing.buyer_id, 'order', existing.payment_mode === 'demo' ? 'Votre commande démo est livrée' : 'Votre commande est livrée', existing.listing_title, `/marketplace?view=orders&order=${orderId}`);
    audit(user.id, 'marketplace.order.delivered', 'order', orderId);
    return participantOrder(orderId, user.id);
  });
  res.json({ order, mode: order.payment_mode });
});

router.post('/orders/:id/request-revision', (req, res) => {
  const user = requireUser(req);
  const orderId = pathId(req);
  const input = z.object({ version: versionInput, note: revisionNote }).strict().parse(req.body);
  const order = transaction(() => {
    const existing = participantOrder(orderId, user.id);
    if (existing.buyer_id !== user.id) throw new HttpError(403, 'Seul l’acheteur peut demander une correction.');
    requireVersion(existing, input.version);
    if (existing.status !== 'delivered') throw new HttpError(409, 'Une correction concerne uniquement une livraison en attente d’acceptation.');
    run("UPDATE orders SET status='paid',revision_requested=1,version=version+1 WHERE id=?", orderId);
    appendOrderEvent(orderId, user.id, 'revision_requested', input.note);
    notify(existing.seller_id, 'order', 'Corrections demandées sur votre livraison', 'Consultez la consigne privée dans la commande.', `/marketplace?view=orders&order=${orderId}`);
    audit(user.id, 'marketplace.order.revision_requested', 'order', orderId);
    return participantOrder(orderId, user.id);
  });
  res.json({ order, mode: order.payment_mode });
});

router.post('/orders/:id/complete', (req, res) => {
  const user = requireUser(req);
  const orderId = pathId(req);
  const input = z.object({ version: versionInput }).strict().parse(req.body);
  const order = transaction(() => {
    const existing = participantOrder(orderId, user.id);
    if (existing.buyer_id !== user.id) throw new HttpError(403, 'Seul l’acheteur peut accepter la livraison.');
    if (existing.status === 'completed') return existing;
    requireVersion(existing, input.version);
    if (existing.status !== 'delivered') throw new HttpError(409, 'La commande doit être livrée avant son acceptation.');
    run("UPDATE orders SET status='completed',version=version+1 WHERE id=?", orderId);
    appendOrderEvent(orderId, user.id, 'completed');
    if (existing.payment_mode !== 'demo') {
      releaseOrderEscrow(orderId, user.id);
      audit(user.id, 'marketplace.order.completed', 'order', orderId, String(existing.price_cents));
      return participantOrder(orderId, user.id);
    }
    run("INSERT INTO transactions (id,user_id,order_id,kind,amount_cents,status,mode) VALUES (?,?,?,'sale',?,'completed','demo')",
      id(), existing.seller_id, orderId, existing.price_cents);
    notify(existing.seller_id, 'payment', 'Livraison acceptée — gain démo enregistré', 'Aucun argent réel n’est versé.', `/marketplace?view=orders&order=${orderId}`);
    audit(user.id, 'demo.marketplace.completed', 'order', orderId, String(existing.price_cents));
    return participantOrder(orderId, user.id);
  });
  res.json({ order, mode: order.payment_mode });
});

router.post('/orders/:id/dispute', (req, res) => {
  const user = requireUser(req);
  const orderId = pathId(req);
  const input = z.object({ reason: z.string().trim().min(10).max(5000) }).strict().parse(req.body);
  const order = transaction(() => {
    const existing = participantOrder(orderId, user.id);
    if (existing.status !== 'paid' && existing.status !== 'delivered') {
      throw new HttpError(409, 'Seules les commandes en attente de livraison ou d’acceptation peuvent être mises en litige. Pour une commande terminée, contactez la modération.');
    }
    if (one("SELECT id FROM transactions WHERE order_id=? AND kind IN ('sale','refund') AND status IN ('completed','pending')", orderId) || hasRealSettlement(orderId)) {
      throw new HttpError(409, 'Cette commande possède une opération financière finalisée ou en cours. Contactez la modération.');
    }
    run("UPDATE orders SET status='disputed',version=version+1 WHERE id=?", orderId);
    appendOrderEvent(orderId, user.id, 'disputed');
    run("INSERT INTO moderation_reports (id,reporter_id,target_type,target_id,reason) VALUES (?,?,'order',?,?)",
      id(), user.id, orderId, input.reason);
    notify(existing.buyer_id === user.id ? existing.seller_id : existing.buyer_id,
      'dispute', existing.payment_mode === 'demo' ? 'Litige ouvert sur une commande démo' : 'Litige ouvert sur une commande',
      existing.payment_mode === 'demo' ? 'La modération examinera le signalement. Aucun remboursement automatique.' : 'Les fonds restent en séquestre pendant l’examen par la modération.',
      `/marketplace?view=orders&order=${orderId}`);
    audit(user.id, 'marketplace.order.disputed', 'order', orderId);
    return participantOrder(orderId, user.id);
  });
  res.json({ order, mode: order.payment_mode });
});

export default router;
