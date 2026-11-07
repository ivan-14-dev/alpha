import { Router, type Request } from 'express';
import { z } from 'zod';
import { audit, HttpError, id, notify, now, param, requireUser } from '../core.js';
import { all, one, run, transaction } from '../db.js';

const router = Router();
const publicFields = 'u.id,u.name,u.title,u.bio,u.skills,u.avatar_color,u.created_at';
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Identifiant invalide.');
const memberRole = z.enum(['member', 'admin']);
const invitationInput = z.object({ user_id: identifier, role: memberRole }).strict();
const emptyInput = z.object({}).strict();
const teamLink = '/settings?tab=teams';
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const profileInput = z.object({
  name: z.string().trim().min(1).max(100),
  title: z.string().trim().max(160),
  bio: z.string().trim().max(3000),
  skills: z.array(z.string().trim().min(1).max(50)).max(20),
  avatar_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Une couleur hexadécimale à six chiffres est requise.'),
}).partial().strict().refine((value) => Object.keys(value).length > 0, 'Indiquez un champ à modifier.');

interface PublicPerson {
  id: string;
  name: string;
  title: string;
  bio: string;
  skills: string;
  avatar_color: string;
  created_at: string;
}

interface Organization {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  created_at: string;
}

interface Invitation {
  id: string;
  organization_id: string;
  inviter_id: string;
  invitee_id: string;
  role: 'member' | 'admin';
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  responded_at: string | null;
}

interface InvitationRow extends Invitation {
  organization_name: string;
  organization_description: string;
  inviter_name: string;
  inviter_title: string;
  inviter_color: string;
  invitee_name: string;
  invitee_title: string;
  invitee_color: string;
}

const invitationProjection = `SELECT i.*,o.name AS organization_name,o.description AS organization_description,
  inviter.name AS inviter_name,inviter.title AS inviter_title,inviter.avatar_color AS inviter_color,
  invitee.name AS invitee_name,invitee.title AS invitee_title,invitee.avatar_color AS invitee_color
  FROM organization_invitations i JOIN organizations o ON o.id=i.organization_id
  JOIN users inviter ON inviter.id=i.inviter_id JOIN users invitee ON invitee.id=i.invitee_id`;

function effectiveStatus(invitation: Invitation): Invitation['status'] {
  return invitation.status === 'pending' && Date.parse(invitation.expires_at) <= Date.now() ? 'expired' : invitation.status;
}

function presentInvitation(row: InvitationRow) {
  const { organization_name, organization_description, inviter_name, inviter_title, inviter_color,
    invitee_name, invitee_title, invitee_color, ...invitation } = row;
  return {
    ...invitation, status: effectiveStatus(invitation),
    organization: { id: invitation.organization_id, name: organization_name, description: organization_description },
    inviter: { id: invitation.inviter_id, name: inviter_name, title: inviter_title, avatar_color: inviter_color },
    invitee: { id: invitation.invitee_id, name: invitee_name, title: invitee_title, avatar_color: invitee_color },
  };
}

function invitationById(invitationId: string): Invitation {
  const invitation = one<Invitation>('SELECT * FROM organization_invitations WHERE id=?', invitationId);
  if (!invitation) throw new HttpError(404, 'Invitation introuvable.');
  return invitation;
}

function invitationView(invitationId: string) {
  return presentInvitation(one<InvitationRow>(`${invitationProjection} WHERE i.id=?`, invitationId)!);
}

function memberById(organizationId: string, userId: string) {
  return one<PublicPerson & { role: string }>(`SELECT ${publicFields},om.role
    FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=? AND om.user_id=?`, organizationId, userId);
}

