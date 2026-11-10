import { Router } from 'express';
import { all, one } from './db.js';
import { paymentSummary } from './finance.js';

const router = Router();
router.get('/', (req, res) => {
  const userId = req.user?.id ?? '';
  const stats = {
    projects: one<{ count: number }>("SELECT COUNT(*) AS count FROM projects WHERE visibility='public'")!.count,
    campaigns: one<{ count: number }>("SELECT COUNT(*) AS count FROM campaigns c JOIN projects p ON p.id=c.project_id WHERE p.visibility='public' AND c.status='open' AND c.deadline>?", new Date().toISOString())!.count,
    members: one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count,
    groups: one<{ count: number }>('SELECT COUNT(*) AS count FROM groups')!.count,
  };
  const projects = all(`SELECT p.id,p.title,p.summary,p.category,p.stage,p.tags,p.color,u.name AS owner_name,
    (SELECT COUNT(*) FROM campaigns c WHERE c.project_id=p.id AND c.status='open' AND c.deadline>?) AS campaign_count
    FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.visibility='public' ORDER BY p.created_at DESC LIMIT 3`, new Date().toISOString());
  const campaigns = all(`SELECT c.id,c.title,c.kind,c.reward_cents,c.payment_mode,c.slots,c.target_devices,c.deadline,
    p.title AS project_title,p.color,
    (SELECT COUNT(*) FROM missions m WHERE m.campaign_id=c.id AND m.status!='cancelled') AS assigned
    FROM campaigns c JOIN projects p ON p.id=c.project_id WHERE p.visibility='public' AND c.status='open' AND c.deadline>?
    ORDER BY c.created_at DESC LIMIT 3`, new Date().toISOString());
  const groups = all(`SELECT g.id,g.name,g.description,g.category,g.color,
    (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS members
    FROM groups g ORDER BY members DESC,g.created_at DESC LIMIT 3`);
  const posts = all(`SELECT p.id,p.body,p.created_at,p.project_id,project.title AS project_title,u.id AS author_id,u.name,u.title,u.avatar_color,
    (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS likes,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comments
    FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN projects project ON project.id=p.project_id
    WHERE p.project_id IS NULL OR project.visibility='public' ORDER BY p.created_at DESC,p.id DESC LIMIT 2`);
  const activity = userId ? {
    own_projects: one<{ count: number }>('SELECT COUNT(*) AS count FROM projects WHERE owner_id=?', userId)!.count,
    active_missions: one<{ count: number }>("SELECT COUNT(*) AS count FROM missions WHERE tester_id=? AND status NOT IN ('paid','cancelled')", userId)!.count,
    unread: one<{ count: number }>('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL', userId)!.count,
    following_people: one<{ count: number }>('SELECT COUNT(*) AS count FROM user_follows WHERE follower_id=?', userId)!.count,
    following_projects: one<{ count: number }>("SELECT COUNT(*) AS count FROM project_follows f JOIN projects p ON p.id=f.project_id WHERE f.user_id=? AND p.visibility='public'", userId)!.count,
    pending_invitations: one<{ count: number }>("SELECT COUNT(*) AS count FROM organization_invitations WHERE invitee_id=? AND status='pending' AND expires_at>?", userId, new Date().toISOString())!.count,
    assigned_tasks: one<{ count: number }>(`SELECT COUNT(*) AS count FROM project_tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.assignee_id=? AND t.status!='done' AND (p.owner_id=? OR
      EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id AND om.user_id=?))`,
    userId, userId, userId)!.count,
    ...paymentSummary(userId),
  } : null;
  res.json({ stats, projects, campaigns, groups, posts, activity });
});
export default router;
