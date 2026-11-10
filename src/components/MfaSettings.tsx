import { useState, type FormEvent } from 'react';
import { Copy, Download, KeyRound, RefreshCw, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { api, ApiError, dateTime, errorMessage } from '../lib/api';
import { Badge, ErrorState } from './ui';
import '../styles/accounts.css';

export interface MfaStatus {
  enabled: boolean;
  enabled_at: string | null;
  pending_setup: boolean;
  recovery_codes_remaining: number;
}
interface SetupData { secret: string; otpauth_url: string; qr_code: string; issuer: string; account: string }
type View = 'idle' | 'confirm' | 'scan' | 'codes' | 'regenerate' | 'disable';

const formatSecret = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

/** Recovery codes are shown exactly once: offers copy and a plain-text download. */
export function MfaRecoveryCodes({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  const content = [
    'Alpha — codes de récupération de la double authentification',
    `Compte : ${email}`,
    `Générés le : ${dateTime(new Date().toISOString())}`,
    '',
    ...codes,
    '',
    'Chaque code ne fonctionne qu’une seule fois. Conservez ce fichier hors de votre téléphone, en lieu sûr.',
    'Les codes précédents ne sont plus valables.',
  ].join('\n');
  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'alpha-codes-de-recuperation.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="stack acct-codes-panel">
    <div className="alert alert-success" role="status">Enregistrez ces {codes.length} codes de récupération maintenant : ils ne seront plus jamais affichés. Chacun permet une seule connexion si vous perdez votre téléphone.</div>
    <ol className="acct-codes" aria-label="Codes de récupération">{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button type="button" className="button button-secondary button-small" onClick={download}><Download size={15} /> Télécharger (.txt)</button>
      <button type="button" className="button button-secondary button-small" onClick={() => { void copyText(codes.join('\n')).then((ok) => setCopied(ok ? 'Codes copiés dans le presse-papiers.' : 'Copie impossible : sélectionnez les codes manuellement.')); }}><Copy size={15} /> Copier</button>
      {copied && <span className="muted small" role="status">{copied}</span>}
    </div>
    <label className="acct-checkbox"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /><span>J’ai conservé ces codes en lieu sûr.</span></label>
    <div><button type="button" className="button button-primary" disabled={!saved} onClick={onDone}>Terminer</button></div>
  </div>;
}

export default function MfaSettings({ status, email, hasPassword, policyLocked, onChanged, onUnauthorized }: {
  status: MfaStatus;
  email: string;
  hasPassword: boolean;
  /** The admin MFA policy forbids disabling MFA for this account. */
  policyLocked: boolean;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [view, setView] = useState<View>('idle');
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function reset(next: View = 'idle') {
    setView(next); setPassword(''); setCode(''); setError('');
    if (next === 'idle') setSetup(null);
  }

  async function run<T>(action: () => Promise<T>, after: (result: T) => void) {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try { after(await action()); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
      setError(errorMessage(failure));
      setCode('');
    } finally { setPending(false); }
  }

  const post = <T,>(path: string, body: unknown) => () => api<T>(path, { method: 'POST', body: JSON.stringify(body) });

  function startSetup(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    void run(post<SetupData>('/auth/mfa/setup', hasPassword ? { password } : {}), (data) => {
      setSetup(data); setPassword(''); setCode(''); setView('scan');
    });
  }

  function enable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(post<{ recovery_codes: string[] }>('/auth/mfa/enable', { code: code.trim() }), (result) => {
      setCodes(result.recovery_codes); setSetup(null); setCode(''); setView('codes');
    });
  }

  function regenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(post<{ recovery_codes: string[] }>('/auth/mfa/recovery-codes', { code: code.trim() }), (result) => {
      setCodes(result.recovery_codes); setCode(''); setView('codes');
    });
  }

  function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(post('/auth/mfa/disable', hasPassword ? { password, code: code.trim() } : { code: code.trim() }), () => {
      reset(); setNotice('La double authentification est désactivée.'); onChanged();
    });
  }

  const codeField = (label: string, allowRecovery: boolean) => <label className="field" htmlFor="mfa-code">{label}
    <input id="mfa-code" className="acct-code-input" autoCapitalize="none" inputMode={allowRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" spellCheck={false}
      minLength={6} maxLength={allowRecovery ? 32 : 6} pattern={allowRecovery ? undefined : '[0-9]{6}'} required value={code}
      placeholder={allowRecovery ? '123456 ou xxxx-xxxx-xxxx-xxxx' : '123456'}
      onChange={(event) => setCode(allowRecovery ? event.target.value : event.target.value.replace(/\D/g, '').slice(0, 6))} />
  </label>;

  return <section className="card card-body stack" aria-labelledby="mfa-title" aria-busy={pending}>
    <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
      <h3 id="mfa-title" className="acct-title-icon"><Smartphone size={18} aria-hidden="true" /> Double authentification (TOTP)</h3>
      {status.enabled || view === 'codes' ? <Badge tone="success">Activée</Badge> : <Badge tone="warning">Désactivée</Badge>}
    </div>
    <ErrorState message={error} />
    {notice && <div className="alert alert-success" role="status">{notice}</div>}

    {view === 'codes' ? <MfaRecoveryCodes codes={codes} email={email} onDone={() => { setCodes([]); reset(); onChanged(); }} />

      : !status.enabled && view === 'scan' && setup ? <div className="stack">
        <ol className="acct-steps">
          <li>Installez une application d’authentification (Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden…).</li>
          <li>Scannez ce QR code, ou saisissez la clé manuellement.</li>
          <li>Entrez le code à 6 chiffres affiché pour confirmer.</li>
        </ol>
        <div className="acct-mfa-setup">
          <img className="acct-qr" src={setup.qr_code} width={220} height={220} alt="QR code à scanner avec votre application d’authentification" />
          <div className="stack" style={{ minWidth: 0 }}>
            <span className="muted small">Clé de configuration manuelle ({setup.issuer} · {setup.account}) — type « basée sur le temps », 6 chiffres, 30 secondes :</span>
            <code className="acct-secret" aria-label="Clé secrète">{formatSecret(setup.secret)}</code>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="button button-secondary button-small" onClick={() => { void copyText(setup.secret).then((ok) => setNotice(ok ? 'Clé copiée.' : 'Copie impossible : recopiez la clé manuellement.')); }}><Copy size={15} /> Copier la clé</button>
              <a className="button button-ghost button-small" href={setup.otpauth_url}>Ouvrir dans l’application</a>
            </div>
            <p className="help-text">Ne partagez jamais cette clé ni ce QR code : ils permettent de générer vos codes.</p>
          </div>
        </div>
        <form className="stack" onSubmit={enable}>
          {codeField('Code affiché par l’application', false)}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="button button-primary" disabled={pending || code.length !== 6}><ShieldCheck size={16} /> {pending ? 'Vérification…' : 'Activer'}</button>
            <button type="button" className="button button-secondary" disabled={pending} onClick={() => reset()}>Annuler</button>
          </div>
        </form>
      </div>

      : !status.enabled ? <div className="stack">
        <p className="muted small">Ajoutez un code temporaire généré par votre téléphone à chaque connexion : même si votre mot de passe fuite, votre compte reste protégé. Elle s’applique aussi aux connexions via GitHub ou Google.</p>
        {status.pending_setup && view === 'idle' && <p className="muted small">Une configuration a été commencée sans être terminée : recommencez pour obtenir une nouvelle clé.</p>}
        {view === 'confirm' && hasPassword ? <form className="stack" onSubmit={startSetup}>
          <label className="field" htmlFor="mfa-password">Confirmez votre mot de passe<input id="mfa-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="button button-primary" disabled={pending || !password}>{pending ? 'Préparation…' : 'Continuer'}</button>
            <button type="button" className="button button-secondary" disabled={pending} onClick={() => reset()}>Annuler</button>
          </div>
        </form> : <div><button type="button" className="button button-primary" disabled={pending} onClick={() => { setNotice(''); if (hasPassword) { reset('confirm'); } else { startSetup(); } }}><ShieldCheck size={16} /> {pending ? 'Préparation…' : 'Activer la double authentification'}</button></div>}
      </div>

      : <div className="stack">
        <p className="muted small">Activée{status.enabled_at ? <> le <time dateTime={status.enabled_at}>{dateTime(status.enabled_at)}</time></> : ''}. Un code de votre application est demandé à chaque connexion.</p>
        <p className={`small ${status.recovery_codes_remaining < 3 ? 'acct-warning' : 'muted'}`}>
          {status.recovery_codes_remaining < 3 && <ShieldAlert size={14} aria-hidden="true" />} Codes de récupération restants : <strong>{status.recovery_codes_remaining}</strong> sur 10.
          {status.recovery_codes_remaining < 3 && ' Générez-en de nouveaux dès maintenant.'}
        </p>
        {view === 'regenerate' ? <form className="stack" onSubmit={regenerate}>
          <p className="muted small">Les anciens codes cesseront immédiatement de fonctionner.</p>
          {codeField('Code actuel de votre application', false)}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="button button-primary" disabled={pending || code.length !== 6}><RefreshCw size={15} /> {pending ? 'Génération…' : 'Générer de nouveaux codes'}</button>
            <button type="button" className="button button-secondary" disabled={pending} onClick={() => reset()}>Annuler</button>
          </div>
        </form> : view === 'disable' ? <form className="stack" onSubmit={disable}>
          <p className="muted small">Votre compte ne sera plus protégé que par votre mot de passe ou vos comptes associés. Un e-mail de confirmation vous sera envoyé.</p>
          {hasPassword && <label className="field" htmlFor="mfa-disable-password">Mot de passe actuel<input id="mfa-disable-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
          {codeField('Code de l’application ou code de récupération', true)}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="button button-danger" disabled={pending || code.trim().length < 6 || (hasPassword && !password)}>{pending ? 'Désactivation…' : 'Désactiver'}</button>
            <button type="button" className="button button-secondary" disabled={pending} onClick={() => reset()}>Annuler</button>
          </div>
        </form> : <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => { setNotice(''); reset('regenerate'); }}><KeyRound size={15} /> Nouveaux codes de récupération</button>
          {policyLocked
            ? <span className="muted small">La politique de sécurité impose la double authentification aux administrateurs.</span>
            : <button type="button" className="button button-ghost button-small" disabled={pending} onClick={() => { setNotice(''); reset('disable'); }}>Désactiver</button>}
        </div>}
      </div>}
  </section>;
}
