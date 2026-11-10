/**
 * Notification categories derived from the `kind` passed to core.notify(). Preferences are stored per
 * category (not per kind) so new kinds added by other modules inherit sensible defaults automatically.
 */
export const NOTIFICATION_CATEGORIES = ['testing', 'marketplace', 'payments', 'community', 'network', 'messages', 'trust', 'account'] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];

export interface CategoryDefinition {
  id: NotificationCategory;
  label: string;
  description: string;
  defaults: { email: boolean; push: boolean };
  /** Notification bodies of these categories may contain private details: they are never copied into push payloads or emails. */
  privateBody: boolean;
}

export const categoryDefinitions: CategoryDefinition[] = [
  { id: 'testing', label: 'Tests & missions', description: 'Candidatures, missions, rapports de test et bac à sable.', defaults: { email: true, push: true }, privateBody: false },
  { id: 'marketplace', label: 'Marketplace', description: 'Commandes, livraisons et demandes de correction.', defaults: { email: false, push: true }, privateBody: false },
  { id: 'payments', label: 'Paiements & portefeuille', description: 'Versements, encaissements, retraits et vérifications d’identité.', defaults: { email: true, push: true }, privateBody: true },
  { id: 'community', label: 'Communautés & avis', description: 'Actualités des projets suivis et nouveaux avis.', defaults: { email: false, push: false }, privateBody: false },
  { id: 'network', label: 'Réseau & équipes', description: 'Abonnés, invitations d’équipe et tâches attribuées.', defaults: { email: false, push: false }, privateBody: false },
  { id: 'messages', label: 'Messages privés', description: 'Nouveaux messages dans vos conversations.', defaults: { email: false, push: true }, privateBody: true },
  { id: 'trust', label: 'Confiance & modération', description: 'Signalements, litiges, décisions et appels.', defaults: { email: true, push: true }, privateBody: true },
  { id: 'account', label: 'Compte & sécurité', description: 'Connexion, sécurité du compte, confidentialité et intégrations.', defaults: { email: true, push: true }, privateBody: true },
];

const exact: Record<string, NotificationCategory> = {
  application: 'testing', mission: 'testing', report: 'testing', campaign: 'testing',
  order: 'marketplace', listing: 'marketplace',
  payment: 'payments', withdrawal: 'payments', payout: 'payments', invoice: 'payments', refund: 'payments', kyc: 'payments',
  review: 'community', post: 'community', comment: 'community',
  organization: 'network', task_assignment: 'network', follow: 'network', invitation: 'network',
  message: 'messages',
  moderation: 'trust', dispute: 'trust', sanction: 'trust', appeal: 'trust',
  security: 'account', login: 'account',
  // Repository activity summaries are project news, not account security: no email by default.
  'integrations.activity': 'network',
};

/**
 * Kinds whose owning module already sends its own transactional email (e.g. privacy requests):
 * they stay in-app/push only so members never receive a second, generic email.
 */
export const SELF_EMAILED_KINDS: ReadonlySet<string> = new Set(['privacy']);

const prefixes: [RegExp, NotificationCategory][] = [
  [/^(testing|missions?|campaigns?|sandbox|reports?)[._-]/, 'testing'],
  [/^(marketplace|orders?|listings?)[._-]/, 'marketplace'],
  [/^(payments?|wallet|withdrawals?|payouts?|compliance|kyc|kyb|invoices?|refunds?|ledger|escrow)[._-]/, 'payments'],
  [/^(community|reputation|reviews?|posts?|groups?)[._-]/, 'community'],
  [/^(network|people|organizations?|teams?|workspace|tasks?)[._-]/, 'network'],
  [/^(messages?|communication|conversations?)[._-]/, 'messages'],
  [/^(trust|moderation|disputes?|sanctions?|appeals?|risk)[._-]/, 'trust'],
  [/^(account|auth|security|mfa|privacy|integrations?|files?|email)[._-]/, 'account'],
];

/** Unknown kinds fall back to `account` (email on): new platform-level notices are usually important. */
export function categoryForKind(kind: string): NotificationCategory {
  const normalized = kind.trim().toLowerCase();
  if (Object.hasOwn(exact, normalized)) return exact[normalized];
  for (const [pattern, category] of prefixes) if (pattern.test(normalized)) return category;
  return 'account';
}

export function categoryDefinition(category: NotificationCategory): CategoryDefinition {
  return categoryDefinitions.find((item) => item.id === category)!;
}

export function isCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

/** Same rule as the communication module: only same-origin relative paths are ever sent to clients. */
export function safeInternalLink(link: string) {
  return /^\/(?!\/)/.test(link) && !/[\\\u0000-\u0020\u007f]/.test(link) && link.length <= 500 ? link : '/notifications';
}
