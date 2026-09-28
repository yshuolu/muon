import type { Scope } from '../shared/types';
import type { IdentityProvider } from './ports';

export class LocalIdentityProvider implements IdentityProvider {
  currentScope(): Scope { return { accountId: 'local-workspace', workspaceId: 'local-project', userId: 'local-owner' }; }
}
