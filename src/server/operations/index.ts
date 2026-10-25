// 本番に登録する操作の一覧。定義は src/shared/operations/ に、処理はここに置く（docs/development.md の「操作の定義」）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { ImplementedOperation } from './implement.ts';
import { myOrganizationsOperation, organizationInfoOperation } from './organization.ts';
import { logoutOperation, meOperation } from './session.ts';

export const implementedOperations: readonly ImplementedOperation[] = [
  myOrganizationsOperation,
  organizationInfoOperation,
  meOperation,
  logoutOperation,
];
