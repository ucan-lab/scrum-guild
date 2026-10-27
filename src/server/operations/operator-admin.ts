// 運用者による管理者の指名し直しの処理（Issue #217）。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータ（人の名前など）を入れない
import { organizationAdminReassign } from '../../shared/operations/operator/index.ts';
import { implement } from './implement.ts';

export const organizationAdminReassignOperation = implement(organizationAdminReassign, async () => {
  throw new Error('未実装');
});