function updateMemberRole(organizationId: string, userId: string, memberId: string, role: 'member' | 'admin', legacy = false) {
  return transaction(() => {
    const organization = organizationById(organizationId);
    requireOwner(organization, userId);
    if (!one('SELECT id FROM users WHERE id=?', memberId)) throw new HttpError(404, 'Profil introuvable.');
    const member = memberById(organizationId, memberId);
    if (memberId === organization.owner_id || member?.role === 'owner') {
      throw new HttpError(409, 'Le rôle du propriétaire ne peut pas être modifié.');
    }
    if (!member) throw new HttpError(legacy ? 409 : 404, legacy
      ? 'Une invitation acceptée est obligatoire pour ajouter un membre. Envoyez une invitation à cette personne.'
      : 'Membre introuvable. Envoyez une invitation pour rejoindre l’organisation.');
    if (member.role !== role) {
      run('UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?', role, organizationId, memberId);
      audit(userId, 'organization.member.role_changed', 'organization', organizationId, JSON.stringify({ user_id: memberId, role }));
      notify(memberId, 'organization', 'Votre rôle a été modifié', `${organization.name} : ${role === 'admin' ? 'administrateur' : 'membre'}.`, teamLink);
    }
    return memberById(organizationId, memberId)!;
  });
}

function removeMembership(organizationId: string, memberId: string) {
  run('DELETE FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, memberId);
  // Invalidate the old acceptance too: replay must not recreate a removed membership, even after a later rejoin.
  run(`UPDATE organization_invitations SET status='revoked',responded_at=?
    WHERE organization_id=? AND invitee_id=? AND status IN ('pending','accepted')`, now(), organizationId, memberId);
}

function routeId(req: Request, key = 'id') {
  return identifier.parse(param(req, key));
}

function organizationById(organizationId: string): Organization {
  const organization = one<Organization>('SELECT id,owner_id,name,description,created_at FROM organizations WHERE id=?', organizationId);
  if (!organization) throw new HttpError(404, 'Organisation introuvable.');
  return organization;
}

function requireOwner(organization: Organization, userId: string) {
  if (organization.owner_id !== userId) throw new HttpError(403, 'Seul le propriétaire peut gérer les membres.');
}

router.get('/', (req, res) => {
  const { q, limit, offset } = pagination.extend({ q: z.string().trim().max(100).default('') }).parse(req.query);
  const match = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `WHERE u.name LIKE ? ESCAPE '\\' OR u.id LIKE ? ESCAPE '\\'
    OR u.title LIKE ? ESCAPE '\\' OR u.skills LIKE ? ESCAPE '\\'`;
  const people = all<PublicPerson>(`SELECT ${publicFields},
    (SELECT COUNT(*) FROM projects p WHERE p.owner_id=u.id AND p.visibility='public') AS public_project_count,
    (SELECT COUNT(*) FROM missions m WHERE m.tester_id=u.id AND m.status IN ('accepted','paid')) AS completed_mission_count,
    (SELECT COUNT(*) FROM reviews r JOIN missions m ON m.id=r.mission_id
      WHERE r.subject_id=u.id AND m.status IN ('accepted','paid')) AS review_count,
    (SELECT AVG(r.rating) FROM reviews r JOIN missions m ON m.id=r.mission_id
      WHERE r.subject_id=u.id AND m.status IN ('accepted','paid')) AS average_rating
    FROM users u ${where} ORDER BY u.name COLLATE NOCASE,u.id LIMIT ? OFFSET ?`,
  match, match, match, match, limit, offset);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM users u ${where}`, match, match, match, match)!.total;
  res.json({ people, total, limit, offset });
});

router.get('/organizations', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pagination.parse(req.query);
  const organizations = all(`SELECT o.id,o.owner_id,o.name,o.description,o.created_at,om.role AS my_role,
    (SELECT COUNT(*) FROM organization_members members WHERE members.organization_id=o.id) AS member_count
    FROM organizations o JOIN organization_members om ON om.organization_id=o.id
    WHERE om.user_id=? ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`, user.id, limit, offset);
  const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM organization_members WHERE user_id=?', user.id)!.total;
  res.json({ organizations, total, limit, offset });
});

router.get('/invitations', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pagination.parse(req.query);
  const invitations = all<InvitationRow>(`${invitationProjection} WHERE i.invitee_id=?
    ORDER BY CASE WHEN i.status='pending' AND julianday(i.expires_at)>julianday(?) THEN 0 ELSE 1 END,
    i.created_at DESC,i.id LIMIT ? OFFSET ?`, user.id, now(), limit, offset).map(presentInvitation);
  const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM organization_invitations WHERE invitee_id=?', user.id)!.total;
  res.json({ invitations, total, limit, offset });
});

router.get('/organizations/:id/invitations', (req, res) => {
  const user = requireUser(req);
  const organization = organizationById(routeId(req));
  requireOwner(organization, user.id);
  const { limit, offset } = pagination.parse(req.query);
  const invitations = all<InvitationRow>(`${invitationProjection} WHERE i.organization_id=?
    ORDER BY CASE WHEN i.status='pending' AND julianday(i.expires_at)>julianday(?) THEN 0 ELSE 1 END,
    i.created_at DESC,i.id LIMIT ? OFFSET ?`, organization.id, now(), limit, offset).map(presentInvitation);
  const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM organization_invitations WHERE organization_id=?', organization.id)!.total;
  res.json({ invitations, total, limit, offset });
});

router.post('/organizations/:id/invitations', (req, res) => {
  const user = requireUser(req);
  const organizationId = routeId(req);
  const input = invitationInput.parse(req.body);
  const invitation = transaction(() => {
    const organization = organizationById(organizationId);
    requireOwner(organization, user.id);
    if (input.user_id === user.id) throw new HttpError(409, 'Vous ne pouvez pas vous inviter vous-même.');
    if (!one('SELECT id FROM users WHERE id=?', input.user_id)) throw new HttpError(404, 'Profil introuvable.');
    if (memberById(organizationId, input.user_id)) throw new HttpError(409, 'Cette personne est déjà membre de l’organisation.');
    const createdAt = now();
    run(`UPDATE organization_invitations SET status='expired'
      WHERE organization_id=? AND invitee_id=? AND status='pending' AND julianday(expires_at)<=julianday(?)`,
    organizationId, input.user_id, createdAt);
    if (one("SELECT id FROM organization_invitations WHERE organization_id=? AND invitee_id=? AND status='pending'", organizationId, input.user_id)) {
      throw new HttpError(409, 'Une invitation est déjà en attente pour cette personne.');
    }
    const invitationId = id();
    const expiresAt = new Date(Date.parse(createdAt) + 7 * 86400000).toISOString();
    run(`INSERT INTO organization_invitations (id,organization_id,inviter_id,invitee_id,role,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?)`, invitationId, organizationId, user.id, input.user_id, input.role, createdAt, expiresAt);
    audit(user.id, 'organization.invitation.created', 'organization_invitation', invitationId, JSON.stringify({ organization_id: organizationId, ...input }));
    notify(input.user_id, 'organization', 'Invitation à rejoindre une équipe', `${user.name} vous invite dans ${organization.name}. Votre accord est nécessaire. Invitation valable 7 jours.`, teamLink);
    return invitationView(invitationId);
  });
  res.status(201).json({ invitation });
});

router.post('/invitations/:id/accept', (req, res) => {
  const user = requireUser(req);
  const invitationId = routeId(req);
  emptyInput.parse(req.body ?? {});
  const result = transaction(() => {
    const invitation = invitationById(invitationId);
    if (invitation.invitee_id !== user.id) throw new HttpError(403, 'Seul le destinataire peut accepter cette invitation.');
    const member = memberById(invitation.organization_id, user.id);
    if (invitation.status === 'accepted') {
      if (!member) throw new HttpError(409, 'Cette adhésion a été retirée. Une nouvelle invitation est nécessaire.');
      return { invitation: invitationView(invitationId), member };
    }
    if (effectiveStatus(invitation) !== 'pending') throw new HttpError(409, 'Cette invitation n’est plus disponible. Demandez une nouvelle invitation.');
    if (member) throw new HttpError(409, 'Vous êtes déjà membre de cette organisation.');
    const organization = organizationById(invitation.organization_id);
    if (organization.owner_id === user.id) throw new HttpError(409, 'Le propriétaire est déjà membre de son organisation.');
    run('INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)', organization.id, user.id, invitation.role);
    run("UPDATE organization_invitations SET status='accepted',responded_at=? WHERE id=?", now(), invitationId);
    audit(user.id, 'organization.invitation.accepted', 'organization_invitation', invitationId);
    notify(organization.owner_id, 'organization', 'Invitation acceptée', `${user.name} a rejoint ${organization.name}.`, teamLink);
    return { invitation: invitationView(invitationId), member: memberById(organization.id, user.id)! };
  });
  res.json(result);
});

for (const action of ['decline', 'revoke'] as const) {
  router.post(`/invitations/:id/${action}`, (req, res) => {
    const user = requireUser(req);
    const invitationId = routeId(req);
    emptyInput.parse(req.body ?? {});
    const invitation = transaction(() => {
      const current = invitationById(invitationId);
      const organization = organizationById(current.organization_id);
      if (action === 'revoke') requireOwner(organization, user.id);
      else if (current.invitee_id !== user.id) throw new HttpError(403, 'Seul le destinataire peut refuser cette invitation.');
      if (effectiveStatus(current) !== 'pending') throw new HttpError(409, 'Cette invitation n’est plus en attente.');
      const status = action === 'decline' ? 'declined' : 'revoked';
      run('UPDATE organization_invitations SET status=?,responded_at=? WHERE id=?', status, now(), invitationId);
      audit(user.id, `organization.invitation.${status}`, 'organization_invitation', invitationId);
      if (action === 'decline') notify(organization.owner_id, 'organization', 'Invitation refusée', `${user.name} a refusé de rejoindre ${organization.name}.`, teamLink);
      else notify(current.invitee_id, 'organization', 'Invitation révoquée', `L’invitation à rejoindre ${organization.name} a été révoquée.`, teamLink);
      return invitationView(invitationId);
    });
    res.json({ invitation });
  });
}

router.post('/organizations', (req, res) => {
  const user = requireUser(req);
  const input = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(3000).default(''),
  }).strict().parse(req.body);
  const organization = transaction(() => {
    const organizationId = id();
    run('INSERT INTO organizations (id,owner_id,name,description) VALUES (?,?,?,?)', organizationId, user.id, input.name, input.description);
    run("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,'owner')", organizationId, user.id);
    audit(user.id, 'organization.created', 'organization', organizationId);
    return { ...organizationById(organizationId), my_role: 'owner', member_count: 1 };
  });
  res.status(201).json({ organization });
});

router.get('/organizations/:id/members', (req, res) => {
  const user = requireUser(req);
  const organization = organizationById(routeId(req));
  if (!one('SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=?', organization.id, user.id)) {
    throw new HttpError(403, 'Les membres de cette organisation sont privés.');
  }
  const { limit, offset } = pagination.parse(req.query);
  const members = all<PublicPerson>(`SELECT ${publicFields},om.role
    FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=?
    ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.name COLLATE NOCASE,u.id
    LIMIT ? OFFSET ?`, organization.id, limit, offset);
  const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM organization_members WHERE organization_id=?', organization.id)!.total;
  res.json({ members, total, limit, offset });
});

router.post('/organizations/:id/members', (req, res) => {
  const user = requireUser(req);
  const organizationId = routeId(req);
  const input = invitationInput.parse(req.body);
  res.json({ member: updateMemberRole(organizationId, user.id, input.user_id, input.role, true) });
});

router.patch('/organizations/:id/members/:userId', (req, res) => {
  const user = requireUser(req);
  const organizationId = routeId(req);
  const memberId = routeId(req, 'userId');
  const { role } = z.object({ role: memberRole }).strict().parse(req.body);
  res.json({ member: updateMemberRole(organizationId, user.id, memberId, role) });
});

router.delete('/organizations/:id/members/:userId', (req, res) => {
  const user = requireUser(req);
  const organizationId = routeId(req);
  const memberId = routeId(req, 'userId');
  transaction(() => {
    const organization = organizationById(organizationId);
    requireOwner(organization, user.id);
    const member = one<{ role: string }>('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, memberId);
    if (!member) throw new HttpError(404, 'Membre introuvable.');
    if (memberId === organization.owner_id || member.role === 'owner') throw new HttpError(409, 'Le propriétaire ne peut pas être retiré.');
    removeMembership(organizationId, memberId);
    audit(user.id, 'organization.member.removed', 'organization', organizationId, memberId);
    notify(memberId, 'organization', 'Vous avez été retiré d’une équipe', `Votre accès d’équipe à ${organization.name} a été retiré.`, teamLink);
  });
  res.json({ removed: true });
});

router.post('/organizations/:id/leave', (req, res) => {
  const user = requireUser(req);
  const organizationId = routeId(req);
  emptyInput.parse(req.body ?? {});
  transaction(() => {
    const organization = organizationById(organizationId);
    const member = memberById(organizationId, user.id);
    if (organization.owner_id === user.id || member?.role === 'owner') throw new HttpError(409, 'Le propriétaire ne peut pas quitter son organisation.');
    if (!member) throw new HttpError(403, 'Vous n’êtes pas membre de cette organisation.');
    removeMembership(organizationId, user.id);
    audit(user.id, 'organization.member.left', 'organization', organizationId);
    notify(organization.owner_id, 'organization', 'Un membre a quitté l’équipe', `${user.name} a quitté ${organization.name}.`, teamLink);
  });
  res.json({ left: true });
});

router.patch('/me', (req, res) => {
  const user = requireUser(req);
  const input = profileInput.parse(req.body);
  const values = Object.entries(input).map(([field, value]) => [field, field === 'skills' ? JSON.stringify([...new Set(value as string[])]) : value] as const);
  const person = transaction(() => {
    run(`UPDATE users SET ${values.map(([field]) => `${field}=?`).join(',')} WHERE id=?`, ...values.map(([, value]) => value as string), user.id);
    audit(user.id, 'profile.updated', 'user', user.id, Object.keys(input).join(','));
    return one<PublicPerson>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, user.id);
  });
  res.json({ person });
});

router.get('/:id', (req, res) => {
  const personId = routeId(req);
  const person = one<PublicPerson>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, personId);
  if (!person) throw new HttpError(404, 'Profil introuvable.');
  const projects = all(`SELECT id,title,summary,category,stage,tags,color,created_at FROM projects
    WHERE owner_id=? AND visibility='public' ORDER BY created_at DESC,id LIMIT 100`, personId);
  const publicProjectCount = one<{ total: number }>("SELECT COUNT(*) AS total FROM projects WHERE owner_id=? AND visibility='public'", personId)!.total;
  const completedMissionCount = one<{ total: number }>("SELECT COUNT(*) AS total FROM missions WHERE tester_id=? AND status IN ('accepted','paid')", personId)!.total;
  const reputation = one<{ average_rating: number | null; review_count: number }>(`SELECT AVG(r.rating) AS average_rating,COUNT(*) AS review_count
    FROM reviews r JOIN missions m ON m.id=r.mission_id WHERE r.subject_id=? AND m.status IN ('accepted','paid')`, personId)!;
  res.json({ person: { ...person, projects, public_project_count: publicProjectCount, completed_mission_count: completedMissionCount, reputation } });
});

export default router;
