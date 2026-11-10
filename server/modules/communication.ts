import { Router } from 'express';
import { z } from 'zod';
import { HttpError, id, notify, now, param, requireUser } from '../core.js';
import { all, one, run, transaction } from '../db.js';
import { publishToUser } from '../platform/events.js';
import { recordSignal, requireCapability } from '../platform/guards.js';
import { registerPersonalData } from '../platform/privacy.js';
import { publishUnread, unreadCount } from '../realtime/hooks.js';

const router = Router();
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const bodySchema = z.object({ body: z.string().trim().min(1).max(10_000) });
const createSchema = bodySchema.extend({
  subject: z.string().trim().min(1).max(160),
  recipient_id: identifier,
});
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  q: z.string().trim().max(120).default(''),
});

interface Person {
  id: string;
  name: string;
  title: string;
  avatar_color: string;
}
interface Conversation {
  id: string;
  subject: string;
  created_by: string;
  created_at: string;
}
interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}
interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
}

function searchPattern(query: string) {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

function participants(conversationId: string) {
  return all<Person>(`SELECT u.id,u.name,u.title,u.avatar_color
    FROM conversation_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.conversation_id=? ORDER BY u.name COLLATE NOCASE,u.id LIMIT 100`, conversationId);
}

function memberConversation(conversationId: string, userId: string) {
  const conversation = one<Conversation>(`SELECT c.id,c.subject,c.created_by,c.created_at
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE c.id=? AND cm.user_id=?`, conversationId, userId);
  // Use the same response for absent conversations and conversations belonging to others.
  if (!conversation) throw new HttpError(404, 'Conversation introuvable.');
  return conversation;
}

function notifyMembers(conversation: Conversation, senderId: string, senderName: string, body: string) {
  const recipients = all<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>? ORDER BY user_id',
    conversation.id, senderId,
  );
  for (const recipient of recipients) {
    notify(recipient.user_id, 'message', `Nouveau message de ${senderName.slice(0, 100)}`,
      `${conversation.subject}\n${body.slice(0, 160)}`, `/messages?conversation=${conversation.id}`);
  }
}

function safeInternalLink(link: string) {
  return /^\/(?!\/)/.test(link) && !/[\\\u0000-\u0020\u007f]/.test(link) ? link : '/notifications';
}

const conversationLink = (conversationId: string) => `/messages?conversation=${conversationId}`;

function memberIds(conversationId: string) {
  return all<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id=?', conversationId).map((row) => row.user_id);
}

/** Realtime fan-out to participants only (the sender too, so their other tabs stay in sync). Delivered after COMMIT. */
function publishMessage(conversation: Conversation, message: Message, sender: { id: string; name: string; avatar_color: string }, created = false) {
  const data = {
    conversation_id: conversation.id,
    message,
    sender: { id: sender.id, name: sender.name, avatar_color: sender.avatar_color },
    ...(created ? { conversation: { ...conversation, participants: participants(conversation.id) } } : {}),
  };
  for (const userId of memberIds(conversation.id)) publishToUser(userId, { type: 'message.created', data });
}

function readReceipts(conversationId: string) {
  return all<{ user_id: string; last_read_at: string }>(
    'SELECT user_id,last_read_at FROM conversation_reads WHERE conversation_id=? ORDER BY user_id', conversationId);
}

function publicNotification(notification: Notification) {
  return { ...notification, link: safeInternalLink(notification.link) };
}

router.get('/people', (req, res) => {
  const user = requireUser(req);
  const { limit, offset, q } = pageSchema.parse(req.query);
  const people = all<Person>(`SELECT id,name,title,avatar_color FROM users
    WHERE id<>? AND (name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
    ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?`,
  user.id, searchPattern(q), searchPattern(q), limit + 1, offset);
  res.json({ people: people.slice(0, limit), has_more: people.length > limit });
});

