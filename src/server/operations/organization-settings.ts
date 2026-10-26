// 組織の言葉づかいと既定のテーマの変更（docs/data-model.md の「書き込みの単位」の組織の設定の変更）。
// 共通の DB の organizations を組織の道具（writeOrganizationSettings）で書き、書けたら組織の DB の change_logs に別の batch() で残す
// （共通の表と組織の中の表は1回の batch() に混ぜない）。履歴を書けなくても、organizations を正として成功を返す
import { now } from '../../shared/clock.ts';
import { organizationSettingsUpdate } from '../../shared/operations/organization/index.ts';
import type { Theme } from '../../shared/theme.ts';
import type { Vocabulary } from '../../shared/vocabulary.ts';
import type { OrganizationDb, OrganizationSettingsChange } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

type SettingsChanges = {
  vocabulary?: readonly [Vocabulary, Vocabulary];
  theme?: readonly [Theme, Theme];
};

// 組織の変更の履歴に、管理者の操作として1行足す。書けなくても投げず、操作、action、組織の ID、前後の値、日時、例外の名前だけを
// ログに残す（例外の message に SQL や接続の詳細が混ざりうる）。organizations は書けているので、欠けた行はログから手で補える
async function logChange(
  db: OrganizationDb,
  log: { actorUserId: string; changes: SettingsChanges; at: Date },
): Promise<void> {
  const action = 'update';
  try {
    await db.batch([
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(log.at),
          organization_id: db.organizationId,
          workspace_id: null,
          actor_user_id: log.actorUserId,
          operator: null,
          entity_type: 'organization',
          entity_id: db.organizationId,
          action,
          changes_json: JSON.stringify(log.changes),
          created_at: log.at.toISOString(),
        }),
      ),
    ]);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        operation: organizationSettingsUpdate.name,
        reason: '組織の設定は書けたが、変更の履歴を書けなかった',
        action,
        organizationId: db.organizationId,
        changes: log.changes,
        at: log.at.toISOString(),
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}

// 順: 1. 画面が見ていた値（from）を入るときに引いた値（organization）と比べ、違えば 409。from と to が同じ項目は外す
// （書く項目が無ければ書かずに今の値を返す）  2. organizations を、停止しておらず from のままなら書く（入ってから書くまでに
// 停止されていたら 403、別の要求が変えていたら 409）  3. change_logs に残す（失敗しても成功を返す）
export const organizationSettingsUpdateOperation = implement(
  organizationSettingsUpdate,
  async ({ db, actor, organization, tools, input }) => {
    // permission: 'admin' は users の行がある管理者だけを通す。型の上の null を 404 で閉じる
    const actorUserId = actorUserIdOf(actor);
    // 画面が見ていた値が今の値と違えば、ほかの管理者が先に変えている（気づかずに上書きしない）
    if (
      (input.vocabulary !== undefined && input.vocabulary.from !== organization.vocabulary) ||
      (input.theme !== undefined && input.theme.from !== organization.theme)
    ) {
      throw new ApiError(409, 'conflict');
    }
    const change: { -readonly [K in keyof OrganizationSettingsChange]: OrganizationSettingsChange[K] } = {};
    const changes: SettingsChanges = {};
    if (input.vocabulary !== undefined && input.vocabulary.to !== input.vocabulary.from) {
      change.vocabulary = input.vocabulary;
      changes.vocabulary = [input.vocabulary.from, input.vocabulary.to];
    }
    if (input.theme !== undefined && input.theme.to !== input.theme.from) {
      change.theme = input.theme;
      changes.theme = [input.theme.from, input.theme.to];
    }
    const after = {
      vocabulary: change.vocabulary?.to ?? organization.vocabulary,
      theme: change.theme?.to ?? organization.theme,
    };
    if (change.vocabulary === undefined && change.theme === undefined) return after;

    const at = now();
    const written = await tools.writeOrganizationSettings(change, at);
    if (written === 'suspended') throw new ApiError(403, 'organization_suspended');
    if (written === 'conflict') throw new ApiError(409, 'conflict');
    await logChange(db, { actorUserId, changes, at });
    return after;
  },
);
