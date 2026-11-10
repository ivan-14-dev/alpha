import { z } from 'zod';
import { one, run, transaction } from '../db.js';
import { id } from '../core.js';

export interface PromotionResult { id: string; name: string; email: string; already_admin: boolean }

/**
 * Grants the admin role to an existing account (first deployment, break-glass recovery).
 * CLI only: there is no HTTP route that can self-promote. Recorded in audit_events with no actor.
 */
export function promoteAdmin(email: string): PromotionResult {
  const parsed = z.string().trim().toLowerCase().pipe(z.string().email().max(254)).safeParse(email);
  if (!parsed.success) throw new Error('Adresse e-mail invalide.');
  return transaction(() => {
    const user = one<{ id: string; name: string; email: string; role: string }>('SELECT id,name,email,role FROM users WHERE lower(email)=?', parsed.data);
    if (!user) throw new Error(`Aucun compte n’utilise l’adresse ${parsed.data}. Inscrivez-vous d’abord sur le site, puis relancez la commande.`);
    if (user.role === 'admin') return { id: user.id, name: user.name, email: user.email, already_admin: true };
    run("UPDATE users SET role='admin' WHERE id=?", user.id);
    run('INSERT INTO audit_events (id,actor_id,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?)',
      id(), null, 'ops.admin_promoted', 'user', user.id, 'Promotion par la commande npm run admin:promote.');
    return { id: user.id, name: user.name, email: user.email, already_admin: false };
  });
}
