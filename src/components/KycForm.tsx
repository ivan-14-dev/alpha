import { useState, type FormEvent } from 'react';
import { CheckCircle2, Clock, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api, date, errorMessage } from '../lib/api';
import FileUpload, { formatFileSize } from './FileUpload';
import { Badge } from './ui';
import { CountryField, countryName } from './PayoutStatus';
import '../styles/compliance.css';

/* Identity verification wizard (GET/PUT /api/compliance/kyc, POST /api/compliance/kyc/submit). OWNER: compliance module.
 * Documents are uploaded through the files module (purpose kyc_document, resource kyc/<userId>) and only referenced here. */

export type KycStatus = 'none' | 'draft' | 'submitted' | 'approved' | 'rejected';
export interface KycAddress { line1: string; line2: string; postal_code: string; city: string; region: string }
export interface KycDocument { id: string; original_name: string; mime_type: string; size_bytes: number; scan_status: 'pending' | 'clean' | 'infected' | 'error' | 'skipped'; created_at: string }
export interface KycView {
  status: KycStatus; level: 'none' | 'basic' | 'enhanced'; legal_name: string; country: string | null; date_of_birth: string | null;
  address: KycAddress | null; documents: KycDocument[]; submitted_at: string | null; reviewed_at: string | null; rejection_reason: string; editable: boolean;
}

export const kycStatusLabels: Record<KycStatus, string> = {
  none: 'Non commencée', draft: 'Brouillon', submitted: 'En cours de vérification', approved: 'Vérifiée', rejected: 'Refusée',
};
const kycTones: Record<KycStatus, string> = { none: 'neutral', draft: 'neutral', submitted: 'orange', approved: 'green', rejected: 'red' };
export function KycStatusBadge({ status }: { status: KycStatus }) {
  return <Badge tone={kycTones[status]}>{kycStatusLabels[status]}</Badge>;
}

const scanLabels: Record<KycDocument['scan_status'], [string, string]> = {
  pending: ['Analyse antivirus en cours', 'orange'], clean: ['Analysé', 'green'], skipped: ['Accepté', 'green'], infected: ['Refusé (menace détectée)', 'red'], error: ['Erreur d’analyse', 'red'],
};

const MAX_DOCUMENTS = 5;
const steps = ['Identité', 'Adresse', 'Documents', 'Envoi'] as const;
const emptyAddress: KycAddress = { line1: '', line2: '', postal_code: '', city: '', region: '' };

function firstIncompleteStep(kyc: KycView): number {
  if (!kyc.legal_name || !kyc.country || !kyc.date_of_birth) return 0;
  if (!kyc.address) return 1;
  if (!kyc.documents.length) return 2;
  return 3;
}

interface Props {
  kyc: KycView;
  userId: string;
  onChange: (kyc: KycView) => void;
}