router.get('/conversations', (req, res) => {
  const user = requireUser(req);
  const { limit, offset, q } = pageSchema.parse(req.query);
  const conversations = all<Conversation & {
    last_message_at: string | null;
    last_message_body: string | null;
    last_sender_id: string | null;
  }>(`SELECT c.id,c.subject,c.created_by,c.created_at,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message_at,
      (SELECT substr(m.body,1,160) FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message_body,
      (SELECT m.sender_id FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_sender_id
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=? AND (c.subject LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM conversation_members peer JOIN users u ON u.id=peer.user_id
      WHERE peer.conversation_id=c.id AND u.id<>? AND u.name LIKE ? ESCAPE '\\'))
    ORDER BY COALESCE(last_message_at,c.created_at) DESC,c.id DESC LIMIT ? OFFSET ?`,
  user.id, searchPattern(q), user.id, searchPattern(q), limit + 1, offset);
  res.json({
    conversations: conversations.slice(0, limit).map((conversation) => ({
      ...conversation,
      participants: participants(conversation.id),
      unread_count: one<{ count: number }>(`SELECT COUNT(*) AS count FROM notifications
        WHERE user_id=? AND kind='message' AND link=? AND read_at IS NULL`, user.id, conversationLink(conversation.id))!.count,
    })),
    has_more: conversations.length > limit,
  });
});

router.post('/conversations', (req, res) => {
  const user = requireCapability(req, 'message');
  const input = createSchema.parse(req.body);
  if (input.recipient_id === user.id) throw new HttpError(400, 'Choisissez un autre membre comme destinataire.');
  const result = transaction(() => {
    if (!one('SELECT id FROM users WHERE id=?', input.recipient_id)) {
      throw new HttpError(404, 'Destinataire introuvable.');
    }
    const conversation: Conversation = {
      id: id(), subject: input.subject, created_by: user.id, created_at: now(),
    };
    const message: Message = {
      id: id(), conversation_id: conversation.id, sender_id: user.id,
      body: input.body, created_at: conversation.created_at,
    };
    run('INSERT INTO conversations (id,subject,created_by,created_at) VALUES (?,?,?,?)',
      conversation.id, conversation.subject, user.id, conversation.created_at);
    run('INSERT INTO conversation_members (conversation_id,user_id) VALUES (?,?),(?,?)',
      conversation.id, user.id, conversation.id, input.recipient_id);
    run('INSERT INTO messages (id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)',
      message.id, conversation.id, user.id, message.body, message.created_at);
    notifyMembers(conversation, user.id, user.name, message.body);
    publishMessage(conversation, message, user, true);
    return { conversation: { ...conversation, participants: participants(conversation.id) }, messages: [message] };
  });
  recordSignal(req, user.id, 'message', { conversation_id: result.conversation.id, created: true });
  res.status(201).json(result);
});

router.get('/conversations/:id', (req, res) => {
  const user = requireUser(req);
  const conversationId = identifier.parse(param(req));
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    before: identifier.optional(),
  }).parse(req.query);
  const conversation = memberConversation(conversationId, user.id);
  const cursor = query.before
    ? one<{ created_at: string; row_number: number }>(
      'SELECT created_at,rowid AS row_number FROM messages WHERE id=? AND conversation_id=?',
      query.before, conversationId,
    )
    : undefined;
  if (query.before && !cursor) throw new HttpError(400, 'Le repère de pagination est invalide.');
  const messages = cursor
    ? all<Message>(`SELECT id,conversation_id,sender_id,body,created_at FROM messages
        WHERE conversation_id=? AND (created_at<? OR (created_at=? AND rowid<?))
        ORDER BY created_at DESC,rowid DESC LIMIT ?`,
      conversationId, cursor.created_at, cursor.created_at, cursor.row_number, query.limit + 1)
    : all<Message>(`SELECT id,conversation_id,sender_id,body,created_at FROM messages
        WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?`, conversationId, query.limit + 1);
  const page = messages.slice(0, query.limit).reverse();
  res.json({
    conversation: { ...conversation, participants: participants(conversationId) },
    reads: readReceipts(conversationId),
    messages: page,
    has_more: messages.length > query.limit,
    next_before: messages.length > query.limit ? page[0].id : null,
  });
});

router.post('/conversations/:id/messages', (req, res) => {
  const user = requireCapability(req, 'message');
  const conversationId = identifier.parse(param(req));
  const { body } = bodySchema.parse(req.body);
  const message = transaction(() => {
    const conversation = memberConversation(conversationId, user.id);
    const message: Message = { id: id(), conversation_id: conversationId, sender_id: user.id, body, created_at: now() };
    run('INSERT INTO messages (id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)',
      message.id, conversationId, user.id, body, message.created_at);
    // Sending implies having read the conversation up to this message.
    run(`INSERT INTO conversation_reads(conversation_id,user_id,last_read_at) VALUES (?,?,?)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_at=excluded.last_read_at`, conversationId, user.id, message.created_at);
    notifyMembers(conversation, user.id, user.name, body);
    publishMessage(conversation, message, user);
    return message;
  });
  recordSignal(req, user.id, 'message', { conversation_id: conversationId });
  res.status(201).json({ message });
});

