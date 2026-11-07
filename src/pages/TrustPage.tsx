import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileSearch, Flag, ShieldCheck } from 'lucide-react';
import { Badge, DemoNotice, EmptyState, ErrorState, Loading, LoginNotice, PageHeader, useApi } from '../components/ui';
import { api, date, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

const targetLabels = {
  project: 'Projet', post: 'Publication', listing: 'Annonce', mission: 'Mission', order: 'Commande', user: 'Profil utilisateur',
};
type TargetType = keyof typeof targetLabels;
type CaseStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed';
const statusLabels: Record<CaseStatus, string> = { open: 'Ouvert', reviewing: 'En examen', resolved: 'Résolu', dismissed: 'Classé sans suite' };
const stateLabels: Record<string, string> = {
  assigned: 'Attribuée', in_progress: 'Travail en cours', submitted: 'Rapport soumis', changes_requested: 'Modifications demandées',
  accepted: 'Travail accepté', cancelled: 'Annulée', disputed: 'En litige', paid: 'Paiement simulé enregistré',
  delivered: 'Livraison documentée', completed: 'Terminée', refunded: 'Remboursement enregistré',
  public: 'Public', private: 'Privé', active: 'Active', archived: 'Archivée',
};
type WorkReport = { summary: string; steps: string; expected: string; observed: string; evidence_url: string };
type Report = {
  id: string; target_type: TargetType; target_id: string; reason: string;
  status: CaseStatus; decision: string; created_at: string; reporter_name?: string; open_reports?: number;
  context?: { title?: string; body?: string; status?: string; work_report?: WorkReport | null; delivery_text?: string; payout_recorded?: boolean; settlement_recorded?: boolean } | null;
};
type AuditEvent = { id: string; actor_name: string | null; action: string; target_type: string; target_id: string; detail: string; created_at: string };

function Policies() {
  return <section className="card card-body stack" aria-labelledby="trust-policies">
    <h2 id="trust-policies"><ShieldCheck size={21} /> Des règles claires, des décisions traçables</h2>
    <div className="three-column">
      <div><h3>Respect et confidentialité</h3><p className="muted">Signalez les abus, le harcèlement, le contenu trompeur ou un désaccord sur un livrable. Décrivez les faits sans publier de secrets ni de données personnelles inutiles.</p></div>
      <div><h3>Un travail, pas un avis acheté</h3><p className="muted">L’acceptation d’une mission dépend du travail réalisé et des livrables convenus, jamais d’un avis positif. Un retour critique et honnête doit rester possible.</p></div>
      <div><h3>Un examen confidentiel</h3><p className="muted">Chaque dossier est visible uniquement par son auteur et la modération, même si les deux parties signalent le même élément. Les parties voient seulement l’état de leur mission ou commande.</p></div>
    </div>
    <DemoNotice />
    <p className="small muted">Un signalement suspend les missions et commandes encore actives. Une mission déjà versée ou annulée et une commande terminée ou remboursée ne sont pas modifiées. La modération doit choisir une reprise explicite à la clôture du dernier dossier. Aucun remboursement ni transfert réel n’est proposé : les corrections financières et remboursements réels sont hors du périmètre de cette démonstration.</p>
    <div className="row gap-sm"><Link className="button button-secondary" to="/missions">Mes missions</Link><Link className="button button-secondary" to="/marketplace">Marketplace et commandes</Link></div>
  </section>;
}

function ReportForm({ onCreated }: { onCreated: () => void }) {
  const [params] = useSearchParams();
  const requestedType = params.get('target_type') ?? '';
  const [targetType, setTargetType] = useState<TargetType>(Object.hasOwn(targetLabels, requestedType) ? requestedType as TargetType : 'project');
  const [targetId, setTargetId] = useState((params.get('target_id') ?? '').slice(0, 100));
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError(''); setSuccess('');
    try {
      await api('/trust/reports', { method: 'POST', body: JSON.stringify({ target_type: targetType, target_id: targetId.trim(), reason: reason.trim() }) });
      setReason('');
      setSuccess('Signalement enregistré. Retrouvez ci-dessous votre dossier confidentiel.');
      onCreated();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <section className="card card-body stack" aria-labelledby="report-form-title">
    <h2 id="report-form-title"><Flag size={20} /> Créer un signalement</h2>
    <p className="muted">Choisissez le type exact et copiez son identifiant depuis sa fiche. Pour une mission ou une commande, vous devez en être participant. Un seul dossier actif par auteur et par élément est autorisé.</p>
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">Type d’élément<select value={targetType} onChange={(event) => setTargetType(event.target.value as TargetType)} disabled={pending}>
          {Object.entries(targetLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="field">Identifiant de l’élément<input value={targetId} onChange={(event) => setTargetId(event.target.value)} required maxLength={100} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" placeholder="Identifiant exact, pas une URL" autoComplete="off" disabled={pending} /></label>
      </div>
      <label className="field">Motif et faits observés<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={10} maxLength={2000} rows={5} disabled={pending} /></label>
      <p className="help-text">10 à 2 000 caractères. Ce texte n’est pas publié auprès de l’autre partie.</p>
      <ErrorState message={error} />
      {success && <p className="alert alert-success" role="status">{success}</p>}
      <button className="button button-primary" type="submit" disabled={pending}>{pending ? 'Envoi en cours…' : 'Envoyer le signalement'}</button>
    </form>
  </section>;
}

function ReviewContext({ report }: { report: Report }) {
  const context = report.context;
  if (!context) return <p className="text-warning">L’élément n’existe plus. Le dossier peut être clôturé sans modifier de workflow.</p>;
  return <details>
    <summary>Examiner l’élément signalé</summary>
    <div className="stack card-body">
      {context.title && <h4>{context.title}</h4>}
      {context.status && <p>État actuel : <strong>{stateLabels[context.status] ?? context.status}</strong></p>}
      {context.body && <p className="pre-wrap">{context.body}</p>}
      {report.target_type === 'mission' && (context.work_report ? <div className="stack">
        <h4>Rapport de test</h4>
        {([['summary', 'Synthèse'], ['steps', 'Étapes'], ['expected', 'Résultat attendu'], ['observed', 'Résultat observé'], ['evidence_url', 'URL de preuve']] as const).map(([field, label]) =>
          context.work_report![field] ? <div key={field}><strong>{label}</strong><p className="pre-wrap">{context.work_report![field]}</p></div> : null)}
      </div> : <p className="muted">Aucun rapport de test : la mission ne peut pas être acceptée ni marquée comme soumise.</p>)}
      {report.target_type === 'order' && <div><h4>Livraison</h4><p className="pre-wrap">{context.delivery_text || 'Aucune livraison documentée.'}</p></div>}
      {context.payout_recorded && <p className="text-warning">Un versement est enregistré. Il ne peut pas être annulé par une décision de modération.</p>}
      {context.settlement_recorded && <p className="text-warning">Une vente ou un remboursement est enregistré. Une décision de modération ne peut pas annuler cette écriture financière.</p>}
    </div>
  </details>;
}

function DecisionForm({ report, onSaved }: { report: Report; onSaved: () => void }) {
  const [status, setStatus] = useState<'reviewing' | 'resolved' | 'dismissed'>('reviewing');
  const [decision, setDecision] = useState(report.decision);
  const [resolution, setResolution] = useState('');
  const [revisionNote, setRevisionNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const closing = status !== 'reviewing';
  const disputed = report.context?.status === 'disputed';
  const otherCases = (report.open_reports ?? 1) > 1;
  const needsResolution = closing && disputed && !otherCases;
  const needsRevisionNote = needsResolution && resolution === 'changes_requested';
  const resolutions = report.target_type === 'mission' ? ['in_progress', 'changes_requested', 'submitted', 'accepted', 'cancelled'] : ['paid', 'delivered'];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    try {
      await api(`/trust/reports/${encodeURIComponent(report.id)}/resolve`, {
        method: 'POST', body: JSON.stringify({
          status, decision: decision.trim(), ...(needsResolution ? { resolution } : {}),
          ...(needsRevisionNote ? { revision_note: revisionNote.trim() } : {}),
        }),
      });
      onSaved();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <form className="form" onSubmit={submit}>
    <div className="form-grid">
      <label className="field">Décision sur le dossier<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} disabled={pending}>
        <option value="reviewing">Poursuivre l’examen</option><option value="resolved">Résoudre le dossier</option><option value="dismissed">Classer sans suite</option>
      </select></label>
      {needsResolution && <label className="field">État de reprise obligatoire<select required value={resolution} onChange={(event) => setResolution(event.target.value)} disabled={pending}>
        <option value="">Choisir explicitement…</option>
        {resolutions.map((value) => <option key={value} value={value} disabled={
          (['changes_requested', 'submitted', 'accepted'].includes(value) && !report.context?.work_report) ||
          (value === 'in_progress' && !!report.context?.work_report) ||
          (value === 'delivered' && !report.context?.delivery_text?.trim())
        }>{stateLabels[value]}</option>)}
      </select></label>}
    </div>
    {disputed && otherCases && <p className="help-text">D’autres dossiers actifs concernent cet élément ({report.open_reports} au total). Cette clôture le laissera en litige ; la reprise sera choisie lors de la clôture du dernier dossier.</p>}
    {needsResolution && <p className="help-text">La reprise ne verse ni ne rembourse d’argent. Un rapport existant peut être soumis, accepté ou renvoyé pour modifications, mais ne peut pas reprendre comme un travail sans rapport. Une commande livrée exige un texte de livraison. Le classement sans suite exige lui aussi une reprise explicite.</p>}
    {needsRevisionNote && <div className="stack">
      <label className="field">Modifications attendues — partagées avec les deux participants<textarea value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} required minLength={10} maxLength={2000} rows={3} disabled={pending} /></label>
      <p className="help-text">Cette consigne apparaîtra dans la mission pour permettre la révision du rapport. Ne divulguez ni l’identité des autres auteurs de signalements ni le contenu confidentiel de leurs dossiers.</p>
    </div>}
    <label className="field">Motivation de la décision<textarea value={decision} onChange={(event) => setDecision(event.target.value)} required minLength={10} maxLength={4000} rows={4} disabled={pending} /></label>
    <p className="help-text">Visible par l’auteur de ce dossier et dans le journal réservé aux administrateurs. Ne divulguez pas les autres auteurs de signalements.</p>
    <ErrorState message={error} />
    <button className="button button-primary" type="submit" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer la décision'}</button>
  </form>;
}

function ReportCard({ report, admin, onSaved }: { report: Report; admin: boolean; onSaved: () => void }) {
  return <article className="card card-body stack">
    <div className="row row-between"><h3>{targetLabels[report.target_type]}</h3><Badge tone={report.status === 'resolved' ? 'green' : report.status === 'dismissed' ? 'neutral' : 'orange'}>{statusLabels[report.status]}</Badge></div>
    <p className="small muted">Élément : <code>{report.target_id}</code><br />Dossier : <code>{report.id}</code> · {date(report.created_at)}{admin && report.reporter_name && <> · Auteur : {report.reporter_name}</>}</p>
    <div><strong>Motif</strong><p className="pre-wrap">{report.reason}</p></div>
    {report.decision && <div className="alert"><strong>Décision de modération</strong><p className="pre-wrap">{report.decision}</p></div>}
    {admin && <ReviewContext report={report} />}
    {admin && ['open', 'reviewing'].includes(report.status) && <DecisionForm report={report} onSaved={onSaved} />}
    {report.target_type === 'mission' && <Link to="/missions">Retrouver mes missions</Link>}
    {report.target_type === 'order' && <Link to="/marketplace">Retrouver mes commandes</Link>}
  </article>;
}

const auditActions: Record<string, string> = {
  'moderation.report.created': 'Signalement créé', 'moderation.report.reviewing': 'Examen mis à jour',
  'moderation.report.resolved': 'Dossier résolu', 'moderation.report.dismissed': 'Dossier classé',
};

function TrustWorkspace({ admin }: { admin: boolean }) {
  const [params] = useSearchParams();
  const reports = useApi<{ reports: Report[] }>('/trust/reports');
  const audit = useApi<{ events: AuditEvent[] }>(admin ? '/trust/audit' : null);
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState('');
  const refresh = () => { reports.reload(); if (admin) audit.reload(); };
  const visible = reports.data?.reports.filter((report) => filter === 'all' || report.status === filter);
  return <div className="stack">
    <ReportForm key={`${params.get('target_type') ?? ''}:${params.get('target_id') ?? ''}`} onCreated={refresh} />
    <section className="stack" aria-labelledby="trust-cases">
      <div className="row row-between"><h2 id="trust-cases"><FileSearch size={21} /> {admin ? 'Examen des signalements' : 'Mes signalements'}</h2><button className="button button-secondary" type="button" onClick={refresh} disabled={reports.loading || audit.loading}>Actualiser</button></div>
      <p className="muted">{admin ? 'Jusqu’à 100 dossiers, actifs en priorité. Examinez les faits avant de décider de la reprise.' : 'Vos 100 derniers dossiers au maximum. Les signalements des autres participants ne sont jamais affichés ici.'}</p>
      <label className="field">Filtrer les dossiers<select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">Tous les états</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {notice && <p className="alert alert-success" role="status">{notice}</p>}
      {reports.loading ? <Loading /> : reports.error ? <ErrorState message={reports.error} /> :
        visible?.length ? visible.map((report) => <ReportCard key={report.id} report={report} admin={admin} onSaved={() => { setNotice('Décision enregistrée et notifiée.'); refresh(); }} />) :
          <EmptyState title="Aucun signalement à afficher" description={filter === 'all' ? 'Les nouveaux dossiers apparaîtront ici après leur envoi.' : 'Aucun dossier ne correspond à cet état.'} />}
    </section>
    {admin && <section className="card card-body stack" aria-labelledby="audit-heading">
      <h2 id="audit-heading">Journal d’audit</h2><p className="muted">Les 100 derniers événements, réservés à la modération. Les décisions, changements d’état et notifications sont enregistrés dans une même transaction.</p>
      {audit.loading ? <Loading /> : audit.error ? <ErrorState message={audit.error} /> : audit.data?.events.length ?
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Date</th><th>Acteur</th><th>Action</th><th>Élément</th><th>Détail</th></tr></thead><tbody>
          {audit.data.events.map((event) => <tr key={event.id}>
            <td>{date(event.created_at)}</td><td>{event.actor_name ?? 'Système'}</td><td>{auditActions[event.action] ?? event.action}</td>
            <td>{event.target_type === 'report' ? 'Dossier' : targetLabels[event.target_type as TargetType] ?? event.target_type}<br /><code>{event.target_id}</code></td>
            <td>{event.detail ? <details><summary>Lire le détail</summary><p className="pre-wrap">{event.detail}</p></details> : '—'}</td>
          </tr>)}
        </tbody></table></div> : <EmptyState title="Aucun événement enregistré" />}
    </section>}
  </div>;
}

export default function TrustPage() {
  const { user, loading, error } = useAuth();
  return <div className="stack">
    <PageHeader eyebrow="Confiance & transparence" title="Un espace pour collaborer sereinement" description="Signaler un problème, suivre son traitement et comprendre les règles de modération." />
    <Policies />
    {loading ? <Loading /> : error ? <ErrorState message={error} /> : user ? <TrustWorkspace key={`${user.id}:${user.role}`} admin={user.role === 'admin'} /> : <LoginNotice />}
  </div>;
}
