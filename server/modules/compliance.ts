import { Router, type Request } from 'express';
import { z } from 'zod';
import { audit, HttpError, param, requireAdmin, requireUser } from '../core.js';
import { one } from '../db.js';
import { baseCurrency, exponent, paymentMode } from '../payments/mode.js';
import { registerPayoutWebhookHandler } from '../payments/webhooks.js';
import { registerJob } from '../platform/jobs.js';
import { requireCapability } from '../platform/guards.js';
import { log } from '../platform/log.js';
import { clientIp, rateLimit } from '../platform/rateLimit.js';
import { adminKycDetail, adminKycQueue, kycDraftSchema, kycView, reviewKyc, saveKycDraft, submitKyc } from '../compliance/kyc.js';
import { createPayoutMethod, createPayoutMethodSchema, deletePayoutMethod, listPayoutMethods, updatePayoutMethod, updatePayoutMethodSchema } from '../compliance/payoutMethods.js';
import {
  adminApproveWithdrawal, adminRejectWithdrawal, adminRetryWithdrawal, adminWithdrawals, cancelWithdrawal, createWithdrawal,
  createWithdrawalSchema, handlePayoutWebhook, listWithdrawals, processPayouts, withdrawalCounts,
} from '../compliance/withdrawals.js';
import { adminInvoices, invoiceFor, invoicesBlocked, issueInvoices, journalsCsv, listInvoices, renderInvoiceHtml } from '../compliance/invoices.js';
import { describeSettings, issuerProblems, saveSetting, settingDefinitions, type SettingName } from '../compliance/settings.js';
import { walletView } from '../compliance/wallet.js';
import '../compliance/privacy.js';

/** V4 compliance module (/api/compliance): wallet, KYC, payout methods, withdrawals, invoices and tax. */
const router = Router();

registerJob({
  name: 'compliance.payouts',
  intervalMs: 60_000,
  description: 'Versements des retraits approuvés auprès des prestataires (nouvelles tentatives, vérification des versements en attente).',
  run: async () => {
    const result = await processPayouts();
    if (result.attempted || result.checked) log.info('compliance.payouts', result);
  },
});

registerPayoutWebhookHandler(handlePayoutWebhook);

registerJob({
  name: 'compliance.invoices',
  intervalMs: 5 * 60_000,
  description: 'Émission des reçus, factures de commission et relevés de versement à partir du grand livre.',
  run: () => {
    const result = issueInvoices();
    if (result.issued || result.blocked) log.info('compliance.invoices', result);
  },
});

const userKey = (req: Request) => req.user?.id ?? clientIp(req);
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const emptyBody = z.object({}).strict();

// ---------------------------------------------------------------- member

router.get('/wallet', (req, res) => {
  const user = requireUser(req);
  res.json(walletView(user.id));
});

router.get('/kyc', (req, res) => {
  const user = requireUser(req);
  res.json(kycView(user.id));
});

router.put('/kyc', (req, res) => {
  const user = requireCapability(req, 'money');
  res.json(saveKycDraft(user.id, kycDraftSchema.parse(req.body)));
});

router.post('/kyc/submit', rateLimit({ name: 'compliance.kyc_submit', limit: 10, windowMs: 3600_000, key: userKey }), (req, res) => {
  const user = requireCapability(req, 'money');
  emptyBody.parse(req.body ?? {});
  res.json(submitKyc(user.id));
});

router.get('/payout-methods', (req, res) => {
  const user = requireUser(req);
  res.json({ payout_methods: listPayoutMethods(user.id) });
});

router.post('/payout-methods', rateLimit({ name: 'compliance.payout_method', limit: 10, windowMs: 3600_000, key: userKey }), (req, res) => {
  const user = requireCapability(req, 'withdraw');
  res.status(201).json(createPayoutMethod(user.id, createPayoutMethodSchema.parse(req.body)));
});

router.patch('/payout-methods/:id', (req, res) => {
  const user = requireCapability(req, 'withdraw');
  res.json(updatePayoutMethod(user.id, param(req), updatePayoutMethodSchema.parse(req.body)));
});

router.post('/payout-methods/:id/default', (req, res) => {
  const user = requireCapability(req, 'withdraw');
  res.json(updatePayoutMethod(user.id, param(req), { is_default: true }));
});

router.delete('/payout-methods/:id', (req, res) => {
  const user = requireCapability(req, 'withdraw');
  deletePayoutMethod(user.id, param(req));
  res.status(204).end();
});

router.get('/withdrawals', (req, res) => {
  const user = requireUser(req);
  const query = page.strict().parse(req.query);
  res.json(listWithdrawals(user.id, query.limit, query.offset));
});

router.post('/withdrawals', rateLimit({ name: 'compliance.withdrawal', limit: 20, windowMs: 3600_000, key: userKey }), (req, res) => {
  const user = requireCapability(req, 'withdraw');
  const result = createWithdrawal(req, user.id, createWithdrawalSchema.parse(req.body));
  res.status(result.created ? 201 : 200).json(result.withdrawal);
});

router.post('/withdrawals/:id/cancel', (req, res) => {
  const user = requireUser(req);
  res.json(cancelWithdrawal(user.id, param(req)));
});

router.get('/invoices', (req, res) => {
  const user = requireUser(req);
  const query = page.strict().parse(req.query);
  res.json(listInvoices(user.id, query.limit, query.offset));
});

/** Printable document. Self-contained HTML, no script: a dedicated CSP replaces the application one. */
router.get('/invoices/:id/html', (req, res) => {
  const user = requireUser(req);
  const invoice = invoiceFor(param(req), user);
  if (user.id !== invoice.user_id) audit(user.id, 'compliance.invoice_viewed', 'invoice', invoice.id, invoice.number);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.number}.html"`);
  res.type('text/html; charset=utf-8').send(renderInvoiceHtml(invoice));
});

