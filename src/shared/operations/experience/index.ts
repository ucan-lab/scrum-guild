// 経験値とレベルの操作の定義（自分の設定の画面と、バックログの画面のチーム全体の合計）
import type { AnyOperationDefinition } from '../define.ts';
import {
  EXPERIENCE_GRANTS_PAGE_SIZE,
  experienceGrants,
  experienceSummary,
  experienceTeamTotal,
  type ExperienceGrant,
} from './experience.ts';

export { EXPERIENCE_GRANTS_PAGE_SIZE, experienceGrants, experienceSummary, experienceTeamTotal, type ExperienceGrant };

export const experienceOperations: readonly AnyOperationDefinition[] = [
  experienceSummary,
  experienceGrants,
  experienceTeamTotal,
];
