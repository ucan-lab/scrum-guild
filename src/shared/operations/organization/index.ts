// 組織の選択と組織の枠が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { myOrganizations } from './my-organizations.ts';
import { organizationInfo } from './organization.ts';

export { myOrganizations, organizationInfo };

export const organizationOperations: readonly AnyOperationDefinition[] = [myOrganizations, organizationInfo];
