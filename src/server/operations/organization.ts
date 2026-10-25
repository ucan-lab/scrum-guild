import { myOrganizations, organizationInfo } from '../../shared/operations/organization/index.ts';
import { isTheme, type Theme } from '../../shared/theme.ts';
import type { Vocabulary } from '../../shared/vocabulary.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

// users.last_seen_at を書き直す間隔。組織の枠を開くたびに書かないための上限
const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000;

// DB の CHECK が守っている値。列挙に無い値が来たら、画面に流さず 500 にする
function themeOf(value: string): Theme {
  if (!isTheme(value)) throw new Error('theme が列挙に無い');
  return value;
}

function vocabularyOf(value: string): Vocabulary {
  if (value !== 'game' && value !== 'scrum') throw new Error('vocabulary が列挙に無い');
  return value;
}

export const myOrganizationsOperation = implement(myOrganizations, async ({ account }) => {
  const { organizations, invitations } = await account.organizations();
  return { organizations: [...organizations], invitations: [...invitations], operator: await account.isOperator() };
});

export const organizationInfoOperation = implement(organizationInfo, async ({ db, actor, organization }) => {
  // permission: 'organization' は users の行がある人だけを通す。型の上の null を 404 で閉じる
  const userId = actor.userId;
  if (userId === null) throw new ApiError(404, 'not_found');
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LAST_SEEN_INTERVAL_MS).toISOString();

  // 1時間に1回までの書き込みは、書く文の WHERE に条件を入れる。並行した呼び出しの片方だけが書き、日時が巻き戻らない
  const [, userResult, workspaceResult] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ last_seen_at: now.toISOString() })
        .where('id', '=', userId)
        .where('organization_id', '=', db.organizationId)
        .where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<=', staleBefore)])),
    ),
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
  ] as const);

  const user = userResult.rows[0];
  if (user === undefined) throw new ApiError(404, 'not_found');
  return {
    organization: {
      name: organization.name,
      vocabulary: vocabularyOf(organization.vocabulary),
      theme: themeOf(organization.theme),
    },
    me: {
      id: user.id,
      name: user.name,
      is_admin: actor.isAdmin,
      theme: user.theme === null ? null : themeOf(user.theme),
    },
    workspaces: workspaceResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role === 'leader' ? ('leader' as const) : ('member' as const),
    })),
  };
});
