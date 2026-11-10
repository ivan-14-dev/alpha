import { z } from 'zod';
import { log } from '../platform/log.js';
import { getSetting, setSetting } from '../platform/settings.js';

/**
 * Sandbox configuration (setting `sandbox.config`, admin editable). The Docker endpoint itself is NOT editable from
 * the web console: it comes from the environment (ALPHA_SANDBOX_DOCKER_HOST...), so a compromised admin session cannot
 * point the platform at another daemon. ALPHA_SANDBOX_IMAGE_ALLOWLIST, when set, locks the image allowlist the same way.
 */
export const SETTING_KEY = 'sandbox.config';
export const placeholders = ['{input}', '{app}', '{entry}'] as const;
export const bounds = {
  timeout_s: [5, 3600], memory_mb: [32, 8192], cpus: [0.1, 8], pids: [16, 4096], tmpfs_mb: [8, 4096],
  max_concurrent: [1, 32], daily_quota: [1, 1000], max_pending_per_user: [1, 20], max_build_mb: [1, 1024],
  log_retention_days: [1, 3650], run_retention_days: [1, 3650],
} as const;

const component = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const registry = '(?:(?:localhost|[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+)(?::[0-9]{1,5})?/)';
const referencePattern = new RegExp(`^(${registry}?${component}(?:/${component})*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$`);
const prefixPattern = new RegExp(`^${registry}?${component}(?:/${component})*/\\*$`);
const relativePath = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export interface ImageReference { repository: string; tag: string | null; digest: string | null }

/** Parses `name[:tag][@sha256:digest]`. Returns null for anything that is not a plain, valid image reference. */
export function parseImage(reference: string): ImageReference | null {
  if (reference.length > 255) return null;
  const match = referencePattern.exec(reference);
  if (!match) return null;
  return { repository: match[1], tag: match[2] ?? null, digest: match[3] ?? null };
}

/** Pinned = an explicit version tag (never `latest`) or a content digest. */
export function isPinned(reference: string): boolean {
  const parsed = parseImage(reference);
  return !!parsed && (!!parsed.digest || (!!parsed.tag && parsed.tag !== 'latest'));
}

/** `alpine` and `library/alpine` both mean `docker.io/library/alpine`. */
export function normalizeRepository(repository: string): string {
  const parts = repository.split('/');
  const hasRegistry = parts.length > 1 && (parts[0] === 'localhost' || parts[0].includes('.') || parts[0].includes(':'));
  if (hasRegistry) return repository;
  return parts.length === 1 ? `docker.io/library/${repository}` : `docker.io/${repository}`;
}

/**
 * Allowlist entry: a repository (`alpine`, `ghcr.io/org/runner`) allowing any pinned version, an exact pin
 * (`alpine:3.20`, `alpine@sha256:…`), or a repository prefix ending with `/*` (`registry.internal/alpha/*`).
 */
export function validAllowlistEntry(entry: string): boolean {
  if (entry.endsWith('/*')) return prefixPattern.test(entry);
  const parsed = parseImage(entry);
  return !!parsed && parsed.tag !== 'latest';
}

let warnedEnvironment = '';

/** Deployment-level allowlist (comma separated). When set, the admin console cannot widen it. */
export function environmentAllowlist(): string[] | null {
  const raw = process.env.ALPHA_SANDBOX_IMAGE_ALLOWLIST?.trim();
  if (!raw) return null;
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const ignored = entries.filter((entry) => !validAllowlistEntry(entry));
  if (ignored.length && warnedEnvironment !== raw) {
    warnedEnvironment = raw;
    log.warn('sandbox.allowlist_entries_ignored', { entries: ignored });
  }
  return entries.filter(validAllowlistEntry);
}

export function effectiveAllowlist(config: Pick<SandboxConfig, 'allowed_images'>): string[] {
  return environmentAllowlist() ?? config.allowed_images;
}

/** Only pinned references can match; an exact-pin entry also requires the same tag (or digest). */
export function imageAllowed(reference: string, allowlist: string[]): boolean {
  const parsed = parseImage(reference);
  if (!parsed || !isPinned(reference)) return false;
  const repository = normalizeRepository(parsed.repository);
  return allowlist.some((entry) => {
    if (!validAllowlistEntry(entry)) return false;
    if (entry.endsWith('/*')) return repository.startsWith(`${normalizeRepository(entry.slice(0, -2))}/`);
    const allowed = parseImage(entry)!;
    if (normalizeRepository(allowed.repository) !== repository) return false;
    if (allowed.digest) return parsed.digest === allowed.digest;
    if (allowed.tag) return parsed.tag === allowed.tag;
    return true;
  });
}

