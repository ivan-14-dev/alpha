import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, FileText, Printer, TriangleAlert } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, PageHeader, useApi } from '../components/ui';
import { api, date, dateTime, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import '../styles/privacy.css';

/** Legal documents (/legal/:doc). OWNER: privacy module. Content is a server-built AST rendered with React only (never raw HTML). */

type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };
type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; id: string; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; paragraphs: Inline[][] }
  | { type: 'rule' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] };

export interface LegalSummary {
  slug: string; title: string; version: string; required: boolean; acceptable: boolean; url: string;
  accepted_at: string | null; pending: boolean;
}
interface LegalDocumentView extends LegalSummary {
  updated: string; blocks: Block[]; toc: { id: string; level: number; text: string }[];
  missing: string[]; file_version_mismatch: boolean;
}

/** Defense in depth: the server already filters links, the client re-checks before rendering. */
function linkKind(href: string): 'internal' | 'anchor' | 'external' | 'mail' | null {
  if (/^#[a-z0-9-]{1,80}$/i.test(href)) return 'anchor';
  if (/^\/(?![/\\])[^\s<>"']*$/.test(href)) return 'internal';
  if (/^mailto:[^\s@<>"']+@[^\s@<>"']+$/i.test(href)) return 'mail';
  if (/^https:\/\/[^\s<>"']+$/i.test(href)) return 'external';
  return null;
}

function renderInline(nodes: Inline[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.type) {
      case 'text': return node.text;
      case 'code': return <code key={key}>{node.text}</code>;
      case 'strong': return <strong key={key}>{renderInline(node.children, `${key}-`)}</strong>;
      case 'em': return <em key={key}>{renderInline(node.children, `${key}-`)}</em>;
      case 'link': {
        const kind = linkKind(node.href);
        const label = renderInline(node.children, `${key}-`);
        if (kind === 'internal') return <Link key={key} to={node.href}>{label}</Link>;
        if (kind === 'external') return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">{label}</a>;
        if (kind === 'anchor' || kind === 'mail') return <a key={key} href={node.href}>{label}</a>;
        return <span key={key}>{label}</span>;
      }
      default: return null;
    }
  });
}

export function LegalBlocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((block, index) => {
    switch (block.type) {
      case 'heading': {
        if (block.level === 1) return null;
        const Tag = (`h${block.level}`) as 'h2' | 'h3' | 'h4';
        return <Tag key={index} id={block.id} tabIndex={-1}>{renderInline(block.children)}</Tag>;
      }
      case 'paragraph': return <p key={index}>{renderInline(block.children)}</p>;
      case 'list': {
        const items = block.items.map((item, position) => <li key={position}>{renderInline(item)}</li>);
        return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'quote': return <blockquote key={index} className="legal-notice">
        <TriangleAlert size={18} aria-hidden="true" />
        <div>{block.paragraphs.map((paragraph, position) => <p key={position}>{renderInline(paragraph)}</p>)}</div>
      </blockquote>;
      case 'rule': return <hr key={index} />;
      case 'table': return <div key={index} className="table-wrap legal-table"><table className="data-table">
        <thead><tr>{block.header.map((cell, position) => <th key={position} scope="col">{renderInline(cell)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, position) => <td key={position}>{renderInline(cell)}</td>)}</tr>)}</tbody>
      </table></div>;
      default: return null;
    }
  })}</>;
}

export default function LegalPage() {
  const { doc = 'terms' } = useParams();
  const { user, refresh } = useAuth();
  const { data, loading, error, reload } = useApi<{ document: LegalDocumentView }>(`/privacy/legal/${encodeURIComponent(doc)}`);
  const list = useApi<{ documents: LegalSummary[] }>(`/privacy/legal${user ? `?u=${user.id}` : ''}`);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const document = data?.document;

  useEffect(() => { setStatus(null); }, [doc]);
  useEffect(() => {
    if (!document) return;
    const previous = window.document.title;
    window.document.title = `${document.title} · Alpha`;
    return () => { window.document.title = previous; };
  }, [document]);

  async function accept() {
    if (!document || pending) return;
    setPending(true);
    setStatus(null);
    try {
      await api('/privacy/legal/accept', { method: 'POST', body: JSON.stringify({ documents: [document.slug] }) });
      setStatus({ tone: 'success', message: `Vous avez accepté « ${document.title} » (version ${document.version}).` });
      reload();
      list.reload();
      await refresh().catch(() => undefined);
    } catch (failure) {
      setStatus({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setPending(false);
    }
  }

  const documents = list.data?.documents ?? [];
  return <div className="stack legal-page">
    <PageHeader eyebrow="Informations légales" title={document?.title ?? 'Documents juridiques'}
      description={document ? `Version ${document.version}${document.updated ? ` · mise à jour le ${date(document.updated)}` : ''}` : undefined}
      action={document && <button type="button" className="button button-secondary button-small legal-print" onClick={() => window.print()}><Printer size={14} aria-hidden="true" /> Imprimer</button>} />
    <div className="legal-layout">
      <aside className="legal-aside" aria-label="Documents et sommaire">
        {documents.length > 0 && <nav className="card card-body legal-nav" aria-label="Documents juridiques">
          <h2 className="small">Documents</h2>
          <ul>{documents.map((item) => <li key={item.slug}>
            <Link to={item.url} aria-current={item.slug === doc ? 'page' : undefined} className={item.slug === doc ? 'active' : ''}>
              <FileText size={13} aria-hidden="true" /> {item.title}
            </Link>
            {item.pending && item.required && <Badge tone="orange">À accepter</Badge>}
          </li>)}</ul>
        </nav>}
        {document && document.toc.length > 0 && <nav className="card card-body legal-toc" aria-label="Sommaire">
          <h2 className="small">Sommaire</h2>
          <ol>{document.toc.map((entry) => <li key={entry.id}><a href={`#${entry.id}`}>{entry.text}</a></li>)}</ol>
        </nav>}
      </aside>
      <article className="card legal-document" aria-labelledby="legal-title">
        {loading && <div className="card-body"><Loading /></div>}
        {error && <div className="card-body"><EmptyState title="Document introuvable" description={error}
          action={<Link className="button button-secondary" to="/legal/terms">Voir les conditions générales</Link>} /></div>}
        {document && <>
          <div className="card-header">
            <div>
              <h2 id="legal-title">{document.title}</h2>
              <p className="muted small">Version {document.version}{document.updated ? ` — en vigueur depuis le ${date(document.updated)}` : ''}</p>
            </div>
            <div className="row gap-sm">
              {document.required && <Badge tone="purple">Obligatoire</Badge>}
              {!document.acceptable && <Badge>Informatif</Badge>}
            </div>
          </div>
          {user?.role === 'admin' && (document.missing.length > 0 || document.file_version_mismatch) && <div className="card-body legal-admin-note">
            <p className="alert alert-error" role="note">
              {document.missing.length > 0 && <>Informations de l’éditeur à compléter : {document.missing.join(', ')}. </>}
              {document.file_version_mismatch && <>La version du fichier modèle ne correspond pas à la version déclarée dans server/platform/legal.ts. </>}
              <Link to="/admin/privacy">Ouvrir la console RGPD</Link>
            </p>
          </div>}
          <div className="card-body prose legal-prose"><LegalBlocks blocks={document.blocks} /></div>
          {user && document.acceptable && <div className="card-footer legal-accept" aria-live="polite">
            {document.accepted_at
              ? <p className="row gap-sm legal-accepted"><CheckCircle2 size={16} aria-hidden="true" /> Accepté le {dateTime(document.accepted_at)} (version {document.version}).</p>
              : <><p className="small muted">{document.required ? 'Ce document doit être accepté pour continuer à utiliser Alpha.' : 'Acceptez ce document si vous utilisez les fonctionnalités concernées.'}</p>
                <button type="button" className="button button-primary" disabled={pending} onClick={() => { void accept(); }}>{pending ? 'Enregistrement…' : 'J’ai lu et j’accepte'}</button></>}
          </div>}
          {status && <div className="card-body">{status.tone === 'success'
            ? <p className="alert alert-success" role="status">{status.message}</p>
            : <ErrorState message={status.message} />}</div>}
        </>}
      </article>
    </div>
  </div>;
}
