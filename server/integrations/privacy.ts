import { all, run } from '../db.js';
import { afterCommit } from '../platform/events.js';
import { registerPersonalData } from '../platform/privacy.js';
import { connectionTokens, type ConnectionRow } from './connections.js';
import { revokeAtProvider } from './providers.js';

registerPersonalData('integrations', {
  description: 'Comptes GitHub, GitLab et Figma connectés (sans jetons) et webhooks sortants créés (sans secrets).',
  export(userId) {
    return {
      connections: all(`SELECT id,provider,base_url,external_id,external_login,scopes,expires_at,created_at,updated_at,revoked_at
        FROM integration_connections WHERE user_id=? ORDER BY created_at`, userId),
      webhook_endpoints: all(`SELECT id,project_id,url,description,events,active,disabled_reason,created_at,updated_at
        FROM integration_webhook_endpoints WHERE owner_id=? ORDER BY created_at`, userId),
      project_sources_created: all(`SELECT id,project_id,provider,full_name,url,created_at FROM integration_project_sources
        WHERE created_by=? ORDER BY created_at`, userId),
    };
  },
  erase(userId) {
    const connections = all<ConnectionRow>('SELECT * FROM integration_connections WHERE user_id=? AND revoked_at IS NULL', userId);
    const tokens = connectionTokens(connections);
    run('UPDATE integration_project_sources SET created_by=NULL WHERE created_by=?', userId);
    run('DELETE FROM integration_oauth_states WHERE user_id=?', userId);
    run('DELETE FROM integration_webhook_endpoints WHERE owner_id=?', userId);
    run('DELETE FROM integration_connections WHERE user_id=?', userId);
    // Provider-side revocation is network work: only after the anonymization transaction commits.
    if (tokens.length) {
      afterCommit(async () => {
        for (const item of tokens) await revokeAtProvider(item.provider, item.base_url, item.token);
      });
    }
  },
});
