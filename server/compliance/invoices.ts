import { all, one, run, transaction } from '../db.js';
import { HttpError, id, now } from '../core.js';
import { ledgerAccounts } from '../payments/ledger.js';
import { log } from '../platform/log.js';
import { kycCountry, kycIdentity } from './kyc.js';
import { issuerProblems, issuerSettings, taxSettings, type IssuerSettings } from './settings.js';
import { csvCell, escapeHtml, formatMoney, tableExists } from './util.js';

export type InvoiceKind = 'receipt' | 'commission' | 'payout_statement';
type Series = 'live' | 'sandbox';
export const INVOICE_CURSOR = 'invoices';

export interface InvoiceRow {
  id: string;
  number: string;
  series: Series;
  year: number;
  sequence: number;
  user_id: string;
  kind: InvoiceKind;
  journal_id: string;
  ref_type: string;
  ref_id: string;
  currency: string;
  amount_net_minor: number;
  amount_tax_minor: number;
  amount_gross_minor: number;
  tax_rate_bps: number;
  description: string;
  lines: string;
  issuer_snapshot: string;
  customer_snapshot: string;
  issued_at: string;
  created_at: string;
}

interface JournalRow { seq: number; id: string; kind: string; mode: Series; currency: string; ref_type: string; ref_id: string; memo: string; created_at: string }
interface Line { label: string; amount_minor?: number; currency?: string }
interface Draft {
  userId: string;
  kind: InvoiceKind;
  description: string;
  lines: Line[];
  net: number;
  tax: number;
  rateBps: number;
}

export const kindLabels: Record<InvoiceKind, string> = {
  receipt: 'Reçu de paiement',
  commission: 'Facture de commission',
  payout_statement: 'Relevé de versement',
};

function entries(journalId: string) {
  return all<{ account: string; amount_minor: number }>('SELECT account,amount_minor FROM ledger_entries WHERE journal_id=?', journalId);
}

const userExists = (userId: string) => !!one('SELECT 1 FROM users WHERE id=?', userId);

/** VAT split of an amount; `inclusive` = the amount already contains the tax. Rounded half-up on the tax. */
export function splitTax(amount: number, rateBps: number, inclusive: boolean) {
  if (rateBps <= 0) return { net: amount, tax: 0 };
  if (inclusive) {
    const net = Math.round((amount * 10000) / (10000 + rateBps));
    return { net, tax: amount - net };
  }
  return { net: amount, tax: Math.round((amount * rateBps) / 10000) };
}

function receipt(journal: JournalRow): Draft | null {
  if (journal.ref_type !== 'payment_intent' || !tableExists('payment_intents')) return null;
  const intent = one<{ user_id: string; amount_minor: number; currency: string }>('SELECT user_id,amount_minor,currency FROM payment_intents WHERE id=?', journal.ref_id);
  if (!intent || !userExists(intent.user_id)) return null;
  const escrowPrefix = journal.kind === 'campaign.funded' ? 'escrow:campaign:' : 'escrow:order:';
  const amount = entries(journal.id).filter((entry) => entry.account.startsWith(escrowPrefix) && entry.amount_minor > 0).reduce((sum, entry) => sum + entry.amount_minor, 0);
  if (amount <= 0) return null;
  const label = journal.kind === 'campaign.funded' ? 'Financement d’une campagne de test (fonds placés sous séquestre)' : 'Achat sur la marketplace (fonds placés sous séquestre jusqu’à la livraison)';
  const lines: Line[] = [{ label, amount_minor: amount }];
  if (intent.currency !== journal.currency) lines.push({ label: 'Montant réglé auprès du prestataire de paiement', amount_minor: intent.amount_minor, currency: intent.currency });
  return { userId: intent.user_id, kind: 'receipt', description: label, lines, net: amount, tax: 0, rateBps: 0 };
}

