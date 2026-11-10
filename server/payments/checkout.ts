import { HttpError, type User } from '../core.js';
import { enabledProviders, readProviderConfig } from './config.js';
import { baseCurrency, fxRates, paymentMode } from './mode.js';
import { settleSimulatedPayment, signSimulatorPayload } from './providers/simulator.js';
import { publicIntent } from './core/store.js';
import { readableIntent } from './intents.js';
import { receiveWebhook } from './webhooks.js';

const methodLabels: Record<string, string> = { card: 'Carte bancaire', mobile_money: 'Mobile money', bank_transfer: 'Virement bancaire' };

/** Providers the checkout dialog can offer right now (current mode, valid config, collect capability). */
export function availableProviders(currency?: string) {
  const mode = paymentMode();
  const base = baseCurrency();
  const rates = fxRates();
  const usable = (code: string) => code === base || Object.hasOwn(rates, code);
  return {
    mode,
    base_currency: base,
    providers: mode === 'demo' ? [] : enabledProviders(currency ? { currency } : {})
      .filter((provider) => provider.capabilities.collect)
      .map((provider) => {
        const config = readProviderConfig(provider.id, mode)!;
        const currencies = provider.currencies.filter(usable);
        const preferred = config.settings.currency && currencies.includes(config.settings.currency) ? config.settings.currency : currencies.includes(base) ? base : currencies[0];
        return {
          id: provider.id,
          label: provider.label,
          methods: provider.methods.map((method) => ({ id: method, label: methodLabels[method] ?? method })),
          currencies,
          default_currency: preferred ?? null,
          countries: provider.countries,
          operators: provider.fields.find((field) => field.key === 'operator')?.options ?? [],
        };
      })
      .filter((provider) => provider.currencies.length > 0),
  };
}

/**
 * Simulator hosted checkout: the payer clicks "Payer" or "Échouer". The outcome is recorded in the simulator,
 * then delivered as a signed webhook through the regular pipeline (so the sandbox exercises the real code path).
 */
export async function completeSimulated(user: User, intentId: string, outcome: 'succeeded' | 'failed') {
  if (paymentMode() !== 'sandbox') throw new HttpError(409, 'Le simulateur n’est disponible qu’en mode bac à sable.');
  const intent = readableIntent(intentId, user);
  if (intent.user_id !== user.id) throw new HttpError(403, 'Seul le payeur peut valider ce paiement simulé.');
  if (intent.provider !== 'simulator' || intent.mode !== 'sandbox' || !intent.provider_reference) throw new HttpError(409, 'Ce paiement ne passe pas par le simulateur.');
  if (intent.status !== 'created' && intent.status !== 'pending') return { intent: publicIntent(intent) };
  if (!settleSimulatedPayment(intent.provider_reference, outcome)) {
    throw new HttpError(409, 'Ce paiement simulé a déjà été finalisé avec un autre résultat ou a expiré (redémarrage du serveur).');
  }
  const config = readProviderConfig('simulator', 'sandbox');
  if (!config) throw new HttpError(409, 'Le simulateur est désactivé.');
  const body = JSON.stringify({ reference: intent.id, provider_reference: intent.provider_reference, status: outcome, type: 'collection', event_id: `simevt_${intent.id}_${outcome}` });
  const response = await receiveWebhook('simulator', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alpha-simulator-signature': signSimulatorPayload(config, body) },
    rawBody: Buffer.from(body),
    query: {},
  });
  if (response.status !== 200) throw new HttpError(502, 'Le webhook simulé a été refusé.');
  return { intent: publicIntent(readableIntent(intent.id, user)) };
}
