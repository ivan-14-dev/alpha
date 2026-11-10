import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Boxes, Check, ClipboardCheck, Clock, FlaskConical, LockKeyhole, Plus, Search, ShieldAlert, Users, Wallet } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, date, errorMessage, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import BookmarkButton from '../components/BookmarkButton';
import CheckoutDialog from '../components/CheckoutDialog';
import FileAttachments from '../components/FileAttachments';
import { modeLabels, PaymentModeBanner, usePaymentMode, type PaymentMode } from '../components/CheckoutStatus';

interface Campaign {
  id: string; project_id: string; owner_id: string; title: string; description: string;
  kind: string; reward_cents: number; slots: number; requirements: string; target_devices: string;
  deadline: string; status: string; created_at: string; project_title: string;
  project_visibility: string; owner_name: string; assigned_count: number; payment_mode?: PaymentMode;
}
interface TestReport {
  id: string; summary: string; steps: string; expected: string; observed: string;
  evidence_url: string; updated_at: string;
}
interface Mission {
  id: string; campaign_id: string; tester_id: string; status: string; decision_note: string;
  owner_id: string; campaign_title: string; project_id: string; project_title: string;
  reward_cents: number; tester_name: string; tester_color: string; deadline: string;
  owner_name: string; report: TestReport | null; payment_mode?: PaymentMode;
}
interface Application {
  id: string; tester_id: string; status: string; motivation: string; created_at: string;
  tester_name: string; tester_title: string; tester_color: string;
}
interface Balance { funded_cents: number; paid_cents: number; reserved_cents: number; available_cents: number; refunded_cents?: number; currency?: string }
interface CampaignDetail {
  campaign: Campaign; application: { id: string; status: string; created_at: string } | null;
  missions: Mission[]; applications?: Application[]; balance?: Balance;
}
interface ManagedProject { id: string; title: string }
const kindLabels: Record<string, string> = {
  usability: 'Expérience utilisateur', functional: 'Tests fonctionnels',
  accessibility: 'Accessibilité', performance: 'Performance',
};
const statusLabels: Record<string, string> = {
  assigned: 'À commencer', in_progress: 'En cours', submitted: 'Rapport à valider',
  changes_requested: 'Corrections demandées', accepted: 'Validée · versement à effectuer',
  disputed: 'Litige en cours', paid: 'Versement démo effectué', cancelled: 'Annulée',
  pending: 'En attente', rejected: 'Non retenue',
};
const isOpen = (campaign: Campaign) => campaign.status === 'open' && Date.parse(campaign.deadline) > Date.now();
const openSlots = (campaign: Campaign) => Math.max(0, campaign.slots - campaign.assigned_count);
const post = (path: string, body?: unknown) => api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
const isReal = (mode?: PaymentMode) => !!mode && mode !== 'demo';

function StatusBadge({ status, application = false }: { status: string; application?: boolean }) {
  const tone = ['accepted', 'paid'].includes(status) ? 'green' : ['disputed', 'changes_requested'].includes(status) ? 'orange' : ['in_progress', 'submitted'].includes(status) ? 'blue' : 'neutral';
  return <Badge tone={tone}>{application && status === 'accepted' ? 'Retenue' : statusLabels[status] ?? status}</Badge>;
}

export default function TestingPage() {
  const { id } = useParams();
  const { user, loading, error } = useAuth();
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  return id ? <CampaignPage key={`${id}:${user?.id ?? 'guest'}`} campaignId={id} />
    : <CampaignsPage key={user?.id ?? 'guest'} />;
}

