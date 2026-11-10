import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { all } from '../db.js';
import { HttpError } from '../core.js';
import { legalDocuments, type LegalDocument } from '../platform/legal.js';
import { appOrigin } from '../platform/settings.js';
import { escapeMarkdown, headingsOf, parseMarkdown, type Block } from './markdown.js';
import { controllerIdentity, controllerLabels, type ControllerIdentity } from './settings.js';

/**
 * Legal templates live in docs/legal/*.md (versions MUST match server/platform/legal.ts). They contain
 * `{{placeholders}}` replaced by the controller identity stored in settings `privacy.controller`.
 * `legal_notice` (mentions légales, LCEN art. 6) is informative only: it is never "accepted".
 */
export const legalNotice = { version: '2026-11-v4', title: 'Mentions légales', required: false } as const;
export type LegalSlug = LegalDocument | 'legal_notice';

export const legalFiles: Record<LegalSlug, string> = {
  terms: 'conditions-generales.md',
  privacy: 'confidentialite.md',
  payments: 'paiements.md',
  tester_charter: 'charte-testeur.md',
  seller_terms: 'conditions-vendeur.md',
  legal_notice: 'mentions-legales.md',
};

export const legalSlugs = Object.keys(legalFiles) as LegalSlug[];
export const isLegalSlug = (value: string): value is LegalSlug => Object.hasOwn(legalFiles, value);
export const isAcceptable = (slug: LegalSlug): slug is LegalDocument => slug !== 'legal_notice';

export function legalInfo(slug: LegalSlug) {
  return isAcceptable(slug) ? legalDocuments[slug] : legalNotice;
}

export function legalDirectory(): string {
  return process.env.LEGAL_DOCS_DIR ? path.resolve(process.env.LEGAL_DOCS_DIR) : fileURLToPath(new URL('../../docs/legal/', import.meta.url));
}

const cache = new Map<string, { mtime: number; source: string }>();

function readTemplate(slug: LegalSlug): string {
  const file = path.join(legalDirectory(), legalFiles[slug]);
  if (!existsSync(file)) throw new HttpError(503, 'Ce document juridique n’est pas encore disponible. Contactez l’éditeur du service.');
  const mtime = statSync(file).mtimeMs;
  const cached = cache.get(file);
  if (cached && cached.mtime === mtime) return cached.source;
  const source = readFileSync(file, 'utf8');
  cache.set(file, { mtime, source });
  return source;
}

const placeholder = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Values from settings are flattened and Markdown-escaped: an admin cannot inject links or markup. */
export function substitute(source: string, values: Record<string, string>, labels: Record<string, string>) {
  return source.replace(placeholder, (match, key: string) => {
    if (!Object.hasOwn(values, key)) return match;
    const value = values[key]?.trim();
    return value ? escapeMarkdown(value) : `\\[à compléter : ${escapeMarkdown(labels[key] ?? key)}\\]`;
  });
}

function placeholderValues(slug: LegalSlug, controller: ControllerIdentity, updated: string) {
  const info = legalInfo(slug);
  return {
    values: { ...controller, app_url: appOrigin(), version: info.version, title: info.title, updated } as Record<string, string>,
    labels: { ...controllerLabels, app_url: 'adresse du service', version: 'version', title: 'titre', updated: 'date de mise à jour' } as Record<string, string>,
  };
}

export interface LegalDocumentView {
  slug: LegalSlug;
  title: string;
  version: string;
  required: boolean;
  acceptable: boolean;
  updated: string;
  content: string;
  blocks: Block[];
  toc: { id: string; level: number; text: string }[];
  missing: string[];
  file_version_mismatch: boolean;
}

export function renderLegalDocument(slug: LegalSlug): LegalDocumentView {
  const info = legalInfo(slug);
  const source = readTemplate(slug);
  const updated = parseMarkdown(source).meta.updated ?? '';
  const controller = controllerIdentity();
  const { values, labels } = placeholderValues(slug, controller, updated);
  const content = substitute(source, values, labels);
  const parsed = parseMarkdown(content);
  const missing = [...new Set([...source.matchAll(placeholder)].map((match) => match[1]))]
    .filter((key) => Object.hasOwn(controllerLabels, key) && !controller[key as keyof ControllerIdentity]?.trim())
    .map((key) => controllerLabels[key as keyof ControllerIdentity]);
  return {
    slug, title: info.title, version: info.version, required: info.required, acceptable: isAcceptable(slug),
    updated, content, blocks: parsed.blocks, toc: headingsOf(parsed.blocks), missing,
    file_version_mismatch: (parsed.meta.version ?? '') !== info.version,
  };
}

export function acceptancesFor(userId: string) {
  return all<{ document: string; version: string; accepted_at: string }>(
    'SELECT document,version,accepted_at FROM legal_acceptances WHERE user_id=? ORDER BY accepted_at DESC,document', userId)
    .map((row) => ({
      ...row,
      current: isLegalSlug(row.document) && legalInfo(row.document).version === row.version,
      title: isLegalSlug(row.document) ? legalInfo(row.document).title : row.document,
    }));
}

export function legalList(userId: string | null) {
  const accepted = userId ? acceptancesFor(userId) : [];
  return legalSlugs.map((slug) => {
    const info = legalInfo(slug);
    const mine = accepted.find((row) => row.document === slug && row.version === info.version);
    return {
      slug, title: info.title, version: info.version, required: info.required, acceptable: isAcceptable(slug),
      url: `/legal/${slug}`,
      accepted_at: mine?.accepted_at ?? null,
      pending: !!userId && isAcceptable(slug) && !mine,
    };
  });
}
