// エピックの読み取り（ダイアログの欄と、画面の中身）、作成、変更、並べ替え、削除、討伐隊の受注、抜ける、割り振り、
// クリア報酬の段階と依頼主の変更の操作の定義。クリアと中止は #65 で足す
import type { AnyOperationDefinition } from '../define.ts';
import { epicCreate } from './epic-create.ts';
import { epicDelete } from './epic-delete.ts';
import { epicDetail } from './epic-detail.ts';
import { epicGet } from './epic-get.ts';
import { epicMove } from './epic-move.ts';
import { epicPartyAssign, epicPartyJoin, epicPartyLeave } from './epic-party.ts';
import { epicRequesterUpdate, epicRewardUpdate } from './epic-reward.ts';
import { epicUpdate } from './epic-update.ts';

export {
  epicCreate,
  epicDelete,
  epicDetail,
  epicGet,
  epicMove,
  epicPartyAssign,
  epicPartyJoin,
  epicPartyLeave,
  epicRequesterUpdate,
  epicRewardUpdate,
  epicUpdate,
};
export { epicJoinedVias, type EpicJoinedVia } from './epic-detail.ts';
export { epicDetailSchema, type EpicDetail } from './epic.ts';

export const epicOperations: readonly AnyOperationDefinition[] = [
  epicCreate,
  epicGet,
  epicDetail,
  epicUpdate,
  epicMove,
  epicDelete,
  epicPartyJoin,
  epicPartyLeave,
  epicPartyAssign,
  epicRewardUpdate,
  epicRequesterUpdate,
];
