// 自分のテーマの変更（me-theme-update。docs/data-model.md の「書き込みの単位」の自分のテーマの変更）。
// 呼んだ人の users の行だけを、組織で絞って書く（入力に ID を取らないので、別の人の行は指せない）。
// マイプロフィールなので change_logs は書かない。最後に書いた値が残る
import { now } from '../../shared/clock.ts';
import { meThemeUpdate } from '../../shared/operations/organization/index.ts';
import { implement } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

export const meThemeUpdateOperation = implement(meThemeUpdate, async ({ db, actor, input }) => {
  const userId = actorUserIdOf(actor);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ theme: input.theme, updated_at: now().toISOString() })
        .where('id', '=', userId)
        .where('organization_id', '=', db.organizationId),
    ),
  ]);
  return { theme: input.theme };
});