const argument = z.string().min(1).max(512).refine((value) => !/[\0\n\r]/.test(value), 'Caractère interdit dans la commande.');
export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Identifiant de profil : minuscules, chiffres et tirets (2 à 40).'),
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  enabled: z.boolean().default(true),
  image: z.string().trim().min(1).max(255),
  command: z.array(argument).min(1).max(32),
  entry_candidates: z.array(z.string().max(200).regex(relativePath, 'Chemin relatif invalide.')).max(20).default([]),
  extract: z.boolean().default(true),
  timeout_s: z.number().int().min(bounds.timeout_s[0]).max(bounds.timeout_s[1]),
  memory_mb: z.number().int().min(bounds.memory_mb[0]).max(bounds.memory_mb[1]),
  cpus: z.number().min(bounds.cpus[0]).max(bounds.cpus[1]),
  pids: z.number().int().min(bounds.pids[0]).max(bounds.pids[1]),
  tmpfs_mb: z.number().int().min(bounds.tmpfs_mb[0]).max(bounds.tmpfs_mb[1]),
}).strict();
export type SandboxProfile = z.infer<typeof profileSchema>;

const int = (range: readonly [number, number]) => z.number().int().min(range[0]).max(range[1]);
const baseConfig = z.object({
  enabled: z.boolean(),
  runtime: z.enum(['docker', 'disabled']),
  oci_runtime: z.string().regex(/^[a-z][a-z0-9._-]{0,39}$/, 'Runtime OCI invalide (ex. runsc).').nullable(),
  input_mode: z.enum(['auto', 'bind', 'stdin']),
  max_concurrent: int(bounds.max_concurrent),
  daily_quota: int(bounds.daily_quota),
  max_pending_per_user: int(bounds.max_pending_per_user),
  max_build_mb: int(bounds.max_build_mb),
  require_clean_scan: z.boolean(),
  log_retention_days: int(bounds.log_retention_days),
  run_retention_days: int(bounds.run_retention_days),
  allowed_images: z.array(z.string().trim().max(255).refine(validAllowlistEntry,
    'Entrée de liste blanche invalide : dépôt (alpine), version exacte (alpine:3.20 ou @sha256:…, jamais latest) ou préfixe se terminant par /*.')).min(1).max(50),
  profiles: z.array(profileSchema).max(30),
}).strict();
export type SandboxConfig = z.infer<typeof baseConfig>;

/** Validates every cross-field rule. The image allowlist used is the environment one when it is locked. */
export const configSchema = baseConfig.superRefine((config, context) => {
  const allowlist = effectiveAllowlist(config);
  const seen = new Set<string>();
  config.profiles.forEach((profile, index) => {
    if (seen.has(profile.id)) context.addIssue({ code: 'custom', path: ['profiles', index, 'id'], message: `Le profil « ${profile.id} » est en double.` });
    seen.add(profile.id);
    if (!isPinned(profile.image)) {
      context.addIssue({ code: 'custom', path: ['profiles', index, 'image'], message: `Image « ${profile.image} » : épinglez une version (nom:tag autre que latest, ou digest sha256).` });
    } else if (!imageAllowed(profile.image, allowlist)) {
      context.addIssue({ code: 'custom', path: ['profiles', index, 'image'], message: `Image « ${profile.image} » absente de la liste blanche.` });
    }
    profile.command.forEach((value, position) => {
      const tokens = value.match(/\{[^}]*\}/g) ?? [];
      if (tokens.length && (tokens.length > 1 || value !== tokens[0] || !(placeholders as readonly string[]).includes(tokens[0]))) {
        context.addIssue({ code: 'custom', path: ['profiles', index, 'command', position],
          message: 'Les variables {input}, {app} et {entry} doivent occuper un argument entier ; aucune autre variable n’est permise.' });
      }
    });
    if (profile.command.includes('{entry}') && profile.extract && profile.entry_candidates.length === 0) {
      context.addIssue({ code: 'custom', path: ['profiles', index, 'entry_candidates'], message: 'Indiquez au moins un point d’entrée possible pour les archives.' });
    }
  });
  if (config.run_retention_days < config.log_retention_days) {
    context.addIssue({ code: 'custom', path: ['run_retention_days'], message: 'La conservation des exécutions doit être au moins égale à celle des journaux.' });
  }
});

