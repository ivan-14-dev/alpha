import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ExternalLink, Figma, Github, Gitlab, Link2, Save, Trash2 } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, LoginNotice, PageHeader, useApi } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

type Provider = 'github' | 'gitlab' | 'linear' | 'figma';
interface Project { id: string; title: string }
interface Integration { id: string; project_id: string; provider: Provider; url: string; created_at: string }
const providers = [
  { id: 'github', name: 'GitHub', hosts: ['github.com'], example: 'https://github.com/collectif/projet', Icon: Github },
  { id: 'gitlab', name: 'GitLab', hosts: ['gitlab.com'], example: 'https://gitlab.com/collectif/projet', Icon: Gitlab },
  { id: 'linear', name: 'Linear', hosts: ['linear.app'], example: 'https://linear.app/equipe', Icon: Link2 },
  { id: 'figma', name: 'Figma', hosts: ['figma.com', 'www.figma.com'], example: 'https://www.figma.com/design/…', Icon: Figma },
] satisfies { id: Provider; name: string; hosts: string[]; example: string; Icon: typeof Github }[];

function safeProviderUrl(provider: (typeof providers)[number], value: string): string | null {
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]?.toLowerCase();
    if (value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)
      || url.protocol !== 'https:' || url.username || url.password || url.port
      || !provider.hosts.includes(url.hostname)
      || !provider.hosts.some((host) => authority === host || authority === `${host}:443`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function IntegrationCard({ project, provider, initial }: {
  project: Project;
  provider: (typeof providers)[number];
  initial?: Integration;
}) {
  const [saved, setSaved] = useState(initial);
  const [url, setUrl] = useState(initial?.url ?? '');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const safeLink = saved ? safeProviderUrl(provider, saved.url) : null;
  const { Icon } = provider;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(''); setMessage('');
    const validated = safeProviderUrl(provider, url.trim());
    if (!validated) {
      setError(`Saisissez une URL HTTPS sans identifiants sur ${provider.hosts.join(' ou ')}.`);
      return;
    }
    setPending('save');
    try {
      const result = await api<{ integration: Integration }>('/integrations', {
        method: 'POST',
        body: JSON.stringify({ project_id: project.id, provider: provider.id, url: validated }),
      });
      setSaved(result.integration);
      setUrl(result.integration.url);
      setMessage('Lien enregistré. Aucune synchronisation n’est effectuée.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!saved || pending) return;
    setPending('delete'); setError(''); setMessage('');
    try {
      await api<{ deleted: boolean }>(`/integrations/${encodeURIComponent(saved.id)}`, { method: 'DELETE' });
      setSaved(undefined);
      setUrl('');
      setMessage('Lien supprimé de ce projet.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  return <article className="card">
    <div className="card-header">
      <div className="row gap-sm"><Icon size={24} aria-hidden="true" /><h3>{provider.name}</h3></div>
      <Badge tone={saved ? 'green' : 'neutral'}>{saved ? 'Lien enregistré' : 'Non configuré'}</Badge>
    </div>
    <div className="card-body stack">
      <p className="muted small">Enregistrez un raccourci vers votre espace {provider.name}, sans connexion à votre compte externe.</p>
      {saved && <div className="stack">
        <p className="small" style={{ overflowWrap: 'anywhere' }}>{saved.url}</p>
        {safeLink
          ? <a className="button button-secondary button-small" href={safeLink} target="_blank" rel="noreferrer">Ouvrir le lien <ExternalLink size={15} aria-hidden="true" /></a>
          : <ErrorState message="Ce lien enregistré n’est pas sûr. Remplacez-le ou supprimez-le." />}
      </div>}
      <form className="form" onSubmit={save} aria-busy={pending !== null}>
        <div className="field">
          <label htmlFor={`integration-${provider.id}`}>Lien {provider.name}</label>
          <input id={`integration-${provider.id}`} type="url" required maxLength={2000}
            value={url} onChange={(event) => setUrl(event.target.value)} disabled={pending !== null}
            placeholder={provider.example} aria-describedby={`integration-help-${provider.id}`} />
          <p id={`integration-help-${provider.id}`} className="help-text">HTTPS uniquement · {provider.hosts.join(' ou ')}. Ne saisissez aucun jeton ni secret dans l’URL.</p>
        </div>
        <ErrorState message={error} />
        {message && <p className="small text-success" role="status">{message}</p>}
        <div className="row gap-sm">
          <button className="button button-primary button-small" type="submit" disabled={pending !== null}>
            <Save size={16} aria-hidden="true" />{pending === 'save' ? 'Enregistrement…' : saved ? 'Mettre à jour le lien' : 'Enregistrer le lien'}
          </button>
          {saved && <button className="button button-danger button-small" type="button" onClick={() => void remove()} disabled={pending !== null}>
            <Trash2 size={16} aria-hidden="true" />{pending === 'delete' ? 'Suppression…' : 'Supprimer'}
          </button>}
        </div>
      </form>
    </div>
  </article>;
}

function ProjectIntegrations({ projectId }: { projectId: string }) {
  const links = useApi<{ project: Project; integrations: Integration[] }>(`/integrations?project_id=${encodeURIComponent(projectId)}`);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportMessage, setExportMessage] = useState('');

  async function download() {
    if (exporting) return;
    setExporting(true); setExportError(''); setExportMessage('');
    try {
      const data = await api<unknown>(`/integrations/export?project_id=${encodeURIComponent(projectId)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'projet';
      anchor.href = url;
      anchor.download = `alpha-export-${safeId}-${new Date().toISOString().slice(0, 10)}.json`;
      try {
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setExportMessage('Export JSON préparé. Le téléchargement a été lancé.');
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  if (links.loading) return <Loading />;
  if (links.error) return <div className="stack"><ErrorState message={links.error} /><button className="button button-secondary" type="button" onClick={links.reload}>Réessayer</button></div>;
  if (!links.data) return <ErrorState message="Les liens du projet n’ont pas pu être chargés." />;
  const { project, integrations } = links.data;

  return <div className="stack">
    <h2 className="section-heading">Outils de « {project.title} »</h2>
    <section aria-label="Liens des outils" className="card-grid">
      {providers.map((provider) => <IntegrationCard key={provider.id} project={project} provider={provider}
        initial={integrations.find((link) => link.provider === provider.id)} />)}
    </section>
    <section className="card card-body stack" aria-labelledby="export-heading">
      <h2 id="export-heading">Exporter les rapports</h2>
      <p className="muted">Téléchargez les campagnes, missions et rapports de « {project.title} » au format JSON. Les comptes, mots de passe et adresses e-mail des utilisateurs ne sont pas inclus. Aucun fichier n’est envoyé à un service externe.</p>
      <p className="help-text">Les récompenses éventuelles sont exprimées en centimes et restent en mode démonstration. Un export est limité à 10 000 éléments par catégorie ; au-delà, aucun fichier partiel n’est généré.</p>
      <ErrorState message={exportError} />
      {exportMessage && <p className="text-success small" role="status">{exportMessage}</p>}
      <div><button className="button button-secondary" type="button" disabled={exporting} onClick={() => void download()} aria-busy={exporting}>
        <Download size={17} aria-hidden="true" />{exporting ? 'Préparation de l’export…' : 'Télécharger l’export JSON'}
      </button></div>
    </section>
  </div>;
}

function ManagedIntegrations() {
  const [offset, setOffset] = useState(0);
  const projects = useApi<{ projects: Project[]; has_more: boolean }>(`/integrations/projects?offset=${offset}`);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('project') ?? projects.data?.projects[0]?.id ?? '';
  const selectedInList = projects.data?.projects.some((project) => project.id === selectedId);

  if (projects.loading) return <Loading />;
  if (projects.error) return <div className="stack"><ErrorState message={projects.error} /><button className="button button-secondary" type="button" onClick={projects.reload}>Réessayer</button></div>;
  if (!projects.data) return <ErrorState message="Les projets n’ont pas pu être chargés." />;
  if (!projects.data.projects.length && !selectedId && offset === 0) return <EmptyState title="Aucun projet à gérer" description="Les intégrations et les exports sont réservés aux responsables de projet et aux responsables de leur organisation." />;

  return <div className="stack">
    <div className="card card-body field">
      <label htmlFor="integrations-project">Projet à configurer</label>
      <select id="integrations-project" value={selectedId} onChange={(event) => {
        const next = new URLSearchParams(searchParams);
        next.set('project', event.target.value);
        setSearchParams(next);
      }}>
        <option value="" disabled>Choisir un projet</option>
        {selectedId && !selectedInList && <option value={selectedId}>Projet sélectionné via son lien</option>}
        {projects.data.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <p className="help-text">Seuls les projets que vous êtes autorisé à gérer sont proposés.</p>
      {(offset > 0 || projects.data.has_more) && <div className="row gap-sm">
        <button className="button button-secondary button-small" type="button" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 200))}>Projets précédents</button>
        <button className="button button-secondary button-small" type="button" disabled={!projects.data.has_more} onClick={() => setOffset((value) => value + 200)}>Projets suivants</button>
      </div>}
    </div>
    {selectedId
      ? <ProjectIntegrations key={selectedId} projectId={selectedId} />
      : <EmptyState title="Aucun projet sur cette page" description="Revenez à la page précédente pour choisir un projet." />}
  </div>;
}

export default function IntegrationsPage() {
  const auth = useAuth();
  return <div className="stack">
    <PageHeader eyebrow="Votre espace de travail" title="Intégrations"
      description="Centralisez les liens de vos outils et exportez les rapports de vos projets." />
    {auth.loading ? <Loading /> : auth.error ? <ErrorState message={auth.error} /> : !auth.user ? <LoginNotice /> : <ManagedIntegrations key={auth.user.id} />}
    <section className="card card-body stack" aria-labelledby="integrations-roadmap">
      <h2 id="integrations-roadmap">Des liens aujourd’hui, des connexions à venir</h2>
      <p className="muted">Cette page enregistre uniquement des liens. Elle ne se connecte pas à GitHub, GitLab, Linear ou Figma, ne synchronise aucune donnée et ne crée aucun ticket.</p>
      <p className="muted">Les connexions OAuth et les webhooks sont prévus pour une prochaine version et ne sont pas disponibles actuellement. Aucun jeton ni secret n’est demandé.</p>
    </section>
  </div>;
}