function commission(journal: JournalRow): Draft | null {
  const legs = entries(journal.id);
  const payee = legs.map((entry) => ({ entry, match: /^user:(.+):available$/.exec(entry.account) })).find((item) => item.match && item.entry.amount_minor > 0);
  const fee = legs.find((entry) => entry.account === ledgerAccounts.platformFees())?.amount_minor ?? 0;
  if (!payee || fee <= 0) return null;
  const userId = payee.match![1];
  if (!userExists(userId)) return null;
  const tax = taxSettings();
  const country = kycCountry(userId);
  const rateBps = (country ? tax.rates[country] : undefined) ?? tax.default_rate_bps;
  const taxLeg = legs.find((entry) => entry.account === ledgerAccounts.platformTaxes())?.amount_minor ?? 0;
  // A separate platform:taxes leg means the fee leg is already net of VAT.
  const split = taxLeg > 0 ? { net: fee, tax: taxLeg } : splitTax(fee, rateBps, tax.prices_include_tax);
  const gross = payee.entry.amount_minor + fee + Math.max(0, taxLeg);
  const subject = journal.kind === 'mission.paid' ? 'récompense de mission de test' : 'vente sur la marketplace';
  const description = `Commission de service Alpha sur ${subject}`;
  return {
    userId, kind: 'commission', description, net: split.net, tax: split.tax, rateBps,
    lines: [
      { label: `${description} (montant brut ${formatMoney(gross, journal.currency)}, net versé ${formatMoney(payee.entry.amount_minor, journal.currency)})`, amount_minor: split.net },
    ],
  };
}

function payoutStatement(journal: JournalRow): Draft | null {
  if (journal.ref_type !== 'withdrawal') return null;
  const withdrawal = one<{ user_id: string; amount_base_minor: number; amount_minor: number; currency: string; provider: string; payout_method_id: string; provider_reference: string | null }>(
    'SELECT user_id,amount_base_minor,amount_minor,currency,provider,payout_method_id,provider_reference FROM withdrawals WHERE id=?', journal.ref_id);
  if (!withdrawal) return null;
  const mask = one<{ display_mask: string }>('SELECT display_mask FROM payout_methods WHERE id=?', withdrawal.payout_method_id)?.display_mask ?? '••••';
  const description = `Versement de vos gains vers ${mask}`;
  return {
    userId: withdrawal.user_id, kind: 'payout_statement', description, net: withdrawal.amount_base_minor, tax: 0, rateBps: 0,
    lines: [
      { label: description, amount_minor: withdrawal.amount_base_minor },
      { label: `Montant reçu (${withdrawal.provider}${withdrawal.provider_reference ? `, réf. ${withdrawal.provider_reference}` : ''})`, amount_minor: withdrawal.amount_minor, currency: withdrawal.currency },
    ],
  };
}

function draftFor(journal: JournalRow): Draft | null {
  switch (journal.kind) {
    case 'campaign.funded':
    case 'order.paid': return receipt(journal);
    case 'mission.paid':
    case 'order.released': return commission(journal);
    case 'withdrawal.paid': return payoutStatement(journal);
    default: return null;
  }
}

function nextNumber(series: Series, year: number) {
  run(`INSERT INTO invoice_counters(series,year,last_number) VALUES (?,?,1)
    ON CONFLICT(series,year) DO UPDATE SET last_number=last_number+1`, series, year);
  const sequence = one<{ last_number: number }>('SELECT last_number FROM invoice_counters WHERE series=? AND year=?', series, year)!.last_number;
  const number = `ALPHA-${series === 'sandbox' ? 'SBX-' : ''}${year}-${String(sequence).padStart(6, '0')}`;
  return { sequence, number };
}

function customerSnapshot(userId: string) {
  const user = one<{ name: string }>('SELECT name FROM users WHERE id=?', userId)!;
  const identity = kycIdentity(userId);
  return {
    user_id: userId,
    name: identity?.legal_name || user.name,
    country: identity?.country ?? null,
    address: identity?.address ? [identity.address.line1, identity.address.line2, `${identity.address.postal_code} ${identity.address.city}`.trim(), identity.address.region].filter(Boolean) : [],
    verified: !!identity,
  };
}

