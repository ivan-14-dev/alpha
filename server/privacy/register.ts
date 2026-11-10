import { personalDataHandlers } from '../platform/privacy.js';
import { controllerIdentity, ERASURE_GRACE_DAYS, EXPORT_VALIDITY_DAYS, retentionSettings } from './settings.js';

/**
 * Register of processing activities (Art. 30 RGPD), generated from the platform's own knowledge
 * (core processing) and from the descriptions registered by each module via registerPersonalData().
 * The operator must review it, complete the missing columns and keep it up to date.
 */
export interface ProcessingActivity {
  id: string;
  name: string;
  purposes: string[];
  legal_basis: string;
  data_subjects: string[];
  data_categories: string[];
  recipients: string[];
  transfers: string;
  retention: string;
  security: string[];
  source: 'core' | 'module';
}

const standardSecurity = ['Chiffrement TLS en transit', 'Mots de passe hachés (scrypt)', 'Jetons de session hachés (SHA-256)',
  'Contrôle d’accès par rôle', 'Journal d’audit', 'Sauvegardes chiffrées (à configurer par l’exploitant)'];

export function coreActivities(): ProcessingActivity[] {
  const retention = retentionSettings();
  const years = (days: number) => `${Math.round(days / 365)} an(s)`;
  return [
    { id: 'accounts', name: 'Gestion des comptes et authentification', purposes: ['Création et sécurisation des comptes', 'Connexion et sessions'],
      legal_basis: 'Exécution du contrat (art. 6.1.b) ; intérêt légitime pour la sécurité (art. 6.1.f)',
      data_subjects: ['Membres'], data_categories: ['Identité (nom, e-mail)', 'Profil professionnel', 'Données de connexion (sessions, adresse IP tronquée dans les journaux)'],
      recipients: ['Équipe Alpha habilitée', 'Hébergeur', 'Fournisseurs OAuth choisis par le membre'], transfers: 'Selon l’hébergeur et les fournisseurs OAuth (voir sous-traitants)',
      retention: `Durée du compte ; suppression ou anonymisation ${ERASURE_GRACE_DAYS} jours après la demande ; sessions expirées purgées automatiquement`,
      security: standardSecurity, source: 'core' },
    { id: 'collaboration', name: 'Projets, tâches, organisations et réseau social', purposes: ['Fourniture du service de collaboration', 'Publications, commentaires, messages'],
      legal_basis: 'Exécution du contrat (art. 6.1.b)', data_subjects: ['Membres', 'Personnes mentionnées par les membres'],
      data_categories: ['Contenus publiés', 'Messages', 'Relations (abonnements, membres d’organisation)'],
      recipients: ['Autres membres selon la visibilité choisie'], transfers: 'Aucun hors hébergeur',
      retention: 'Durée du compte ; contenus anonymisés ou remplacés à la suppression du compte', security: standardSecurity, source: 'core' },
    { id: 'testing', name: 'Campagnes de tests rémunérés', purposes: ['Mise en relation porteurs de projets / testeurs', 'Rapports de tests', 'Rémunération'],
      legal_basis: 'Exécution du contrat (art. 6.1.b)', data_subjects: ['Testeurs', 'Porteurs de projets'],
      data_categories: ['Candidatures', 'Rapports', 'Évaluations', 'Montants'], recipients: ['Porteur de la campagne', 'Prestataires de paiement'],
      transfers: 'Selon le prestataire de paiement', retention: 'Durée du compte ; données comptables 10 ans (art. L123-22 C. com.)', security: standardSecurity, source: 'core' },
    { id: 'marketplace', name: 'Marketplace et paiements', purposes: ['Ventes de produits et services', 'Séquestre, commissions, retraits', 'Prévention de la fraude'],
      legal_basis: 'Exécution du contrat (art. 6.1.b) ; obligation légale comptable et LCB-FT (art. 6.1.c)',
      data_subjects: ['Acheteurs', 'Vendeurs'], data_categories: ['Commandes', 'Transactions', 'Écritures du grand livre', 'Avis'],
      recipients: ['Stripe, Flutterwave, CamPay, MTN MoMo, Orange Money, Wave, Kratos Pay selon le moyen choisi', 'Administration fiscale sur réquisition'],
      transfers: 'Hors UE possible (prestataires africains et américains) : clauses contractuelles types à vérifier',
      retention: 'Pièces comptables et grand livre : 10 ans, conservés sous identifiant anonymisé', security: [...standardSecurity, 'Grand livre en double écriture immuable'], source: 'core' },
    { id: 'notifications', name: 'Notifications et e-mails transactionnels', purposes: ['Informer des événements du compte'],
      legal_basis: 'Exécution du contrat (art. 6.1.b)', data_subjects: ['Membres'], data_categories: ['E-mail', 'Contenu des notifications'],
      recipients: ['Fournisseur SMTP'], transfers: 'Selon le fournisseur SMTP',
      retention: `Notifications lues : ${retention.notifications_read_days} jours ; e-mails envoyés : ${retention.email_sent_days} jours ; en échec : ${retention.email_failed_days} jours`,
      security: standardSecurity, source: 'core' },
    { id: 'marketing', name: 'Communications marketing et nouveautés', purposes: ['Envoi d’informations commerciales et de nouveautés produit'],
      legal_basis: 'Consentement (art. 6.1.a ; art. L34-5 CPCE)', data_subjects: ['Membres ayant consenti'], data_categories: ['E-mail', 'Historique des consentements'],
      recipients: ['Fournisseur SMTP'], transfers: 'Selon le fournisseur SMTP', retention: 'Jusqu’au retrait du consentement ; preuve du consentement conservée 5 ans',
      security: standardSecurity, source: 'core' },
    { id: 'security', name: 'Sécurité, journalisation et lutte contre les abus', purposes: ['Journal d’audit', 'Limitation de débit', 'Modération'],
      legal_basis: 'Intérêt légitime (art. 6.1.f) ; obligation légale de conservation des données de connexion (LCEN)',
      data_subjects: ['Membres', 'Visiteurs'], data_categories: ['Actions effectuées', 'Identifiant technique', 'Adresse IP (compteurs temporaires)'],
      recipients: ['Équipe Alpha habilitée', 'Autorités sur réquisition'], transfers: 'Aucun hors hébergeur',
      retention: `Audit ordinaire : ${years(retention.audit_days)} ; audit financier, confiance et RGPD : ${years(retention.audit_long_days)} ; compteurs anti-abus : jusqu’à expiration`,
      security: standardSecurity, source: 'core' },
    { id: 'privacy', name: 'Gestion des droits RGPD', purposes: ['Exports, suppressions, consentements, violations de données'],
      legal_basis: 'Obligation légale (art. 6.1.c ; art. 12 à 22 et 33 RGPD)', data_subjects: ['Membres'],
      data_categories: ['Demandes et leur traitement', 'Historique des consentements', 'Registre des violations'],
      recipients: ['Délégué à la protection des données', 'CNIL en cas de violation'], transfers: 'Aucun',
      retention: `Lien d’export : ${EXPORT_VALIDITY_DAYS} jours (archive générée à la demande, jamais stockée) ; demandes clôturées : ${years(retention.privacy_requests_days)}`,
      security: standardSecurity, source: 'core' },
  ];
}

export function processingRegister() {
  const modules: ProcessingActivity[] = personalDataHandlers().map(([name, handler]) => ({
    id: `module:${name}`, name: `Module ${name}`, purposes: [handler.description],
    legal_basis: 'À compléter par l’exploitant', data_subjects: ['Membres'], data_categories: [handler.description],
    recipients: ['À compléter'], transfers: 'À compléter', retention: 'Durée du compte, puis effacement par le module lors de la suppression',
    security: standardSecurity, source: 'module',
  }));
  return {
    generated_at: new Date().toISOString(),
    controller: controllerIdentity(),
    notice: 'Registre généré automatiquement (art. 30 RGPD). À relire, compléter et faire valider par le DPO ou un juriste.',
    activities: [...coreActivities(), ...modules],
  };
}
