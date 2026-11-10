import { one, transaction } from '../db.js';
import type { SignalKind } from '../platform/guards.js';
import { onDomainEvent, type DomainEvent } from '../platform/events.js';
import { log } from '../platform/log.js';
import { requestOf } from './context.js';
import { inlineMissionDetection, inlineOrderDetection } from './detectors.js';
import { storeSignal } from './signals.js';

interface Mapping { kind: SignalKind; meta: Record<string, unknown>; subject?: 'actor' | 'tester'; check?: 'order' | 'mission' }

/**
 * Maps audited domain actions (demo V3 names and the V4 payments/compliance names) to risk signals.
 * Runs synchronously inside the business transaction: DB writes to risk_signals/risk_cases only.
 */
export function mapDomainAction(event: DomainEvent): Mapping | null {
  const { action, target_type: type, target_id: target } = event;
  if (action === 'review.created') return { kind: 'review', meta: { review_id: target } };
  if (action === 'marketplace.listing.created') return { kind: 'listing', meta: { listing_id: target } };
  if (/^(demo\.)?marketplace\.purchased$|^(marketplace\.|payments\.)?order\.(paid|purchased)$/.test(action)) {
    return { kind: 'payment', meta: { purpose: 'order', order_id: type === 'order' ? target : null, status: 'succeeded' }, check: type === 'order' ? 'order' : undefined };
  }
  if (/^(demo\.|payments\.)?campaign\.funded$/.test(action)) return { kind: 'payment', meta: { purpose: 'campaign', campaign_id: target, status: 'succeeded' } };
  if (/^payments?\.(intent\.)?failed$/.test(action)) return { kind: 'payment', meta: { status: 'failed', ref: type } };
  if (/^(demo\.|payments\.)?mission\.paid$/.test(action) && type === 'mission') return { kind: 'payout', meta: { mission_id: target }, subject: 'tester', check: 'mission' };
  if (/^(compliance\.)?withdrawal\.(requested|created)$/.test(action)) return { kind: 'withdrawal', meta: { withdrawal_id: target } };
  if (['application.created', 'mission.started', 'mission.submitted', 'report.submitted', 'report.revised'].includes(action)) {
    return { kind: 'mission', meta: { action, target_type: type, target_id: target } };
  }
  if (/^(demo\.)?marketplace\.(order\.|completed$)|^payments\.order\.released$/.test(action)) return { kind: 'order', meta: { action, order_id: target } };
  return null;
}

export function handleDomainEvent(event: DomainEvent) {
  if (event.action.startsWith('trust.')) return;
  const mapping = mapDomainAction(event);
  if (!mapping) return;
  try {
    transaction(() => {
      if (mapping.subject === 'tester') {
        // The payout beneficiary is not the acting user: no request fingerprint is attached.
        const tester = one<{ tester_id: string }>('SELECT tester_id FROM missions WHERE id=?', event.target_id)?.tester_id ?? null;
        storeSignal(null, tester, mapping.kind, mapping.meta);
      } else {
        storeSignal(requestOf(event.actor_id), event.actor_id, mapping.kind, mapping.meta);
      }
      if (mapping.check === 'order') inlineOrderDetection(event.target_id);
      if (mapping.check === 'mission') inlineMissionDetection(event.target_id);
    });
  } catch (error) {
    log.warn('trust.domain_hook_failed', { action: event.action, error });
  }
}

onDomainEvent('trust.signals', handleDomainEvent);
