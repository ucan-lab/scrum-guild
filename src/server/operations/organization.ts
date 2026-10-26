import { now } from '../../shared/clock.ts';
import { levelOf } from '../../shared/experience.ts';
import { myOrganizations, organizationInfo } from '../../shared/operations/organization/index.ts';
import type { Theme } from '../../shared/theme.ts';
import { ApiError } from '../errors.ts';
import { amountOf, userExperienceTotalStatement } from './experience.ts';
import { implement } from './implement.ts';

// users.last_seen_at を書き直す間隔。組織の枠を開くたびに書かないための上限
const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000;

export const myOrganizationsOperation = implement(myOrganizations, async ({ account }) => {
  const { organizations, invitations } = await account.organizations();
  return { organizations: [...organizations], invitations: [...invitations], operator: await account.isOperator() };
});

export const organizationInfoOperation = implement(organizationInfo, async ({ db, actor, organization, defer }) => {
  // permission: 'organization' は users の行がある人だけを通す。型の上の null を 404 で閉じる
  const userId = actor.userId;
  if (userId === null) throw new ApiError(404, 'not_found');
  const at = now();
  const staleBefore = new Date(at.getTime() - LAST_SEEN_INTERVAL_MS).toISOString();

  // 画面に返す値を読む。書き込みは混ぜず、書き込みが失敗しても画面は開く
  const [userResult, workspaceResult, anyWorkspaceResult, experienceResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('users')
        .select(['id', 'name', 'theme'])
        .where('id', '=', userId)
        .where('organization_id', '=', db.organizationId),
    ),
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id', 'w.name', 'm.role'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .orderBy('w.name')
        .orderBy('w.id'),
    ),
    db.statement((q) =>
      q.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId).limit(1),
    ),
    // アカウントのメニューの紋章に出すレベルの元。合計そのものは返さない
    userExperienceTotalStatement(db, userId),
  ] as const);

  const user = userResult.rows[0];
  if (user === undefined) throw new ApiError(404, 'not_found');

  // 1時間に1回までの書き込み。応答を待たせない。条件は書く文の WHERE に入れ、並行した呼び出しの片方だけが書き、日時が巻き戻らない
  defer(() =>
    db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ last_seen_at: at.toISOString() })
          .where('id', '=', userId)
          .where('organization_id', '=', db.organizationId)
          .where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<=', staleBefore)])),
      ),
    ]),
  );

  return {
    // vocabulary と theme の形は出力のスキーマ（z.enum）が検証する
    organization: {
      name: organization.name,
      vocabulary: organization.vocabulary,
      theme: organization.theme,
      has_workspaces: anyWorkspaceResult.rows.length > 0,
    },
    me: {
      id: user.id,
      name: user.name,
      is_admin: actor.isAdmin,
      // 列の CHECK が守る値（組織の theme と同じ列挙）
      theme: user.theme as Theme | null,
      level: levelOf(amountOf(experienceResult.rows[0]?.total)),
    },
    workspaces: workspaceResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role === 'leader' ? ('leader' as const) : ('member' as const),
    })),
  };
});
