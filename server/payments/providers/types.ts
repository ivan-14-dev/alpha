/**
 * Payment provider adapter contract.
 * Adapters are pure HTTP clients: they never touch the database. The payments module stores configs
 * (secrets sealed), creates intents, processes webhooks and posts ledger journals.
 *
 * SECURITY RULES
 *  - `verifyWebhook` must authenticate the request (signature/HMAC/shared secret) and return null when invalid.
 *  - Webhooks are hints: the payments module ALWAYS re-confirms with `status()` before crediting money
 *    (mandatory for providers without signed webhooks, e.g. MTN MoMo, Orange Money).
 *  - Amounts are integers in the provider currency's minor units (XAF/XOF have 0 decimals).
 *  - Never log secrets or full phone numbers.
 */
export type ProviderId = 'simulator' | 'stripe' | 'flutterwave' | 'campay' | 'mtn_momo' | 'orange_money' | 'wave' | 'kratos_pay';
export type ProviderEnvironment = 'sandbox' | 'live';
export type PaymentMethod = 'card' | 'mobile_money' | 'bank_transfer';

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help?: string;
  /** Allowed values for select inputs. */
  options?: string[];
  placeholder?: string;
}

export interface ProviderConfig {
  id: ProviderId;
  environment: ProviderEnvironment;
  /** Non-secret settings (country, currency, merchant id, base URL override...). */
  settings: Record<string, string>;
  /** Decrypted secrets. Never returned to the client. */
  secrets: Record<string, string>;
}

export interface ProviderContext {
  fetch: typeof fetch;
  now: () => Date;
  /** Absolute URL where the provider must POST/GET webhooks for this provider. */
  webhookUrl: string;
}

export interface Customer { name: string; email: string; phone?: string; country?: string }

export interface CollectRequest {
  /** Our payment intent id. Used as idempotency key / merchant reference. Max 64 chars [A-Za-z0-9_-]. */
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  customer: Customer;
  returnUrl: string;
  cancelUrl: string;
  method?: PaymentMethod;
  /** Mobile operator code for aggregators: 'mtn' | 'orange' | 'moov' | 'wave' | 'airtel' ... */
  operator?: string;
}

export type CollectResult =
  | { kind: 'redirect'; url: string; providerReference: string; raw?: unknown }
  | { kind: 'pending_approval'; providerReference: string; instructions: string; raw?: unknown };

export type ProviderStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface StatusResult {
  status: ProviderStatus;
  providerReference: string;
  amountMinor?: number;
  currency?: string;
  failureReason?: string;
  raw?: unknown;
}

export interface PayoutRecipient {
  name: string;
  email?: string;
  phone?: string;
  country?: string;
  operator?: string;
  /** Stripe connected account id (acct_...). */
  accountId?: string;
  bankCode?: string;
  accountNumber?: string;
}

export interface PayoutRequest {
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  recipient: PayoutRecipient;
}

export interface RefundRequest {
  reference: string;
  /** Provider reference of the original collection. */
  providerReference: string;
  amountMinor: number;
  currency: string;
  reason: string;
}

export interface OperationResult {
  status: ProviderStatus;
  providerReference: string;
  failureReason?: string;
  raw?: unknown;
}

export interface WebhookInput {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  query: Record<string, unknown>;
}

export interface WebhookEvent {
  type: 'collection' | 'payout' | 'refund' | 'account';
  /** Our reference when the provider echoes it. */
  reference?: string;
  providerReference?: string;
  status: ProviderStatus;
  amountMinor?: number;
  currency?: string;
  /** Provider event id, used for de-duplication. */
  eventId?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  id: ProviderId;
  label: string;
  /** ISO 3166-1 alpha-2 country codes where the provider operates. */
  countries: string[];
  currencies: string[];
  methods: PaymentMethod[];
  capabilities: { collect: boolean; payout: boolean; refund: boolean; webhooks: 'signed' | 'unsigned' | 'none' };
  /** Configuration form rendered in the admin console. */
  fields: ProviderField[];
  docsUrl: string;
  /** Returns a list of human readable problems (empty = valid). Must not call the network. */
  validateConfig(config: ProviderConfig): string[];
  collect(config: ProviderConfig, request: CollectRequest, context: ProviderContext): Promise<CollectResult>;
  status(config: ProviderConfig, kind: 'collection' | 'payout' | 'refund', providerReference: string, context: ProviderContext, reference?: string): Promise<StatusResult>;
  payout?(config: ProviderConfig, request: PayoutRequest, context: ProviderContext): Promise<OperationResult>;
  refund?(config: ProviderConfig, request: RefundRequest, context: ProviderContext): Promise<OperationResult>;
  /** null = authentication failed (respond 401). [] = authenticated but nothing to process. */
  verifyWebhook(config: ProviderConfig, input: WebhookInput, context: ProviderContext): Promise<WebhookEvent[] | null>;
}

export class ProviderError extends Error {
  constructor(public provider: ProviderId, message: string, public retryable = false, public httpStatus?: number) {
    super(message);
  }
}
