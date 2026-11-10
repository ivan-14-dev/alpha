import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { EmptyState, Loading, LoginNotice, PageHeader } from '../components/ui';
import RouteBoundary from '../components/RouteBoundary';

interface Section { id: string; label: string; description: string; component: LazyExoticComponent<ComponentType> }

/** Each section is owned by its module and lazy-loaded so member bundles never include admin code. */
export const adminSections: Section[] = [
  { id: 'overview', label: 'Vue d’ensemble', description: 'Indicateurs clés de la plateforme.', component: lazy(() => import('../admin/OverviewAdmin')) },
  { id: 'users', label: 'Utilisateurs', description: 'Rôles, statuts et sanctions des comptes.', component: lazy(() => import('../admin/UsersAdmin')) },
  { id: 'payments', label: 'Paiements', description: 'Prestataires (Stripe, Flutterwave, CamPay, MTN MoMo, Orange Money, Wave, Kratos Pay), mode, devises et webhooks.', component: lazy(() => import('../admin/PaymentsAdmin')) },
  { id: 'compliance', label: 'Conformité', description: 'KYC/KYB, retraits, factures et fiscalité.', component: lazy(() => import('../admin/ComplianceAdmin')) },
  { id: 'risk', label: 'Fraude & sanctions', description: 'Signaux de risque, multi-comptes, collusion et sanctions.', component: lazy(() => import('../admin/RiskAdmin')) },
  { id: 'appeals', label: 'Appels', description: 'Contestations des décisions de modération.', component: lazy(() => import('../admin/AppealsAdmin')) },
  { id: 'files', label: 'Fichiers & antivirus', description: 'Analyse antivirus, quarantaine et stockage privé.', component: lazy(() => import('../admin/FilesAdmin')) },
  { id: 'sandbox', label: 'Bac à sable', description: 'Exécution isolée des logiciels testés.', component: lazy(() => import('../admin/SandboxAdmin')) },
  { id: 'integrations', label: 'Intégrations', description: 'Applications OAuth GitHub, GitLab et Figma, webhooks.', component: lazy(() => import('../admin/IntegrationsAdmin')) },
  { id: 'auth', label: 'Connexion & sécurité', description: 'Connexion GitHub/Google, vérification e-mail et MFA.', component: lazy(() => import('../admin/AuthAdmin')) },
  { id: 'email', label: 'E-mails & notifications', description: 'SMTP, file d’envoi et notifications push.', component: lazy(() => import('../admin/EmailAdmin')) },
  { id: 'privacy', label: 'RGPD', description: 'Exports, suppressions et durées de conservation.', component: lazy(() => import('../admin/PrivacyAdmin')) },
  { id: 'system', label: 'Système', description: 'Santé, tâches planifiées, sauvegardes et métriques.', component: lazy(() => import('../admin/SystemAdmin')) },
];

export default function AdminPage() {
  const { user, loading } = useAuth();
  const { section: sectionId } = useParams();
  if (loading) return <Loading />;
  if (!user) return <LoginNotice />;
  if (user.role !== 'admin') return <EmptyState title="Espace réservé à l’administration" description="Votre compte n’a pas accès à la console d’administration." />;
  const section = adminSections.find((item) => item.id === (sectionId ?? 'overview'));
  if (!section) return <Navigate to="/admin" replace />;
  const Component = section.component;
  return <div className="stack">
    <PageHeader eyebrow="Administration" title={section.label} description={section.description} />
    <nav className="tabs" aria-label="Sections d’administration">
      {adminSections.map((item) => <NavLink key={item.id} to={item.id === 'overview' ? '/admin' : `/admin/${item.id}`} end className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>{item.label}</NavLink>)}
    </nav>
    <RouteBoundary key={section.id}><Suspense fallback={<Loading />}><Component /></Suspense></RouteBoundary>
  </div>;
}
