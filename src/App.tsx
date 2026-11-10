import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Link, Route, Routes, useLocation } from 'react-router-dom';
import { ArrowUpRight, Bell, Beaker, Bookmark, Boxes, ChevronDown, Compass, CreditCard, ExternalLink, Gauge, Layers3, ListTodo, LogOut, Menu, MessageCircle, Network, Plug, Search, Settings, ShieldCheck, ShoppingBag, Sparkles, Star, Users, Wallet, X } from 'lucide-react';
import { useAuth } from './lib/auth';
import { Avatar, ErrorState, Loading, useApi } from './components/ui';
import RouteBoundary from './components/RouteBoundary';
import { errorMessage } from './lib/api';
import { useUnreadNotifications } from './lib/realtime';
import DashboardPage from './pages/DashboardPage';
const AuthPage = lazy(() => import('./pages/AuthPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectsPage').then((module) => ({ default: module.ProjectDetailPage })));
const TestingPage = lazy(() => import('./pages/TestingPage'));
const CommunityPage = lazy(() => import('./pages/CommunityPage'));
const MarketplacePage = lazy(() => import('./pages/MarketplacePage'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'));
const PeoplePage = lazy(() => import('./pages/PeoplePage'));
const SettingsPage = lazy(() => import('./pages/PeoplePage').then((module) => ({ default: module.SettingsPage })));
const ReputationPage = lazy(() => import('./pages/ReputationPage'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const NotificationsPage = lazy(() => import('./pages/MessagesPage').then((module) => ({ default: module.NotificationsPage })));
const TrustPage = lazy(() => import('./pages/TrustPage'));
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage'));
const NetworkPage = lazy(() => import('./pages/NetworkPage'));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
const DiscoveryPage = lazy(() => import('./pages/DiscoveryPage'));
const AccountRecoveryPage = lazy(() => import('./pages/AccountRecoveryPage'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
const WalletPage = lazy(() => import('./pages/WalletPage'));
const SandboxPage = lazy(() => import('./pages/SandboxPage'));
const LegalPage = lazy(() => import('./pages/LegalPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

const discovery = [
  { to: '/', label: 'Vue d’ensemble', icon: Compass, end: true },
  { to: '/search', label: 'Rechercher sur Alpha', icon: Search },
  { to: '/projects', label: 'Explorer les projets', icon: Layers3 },
  { to: '/missions', label: 'Missions de test', icon: Beaker },
  { to: '/marketplace', label: 'Marketplace', icon: ShoppingBag },
];
const collective = [
  { to: '/network', label: 'Mon réseau', icon: Network },
  { to: '/community', label: 'Communautés', icon: Users },
  { to: '/people', label: 'Les talents', icon: Sparkles },
  { to: '/messages', label: 'Messagerie', icon: MessageCircle },
  { to: '/reputation', label: 'Avis & réputation', icon: Star },
];
const workspace = [
  { to: '/library', label: 'Mes favoris', icon: Bookmark },
  { to: '/workspace', label: 'Atelier d’équipe', icon: ListTodo },
  { to: '/wallet', label: 'Portefeuille', icon: Wallet },
  { to: '/payments', label: 'Paiements', icon: CreditCard },
  { to: '/sandbox', label: 'Bac à sable', icon: Boxes },
  { to: '/integrations', label: 'Intégrations', icon: Plug },
  { to: '/trust', label: 'Confiance & sécurité', icon: ShieldCheck },
  { to: '/settings', label: 'Mon compte', icon: Settings },
];

export default function App() {
  const { user, logout, error: authError } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [error, setError] = useState('');
  const location = useLocation();
  const { data: dashboard } = useApi<{ activity: { unread: number } | null }>(user ? `/dashboard?nav=${location.pathname}&user=${user.id}` : null);
  const { data: health } = useApi<{ payment_mode: 'demo' | 'sandbox' | 'live' }>('/health');
  const liveUnread = useUnreadNotifications();
  const unread = liveUnread ?? dashboard?.activity?.unread ?? 0;
  const modeLabel = health?.payment_mode === 'live' ? 'PAIEMENTS RÉELS' : health?.payment_mode === 'sandbox' ? 'MODE SANDBOX' : 'MODE DÉMO';
  useEffect(() => { setMobileOpen(false); window.scrollTo(0, 0); }, [location.pathname]);
  return <div className="app-shell">
    {mobileOpen && <button className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-label="Fermer le menu" />}
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}><Link className="brand" to="/"><span className="brand-mark">a<span /></span><span>alpha<span className="brand-period">.</span></span></Link><span className="brand-tagline">Build. Test. Together.</span>
      <Link to="/community" className="workspace-picker"><span className="workspace-logo"><Users size={18} /></span><div><strong>Le collectif Alpha</strong><small>Un espace, mille possibilités</small></div><ChevronDown size={15} /></Link>
      <nav aria-label="Navigation principale"><NavGroup label="DÉCOUVRIR" items={discovery} /><NavGroup label="LE COLLECTIF" items={collective} /><NavGroup label="MON ESPACE" items={workspace} />{user?.role === 'admin' && <NavGroup label="ADMINISTRATION" items={[{ to: '/admin', label: 'Console admin', icon: Gauge }]} />}</nav>
      <div className="sidebar-bottom"><Link className="sidebar-invite" to="/projects"><span className="invite-spark">✳</span><strong>Vous construisez quelque chose ?</strong><span>Donnez-lui le bon départ.</span><span className="invite-link">Partager mon projet <ArrowUpRight size={15} /></span></Link>{user ? <div className="sidebar-user"><Link className="row" to={`/people/${user.id}`}><Avatar name={user.name} color={user.avatar_color} size="small" /><div><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Modération' : 'Membre du collectif'}</small></div></Link><button className="icon-button" aria-label="Se déconnecter" onClick={() => { void logout().catch((error) => setError(errorMessage(error))); }}><LogOut size={17} /></button></div> : <Link className="sidebar-user guest-link" to="/login"><span className="guest-avatar"><Users size={18} /></span><div><strong>Votre place est ici</strong><small>Connectez-vous au collectif</small></div><ArrowUpRight size={16} /></Link>}</div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="row"><button className="icon-button mobile-menu" aria-label={mobileOpen ? 'Fermer le menu' : 'Ouvrir le menu'} onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={21} /> : <Menu size={21} />}</button><form className="global-search" action="/search"><Search size={17} /><input name="q" maxLength={120} aria-label="Rechercher sur Alpha" placeholder="Un projet, une mission, une offre, un talent…" /><kbd>↵</kbd></form></div><div className="topbar-actions"><span className={`demo-pill ${health?.payment_mode === 'live' ? 'is-live' : ''}`}><span /> V4 · {modeLabel}</span><Link to="/notifications" className="notification-button" aria-label={`Notifications${unread ? ` (${unread} non lues)` : ''}`}><Bell size={20} />{!!unread && <i />}</Link><span className="topbar-separator" />{user ? <Link className="topbar-avatar" to="/settings"><Avatar name={user.name} color={user.avatar_color} size="small" /></Link> : <Link className="button button-primary button-small" to="/register">Rejoindre Alpha <ArrowUpRight size={14} /></Link>}</div></header>
      <div className="content"><ErrorState message={error || authError} /><RouteBoundary key={`${location.pathname}:${user?.id ?? 'guest'}`}><Suspense fallback={<Loading />}><Routes>
        <Route path="/" element={<DashboardPage />} /><Route path="/login" element={<AuthPage />} /><Route path="/register" element={<AuthPage />} />
        <Route path="/projects" element={<ProjectsPage />} /><Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/missions" element={<TestingPage />} /><Route path="/missions/:id" element={<TestingPage />} />
        <Route path="/community" element={<CommunityPage />} /><Route path="/community/:id" element={<CommunityPage />} />
        <Route path="/network" element={<NetworkPage />} /><Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/search" element={<DiscoveryPage />} /><Route path="/library" element={<DiscoveryPage library />} />
        <Route path="/marketplace" element={<MarketplacePage />} /><Route path="/marketplace/:id" element={<MarketplacePage />} />
        <Route path="/payments" element={<PaymentsPage />} /><Route path="/people" element={<PeoplePage />} /><Route path="/people/:id" element={<PeoplePage />} /><Route path="/settings" element={<SettingsPage />} />
        <Route path="/reputation" element={<ReputationPage />} /><Route path="/messages" element={<MessagesPage />} /><Route path="/notifications" element={<NotificationsPage />} /><Route path="/trust" element={<TrustPage />} /><Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/forgot-password" element={<AccountRecoveryPage />} /><Route path="/reset-password" element={<AccountRecoveryPage />} /><Route path="/verify-email" element={<AccountRecoveryPage />} />
        <Route path="/checkout/*" element={<CheckoutPage />} /><Route path="/wallet" element={<WalletPage />} /><Route path="/sandbox" element={<SandboxPage />} /><Route path="/sandbox/:id" element={<SandboxPage />} />
        <Route path="/legal/:doc" element={<LegalPage />} /><Route path="/admin" element={<AdminPage />} /><Route path="/admin/:section" element={<AdminPage />} />
        <Route path="*" element={<div className="empty-state"><h1>Cette page reste à inventer.</h1><p className="muted">L’adresse demandée n’existe pas.</p><Link className="button button-primary" to="/">Retour à l’accueil</Link></div>} />
      </Routes></Suspense></RouteBoundary><footer className="site-footer"><span>© {new Date().getFullYear()} Alpha · Construit pour construire ensemble.</span><nav className="row gap-sm" aria-label="Informations légales"><Link to="/legal/terms">Conditions</Link><Link to="/legal/privacy">Confidentialité</Link><Link to="/legal/payments">Paiements</Link><Link to="/trust">Confiance & transparence <ExternalLink size={12} /></Link></nav></footer></div>
    </div>
  </div>;
}

function NavGroup({ label, items }: { label: string; items: { to: string; label: string; icon: typeof Compass; end?: boolean; badge?: string }[] }) {
  return <div className="nav-group"><span className="nav-group-label">{label}</span>{items.map((item) => <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span>{item.badge && <small className="nav-badge">{item.badge}</small>}</NavLink>)}</div>;
}