function CampaignsPage() {
  const { user } = useAuth();
  const platformMode = usePaymentMode();
  const [params] = useSearchParams();
  const projectId = params.get('project') ?? '';
  const navigate = useNavigate();
  const collection = useApi<{ campaigns: Campaign[]; managed_projects: ManagedProject[] }>(
    `/testing/campaigns${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`);
  const work = useApi<{ missions: Mission[] }>(user ? '/testing/missions' : null);
  const [tab, setTab] = useState('discover');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [owned, setOwned] = useState(false);
  const [creating, setCreating] = useState(false);
  const campaigns = (collection.data?.campaigns ?? []).filter((campaign) =>
    (!kind || campaign.kind === kind) && (!owned || campaign.owner_id === user?.id)
    && `${campaign.title} ${campaign.project_title} ${campaign.description}`.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr')));
  const missions = (work.data?.missions ?? []).filter((mission) => (!projectId || mission.project_id === projectId));
  return <div className="stack">
    <PageHeader eyebrow="Le laboratoire Alpha" title="Missions de test"
      description="Faites progresser un projet, partagez un retour utile et valorisez votre expertise."
      action={user ? <button type="button" className="button button-primary" disabled={collection.loading || !collection.data}
        onClick={() => setCreating(true)}><Plus size={18} /> Créer une campagne</button> : <Link className="button button-primary" to="/login">Rejoindre les testeurs <ArrowUpRight size={18} /></Link>} />
    <PaymentModeBanner mode={platformMode} />
    {projectId && <div className="row-between"><span className="muted">Campagnes et missions du projet sélectionné</span><Link to="/missions" className="button button-ghost button-small">Voir tous les projets</Link></div>}
    <div className="tabs" aria-label="Vue des missions">
      <button type="button" className={`tab ${tab === 'discover' ? 'active' : ''}`} aria-pressed={tab === 'discover'} onClick={() => setTab('discover')}><FlaskConical size={17} /> Découvrir les campagnes</button>
      <button type="button" className={`tab ${tab === 'work' ? 'active' : ''}`} aria-pressed={tab === 'work'} onClick={() => setTab('work')}><ClipboardCheck size={17} /> Mes missions</button>
    </div>
    {tab === 'discover' ? <>
      <div className="filters">
        <label className="field"><span>Rechercher une campagne</span><div className="search-input"><Search size={18} /><input type="search" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Projet, titre, objectif…" /></div></label>
        <label className="field"><span>Type de test</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Tous les types</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {user && <label className="row gap-sm"><input type="checkbox" checked={owned} onChange={(event) => setOwned(event.target.checked)} /> Mes campagnes uniquement</label>}
      </div>
      {collection.loading ? <Loading /> : collection.error ? <div className="stack"><ErrorState message={collection.error} /><button type="button" className="button button-secondary" onClick={collection.reload}>Réessayer</button></div>
        : campaigns.length ? <>
          <div className="row-between"><h2 className="section-heading">{campaigns.length} campagne{campaigns.length > 1 ? 's' : ''}</h2><span className="small muted">Jusqu’à 100 campagnes récentes</span></div>
          <div className="card-grid">{campaigns.map((campaign) => <CampaignCard key={campaign.id} campaign={campaign} />)}</div>
        </> : <EmptyState title="Aucune campagne à afficher" description={query || kind || owned ? 'Modifiez vos filtres pour découvrir d’autres campagnes.' : 'Les prochaines campagnes de test apparaîtront ici. Vous gérez un projet ? Lancez la première.'} />}
    </> : !user ? <LoginNotice /> : work.loading ? <Loading /> : work.error ? <div className="stack"><ErrorState message={work.error} /><button type="button" className="button button-secondary" onClick={work.reload}>Réessayer</button></div>
      : missions.length ? <div className="stack"><p className="muted">Vos tests assignés et les rapports des campagnes dont vous êtes responsable. Jusqu’à 100 missions récentes.</p>{missions.map((mission) => <MissionCard key={mission.id} mission={mission} onChanged={() => { work.reload(); collection.reload(); }} showCampaign />)}</div>
        : <EmptyState title="Votre prochaine mission vous attend" description="Postulez à une campagne. Les missions sélectionnées et celles que vous gérez apparaîtront ici." action={<button type="button" className="button button-primary" onClick={() => setTab('discover')}>Explorer les campagnes</button>} />}
    {creating && collection.data && <CreateCampaign projects={collection.data.managed_projects} projectId={projectId}
      onClose={() => setCreating(false)} onCreated={(campaignId) => { setCreating(false); navigate(`/missions/${campaignId}`); }} />}
  </div>;
}

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const open = isOpen(campaign);
  return <article className="card stack">
    <div className="card-body stack">
      <div className="row-between"><Badge tone="purple">{kindLabels[campaign.kind] ?? campaign.kind}</Badge><Badge tone={open && openSlots(campaign) ? 'green' : 'neutral'}>{!open ? 'Terminée' : openSlots(campaign) ? 'Candidatures ouvertes' : 'Complète'}</Badge></div>
      <div><p className="small muted">{campaign.project_title}{campaign.project_visibility === 'private' ? ' · Projet privé' : ''}</p><h2><Link to={`/missions/${campaign.id}`}>{campaign.title}</Link></h2></div>
      <p className="muted">{campaign.description.length > 180 ? `${campaign.description.slice(0, 180)}…` : campaign.description}</p>
      <div className="tag-list"><span className="small"><Users size={15} /> {openSlots(campaign)} / {campaign.slots} place{campaign.slots > 1 ? 's' : ''} restante{openSlots(campaign) > 1 ? 's' : ''}</span><span className="small"><Clock size={15} /> {date(campaign.deadline)}</span></div>
      <p className="small muted">Appareils : {campaign.target_devices}</p>
    </div>
    <div className="card-footer row-between"><div><strong className="price">{money(campaign.reward_cents)}</strong><span className="small muted"> / mission{isReal(campaign.payment_mode) ? '' : ' · démo'}</span></div><Link className="button button-secondary button-small" to={`/missions/${campaign.id}`}>Voir la campagne <ArrowUpRight size={16} /></Link></div>
  </article>;
}

