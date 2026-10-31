import { createMyOrganization } from '../../shared/operations/organization/index.ts';
import { implement } from './implement.ts';

export const createMyOrganizationOperation = implement(createMyOrganization, async () => {
  throw new Error('未実装');
});
