/**
 * GDPR registry. Every module that stores personal data registers a handler at import time.
 * OWNER of orchestration (export archive, deletion requests, anonymization): privacy module.
 *  - export(userId): JSON-serialisable data about the user (no secrets, no other users' private data).
 *  - erase(userId): synchronous DB writes run inside the anonymization transaction. Delete or scrub personal
 *    data; KEEP financial/ledger/audit rows required by law (they reference the anonymized user id).
 */
export interface PersonalDataHandler {
  description: string;
  export(userId: string): unknown;
  erase(userId: string): void;
}

const handlers = new Map<string, PersonalDataHandler>();

export function registerPersonalData(name: string, handler: PersonalDataHandler) { handlers.set(name, handler); }
export function personalDataHandlers(): [string, PersonalDataHandler][] { return [...handlers]; }
