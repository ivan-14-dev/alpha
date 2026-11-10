import { simulator } from './simulator.js';
import type { PaymentProvider, ProviderId } from './types.js';

/**
 * Provider registry. OWNER: payments-providers module (adds stripe, flutterwave, campay, mtn_momo,
 * orange_money, wave, kratos_pay). The payments module only uses `getProvider` / `listProviders`.
 */
const providers = new Map<ProviderId, PaymentProvider>([[simulator.id, simulator]]);

export function registerProvider(provider: PaymentProvider) { providers.set(provider.id, provider); }
export function getProvider(id: string): PaymentProvider | undefined { return providers.get(id as ProviderId); }
export function listProviders(): PaymentProvider[] { return [...providers.values()]; }
