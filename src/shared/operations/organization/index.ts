// 組織の選択と組織の枠、組織の管理の画面が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { meThemeUpdate } from './me-theme-update.ts';
import { myOrganizations } from './my-organizations.ts';
import { organizationInfo } from './organization.ts';
import { organizationHistory } from './organization-history.ts';
import { organizationHolidayAdd, organizationHolidayDelete, organizationHolidayList } from './organization-holiday.ts';
import { organizationSettingsUpdate } from './organization-settings.ts';
import { userAdminUpdate, userDisable, userEnable, userList } from './user.ts';
import { today } from './today.ts';

export {
  meThemeUpdate,
  myOrganizations,
  organizationHistory,
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationHolidayList,
  organizationInfo,
  organizationSettingsUpdate,
  userAdminUpdate,
  userDisable,
  userEnable,
  userList,
  today,
};

export const organizationOperations: readonly AnyOperationDefinition[] = [
  myOrganizations,
  organizationInfo,
  meThemeUpdate,
  organizationHolidayList,
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationSettingsUpdate,
  organizationHistory,
  userList,
  userAdminUpdate,
  userDisable,
  userEnable,
  today,
];
