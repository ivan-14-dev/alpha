import { hmacHex, safeEqual } from '../../platform/secrets.js';
import type { PaymentProvider, ProviderConfig, ProviderStatus } from './types.js';

/**
 * Alpha Simulator: a local, credential-free provider that exercises the full sandbox flow
 * (hosted checkout page, signed webhook, status confirmation, payouts, refunds). Never moves money.
 * It is refused in live mode by the payments module.
 */
const outcomes = new Map<string, { status: ProviderStatus; amountMinor: number; currency: string }>();

export function simulatorSecret(config: ProviderConfig): string {
  return config.secrets.webhook_secret || 'alpha-simulator-local-secret';
}

/** Used by the simulator checkout endpoint (and tests) to settle a simulated payment. */
export function settleSimulatedPayment(providerReference: string, status: Exclude<ProviderStatus, 'pending'>) {
  const current = outcomes.get(providerReference);
  if (!current) return false;
  if (current.status !== 'pending') return current.status === status;
  outcomes.set(providerReference, { ...current, status });
  return true;
}

export function signSimulatorPayload(config: ProviderConfig, body: string) {
  return hmacHex(simulatorSecret(config), body);
}

export const simulator: PaymentProvider = {
  id: 'simulator',
  label: 'Alpha Simulator (bac à sable)',
  countries: ['*'],
  currencies: ['EUR', 'XAF', 'XOF', 'USD'],
  methods: ['card', 'mobile_money'],
  capabilities: { collect: true, payout: true, refund: true, webhooks: 'signed' },
  fields: [
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: ['EUR', 'XAF', 'XOF', 'USD'] },
    { key: 'webhook_secret', label: 'Secret de signature des webhooks simulés', secret: true, required: false, help: 'Optionnel en local.' },
  ],
  docsUrl: '/legal/payments',
  validateConfig(config) {
    return config.environment === 'live' ? ['Le simulateur est interdit en production réelle.'] : [];
  },
  async collect(_config, request) {
    const providerReference = `sim_${request.reference}`;
    if (!outcomes.has(providerReference)) outcomes.set(providerReference, { status: 'pending', amountMinor: request.amountMinor, currency: request.currency });
    if (request.method === 'mobile_money' && request.customer.phone) {
      return { kind: 'pending_approval', providerReference, instructions: 'Validez la demande simulée depuis la page de paiement Alpha.' };
    }
    return { kind: 'redirect', providerReference, url: `/checkout/simulator?reference=${encodeURIComponent(request.reference)}` };
  },
  async status(_config, _kind, providerReference) {
    const outcome = outcomes.get(providerReference);
    if (!outcome) return { status: 'pending', providerReference };
    return { status: outcome.status, providerReference, amountMinor: outcome.amountMinor, currency: outcome.currency };
  },
  async payout(_config, request) {
    const providerReference = `simpo_${request.reference}`;
    outcomes.set(providerReference, { status: 'succeeded', amountMinor: request.amountMinor, currency: request.currency });
    return { status: 'succeeded', providerReference };
  },
  async refund(_config, request) {
    const providerReference = `simre_${request.reference}`;
    outcomes.set(providerReference, { status: 'succeeded', amountMinor: request.amountMinor, currency: request.currency });
    return { status: 'succeeded', providerReference };
  },
  async verifyWebhook(config, input) {
    const signature = input.headers['x-alpha-simulator-signature'];
    if (typeof signature !== 'string' || !safeEqual(signature, signSimulatorPayload(config, input.rawBody.toString('utf8')))) return null;
    const payload = JSON.parse(input.rawBody.toString('utf8')) as { reference?: string; provider_reference: string; status: ProviderStatus; type?: 'collection' | 'payout' | 'refund'; event_id?: string };
    return [{ type: payload.type ?? 'collection', reference: payload.reference, providerReference: payload.provider_reference, status: payload.status, eventId: payload.event_id }];
  },
};
