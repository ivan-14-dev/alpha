import { useState } from 'react';
import { CreditCard, Landmark, Smartphone, Star, Trash2 } from 'lucide-react';
import { api, date, errorMessage } from '../lib/api';
import { Badge, EmptyState } from './ui';
import { countryName, payoutKindLabels, type PayoutKind, type PayoutMethodView } from './PayoutStatus';
import '../styles/compliance.css';

/* Masked list of the user's payout methods with default / delete actions. OWNER: compliance module. */

const icons: Record<PayoutKind, typeof Smartphone> = { mobile_money: Smartphone, bank_account: Landmark, stripe_connect: CreditCard };

interface Props {
  methods: PayoutMethodView[];
  onChange: () => void;
  disabled?: boolean;
}

export default function PayoutMethodList({ methods, onChange, disabled }: Props) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const act = async (methodId: string, action: () => Promise<unknown>) => {
    setBusy(methodId); setError('');
    try {
      await action();
      onChange();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy('');
    }
  };

  const makeDefault = (method: PayoutMethodView) => act(method.id, () => api(`/compliance/payout-methods/${encodeURIComponent(method.id)}/default`, { method: 'POST' }));
  const remove = (method: PayoutMethodView) => {
    if (!window.confirm(`Supprimer « ${method.label || method.display_mask} » ? Les coordonnées seront effacées définitivement.`)) return;
    void act(method.id, () => api(`/compliance/payout-methods/${encodeURIComponent(method.id)}`, { method: 'DELETE' }));
  };

  if (!methods.length) return <EmptyState title="Aucun moyen de versement" description="Ajoutez un compte mobile money, un compte bancaire ou un compte Stripe Connect pour recevoir vos retraits." />;

  return <div className="stack">
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <ul className="cmp-methods">
      {methods.map((method) => {
        const Icon = icons[method.kind];
        return <li key={method.id} className="cmp-method">
          <div className="cmp-method-main">
            <span className="cmp-method-icon" aria-hidden="true"><Icon size={18} /></span>
            <div>
              <span className="cmp-method-title">
                {method.label || payoutKindLabels[method.kind]}
                {method.is_default && <Badge tone="purple">Par défaut</Badge>}
                {method.verified_at && <Badge tone="green">Versement réussi</Badge>}
                {method.payout_available === false && <Badge tone="orange">Indisponible</Badge>}
              </span>
              <span className="cmp-sub"><span className="cmp-mono">{method.display_mask}</span> · {payoutKindLabels[method.kind]} · {countryName(method.country)} · {method.currency}</span>
              <span className="cmp-sub">Ajouté le {date(method.created_at)}{method.payout_available === false ? ' — aucun prestataire de versement n’est actif pour ce moyen et cette devise dans le mode actuel.' : ''}</span>
            </div>
          </div>
          <div className="cmp-actions">
            {!method.is_default && <button type="button" className="button button-secondary button-small" disabled={disabled || !!busy} onClick={() => { void makeDefault(method); }}>
              <Star size={14} /> Par défaut
            </button>}
            <button type="button" className="button button-ghost button-small" disabled={disabled || !!busy} onClick={() => remove(method)} aria-label={`Supprimer ${method.label || method.display_mask}`}>
              <Trash2 size={14} /> Supprimer
            </button>
          </div>
        </li>;
      })}
    </ul>
  </div>;
}
