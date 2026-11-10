import { AlertTriangle, FlaskConical, ShieldCheck } from 'lucide-react';
import { Badge, DemoNotice, useApi } from './ui';
import '../styles/payments.css';

export type PaymentMode = 'demo' | 'sandbox' | 'live';
export type IntentStatus = 'created' | 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface PublicIntent {
  id: string;
  purpose: 'campaign_funding' | 'order_purchase';
  ref_type: 'campaign' | 'listing';
  ref_id: string;
  order_id: string | null;
  title: string;
  mode: 'sandbox' | 'live';
  provider: string;
  method: 'card' | 'mobile_money' | 'bank_transfer' | null;
  operator: string | null;
  provider_reference: string | null;
  amount_base_minor: number;
  base_currency: string;
  amount_minor: number;
  currency: string;
  status: IntentStatus;
  failure_reason: string;
  settlement: 'none' | 'settled' | 'unapplied';
  review_required: boolean;
  redirect_url: string | null;
  instructions: string;
  customer_phone_masked: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  final: boolean;
}

export const intentStatusLabels: Record<IntentStatus, string> = {
  created: 'Créé', pending: 'En attente', succeeded: 'Réussi', failed: 'Échoué', cancelled: 'Annulé', expired: 'Expiré',
};
export const purposeLabels: Record<PublicIntent['purpose'], string> = {
  campaign_funding: 'Financement de campagne', order_purchase: 'Achat marketplace',
};
export const methodLabels: Record<string, string> = { card: 'Carte bancaire', mobile_money: 'Mobile money', bank_transfer: 'Virement bancaire' };
export const modeLabels: Record<PaymentMode, string> = { demo: 'Démonstration', sandbox: 'Bac à sable', live: 'Paiements réels' };

/** Platform payment mode read from /api/health. `null` while loading: callers keep the V3 demo interface meanwhile. */
export function usePaymentMode(): PaymentMode | null {
  const { data } = useApi<{ payment_mode?: PaymentMode }>('/health');
  return data?.payment_mode ?? null;
}

export function IntentStatusBadge({ intent }: { intent: Pick<PublicIntent, 'status' | 'review_required' | 'settlement'> }) {
  if (intent.review_required || intent.settlement === 'unapplied') return <Badge tone="orange">En vérification</Badge>;
  const tone = intent.status === 'succeeded' ? 'green' : intent.status === 'failed' ? 'red' : intent.status === 'pending' || intent.status === 'created' ? 'blue' : 'neutral';
  return <Badge tone={tone}>{intentStatusLabels[intent.status] ?? intent.status}</Badge>;
}

/** Where the payer continues after a payment (campaign page or marketplace order). */
export function intentDestination(intent: Pick<PublicIntent, 'purpose' | 'ref_id' | 'order_id'>) {
  if (intent.order_id) return { to: `/marketplace?view=orders&order=${encodeURIComponent(intent.order_id)}`, label: 'Voir ma commande' };
  if (intent.purpose === 'campaign_funding') return { to: `/missions/${encodeURIComponent(intent.ref_id)}`, label: 'Retour à la campagne' };
  return { to: `/marketplace/${encodeURIComponent(intent.ref_id)}`, label: 'Retour à l’offre' };
}

export function PaymentModeBanner({ mode, compact = false }: { mode: PaymentMode | null; compact?: boolean }) {
  if (!mode || mode === 'demo') return <DemoNotice />;
  if (mode === 'sandbox') {
    return <div className="pay-banner pay-banner-sandbox" role="note"><FlaskConical size={16} aria-hidden="true" /><div><strong>Mode bac à sable</strong>{!compact && 'Les paiements passent par les environnements de test des prestataires (ou le simulateur Alpha). Aucun argent réel n’est débité ni versé.'}</div></div>;
  }
  return <div className="pay-banner pay-banner-live" role="note"><ShieldCheck size={16} aria-hidden="true" /><div><strong>Paiements réels activés</strong>{!compact && 'Les montants sont réellement débités par le prestataire choisi et conservés en séquestre jusqu’à la validation du travail. Alpha ne stocke jamais vos données de carte.'}</div></div>;
}

export function ReviewNotice() {
  return <div className="pay-banner pay-banner-warning" role="status"><AlertTriangle size={16} aria-hidden="true" /><div><strong>Paiement en vérification</strong>Le montant confirmé par le prestataire ne correspond pas à la demande. Rien n’a été crédité : notre équipe vérifie et vous contactera (remboursement si nécessaire).</div></div>;
}
