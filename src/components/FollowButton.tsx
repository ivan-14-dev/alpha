import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, UserPlus } from 'lucide-react';
import { ErrorState } from './ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Props { targetType: 'user' | 'project'; targetId: string }
interface FollowStatus { following: boolean; followers: number; can_follow: boolean }

function FollowControl({ targetType, targetId }: Props) {
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<FollowStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const statusPath = `/network/status?${new URLSearchParams({ target_type: targetType, target_id: targetId })}`;
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setStatus(null);
    api<FollowStatus>(statusPath)
      .then((value) => { if (active) setStatus(value); })
      .catch((error) => { if (active) setError(errorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [statusPath, revision]);

  async function toggle() {
    if (!status || pending || !user || !status.can_follow) return;
    setPending(true); setError('');
    try {
      const path = `/network/${targetType === 'user' ? 'users' : 'projects'}/${encodeURIComponent(targetId)}/follow`;
      if (status.following) {
        await api(path, { method: 'DELETE' });
        setStatus(null);
        setStatus(await api<FollowStatus>(statusPath));
      } else setStatus(await api<FollowStatus>(path, { method: 'POST' }));
    } catch (error) {
      setError(errorMessage(error)); setStatus(null);
    } finally { setPending(false); }
  }

  const self = targetType === 'user' && user?.id === targetId;
  return <div className="stack">
    <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
      {!user && !authLoading && status ? <Link to="/login" className="button button-secondary button-small"><UserPlus size={16} /> Se connecter pour suivre</Link> : <button
        type="button" className={`button button-small ${status?.following ? 'button-secondary' : 'button-primary'}`}
        disabled={authLoading || loading || pending || !status?.can_follow}
        aria-pressed={status?.following ?? false} onClick={() => void toggle()}>
        {status?.following ? <Check size={16} /> : <UserPlus size={16} />}
        {loading || authLoading ? 'Chargement…' : pending ? 'Mise à jour…' : self ? 'Votre profil' : status?.following ? 'Ne plus suivre' : 'Suivre'}
      </button>}
      {status && <span className="small muted" aria-live="polite">{status.followers} abonné{status.followers > 1 ? 's' : ''}</span>}
    </div>
    <ErrorState message={error} />
    {error && <button type="button" className="button button-ghost button-small" disabled={pending || loading} onClick={() => setRevision((value) => value + 1)}>Réessayer</button>}
  </div>;
}

export default function FollowButton(props: Props) {
  const { user } = useAuth();
  return <FollowControl key={`${props.targetType}:${props.targetId}:${user?.id ?? 'guest'}`} {...props} />;
}