/** Read receipt: marks the conversation (and its message notifications) as read and informs the participants. */
router.post('/conversations/:id/read', (req, res) => {
  const user = requireUser(req);
  const conversationId = identifier.parse(param(req));
  const result = transaction(() => {
    memberConversation(conversationId, user.id);
    const readAt = now();
    const previous = one<{ last_read_at: string }>('SELECT last_read_at FROM conversation_reads WHERE conversation_id=? AND user_id=?',
      conversationId, user.id);
    const latest = one<{ created_at: string }>('SELECT created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      conversationId);
    const cleared = Number(run(`UPDATE notifications SET read_at=? WHERE user_id=? AND kind='message' AND link=? AND read_at IS NULL`,
      readAt, user.id, conversationLink(conversationId)).changes);
    const advanced = !previous || (!!latest && latest.created_at > previous.last_read_at) || cleared > 0;
    if (advanced) {
      run(`INSERT INTO conversation_reads(conversation_id,user_id,last_read_at) VALUES (?,?,?)
        ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_at=excluded.last_read_at`, conversationId, user.id, readAt);
      for (const userId of memberIds(conversationId)) {
        publishToUser(userId, { type: 'conversation.read', data: { conversation_id: conversationId, user_id: user.id, read_at: readAt } });
      }
    }
    if (cleared) publishUnread(user.id);
    return {
      conversation_id: conversationId,
      last_read_at: advanced ? readAt : previous!.last_read_at,
      notifications_read: cleared,
      unread_count: unreadCount(user.id),
    };
  });
  res.json(result);
});

router.get('/notifications', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pageSchema.parse(req.query);
  const notifications = all<Notification>(`SELECT id,kind,title,body,link,read_at,created_at
    FROM notifications WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,
  user.id, limit + 1, offset);
  const unread = one<{ count: number }>(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL', user.id,
  )!;
  res.json({
    notifications: notifications.slice(0, limit).map(publicNotification),
    unread_count: unread.count,
    has_more: notifications.length > limit,
  });
});

router.post('/notifications/read-all', (req, res) => {
  const user = requireUser(req);
  const result = transaction(() => {
    const updated = run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), user.id);
    if (updated.changes) publishUnread(user.id);
    return updated;
  });
  res.json({ unread_count: 0, updated_count: Number(result.changes) });
});

router.post('/notifications/:id/read', (req, res) => {
  const user = requireUser(req);
  const notificationId = identifier.parse(param(req));
  const notification = transaction(() => {
    const unreadBefore = one('SELECT 1 FROM notifications WHERE id=? AND user_id=? AND read_at IS NULL', notificationId, user.id);
    const result = run('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?',
      now(), notificationId, user.id);
    if (!result.changes) throw new HttpError(404, 'Notification introuvable.');
    if (unreadBefore) publishUnread(user.id);
    return one<Notification>(`SELECT id,kind,title,body,link,read_at,created_at
      FROM notifications WHERE id=? AND user_id=?`, notificationId, user.id)!;
  });
  res.json({ notification: publicNotification(notification) });
});

registerPersonalData('communication', {
  description: 'Conversations privées, messages envoyés et notifications reçues.',
  export(userId) {
    return {
      conversations: all(`SELECT c.id,c.subject,c.created_at,c.created_by=? AS created_by_me FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY c.created_at`, userId, userId),
      // Only the user's own messages: other participants' messages are their personal data.
      messages_sent: all('SELECT id,conversation_id,body,created_at FROM messages WHERE sender_id=? ORDER BY created_at', userId),
      notifications: all('SELECT id,kind,title,body,link,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at', userId),
    };
  },
  erase(userId) {
    // Conversations stay readable for the other participants; the erased member's words are removed.
    run("UPDATE messages SET body='[message supprimé à la demande de son auteur]' WHERE sender_id=?", userId);
    run('DELETE FROM notifications WHERE user_id=?', userId);
  },
});

export default router;
