import { z } from 'zod';
import { getSetting } from '../../platform/settings.js';

/** Platform commission in basis points (1 % = 100 bps), applied to tester payouts and marketplace releases. */
export const FEES_SETTING = 'payments.fees';
export const feesSchema = z.object({
  testing_fee_bps: z.number().int().min(0).max(5000),
  marketplace_fee_bps: z.number().int().min(0).max(5000),
}).strict();
export type FeeSettings = z.infer<typeof feesSchema>;
export const defaultFees: FeeSettings = { testing_fee_bps: 1000, marketplace_fee_bps: 1000 };

export function feeSettings(): FeeSettings {
  return getSetting(FEES_SETTING, feesSchema, defaultFees);
}

/** Rounded down: the platform never takes more than the configured rate. */
export function computeFee(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps) / 10_000);
}