// ---------------------------------------------------------------- admin

router.get('/admin/summary', (req, res) => {
  requireAdmin(req);
  const base = baseCurrency();
  res.json({
    mode: paymentMode(),
    base_currency: base,
    base_exponent: exponent(base),
    kyc_pending: one<{ count: number }>("SELECT COUNT(*) AS count FROM kyc_profiles WHERE status='submitted'")!.count,
    withdrawals: withdrawalCounts(),
    invoices_blocked: invoicesBlocked(),
    issuer_problems: issuerProblems(),
    invoices_total: one<{ count: number }>('SELECT COUNT(*) AS count FROM invoices')!.count,
  });
});

const kycStatusSchema = z.enum(['draft', 'submitted', 'approved', 'rejected']);

router.get('/admin/kyc', (req, res) => {
  requireAdmin(req);
  const query = page.extend({ status: kycStatusSchema.default('submitted') }).strict().parse(req.query);
  res.json(adminKycQueue(query.status, query.limit, query.offset));
});

router.get('/admin/kyc/:userId', (req, res) => {
  const admin = requireAdmin(req);
  const userId = param(req, 'userId');
  const detail = adminKycDetail(userId);
  // Every consultation of an identity dossier is traced.
  audit(admin.id, 'compliance.kyc_viewed', 'user', userId, '');
  res.json(detail);
});

router.post('/admin/kyc/:userId/approve', (req, res) => {
  const admin = requireAdmin(req);
  const body = z.object({ level: z.enum(['basic', 'enhanced']).default('basic'), note: z.string().trim().max(500).default('') }).strict().parse(req.body ?? {});
  res.json(reviewKyc(admin.id, param(req, 'userId'), { approve: true, level: body.level, note: body.note }));
});

router.post('/admin/kyc/:userId/reject', (req, res) => {
  const admin = requireAdmin(req);
  const body = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
  res.json(reviewKyc(admin.id, param(req, 'userId'), { approve: false, reason: body.reason }));
});

const withdrawalFilter = z.enum(['open', 'all', 'requested', 'on_hold', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled']);

router.get('/admin/withdrawals', (req, res) => {
  requireAdmin(req);
  const query = page.extend({ status: withdrawalFilter.default('open') }).strict().parse(req.query);
  res.json(adminWithdrawals(query.status, query.limit, query.offset));
});

router.post('/admin/withdrawals/:id/approve', (req, res) => {
  const admin = requireAdmin(req);
  const body = z.object({ note: z.string().trim().max(500).default('') }).strict().parse(req.body ?? {});
  res.json(adminApproveWithdrawal(admin.id, param(req), body.note));
});

router.post('/admin/withdrawals/:id/reject', (req, res) => {
  const admin = requireAdmin(req);
  const body = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
  res.json(adminRejectWithdrawal(admin.id, param(req), body.reason));
});

router.post('/admin/withdrawals/:id/retry', (req, res) => {
  const admin = requireAdmin(req);
  emptyBody.parse(req.body ?? {});
  res.json(adminRetryWithdrawal(admin.id, param(req)));
});

router.get('/admin/settings', (req, res) => {
  requireAdmin(req);
  res.json(describeSettings());
});

router.put('/admin/settings/:name', (req, res) => {
  const admin = requireAdmin(req);
  const name = param(req, 'name');
  if (!Object.hasOwn(settingDefinitions, name)) throw new HttpError(404, 'Réglage inconnu.');
  const value = saveSetting(name as SettingName, req.body, admin.id);
  audit(admin.id, 'compliance.settings_updated', 'setting', settingDefinitions[name as SettingName].key, JSON.stringify(value).slice(0, 2000));
  res.json(describeSettings());
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ attendue.').refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Date invalide.');
const dayStart = (value: string) => `${value}T00:00:00.000Z`;
const nextDayStart = (value: string) => new Date(Date.parse(`${value}T00:00:00Z`) + 86400_000).toISOString();

router.get('/admin/invoices', (req, res) => {
  requireAdmin(req);
  const query = page.extend({ from: day.optional(), to: day.optional(), kind: z.enum(['receipt', 'commission', 'payout_statement']).optional() }).strict().parse(req.query);
  res.json(adminInvoices({ from: query.from && dayStart(query.from), to: query.to && nextDayStart(query.to), kind: query.kind }, query.limit, query.offset));
});

/** Accounting export: every ledger entry of the period (inclusive days, UTC), safe to open in a spreadsheet. */
router.get('/admin/exports/journals.csv', (req, res) => {
  const admin = requireAdmin(req);
  const query = z.object({ from: day, to: day, mode: z.enum(['sandbox', 'live']).optional(), sep: z.enum(['comma', 'semicolon']).default('semicolon') })
    .strict().parse(req.query);
  const from = dayStart(query.from);
  const to = nextDayStart(query.to);
  const days = (Date.parse(to) - Date.parse(from)) / 86400_000;
  if (days <= 0) throw new HttpError(400, 'La date de fin doit suivre la date de début.');
  if (days > 366) throw new HttpError(400, 'La période exportée ne peut pas dépasser 366 jours.');
  const { csv, count } = journalsCsv(from, to, query.mode, query.sep === 'comma' ? ',' : ';');
  audit(admin.id, 'compliance.journals_exported', 'ledger', `${query.from}..${query.to}`, `${count} lignes${query.mode ? `, mode ${query.mode}` : ''}`);
  res.setHeader('Content-Disposition', `attachment; filename="alpha-journaux-${query.from}-${query.to}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('text/csv; charset=utf-8').send(csv);
});

export default router;
