import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth, type LegalDocumentKey } from '../lib/auth';
import '../styles/accounts.css';

export const legalTitles: Record<LegalDocumentKey, string> = {
  terms: 'Conditions générales d’utilisation',
  privacy: 'Politique de confidentialité',
  payments: 'Conditions des paiements, séquestre et retraits',
  tester_charter: 'Charte des testeurs',
  seller_terms: 'Conditions vendeurs de la marketplace',
};

const laterKey = (userId: string, documents: string[]) => `alpha_legal_later:${userId}:${documents.join(',')}`;
function postponed(key: string): boolean {
  try { return sessionStorage.getItem(key) === '1'; } catch { return false; }
}

/** Non-blocking banner listing required legal documents the signed-in user has not accepted in their current version. */
export default function LegalConsentBanner() {
  const { user, refresh } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [hiddenKey, setHiddenKey] = useState('');
  const documents = user?.pending_legal ?? [];
  if (!user || documents.length === 0) return null;
  const key = laterKey(user.id, documents);
  if (hiddenKey === key || postponed(key)) return null;

  async function accept() {
    if (pending) return;
    setPending(true); setError('');
    try {
      await api('/auth/legal/accept', { method: 'POST', body: JSON.stringify({ documents }) });
      await refresh();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  function later() {
    try { sessionStorage.setItem(key, '1'); } catch { /* storage unavailable: hide for this render tree only */ }
    setHiddenKey(key);
  }

  return <aside className="acct-legal-banner" role="region" aria-labelledby="legal-banner-title">
    <ScrollText size={20} aria-hidden="true" className="acct-legal-icon" />
    <div className="acct-legal-text">
      <strong id="legal-banner-title">{documents.length > 1 ? 'Documents contractuels à accepter' : 'Document contractuel à accepter'}</strong>
      <p>Merci de prendre connaissance {documents.length > 1 ? 'des documents suivants' : 'du document suivant'} et de {documents.length > 1 ? 'les ' : 'l’'}accepter pour continuer à utiliser Alpha en toute transparence :{' '}
        {documents.map((document, index) => <span key={document}>{index > 0 && (index === documents.length - 1 ? ' et ' : ', ')}<Link to={`/legal/${document}`}>{legalTitles[document] ?? document}</Link></span>)}.
      </p>
      {error && <p className="acct-legal-error" role="alert">{error}</p>}
    </div>
    <div className="acct-legal-actions">
      <button type="button" className="button button-primary button-small" disabled={pending} onClick={() => { void accept(); }}>{pending ? 'Enregistrement…' : 'J’ai lu et j’accepte'}</button>
      <button type="button" className="button button-ghost button-small" disabled={pending} onClick={later}>Plus tard</button>
    </div>
  </aside>;
}
