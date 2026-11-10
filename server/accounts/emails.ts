import { queueEmail, renderEmail } from '../platform/mailer.js';

/** Transactional account e-mails. Call inside the business transaction: they are only sent if it commits. */
interface Recipient { id: string; email: string; name: string }

export function queueVerificationEmail(user: Recipient, token: string) {
  const body = renderEmail({
    title: 'Confirmez votre adresse e-mail',
    paragraphs: [
      `Bonjour ${user.name},`,
      'Pour sécuriser votre compte Alpha, confirmez que cette adresse vous appartient. Le lien est valable 48 heures et ne peut servir qu’une fois.',
      'Si vous n’êtes pas à l’origine de cette inscription, ignorez simplement cet e-mail.',
    ],
    action: { label: 'Confirmer mon adresse', url: `/verify-email?token=${token}` },
  });
  queueEmail({ to: user.email, userId: user.id, category: 'account.verify', subject: 'Confirmez votre adresse e-mail', ...body, sensitive: true });
}

export function queuePasswordResetEmail(user: Recipient, token: string) {
  const body = renderEmail({
    title: 'Réinitialisation de votre mot de passe',
    paragraphs: [
      `Bonjour ${user.name},`,
      'Une demande de réinitialisation du mot de passe de votre compte Alpha a été reçue.',
      'Ce lien est valable 1 heure et ne peut être utilisé qu’une seule fois. Toutes vos sessions seront fermées après le changement.',
      'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : votre mot de passe actuel reste valable.',
    ],
    action: { label: 'Choisir un nouveau mot de passe', url: `/reset-password?token=${token}` },
  });
  queueEmail({ to: user.email, userId: user.id, category: 'account.reset', subject: 'Réinitialisation de votre mot de passe', ...body, sensitive: true });
}

export function queuePasswordChangedEmail(user: Recipient) {
  const body = renderEmail({
    title: 'Votre mot de passe a été modifié',
    paragraphs: [
      `Bonjour ${user.name},`,
      'Le mot de passe de votre compte Alpha vient d’être modifié et toutes vos anciennes sessions ont été fermées.',
      'Si vous n’êtes pas à l’origine de ce changement, réinitialisez immédiatement votre mot de passe puis contactez l’équipe Alpha.',
    ],
    action: { label: 'Réinitialiser mon mot de passe', url: '/forgot-password' },
  });
  queueEmail({ to: user.email, userId: user.id, category: 'account.password_changed', subject: 'Votre mot de passe a été modifié', ...body });
}

export function queueSecurityEmail(user: Recipient, subject: string, paragraph: string) {
  const body = renderEmail({
    title: subject,
    paragraphs: [`Bonjour ${user.name},`, paragraph, 'Si vous n’êtes pas à l’origine de cette action, sécurisez votre compte : changez votre mot de passe et fermez vos autres sessions depuis « Mon compte ».'],
    action: { label: 'Ouvrir la sécurité du compte', url: '/settings' },
  });
  queueEmail({ to: user.email, userId: user.id, category: 'account.security', subject, ...body });
}
