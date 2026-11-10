/**
 * Grants the admin role to an existing account (first deployment or recovery).
 *   npm run admin:promote -- admin@example.com
 *   docker compose exec app npm run admin:promote -- admin@example.com
 * The account must already exist (sign up on the site first).
 */
import { promoteAdmin } from '../server/ops/admin-tools.js';

const email = process.argv[2];
if (!email || email.startsWith('-')) {
  console.log('Usage : npm run admin:promote -- <adresse e-mail>');
  process.exit(1);
}
try {
  const result = promoteAdmin(email);
  console.log(result.already_admin
    ? `${result.name} <${result.email}> est déjà administrateur.`
    : `${result.name} <${result.email}> est maintenant administrateur : rechargez la page pour accéder à /admin.`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
