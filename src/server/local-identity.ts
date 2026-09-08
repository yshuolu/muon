import type { Scope } from '../shared/domain';
import type { IdentityProvider } from './ports';

export class LocalIdentityProvider implements IdentityProvider {
  currentScope(): Scope { return { workspaceId: 'local-workspace', projectId: 'local-project', userId: 'local-owner' }; }
}