/** Issues the document for one journal (idempotent per kind + journal, null when nothing new). Call inside a transaction. */
function issueFor(journal: JournalRow): InvoiceRow | null {
  const draft = draftFor(journal);
  if (!draft) return null;
  if (one('SELECT 1 FROM invoices WHERE kind=? AND journal_id=?', draft.kind, journal.id)) return null;
  const issuedAt = now();
  const year = new Date(issuedAt).getUTCFullYear();
  const { sequence, number } = nextNumber(journal.mode, year);
  const invoiceId = id();
  const issuer: IssuerSettings & { mode: Series } = { ...issuerSettings(), mode: journal.mode };
  run(`INSERT INTO invoices(id,number,series,year,sequence,user_id,kind,journal_id,ref_type,ref_id,currency,amount_net_minor,amount_tax_minor,
    amount_gross_minor,tax_rate_bps,description,lines,issuer_snapshot,customer_snapshot,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  invoiceId, number, journal.mode, year, sequence, draft.userId, draft.kind, journal.id, journal.ref_type, journal.ref_id, journal.currency,
  draft.net, draft.tax, draft.net + draft.tax, draft.rateBps, draft.description.slice(0, 500), JSON.stringify(draft.lines),
  JSON.stringify(issuer), JSON.stringify(customerSnapshot(draft.userId)), issuedAt);
  return one<InvoiceRow>('SELECT * FROM invoices WHERE id=?', invoiceId)!;
}

/**
 * Job `compliance.invoices`: scans ledger journals after the cursor (rowid, journals are append-only) and issues
 * receipts, commission invoices and payout statements. Live documents wait until the issuer identity is complete.
 */
export function issueInvoices(batch = 500) {
  let issued = 0;
  let scanned = 0;
  let blocked = false;
  for (;;) {
    const position = one<{ position: number }>('SELECT position FROM compliance_cursors WHERE name=?', INVOICE_CURSOR)?.position ?? 0;
    const journals = all<JournalRow>(`SELECT rowid AS seq,id,kind,mode,currency,ref_type,ref_id,memo,created_at FROM ledger_journals
      WHERE rowid>? ORDER BY rowid LIMIT ?`, position, batch);
    if (!journals.length) break;
    for (const journal of journals) {
      if (journal.mode === 'live' && issuerProblems().length) {
        blocked = true;
        log.warn('compliance.invoices_blocked', { reason: 'issuer_incomplete', journal_id: journal.id });
        break;
      }
      transaction(() => {
        try {
          // Savepoint: a failure never leaves a consumed number behind (continuous numbering).
          if (transaction(() => issueFor(journal))) issued += 1;
        } catch (error) {
          // A malformed journal must not block the whole accounting stream: logged and skipped.
          log.error('compliance.invoice_failed', { journal_id: journal.id, kind: journal.kind, error });
        }
        run(`INSERT INTO compliance_cursors(name,position,updated_at) VALUES (?,?,?)
          ON CONFLICT(name) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`, INVOICE_CURSOR, journal.seq, now());
      });
      scanned += 1;
    }
    if (blocked || journals.length < batch) break;
  }
  return { issued, scanned, blocked };
}

export function invoicesBlocked() {
  const position = one<{ position: number }>('SELECT position FROM compliance_cursors WHERE name=?', INVOICE_CURSOR)?.position ?? 0;
  const pendingLive = !!one("SELECT 1 FROM ledger_journals WHERE rowid>? AND mode='live' LIMIT 1", position);
  return pendingLive && issuerProblems().length > 0;
}

export function invoiceView(invoice: InvoiceRow) {
  return {
    id: invoice.id,
    number: invoice.number,
    kind: invoice.kind,
    kind_label: kindLabels[invoice.kind],
    series: invoice.series,
    currency: invoice.currency,
    amount_net_minor: invoice.amount_net_minor,
    amount_tax_minor: invoice.amount_tax_minor,
    amount_gross_minor: invoice.amount_gross_minor,
    tax_rate_bps: invoice.tax_rate_bps,
    description: invoice.description,
    ref_type: invoice.ref_type,
    ref_id: invoice.ref_id,
    issued_at: invoice.issued_at,
    html_url: `/api/compliance/invoices/${encodeURIComponent(invoice.id)}/html`,
  };
}

export function listInvoices(userId: string, limit = 20, offset = 0) {
  return {
    total: one<{ count: number }>('SELECT COUNT(*) AS count FROM invoices WHERE user_id=?', userId)!.count,
    invoices: all<InvoiceRow>('SELECT * FROM invoices WHERE user_id=? ORDER BY issued_at DESC, sequence DESC LIMIT ? OFFSET ?', userId, limit, offset).map(invoiceView),
  };
}

export function adminInvoices(filter: { from?: string; to?: string; kind?: InvoiceKind }, limit: number, offset: number) {
  const where: string[] = ['1=1'];
  const params: string[] = [];
  if (filter.from) { where.push('i.issued_at>=?'); params.push(filter.from); }
  if (filter.to) { where.push('i.issued_at<?'); params.push(filter.to); }
  if (filter.kind) { where.push('i.kind=?'); params.push(filter.kind); }
  const rows = all<InvoiceRow & { user_name: string }>(`SELECT i.*,u.name AS user_name FROM invoices i JOIN users u ON u.id=i.user_id
    WHERE ${where.join(' AND ')} ORDER BY i.issued_at DESC, i.sequence DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = one<{ count: number }>(`SELECT COUNT(*) AS count FROM invoices i WHERE ${where.join(' AND ')}`, ...params)!.count;
  return { total, invoices: rows.map((invoice) => ({ ...invoiceView(invoice), user_id: invoice.user_id, user_name: invoice.user_name })) };
}

export function invoiceFor(invoiceId: string, viewer: { id: string; role: string }): InvoiceRow {
  const invoice = one<InvoiceRow>('SELECT * FROM invoices WHERE id=?', invoiceId);
  // 404 for other users' documents: never reveal that an invoice id exists.
  if (!invoice || (invoice.user_id !== viewer.id && viewer.role !== 'admin')) throw new HttpError(404, 'Document introuvable.');
  return invoice;
}

const dateFr = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
const percent = (bps: number) => `${(bps / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
const multiline = (value: string) => escapeHtml(value).replace(/\r?\n/g, '<br>');

/** Printable, fully escaped, script-free HTML document (served with a restrictive CSP). */
export function renderInvoiceHtml(invoice: InvoiceRow): string {
  const issuer = JSON.parse(invoice.issuer_snapshot) as Partial<IssuerSettings> & { mode?: Series };
  const customer = JSON.parse(invoice.customer_snapshot) as { name: string; country: string | null; address: string[]; user_id: string };
  const lines = JSON.parse(invoice.lines) as Line[];
  const operationDate = one<{ created_at: string }>('SELECT created_at FROM ledger_journals WHERE id=?', invoice.journal_id)?.created_at ?? invoice.issued_at;
  const tax = taxSettings();
  const specimen = invoice.series === 'sandbox';
  const mentions: string[] = [];
  if (invoice.kind === 'receipt') mentions.push('Reçu d’encaissement : les fonds sont détenus sous séquestre pour le compte des bénéficiaires (testeurs ou vendeurs) et ne constituent pas un chiffre d’affaires d’Alpha. La commission d’Alpha fait l’objet d’une facture distincte adressée au bénéficiaire.');
  if (invoice.kind === 'payout_statement') mentions.push('Relevé de versement : transfert de fonds vous appartenant, non soumis à TVA. À conserver pour vos déclarations de revenus.');
  if (invoice.kind === 'commission') {
    mentions.push('Facture acquittée : la commission a été prélevée lors du versement.');
    if (invoice.tax_rate_bps === 0 && tax.exemption_mention) mentions.push(tax.exemption_mention);
  }
  const row = (line: Line) => `<tr><td>${escapeHtml(line.label)}</td><td class="num">${line.amount_minor === undefined ? '' : escapeHtml(formatMoney(line.amount_minor, line.currency ?? invoice.currency))}</td></tr>`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(kindLabels[invoice.kind])} ${escapeHtml(invoice.number)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#1d1b29;margin:0;background:#f6f4ef}
main{max-width:800px;margin:24px auto;background:#fff;padding:40px;border-radius:12px}
h1{font-size:24px;margin:0 0 4px}.muted{color:#6f6a7d;font-size:13px}.grid{display:flex;gap:32px;justify-content:space-between;margin:28px 0}
.grid section{flex:1}.label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6f6a7d;margin:0 0 6px}
table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e8e5ee;vertical-align:top}
.num{text-align:right;white-space:nowrap}.totals td{border:0;padding:4px 8px}.totals .grand td{font-weight:700;font-size:17px;border-top:2px solid #1d1b29}
.specimen{background:#fff4d6;border:1px solid #e8b100;padding:10px 14px;border-radius:8px;font-weight:700}
footer{margin-top:32px;font-size:12px;color:#6f6a7d;line-height:1.5}.hint{text-align:center;font-size:13px;color:#6f6a7d}
@media print{body{background:#fff}main{margin:0;padding:0;border-radius:0}.hint{display:none}}
</style></head><body><main>
${specimen ? '<p class="specimen" role="note">SPÉCIMEN — document émis en mode bac à sable, sans valeur comptable ni fiscale.</p>' : ''}
<header><h1>${escapeHtml(kindLabels[invoice.kind])}</h1><p class="muted">N° ${escapeHtml(invoice.number)} · émis le ${escapeHtml(dateFr(invoice.issued_at))} · opération du ${escapeHtml(dateFr(operationDate))}</p></header>
<div class="grid">
<section><p class="label">Émetteur</p><strong>${escapeHtml(issuer.legal_name || 'Alpha (raison sociale à compléter)')}</strong>
${issuer.legal_form ? `<br>${escapeHtml(issuer.legal_form)}` : ''}<br>${multiline(issuer.address || 'Adresse à compléter')}
${issuer.registration_number ? `<br>Immatriculation : ${escapeHtml(issuer.registration_number)}` : ''}
${issuer.vat_number ? `<br>N° TVA intracommunautaire : ${escapeHtml(issuer.vat_number)}` : ''}${issuer.email ? `<br>${escapeHtml(issuer.email)}` : ''}</section>
<section><p class="label">Client</p><strong>${escapeHtml(customer.name)}</strong>${customer.address.map((line) => `<br>${escapeHtml(line)}`).join('')}
${customer.country ? `<br>${escapeHtml(customer.country)}` : ''}<br><span class="muted">Compte Alpha ${escapeHtml(customer.user_id.slice(0, 8))}</span></section>
</div>
<table><caption class="muted" style="text-align:left">Montants en ${escapeHtml(invoice.currency)}</caption>
<thead><tr><th scope="col">Désignation</th><th scope="col" class="num">Montant</th></tr></thead>
<tbody>${lines.map(row).join('')}</tbody></table>
<table class="totals"><tbody>
<tr><td>Total hors taxes</td><td class="num">${escapeHtml(formatMoney(invoice.amount_net_minor, invoice.currency))}</td></tr>
<tr><td>TVA (${escapeHtml(percent(invoice.tax_rate_bps))})</td><td class="num">${escapeHtml(formatMoney(invoice.amount_tax_minor, invoice.currency))}</td></tr>
<tr class="grand"><td>Total TTC</td><td class="num">${escapeHtml(formatMoney(invoice.amount_gross_minor, invoice.currency))}</td></tr>
</tbody></table>
${mentions.map((mention) => `<p class="muted">${escapeHtml(mention)}</p>`).join('')}
<footer>${issuer.footer ? multiline(issuer.footer) : 'Mentions légales à compléter par l’administrateur (pénalités de retard, indemnité forfaitaire de recouvrement de 40 € pour les professionnels, conditions d’escompte).'}</footer>
<p class="hint">Pour imprimer ou enregistrer en PDF, utilisez la commande Imprimer de votre navigateur (Ctrl+P / Cmd+P).</p>
</main></body></html>`;
}