function CreateCampaign({ projects, projectId, onClose, onCreated }: {
  projects: ManagedProject[]; projectId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const platformMode = usePaymentMode();
  const realPayments = isReal(platformMode ?? undefined);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      const { campaign } = await api<{ campaign: Campaign }>('/testing/campaigns', { method: 'POST', body: JSON.stringify({
        project_id: form.get('project_id'), title: form.get('title'), description: form.get('description'),
        kind: form.get('kind'), reward_cents: Math.round(Number(form.get('reward')) * 100), slots: Number(form.get('slots')),
        requirements: form.get('requirements'), target_devices: form.get('target_devices'),
        deadline: new Date(String(form.get('deadline'))).toISOString(),
      }) });
      onCreated(campaign.id);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  return <Modal title="Créer une campagne de test" onClose={() => { if (!pending) onClose(); }}>
    {!projects.length ? <EmptyState title="Un projet est nécessaire" description="Créez un projet ou devenez responsable d’un projet pour lancer une campagne." action={<Link className="button button-primary" to="/projects">Voir mes projets</Link>} />
      : <form className="form" onSubmit={submit}>
        <PaymentModeBanner mode={platformMode} compact />
        <p className="help-text">{realPayments ? 'La création ne finance pas la campagne. Vous la financerez ensuite par paiement sécurisé (fonds en séquestre) depuis sa page, avant de sélectionner un testeur.' : 'La création ne finance pas la campagne. Vous pourrez ensuite ajouter un budget de démonstration depuis Paiements avant de sélectionner un testeur.'}</p>
        <label className="field">Projet<select name="project_id" defaultValue={projects.some((project) => project.id === projectId) ? projectId : projects[0].id} required>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className="field">Titre de la campagne<input name="title" minLength={3} maxLength={160} placeholder="Testez le parcours d’inscription" required /></label>
        <label className="field">Objectifs et consignes<textarea name="description" rows={5} minLength={20} maxLength={10000} placeholder="Décrivez le périmètre à tester, les accès nécessaires et les retours attendus." required /></label>
        <div className="form-grid">
          <label className="field">Type de test<select name="kind">{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field">Appareils ciblés<input name="target_devices" defaultValue="Web" maxLength={300} required /></label>
          <label className="field">{realPayments ? 'Récompense par mission (€)' : 'Récompense par mission (€ de démo)'}<input name="reward" type="number" min="0.01" max="10000" step="0.01" defaultValue="25" required /></label>
          <label className="field">Nombre de places<input name="slots" type="number" min={1} max={100} step={1} defaultValue={3} required /></label>
          <label className="field full-width">Échéance (heure locale)<input name="deadline" type="datetime-local" required /><span className="help-text">Choisissez une date future ; les candidatures et sélections s’arrêtent à cette échéance.</span></label>
        </div>
        <label className="field">Profil recherché et prérequis<textarea name="requirements" rows={3} maxLength={3000} placeholder="Compétences, disponibilité, navigateur…" /></label>
        <ErrorState message={error} />
        <button type="submit" className="button button-primary" disabled={pending}>{pending ? 'Création…' : 'Créer la campagne'}</button>
      </form>}
  </Modal>;
}

function CampaignPage({ campaignId }: { campaignId: string }) {
  const { user } = useAuth();
  const detail = useApi<CampaignDetail>(`/testing/campaigns/${encodeURIComponent(campaignId)}`);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [motivation, setMotivation] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [closing, setClosing] = useState(false);
  const platformMode = usePaymentMode();
  function refreshed(message: string) { setNotice(message); detail.reload(); }
  async function close(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending('close'); setError(''); setNotice('');
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    try {
      const result = await api<{ refund: { refunded_cents: number; currency: string } | null }>(`/testing/campaigns/${encodeURIComponent(campaignId)}/close`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
      setClosing(false);
      refreshed(result.refund ? `Campagne clôturée. Le solde non utilisé (${money(result.refund.refunded_cents, result.refund.currency)}) est remboursé sur votre moyen de paiement d’origine.` : 'Campagne clôturée. Elle ne reçoit plus de candidatures.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(''); }
  }
  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending('apply'); setError(''); setNotice('');
    try {
      await post(`/testing/campaigns/${campaignId}/applications`, { motivation });
      setMotivation(''); refreshed('Votre candidature a été envoyée au responsable.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(''); }
  }
  async function decide(applicationId: string, action: 'accept' | 'reject') {
    setPending(applicationId); setError(''); setNotice('');
    try {
      await post(`/testing/applications/${applicationId}/${action}`);
      refreshed(action === 'accept' ? 'Testeur sélectionné : sa récompense de démonstration est réservée.' : 'Candidature refusée.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(''); }
  }
  if (detail.loading) return <Loading />;
  if (detail.error) return <div className="stack"><Link to="/missions" className="button button-ghost"><ArrowLeft size={16} /> Toutes les campagnes</Link><ErrorState message={detail.error} /><button type="button" className="button button-secondary" onClick={detail.reload}>Réessayer</button></div>;
  if (!detail.data) return <EmptyState title="Campagne introuvable" />;
  const { campaign, application, missions, applications, balance } = detail.data;
  const owner = user?.id === campaign.owner_id;
  const open = isOpen(campaign);
  const remaining = openSlots(campaign);
  const canSelect = open && remaining > 0 && !!balance && balance.available_cents >= campaign.reward_cents;
  const realCampaign = isReal(campaign.payment_mode);
  // Same rule as the server: real-money campaigns, or unfunded campaigns once real payments are enabled, use the secure checkout.
  const secureFunding = realCampaign ? platformMode === campaign.payment_mode : isReal(platformMode ?? undefined) && !!balance && balance.funded_cents === 0;
  const budgetCents = campaign.reward_cents * campaign.slots;
  const toFund = balance ? Math.max(0, budgetCents - (balance.funded_cents - (balance.refunded_cents ?? 0))) : 0;
  const amount = (minor: number) => money(minor, realCampaign ? balance?.currency : undefined);
  const fundButton = (label: string, small = false) => secureFunding
    ? <button type="button" className={`button button-primary${small ? ' button-small' : ''}`} disabled={!!pending || toFund <= 0} onClick={() => { setError(''); setCheckout(true); }}><LockKeyhole size={small ? 16 : 17} /> {label}</button>
    : <Link className={`button button-primary${small ? ' button-small' : ''}`} to={`/payments?campaign=${campaign.id}`}><Wallet size={small ? 16 : 17} /> {label}</Link>;
  return <div className="stack">
    <Link to={`/missions?project=${campaign.project_id}`} className="button button-ghost"><ArrowLeft size={16} /> Campagnes du projet</Link>
    <PageHeader eyebrow={campaign.project_title} title={campaign.title}
      description={`Une campagne proposée par ${campaign.owner_name}`} action={<Badge tone={open ? 'green' : 'neutral'}>{open ? remaining ? 'Candidatures ouvertes' : 'Places attribuées' : 'Campagne terminée'}</Badge>} />
    {campaign.project_visibility === 'public' && <div><BookmarkButton targetType="campaign" targetId={campaign.id} /></div>}
    <PaymentModeBanner mode={realCampaign ? campaign.payment_mode! : platformMode} />
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <ErrorState message={error} />
    <div className="detail-layout">
      <div className="detail-main stack">
        <section className="card card-body stack">
          <div className="tag-list"><Badge tone="purple">{kindLabels[campaign.kind] ?? campaign.kind}</Badge>{campaign.project_visibility === 'private' && <Badge>Projet privé</Badge>}</div>
          <h2>À vous de tester</h2><p className="pre-wrap">{campaign.description}</p>
          <div className="divider" />
          <h3>Profil recherché</h3><p className="pre-wrap">{campaign.requirements || 'Tous les profils sont les bienvenus. Décrivez votre expérience et votre disponibilité dans votre candidature.'}</p>
          <h3>Appareils ciblés</h3><p>{campaign.target_devices}</p>
          <div className="row gap-sm"><Link className="button button-secondary" to={`/projects/${campaign.project_id}`}>Découvrir le projet <ArrowUpRight size={16} /></Link>
            {(owner || application?.status === 'accepted') && campaign.status !== 'cancelled' && <Link className="button button-secondary" to={`/sandbox?campaign=${campaign.id}&new=1`}><Boxes size={16} /> Exécuter un build</Link>}</div>
        </section>
        {user && (owner || application?.status === 'accepted' || missions.length > 0) && <section className="card card-body"><FileAttachments resourceType="campaign" resourceId={campaign.id} purpose="campaign_build" canUpload={owner} title="Builds à tester" /></section>}
        {owner && applications && <section className="card card-body stack">
          <div className="row-between"><h2>Candidatures</h2><Badge>{applications.length}</Badge></div>
          <p className="help-text">Les motivations sont visibles uniquement par le responsable. Jusqu’à 200 candidatures, en attente en priorité.</p>
          {balance && balance.available_cents < campaign.reward_cents && open && remaining > 0 && <div className="alert"><p>{secureFunding ? 'Financez la campagne par paiement sécurisé avant de sélectionner un testeur : les fonds restent en séquestre jusqu’à la validation des rapports.' : 'Ajoutez un budget de démonstration avant de sélectionner un testeur.'}</p>{fundButton('Financer la campagne', true)}</div>}
          {!applications.length ? <EmptyState title="Aucune candidature pour le moment" description="Les candidatures reçues apparaîtront ici pour vous permettre de sélectionner les testeurs." />
            : <div className="list">{applications.map((candidate) => <article className="list-item stack" key={candidate.id}>
              <div className="row-between"><div className="row gap-sm"><Avatar name={candidate.tester_name} color={candidate.tester_color} /><div><Link to={`/people/${candidate.tester_id}`}><strong>{candidate.tester_name}</strong></Link><p className="small muted">{candidate.tester_title || 'Membre Alpha'} · {date(candidate.created_at)}</p></div></div><StatusBadge status={candidate.status} application /></div>
              <p className="pre-wrap">{candidate.motivation}</p>
              {candidate.status === 'pending' && <div className="row gap-sm"><button type="button" className="button button-primary button-small" disabled={!!pending || !canSelect}
                onClick={() => void decide(candidate.id, 'accept')}>{pending === candidate.id ? 'Traitement…' : 'Sélectionner'}</button><button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => void decide(candidate.id, 'reject')}>Refuser</button></div>}
            </article>)}</div>}
          {!canSelect && applications.some((candidate) => candidate.status === 'pending') && <p className="help-text">{!open ? 'La campagne est fermée ou son échéance est dépassée.' : !remaining ? 'Toutes les places sont attribuées.' : 'Le budget disponible doit couvrir la récompense de la prochaine mission.'}</p>}
        </section>}
        {!!missions.length && <section className="stack"><h2>{owner ? 'Missions et rapports' : 'Votre mission'}</h2>{missions.map((mission) => <MissionCard key={mission.id} mission={{ ...mission, payment_mode: mission.payment_mode ?? campaign.payment_mode }} onChanged={(message) => refreshed(message)} />)}</section>}
        {!owner && <section className="card card-body stack"><h2>Votre candidature</h2>
          {!user ? <LoginNotice /> : application ? <div className="stack"><div className="row gap-sm"><StatusBadge status={application.status} application /><span className="small muted">Envoyée le {date(application.created_at)}</span></div><p className="muted">{application.status === 'pending' ? 'Le responsable examine votre candidature. Vous serez notifié de sa décision.' : application.status === 'accepted' ? 'Votre mission et les actions disponibles figurent ci-dessus.' : 'Votre candidature n’a pas été retenue. Découvrez les autres campagnes.'}</p></div>
            : !open || !remaining ? <p className="muted">Cette campagne ne reçoit plus de candidatures.</p>
              : <form className="form" onSubmit={apply}><label className="field">Pourquoi souhaitez-vous tester ce projet ?<textarea value={motivation} onChange={(event) => setMotivation(event.target.value)} minLength={20} maxLength={3000} rows={5} required placeholder="Présentez votre expérience, vos appareils et votre disponibilité." /></label><p className="help-text">Votre motivation sera visible uniquement par le responsable de cette campagne.</p><button className="button button-primary" type="submit" disabled={!!pending}>{pending === 'apply' ? 'Envoi…' : 'Envoyer ma candidature'}</button></form>}
        </section>}
      </div>
      <aside className="detail-aside stack">
        <section className="card card-body stack"><span className="eyebrow">Récompense par mission</span><strong className="price">{money(campaign.reward_cents)}</strong><p className="small muted">{realCampaign || secureFunding ? 'Versée depuis le séquestre à la validation du rapport, frais de plateforme déduits.' : 'Versement de démonstration après validation du rapport. Aucun argent réel.'}</p><div className="divider" /><div className="row-between"><span>Places restantes</span><strong>{remaining} / {campaign.slots}</strong></div><div className="row-between"><span>Échéance</span><strong>{date(campaign.deadline)}</strong></div><p className="small muted">{new Date(campaign.deadline).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (heure locale)</p></section>
        {owner && balance && (realCampaign || secureFunding ? <section className="card card-body stack"><h2>Budget en séquestre</h2>{realCampaign && <Badge tone={campaign.payment_mode === 'live' ? 'green' : 'blue'}>{modeLabels[campaign.payment_mode!]}</Badge>}<div className="row-between"><span>Budget total prévu</span><strong>{amount(budgetCents)}</strong></div><div className="row-between"><span>Financé</span><strong>{amount(balance.funded_cents)}</strong></div><div className="row-between"><span>Réservé aux missions</span><strong>{amount(balance.reserved_cents)}</strong></div><div className="row-between"><span>Déjà versé</span><strong>{amount(balance.paid_cents)}</strong></div>{!!balance.refunded_cents && <div className="row-between"><span>Remboursé</span><strong>{amount(balance.refunded_cents)}</strong></div>}<div className="row-between"><span>Disponible</span><strong>{amount(balance.available_cents)}</strong></div>{campaign.status === 'open' && toFund > 0 && (secureFunding ? fundButton(`Financer ${amount(toFund)}`) : <p className="help-text">Cette campagne est financée en mode {modeLabels[campaign.payment_mode!].toLowerCase()} : le financement n’est pas disponible dans le mode actuel.</p>)}<p className="help-text">Les fonds sont conservés en séquestre. Valider un rapport verse immédiatement la récompense au testeur, frais de plateforme déduits. À la clôture, le solde non engagé vous est remboursé.</p></section>
          : <section className="card card-body stack"><h2>Budget de démonstration</h2><div className="row-between"><span>Budget total prévu</span><strong>{money(campaign.reward_cents * campaign.slots)}</strong></div><div className="row-between"><span>Financé</span><strong>{money(balance.funded_cents)}</strong></div><div className="row-between"><span>Réservé aux missions</span><strong>{money(balance.reserved_cents)}</strong></div><div className="row-between"><span>Déjà versé (démo)</span><strong>{money(balance.paid_cents)}</strong></div><div className="row-between"><span>Disponible</span><strong>{money(balance.available_cents)}</strong></div><Link className="button button-primary" to={`/payments?campaign=${campaign.id}`}><Wallet size={17} /> {balance.funded_cents ? 'Gérer le financement' : 'Financer la campagne'}</Link><p className="help-text">Aucun financement automatique. Sélectionner un testeur réserve sa récompense ; valider son rapport ne déclenche pas le versement.</p></section>)}
        {owner && campaign.status === 'open' && <section className="card card-body stack"><h3>Clôturer la campagne</h3>{closing ? <form className="form" onSubmit={(event) => void close(event)}><label className="field">Motif (facultatif)<textarea name="reason" maxLength={500} rows={3} /></label><p className="help-text">La campagne ne recevra plus de candidatures. Les missions en cours continuent{realCampaign ? ' et gardent leur récompense en séquestre ; le solde non engagé vous est remboursé automatiquement' : ''}.</p><div className="row gap-sm"><button type="submit" className="button button-danger button-small" disabled={!!pending}>{pending === 'close' ? 'Clôture…' : 'Confirmer la clôture'}</button><button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => setClosing(false)}>Annuler</button></div></form> : <><p className="small muted">Arrêtez les candidatures quand vous avez assez de testeurs{realCampaign ? ' et récupérez le budget non utilisé' : ''}.</p><button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => setClosing(true)}>Clôturer…</button></>}</section>}
        <section className="card card-body stack"><h3>Un parcours clair</h3><p className="small muted">1. Candidature et sélection<br />2. Tests et rapport détaillé<br />3. Validation ou corrections<br />4. {realCampaign || secureFunding ? 'Versement depuis le séquestre' : 'Versement de démonstration'}</p><p className="small muted">En cas de désaccord, le responsable ou le testeur peut demander l’intervention de la modération avant le versement.</p></section>
      </aside>
    </div>
    {checkout && <CheckoutDialog purpose="campaign_funding" refId={campaign.id} title={campaign.title} amountMinor={toFund} onClose={() => setCheckout(false)} />}
  </div>;
}

function MissionCard({ mission, onChanged, showCampaign = false }: {
  mission: Mission; onChanged: (message: string) => void; showCampaign?: boolean;
}) {
  const { user } = useAuth();
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [reasonAction, setReasonAction] = useState<'changes' | 'dispute' | null>(null);
  const [editing, setEditing] = useState(false);
  const owner = user?.id === mission.owner_id;
  const tester = user?.id === mission.tester_id;
  const canReport = tester && ['assigned', 'in_progress', 'changes_requested'].includes(mission.status);
  const canDispute = (owner || tester) && ['assigned', 'in_progress', 'submitted', 'changes_requested', 'accepted'].includes(mission.status);
  async function action(action: string, body?: unknown) {
    setPending(action); setError('');
    try {
      await post(action === 'pay' ? `/payments/missions/${mission.id}/pay` : `/testing/missions/${mission.id}/${action}`, body);
      setReasonAction(null); setEditing(false);
      onChanged(action === 'pay' ? (isReal(mission.payment_mode) ? 'Récompense versée au testeur depuis le séquestre.' : 'Versement de démonstration effectué. Aucun argent réel n’a été transféré.') : action === 'dispute' ? 'Litige transmis à la modération. Le versement est suspendu.' : action === 'report' ? 'Votre rapport a été transmis au responsable.' : action === 'changes' ? 'Les corrections demandées ont été transmises au testeur.' : action === 'accept' ? (isReal(mission.payment_mode) ? 'Rapport validé : la récompense a été versée au testeur depuis le séquestre, frais de plateforme déduits.' : 'Rapport validé. Vous pouvez maintenant effectuer le versement de démonstration.') : 'La mission a commencé.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(''); }
  }
  const report = mission.report;
  const real = isReal(mission.payment_mode);
  return <article className="card card-body stack">
    <div className="row-between"><div className="row gap-sm"><Avatar name={mission.tester_name} color={mission.tester_color} /><div><h3>{tester ? 'Votre mission de test' : mission.tester_name}</h3><p className="small muted">{owner ? 'Vous gérez cette mission' : `Responsable : ${mission.owner_name}`}</p></div></div>{real && mission.status === 'paid' ? <Badge tone="green">Récompense versée</Badge> : <StatusBadge status={mission.status} />}</div>
    {showCampaign && <div><Link className="section-heading" to={`/missions/${mission.campaign_id}`}>{mission.campaign_title} <ArrowUpRight size={16} /></Link><p className="small muted">{mission.project_title} · Échéance : {date(mission.deadline)}</p></div>}
    <p className="small"><strong>{money(mission.reward_cents)}</strong> {real ? `pour cette mission · paiement sécurisé (${modeLabels[mission.payment_mode!].toLowerCase()})` : 'de démonstration pour cette mission'}</p>
    {mission.decision_note && <div className="alert"><strong>{mission.status === 'disputed' ? 'Examen du litige' : 'Corrections demandées'}</strong><p className="pre-wrap">{mission.decision_note}</p></div>}
    {report && !editing && <div className="stack">
      <div className="row-between"><h3>Rapport de test</h3><span className="small muted">Mis à jour le {date(report.updated_at)}</span></div>
      <div><h4>Synthèse</h4><p className="pre-wrap">{report.summary}</p></div>
      <details><summary>Lire les étapes et les résultats</summary><div className="stack"><div><h4>Étapes de reproduction</h4><p className="pre-wrap">{report.steps}</p></div><div><h4>Résultat attendu</h4><p className="pre-wrap">{report.expected}</p></div><div><h4>Résultat observé</h4><p className="pre-wrap">{report.observed}</p></div>
        {report.evidence_url && /^https?:\/\//i.test(report.evidence_url) && <a className="button button-secondary button-small" href={report.evidence_url} target="_blank" rel="noreferrer">Ouvrir la preuve externe <ArrowUpRight size={16} /></a>}</div></details>
    </div>}
    <FileAttachments resourceType="mission" resourceId={mission.id} purpose="mission_attachment" canUpload={(tester || owner) && mission.status !== 'cancelled'} title="Pièces jointes (captures, journaux, vidéos)" />
    {mission.status === 'disputed' && <p className="muted">La mission est suspendue pendant l’examen du litige par la modération. Aucun versement ne peut être effectué.</p>}
    {mission.status === 'submitted' && tester && <p className="muted">Votre rapport attend la validation du responsable. Il ne peut être modifié que si des corrections sont demandées.</p>}
    {mission.status === 'accepted' && tester && <p className="text-success">{real ? 'Votre rapport est validé. Le versement depuis le séquestre est en cours.' : 'Votre rapport est validé. Le responsable doit maintenant déclencher le versement de démonstration.'}</p>}
    {mission.status === 'paid' && <p className="text-success">{real ? 'Mission terminée : la récompense a été versée depuis le séquestre (frais de plateforme déduits).' : 'Mission terminée : le versement de démonstration est enregistré.'}</p>}
    <div className="row gap-sm">
      {tester && mission.status === 'assigned' && <button type="button" className="button button-primary button-small" disabled={!!pending} onClick={() => void action('start')}>{pending === 'start' ? 'Démarrage…' : 'Commencer la mission'}</button>}
      {canReport && !editing && <button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => { setEditing(true); setReasonAction(null); setError(''); }}><ClipboardCheck size={16} /> {report ? 'Corriger le rapport' : 'Rédiger mon rapport'}</button>}
      {owner && mission.status === 'submitted' && <><button type="button" className="button button-primary button-small" disabled={!!pending} onClick={() => void action('accept')}><Check size={16} /> {pending === 'accept' ? 'Validation…' : 'Valider le rapport'}</button><button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => { setReasonAction('changes'); setEditing(false); setError(''); }}>Demander des corrections</button></>}
      {owner && mission.status === 'accepted' && <button type="button" className="button button-primary button-small" disabled={!!pending} onClick={() => void action('pay')}><Wallet size={16} /> {pending === 'pay' ? 'Versement…' : real ? `Verser ${money(mission.reward_cents)} depuis le séquestre` : `Verser ${money(mission.reward_cents)} (démo)`}</button>}
      {canDispute && <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => { setReasonAction('dispute'); setEditing(false); setError(''); }}><ShieldAlert size={16} /> Ouvrir un litige</button>}
    </div>
    {editing && canReport && <ReportForm report={report} pending={!!pending} onSubmit={(body) => void action('report', body)} onCancel={() => { setEditing(false); setError(''); }} />}
    {reasonAction && <form className="form" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void action(reasonAction, { reason: form.get('reason') });
    }}><h3>{reasonAction === 'changes' ? 'Préciser les corrections attendues' : 'Demander une médiation'}</h3><label className="field">{reasonAction === 'changes' ? 'Corrections demandées' : 'Motif du litige'}<textarea key={reasonAction} name="reason" minLength={10} maxLength={3000} rows={4} required /></label>{reasonAction === 'dispute' && <p className="help-text">Votre motif est transmis confidentiellement à la modération. L’autre partie sera informée de l’ouverture du litige. Le versement sera suspendu jusqu’à la décision de la modération.</p>}<div className="row gap-sm"><button className={`button ${reasonAction === 'dispute' ? 'button-danger' : 'button-primary'}`} type="submit" disabled={!!pending}>{pending ? 'Envoi…' : reasonAction === 'dispute' ? 'Confirmer le litige' : 'Envoyer les corrections'}</button><button className="button button-ghost" type="button" disabled={!!pending} onClick={() => setReasonAction(null)}>Annuler</button></div></form>}
    <ErrorState message={error} />
  </article>;
}

function ReportForm({ report, pending, onSubmit, onCancel }: {
  report: TestReport | null; pending: boolean;
  onSubmit: (body: { summary: string; steps: string; expected: string; observed: string; evidence_url: string }) => void;
  onCancel: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({
      summary: String(form.get('summary')), steps: String(form.get('steps')),
      expected: String(form.get('expected')), observed: String(form.get('observed')),
      evidence_url: String(form.get('evidence_url')),
    });
  }
  return <form className="form" onSubmit={submit}>
    <h3>{report ? 'Réviser votre rapport' : 'Partager un retour exploitable'}</h3>
    <label className="field">Synthèse<textarea name="summary" defaultValue={report?.summary ?? ''} minLength={10} maxLength={4000} rows={3} required placeholder="Résumez le test et les principaux constats." /></label>
    <label className="field">Étapes de reproduction<textarea name="steps" defaultValue={report?.steps ?? ''} minLength={10} maxLength={10000} rows={5} required placeholder="1. Ouvrir… 2. Sélectionner… Indiquez aussi l’environnement utilisé." /></label>
    <div className="form-grid"><label className="field">Résultat attendu<textarea name="expected" defaultValue={report?.expected ?? ''} minLength={5} maxLength={5000} rows={4} required /></label><label className="field">Résultat observé<textarea name="observed" defaultValue={report?.observed ?? ''} minLength={5} maxLength={5000} rows={4} required /></label></div>
    <label className="field">Lien vers une preuve (facultatif)<input name="evidence_url" type="url" pattern="https?://.*" maxLength={2000} defaultValue={report?.evidence_url ?? ''} placeholder="https://…" /><span className="help-text">Lien HTTP ou HTTPS vers une capture ou un enregistrement déjà hébergé. N’incluez pas d’informations sensibles. Vous pouvez aussi ajouter captures et journaux dans les pièces jointes de la mission.</span></label>
    <p className="help-text">Après envoi, le rapport ne peut être révisé que si le responsable demande des corrections.</p>
    <div className="row gap-sm"><button type="submit" className="button button-primary" disabled={pending}>{pending ? 'Envoi…' : report ? 'Envoyer la version corrigée' : 'Envoyer le rapport'}</button><button type="button" className="button button-ghost" disabled={pending} onClick={onCancel}>Annuler</button></div>
  </form>;
}
