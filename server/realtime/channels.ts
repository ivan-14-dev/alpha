import { z } from 'zod';
import { getSetting, setSetting } from '../platform/settings.js';

/**
 * Global admin switches for external notification channels. In-app notifications and realtime events
 * are never affected; transactional account emails (verification, reset) do not go through these hooks.
 */
export const MAIL_NOTIFICATIONS_SETTING = 'mail.notifications';
export const PUSH_CONFIG_SETTING = 'push.config';
export const PUSH_VAPID_SETTING = 'push.vapid';

const mailNotifications = z.object({ enabled: z.boolean() }).strict();
export const pushConfigSchema = z.object({
  enabled: z.boolean(),
  /** VAPID `sub` claim: https: URL or mailto: address. Empty = derive from APP_ORIGIN. */
  subject: z.string().max(255).refine((value) => value === '' || /^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(value), 'Sujet VAPID invalide.'),
  ttl_seconds: z.number().int().min(60).max(2419200),
}).strict();
export type PushConfig = z.infer<typeof pushConfigSchema>;
const defaultPushConfig: PushConfig = { enabled: true, subject: '', ttl_seconds: 86400 };

export function emailNotificationsEnabled(): boolean {
  return getSetting(MAIL_NOTIFICATIONS_SETTING, mailNotifications, { enabled: true }).enabled;
}

export function pushConfig(): PushConfig {
  return getSetting(PUSH_CONFIG_SETTING, pushConfigSchema, defaultPushConfig);
}

export function pushEnabled(): boolean { return pushConfig().enabled; }

/** Must run inside the caller's transaction (with the audit row). */
export function setChannels(input: { email_notifications?: boolean; push?: boolean }, actorId: string) {
  if (input.email_notifications !== undefined) setSetting(MAIL_NOTIFICATIONS_SETTING, { enabled: input.email_notifications }, actorId);
  if (input.push !== undefined) setSetting(PUSH_CONFIG_SETTING, { ...pushConfig(), enabled: input.push }, actorId);
}

export function channelsStatus() {
  return { email_notifications: emailNotificationsEnabled(), push: pushEnabled() };
}
