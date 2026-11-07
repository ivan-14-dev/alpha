import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import { ErrorState } from './ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Props { targetType: 'project' | 'campaign' | 'listing'; targetId: string; initialSaved?: boolean; onChange?: () => void }

function BookmarkControl({ targetType, targetId, initialSaved, onChange }: Props) {
  const { user, loading } = useAuth();
  const [saved, setSaved] = useState<boolean | null>(initialSaved ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const path = `/discovery/bookmarks/${targetType}/${encodeURIComponent(targetId)}`;
  useEffect(() => {
    if (!user) return;
    if (initialSaved !== undefined && revision === 0) { setSaved(initialSaved); return; }
    let active = true;
    setSaved(null); setError('');
    api<{ saved: boolean }>(path).then((result) => { if (active) setSaved(result.saved); })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [path, user?.id, revision, initialSaved]);
  async function toggle() {
    if (pending || saved === null) return;
    setPending(true); setError('');
    try {
      const result = await api<{ saved: boolean }>(path, { method: saved ? 'DELETE' : 'POST' });
      setSaved(result.saved); onChange?.();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  if (!user && !loading) return <Link className="button button-secondary button-small" to="/login"><Bookmark size={16} /> Se connecter pour enregistrer</Link>;
  return <div className="stack gap-sm">
    <button className="button button-secondary button-small" type="button" aria-pressed={saved ?? false}
      disabled={loading || pending || saved === null} onClick={() => void toggle()}>
      {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
      {pending ? 'Enregistrement…' : saved === null ? 'Favori…' : saved ? 'Retirer des favoris' : 'Enregistrer'}
    </button>
    <ErrorState message={error} />
    {error && <button className="button button-ghost button-small" type="button" disabled={pending} onClick={() => setRevision((value) => value + 1)}>Réessayer le favori</button>}
  </div>;
}

export default function BookmarkButton(props: Props) {
  const { user } = useAuth();
  return <BookmarkControl key={`${user?.id ?? 'guest'}:${props.targetType}:${props.targetId}`} {...props} />;
}
