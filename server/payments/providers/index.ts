import { campay } from './campay.js';
import { flutterwave } from './flutterwave.js';
import { kratosPay } from './kratos-pay.js';
import { mtnMomo } from './mtn-momo.js';
import { orangeMoney } from './orange-money.js';
import { simulator } from './simulator.js';
import { stripe } from './stripe.js';
import type { PaymentProvider, ProviderId } from './types.js';
import { wave } from './wave.js';

/**
 * Provider registry. OWNER: payments-providers module. The payments module only uses `getProvider` /
 * `listProviders`. Adapters are pure HTTP clients (see types.ts); the simulator stays first for demo mode.
 */
const providers = new Map<ProviderId, PaymentProvider>(
  [simulator, stripe, flutterwave, campay, mtnMomo, orangeMoney, wave, kratosPay].map((provider) => [provider.id, provider]),
);

export function registerProvider(provider: PaymentProvider) { providers.set(provider.id, provider); }
export function getProvider(id: string): PaymentProvider | undefined { return providers.get(id as ProviderId); }
export function listProviders(): PaymentProvider[] { return [...providers.values()]; }
