import { Link } from 'react-router-dom';
import { Badge, ErrorState, Loading, useApi } from './ui';

export interface RatingEvidence {
  average: number | null;
  count: number;
}

interface ReviewAggregate extends RatingEvidence {
  without_criteria_count: number;
  criteria: { communication: RatingEvidence; quality: RatingEvidence };
}

export interface ReputationSummary extends ReviewAggregate {
  distribution: { rating: number; count: number }[];
  roles: { tester: ReviewAggregate; owner: ReviewAggregate };
  paid_missions: { tester: number; owner: number; total: number };
  milestones: { id: string; label: string; threshold: number; count: number; earned: boolean }[];
  payment_mode: 'demo';
}

export function evidenceLabel(evidence: RatingEvidence) {
  return evidence.average === null || evidence.count === 0
    ? 'Non renseigné · 0 avis'
    : `${evidence.average.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}/5 · ${evidence.count} avis`;
}

export function ReputationDetails({ summary, compact = false }: { summary: ReputationSummary; compact?: boolean }) {
  return <div className="stack">
    <div>
      <h3>Appréciations subjectives</h3>
      <p className="small">Communication : {evidenceLabel(summary.criteria.communication)}</p>
      <p className="small">Qualité de la contribution : {evidenceLabel(summary.criteria.quality)}</p>
      <p className="help-text">Critères facultatifs : chaque moyenne utilise uniquement les notes renseignées. {summary.without_criteria_count} avis sans ces critères (anciens avis inclus), jamais remplacés par zéro.</p>
    </div>
    <div className={compact ? 'stack' : 'two-column'}>
      {(['tester', 'owner'] as const).map((role) => <section className={compact ? 'stack gap-sm' : 'card card-body stack gap-sm'} key={role} aria-label={`Réputation comme ${role === 'tester' ? 'testeur' : 'créateur'}`}>
        <h3>{role === 'tester' ? 'Comme testeur ou testeuse' : 'Comme créateur ou créatrice'}</h3>
        <p><strong>{summary.paid_missions[role]}</strong> mission{summary.paid_missions[role] > 1 ? 's' : ''} payée{summary.paid_missions[role] > 1 ? 's' : ''} en démo</p>
        <p className="small">Collaboration : {evidenceLabel(summary.roles[role])}</p>
        <p className="small muted">Communication : {evidenceLabel(summary.roles[role].criteria.communication)}<br />Contribution : {evidenceLabel(summary.roles[role].criteria.quality)}</p>
      </section>)}
    </div>
    <div className="stack gap-sm">
      <h3>Jalons factuels</h3>
      {summary.milestones.map((milestone) => <div key={milestone.id}>
        <Badge tone={milestone.earned ? 'green' : 'neutral'}>{milestone.earned ? 'Atteint' : 'Non atteint'} · {milestone.label}</Badge>
        <p className="help-text">Seuil : {milestone.threshold} mission{milestone.threshold > 1 ? 's' : ''} payée{milestone.threshold > 1 ? 's' : ''} en démo · constaté : {milestone.count}.</p>
      </div>)}
    </div>
  </div>;
}

export default function ReputationHighlights({ userId }: { userId: string }) {
  const { data, loading, error, reload } = useApi<{ summary: ReputationSummary }>(`/reputation/summary?user=${encodeURIComponent(userId)}`);
  return <section className="card" aria-label="Réputation vérifiée">
    <div className="card-header"><h2>Collaborations vérifiées</h2></div>
    <div className="card-body stack">
      {loading ? <Loading /> : error ? <>
        <ErrorState message={error} />
        <button type="button" className="button button-secondary button-small" onClick={reload}>Réessayer la réputation</button>
      </> : data && <>
        <p><strong>{data.summary.paid_missions.total}</strong> missions payées en démo · collaboration : {evidenceLabel(data.summary)}</p>
        <ReputationDetails summary={data.summary} compact />
      </>}
      <p className="help-text">« Vérifiée » confirme la participation à une mission payée en démonstration, sans argent réel ; pas la véracité des opinions. Les totaux incluent les missions privées sans en révéler les détails. Aucun score de fiabilité ni mesure de ponctualité.</p>
      <Link to={`/reputation?user=${encodeURIComponent(userId)}`}>Voir les avis et l’historique public</Link>
    </div>
  </section>;
}