export default function KycForm({ kyc, userId, onChange }: Props) {
  const [step, setStep] = useState(() => firstIncompleteStep(kyc));
  const [legalName, setLegalName] = useState(kyc.legal_name);
  const [country, setCountry] = useState(kyc.country ?? '');
  const [birth, setBirth] = useState(kyc.date_of_birth ?? '');
  const [address, setAddress] = useState<KycAddress>(kyc.address ?? emptyAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const call = async (path: string, init: RequestInit, done?: (next: KycView) => void) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<KycView>(path, init);
      onChange(next);
      done?.(next);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (body: Record<string, unknown>, done?: (next: KycView) => void) => call('/compliance/kyc', { method: 'PUT', body: JSON.stringify(body) }, done);
  const refresh = () => call('/compliance/kyc', {});

  if (kyc.status === 'approved') {
    return <div className="cmp-notice cmp-notice-live" role="status"><ShieldCheck size={18} /><div>
      <strong>Identité vérifiée{kyc.level === 'enhanced' ? ' (niveau renforcé)' : ''}</strong>
      {kyc.legal_name} — {countryName(kyc.country)}{kyc.reviewed_at ? `, vérifiée le ${date(kyc.reviewed_at)}` : ''}. Pour modifier ces informations, contactez le support.
    </div></div>;
  }

  if (kyc.status === 'submitted') {
    return <div className="stack">
      <div className="cmp-notice cmp-notice-sandbox" role="status"><Clock size={18} /><div>
        <strong>Dossier en cours de vérification</strong>
        Envoyé le {kyc.submitted_at ? date(kyc.submitted_at) : '—'}. Notre équipe vérifie vos documents, généralement sous 2 jours ouvrés. Vous serez notifié de la décision.
      </div></div>
      <Summary kyc={kyc} />
    </div>;
  }

  const identity = (event: FormEvent) => {
    event.preventDefault();
    void save({ legal_name: legalName.trim(), country: country || null, date_of_birth: birth || null }, () => setStep(1));
  };
  const saveAddress = (event: FormEvent) => {
    event.preventDefault();
    void save({ address: { ...address } }, () => setStep(2));
  };
  const addDocument = (fileId: string) => {
    if (kyc.documents.some((document) => document.id === fileId)) return;
    void save({ document_file_ids: [...kyc.documents.map((document) => document.id), fileId] }, () => setMessage('Document ajouté à votre dossier.'));
  };
  const removeDocument = async (fileId: string) => {
    const neverSubmitted = !kyc.submitted_at;
    const saved = await save({ document_file_ids: kyc.documents.filter((document) => document.id !== fileId).map((document) => document.id) });
    // A dossier never sent for review carries no retention obligation: the identity document itself is deleted (best effort).
    if (saved && neverSubmitted) await api(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch(() => undefined);
  };
  const submit = () => {
    void call('/compliance/kyc/submit', { method: 'POST', body: JSON.stringify({}) }, () => setMessage('Votre dossier a été envoyé.'));
  };

  const scanning = kyc.documents.some((document) => document.scan_status === 'pending');
  const refused = kyc.documents.some((document) => document.scan_status === 'infected' || document.scan_status === 'error');

  return <div className="stack">
    {kyc.status === 'rejected' && <div className="alert alert-error" role="alert"><strong>Dossier refusé.</strong> {kyc.rejection_reason || 'Aucun motif précisé.'} Corrigez les informations ou ajoutez de nouveaux documents, puis renvoyez votre dossier.</div>}
    <ol className="cmp-steps" aria-label="Étapes de la vérification">
      {steps.map((name, index) => <li key={name} className={index < step ? 'is-done' : index === step ? 'is-current' : ''} aria-current={index === step ? 'step' : undefined}>
        <button type="button" className="cmp-step-button" onClick={() => setStep(index)}>{name}</button>
      </li>)}
    </ol>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {message && <div className="alert alert-success" role="status">{message}</div>}

    {step === 0 && <form className="form" onSubmit={identity}>
      <p className="help-text">Indiquez votre identité exactement comme sur votre pièce d’identité. Ces données sont chiffrées et ne servent qu’aux obligations de vérification (lutte contre la fraude et le blanchiment).</p>
      <div className="form-grid">
        <label className="field" htmlFor="kyc-name">Nom et prénoms légaux
          <input id="kyc-name" autoComplete="name" required minLength={2} maxLength={160} value={legalName} onChange={(event) => setLegalName(event.target.value)} />
        </label>
        <label className="field" htmlFor="kyc-birth">Date de naissance
          <input id="kyc-birth" type="date" autoComplete="bday" required value={birth} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setBirth(event.target.value)} />
        </label>
        <CountryField id="kyc-country" label="Pays de résidence" value={country} onChange={setCountry} required />
      </div>
      <div className="cmp-actions cmp-actions-end"><button type="submit" className="button button-primary" disabled={busy}>Enregistrer et continuer</button></div>
    </form>}

    {step === 1 && <form className="form" onSubmit={saveAddress}>
      <div className="form-grid">
        <label className="field" htmlFor="kyc-line1">Adresse
          <input id="kyc-line1" autoComplete="address-line1" required minLength={2} maxLength={200} value={address.line1} onChange={(event) => setAddress({ ...address, line1: event.target.value })} />
        </label>
        <label className="field" htmlFor="kyc-line2">Complément (facultatif)
          <input id="kyc-line2" autoComplete="address-line2" maxLength={200} value={address.line2} onChange={(event) => setAddress({ ...address, line2: event.target.value })} />
        </label>
        <label className="field" htmlFor="kyc-postal">Code postal / boîte postale (facultatif)
          <input id="kyc-postal" autoComplete="postal-code" maxLength={20} value={address.postal_code} onChange={(event) => setAddress({ ...address, postal_code: event.target.value })} />
        </label>
        <label className="field" htmlFor="kyc-city">Ville
          <input id="kyc-city" autoComplete="address-level2" required maxLength={100} value={address.city} onChange={(event) => setAddress({ ...address, city: event.target.value })} />
        </label>
        <label className="field" htmlFor="kyc-region">Région / quartier (facultatif)
          <input id="kyc-region" autoComplete="address-level1" maxLength={100} value={address.region} onChange={(event) => setAddress({ ...address, region: event.target.value })} />
        </label>
      </div>
      <div className="cmp-actions cmp-actions-end">
        <button type="button" className="button button-ghost" onClick={() => setStep(0)}>Retour</button>
        <button type="submit" className="button button-primary" disabled={busy}>Enregistrer et continuer</button>
      </div>
    </form>}

    {step === 2 && <div className="form">
      <p className="help-text">Ajoutez une pièce d’identité officielle en cours de validité (carte nationale d’identité recto et verso, passeport ou titre de séjour) et, si possible, un justificatif de domicile de moins de 3 mois. Formats PDF, JPG ou PNG. Les documents sont analysés par un antivirus puis consultables uniquement par l’équipe conformité.</p>
      {kyc.documents.length > 0 && <ul className="cmp-docs">
        {kyc.documents.map((document) => <li key={document.id}>
          <span><strong>{document.original_name}</strong><span className="cmp-sub">{formatFileSize(document.size_bytes)} · ajouté le {date(document.created_at)}</span></span>
          <span className="cmp-actions">
            <Badge tone={scanLabels[document.scan_status][1]}>{scanLabels[document.scan_status][0]}</Badge>
            <button type="button" className="button button-ghost button-small" disabled={busy} onClick={() => void removeDocument(document.id)} aria-label={`Retirer ${document.original_name}`}><Trash2 size={14} /> Retirer</button>
          </span>
        </li>)}
      </ul>}
      {kyc.documents.length < MAX_DOCUMENTS
        ? <FileUpload purpose="kyc_document" resourceType="kyc" resourceId={userId} label="Ajouter une pièce justificative" disabled={busy} onUploaded={(file) => addDocument(file.id)} />
        : <p className="help-text">Nombre maximal de documents atteint ({MAX_DOCUMENTS}). Retirez-en un pour en ajouter un autre.</p>}
      {scanning && <div className="cmp-actions"><span className="small muted">L’analyse antivirus peut prendre quelques instants.</span><button type="button" className="button button-secondary button-small" onClick={() => { void refresh(); }} disabled={busy}><RefreshCw size={14} /> Actualiser</button></div>}
      <div className="cmp-actions cmp-actions-end">
        <button type="button" className="button button-ghost" onClick={() => setStep(1)}>Retour</button>
        <button type="button" className="button button-primary" disabled={busy || !kyc.documents.length} onClick={() => setStep(3)}>Continuer</button>
      </div>
    </div>}

    {step === 3 && <div className="form">
      <Summary kyc={kyc} />
      {refused && <div className="alert alert-error" role="alert">Un document a été refusé par l’analyse antivirus : retirez-le avant d’envoyer votre dossier.</div>}
      <p className="help-text">En envoyant votre dossier, vous certifiez l’exactitude des informations fournies. Elles servent uniquement à la vérification de votre identité et sont conservées pendant les durées légales applicables, conformément à notre politique de confidentialité.</p>
      <div className="cmp-actions cmp-actions-end">
        <button type="button" className="button button-ghost" onClick={() => setStep(2)}>Retour</button>
        <button type="button" className="button button-primary" disabled={busy || refused || !kyc.documents.length} onClick={submit}><CheckCircle2 size={16} /> Envoyer pour vérification</button>
      </div>
    </div>}
  </div>;
}

function Summary({ kyc }: { kyc: KycView }) {
  const address = kyc.address;
  return <dl className="cmp-dl">
    <dt>Nom légal</dt><dd>{kyc.legal_name || '—'}</dd>
    <dt>Date de naissance</dt><dd>{kyc.date_of_birth ? date(`${kyc.date_of_birth}T12:00:00Z`) : '—'}</dd>
    <dt>Pays de résidence</dt><dd>{countryName(kyc.country)}</dd>
    <dt>Adresse</dt><dd>{address ? [address.line1, address.line2, [address.postal_code, address.city].filter(Boolean).join(' '), address.region].filter(Boolean).join(', ') : '—'}</dd>
    <dt>Documents</dt><dd>{kyc.documents.length ? kyc.documents.map((document) => document.original_name).join(', ') : 'Aucun'}</dd>
  </dl>;
}