/** CSV of every ledger entry for journals created in [from, to). Cells are protected against formula injection. */
export function journalsCsv(from: string, to: string, mode: Series | undefined, separator: ',' | ';') {
  const rows = all<{ journal_id: string; created_at: string; kind: string; mode: string; currency: string; ref_type: string; ref_id: string; memo: string; account: string; amount_minor: number; invoice_number: string | null }>(
    `SELECT j.id AS journal_id,j.created_at,j.kind,j.mode,j.currency,j.ref_type,j.ref_id,j.memo,e.account,e.amount_minor,
      (SELECT group_concat(number,' ') FROM invoices i WHERE i.journal_id=j.id) AS invoice_number
     FROM ledger_journals j JOIN ledger_entries e ON e.journal_id=j.id
     WHERE j.created_at>=? AND j.created_at<? ${mode ? 'AND j.mode=?' : ''} ORDER BY j.created_at, j.id, e.account LIMIT 200000`,
    ...(mode ? [from, to, mode] : [from, to]));
  const header = ['journal_id', 'date', 'type', 'mode', 'devise', 'ref_type', 'ref_id', 'libelle', 'compte', 'montant_minor', 'documents'];
  const lines = [header.map(csvCell).join(separator), ...rows.map((item) => [item.journal_id, item.created_at, item.kind, item.mode, item.currency,
    item.ref_type, item.ref_id, item.memo, item.account, item.amount_minor, item.invoice_number ?? ''].map(csvCell).join(separator))];
  return { csv: `\ufeff${lines.join('\r\n')}\r\n`, count: rows.length };
}

export function exportInvoices(userId: string) {
  return all<InvoiceRow>('SELECT * FROM invoices WHERE user_id=? ORDER BY issued_at', userId).map(invoiceView);
}