export const defaultProfiles: SandboxProfile[] = [
  {
    id: 'linux-shell', label: 'Linux (script shell ou binaire statique)', enabled: true,
    description: 'Exécute un script shell ou un binaire Linux statique (x86-64/arm64 selon l’hôte). Archive : alpha-test.sh, test.sh, run.sh ou start.sh.',
    image: 'alpine:3.20', command: ['{entry}'], entry_candidates: ['alpha-test.sh', 'test.sh', 'run.sh', 'start.sh'], extract: true,
    timeout_s: 60, memory_mb: 256, cpus: 0.5, pids: 64, tmpfs_mb: 128,
  },
  {
    id: 'node', label: 'Node.js 22', enabled: true,
    description: 'Lance un fichier JavaScript avec node. Archive : alpha-test.js, index.js, main.js… Les dépendances doivent être incluses (aucun accès réseau, pas de npm install).',
    image: 'node:22-alpine', command: ['node', '{entry}'],
    entry_candidates: ['alpha-test.js', 'test.js', 'index.js', 'main.js', 'server.js', 'app.js', 'index.mjs', 'dist/index.js', 'src/index.js'], extract: true,
    timeout_s: 120, memory_mb: 512, cpus: 1, pids: 128, tmpfs_mb: 256,
  },
  {
    id: 'python', label: 'Python 3.12', enabled: true,
    description: 'Lance un script Python. Archive : alpha_test.py, main.py, app.py… Les bibliothèques tierces doivent être embarquées (pas de pip install).',
    image: 'python:3.12-alpine', command: ['python', '-B', '-E', '-s', '{entry}'],
    entry_candidates: ['alpha_test.py', 'test.py', 'main.py', 'app.py', '__main__.py', 'src/main.py'], extract: true,
    timeout_s: 120, memory_mb: 512, cpus: 1, pids: 128, tmpfs_mb: 256,
  },
  {
    id: 'java', label: 'Java 21 (JAR exécutable)', enabled: true,
    description: 'Lance un JAR exécutable (java -jar) avec le JRE Temurin 21.',
    image: 'eclipse-temurin:21-jre-alpine',
    command: ['java', '-XX:+UseSerialGC', '-XX:MaxRAMPercentage=75', '-XX:-UsePerfData', '-Djava.io.tmpdir=/tmp', '-jar', '{input}'],
    entry_candidates: [], extract: false,
    timeout_s: 120, memory_mb: 768, cpus: 1, pids: 128, tmpfs_mb: 256,
  },
];

export const defaultConfig: SandboxConfig = {
  enabled: false,
  runtime: 'docker',
  oci_runtime: null,
  input_mode: 'auto',
  max_concurrent: 2,
  daily_quota: 20,
  max_pending_per_user: 3,
  max_build_mb: 100,
  require_clean_scan: false,
  log_retention_days: 30,
  run_retention_days: 180,
  allowed_images: ['alpine', 'node', 'python', 'eclipse-temurin'],
  profiles: defaultProfiles,
};

export function sandboxConfig(): SandboxConfig {
  return getSetting<SandboxConfig>(SETTING_KEY, baseConfig, defaultConfig);
}

export class ConfigError extends Error {}

/** Throws a French, field-specific ConfigError when invalid. */
export function validateConfig(input: unknown): SandboxConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')} : ` : '';
    throw new ConfigError(`${where}${issue.message}`);
  }
  return parsed.data;
}

/** Must be called inside the caller's transaction (paired with audit()). */
export function saveConfig(config: SandboxConfig, actorId: string) {
  setSetting(SETTING_KEY, config, actorId);
}

export function sandboxActive(config: SandboxConfig): boolean {
  return config.enabled && config.runtime !== 'disabled';
}

/** `/tmp` is small noexec scratch space; `/work` (build copy + extraction) gets the profile's full tmpfs size. */
export function tmpSizeMb(profile: Pick<SandboxProfile, 'tmpfs_mb'>): number {
  return Math.max(8, Math.min(64, Math.floor(profile.tmpfs_mb / 4)));
}
