// 組織の選択と組織の枠、組織の管理の画面が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { myOrganizations } from './my-organizations.ts';
import { organizationInfo } from './organization.ts';
import { organizationHolidayAdd, organizationHolidayDelete, organizationHolidayList } from './organization-holiday.ts';
import { organizationSettingsUpdate } from './organization-settings.ts';

export {
  myOrganizations,
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationHolidayList,
  organizationInfo,
  organizationSettingsUpdate,
};

export const organizationOperations: readonly AnyOperationDefinition[] = [
  myOrganizations,
  organizationInfo,
  organizationHolidayList,
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationSettingsUpdate,
];
