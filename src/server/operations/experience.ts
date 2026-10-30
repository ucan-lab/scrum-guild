import { XP_TASK_CREATED, levelOf, levelStartOf, type ExperienceAction } from '../../shared/experience.ts';
import {
  EXPERIENCE_GRANTS_PAGE_SIZE,
  experienceGrants,
  experienceSummary,
  experienceTeamTotal,
} from '../../shared/operations/experience/index.ts';
import { MIN_POINTS_FOR_EXPERIENCE } from '../../shared/task.ts';
import type { OrganizationDb } from '../db/index.ts';
import { implement } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

// 経験値の読み方（docs/data-model.md の「経験値の読み方」）。合計は xp_grants の SUM(amount) で、組織の中の表だけを読む。
// xp_grants は organization_id を持たないので、結合した workspaces.organization_id を入口の組織で絞る。
// ほかの人の数値と明細は返さない。人ごとの合計を読むのは、レベルを出す member-list、organization、epic-detail（討伐隊）だけで、数値は応答に入れない

// 1人の、組織の中の経験値の合計（抜けたワークスペースと閉じたワークスペースの分も含む）。行が無ければ 0。
// 索引 xp_grants_user_workspace_amount（user_id, workspace_id, amount）だけで読む
export function userExperienceTotalStatement(db: OrganizationDb, userId: string) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('xp_grants as g')
      .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('g.amount'), eb.lit(0)).as('total'))
      .where('g.user_id', '=', userId)
      .where('w.organization_id', '=', organizationId),
  );
}

// ワークスペースに今所属している人ごとの、組織の中の経験値の合計。明細の無い人は行を返さない（合計 0 として扱う）。
// メンバーの一覧のレベルに使う。人数によらず束縛は2つで、D1 の1文あたりの上限に当たらない
export function memberExperienceTotalsStatement(db: OrganizationDb, workspaceId: string) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('xp_grants as g')
      .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
      .select((eb) => ['g.user_id', eb.fn.sum<number>('g.amount').as('total')])
      .where('w.organization_id', '=', organizationId)
      .where('g.user_id', 'in', (eb) =>
        eb
          .selectFrom('memberships as m')
          .innerJoin('workspaces as mw', 'mw.id', 'm.workspace_id')
          .select('m.user_id')
          .where('m.workspace_id', '=', workspaceId)
          .where('m.left_at', 'is', null)
          .where('mw.organization_id', '=', organizationId),
      )
      .groupBy('g.user_id'),
  );
}

// エピックの討伐隊の人ごとの、組織の中の経験値の合計。討伐隊は抜けた人も含みうるので、今の所属でなく討伐隊の行で絞る。
// 明細の無い人は行を返さない（合計 0 として扱う）。エピックはワークスペースで絞って引く（別のワークスペースの討伐隊を読まない）
export function epicPartyExperienceTotalsStatement(db: OrganizationDb, workspaceId: string, epicId: string) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('xp_grants as g')
      .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
      .select((eb) => ['g.user_id', eb.fn.sum<number>('g.amount').as('total')])
      .where('w.organization_id', '=', organizationId)
      .where('g.user_id', 'in', (eb) =>
        eb
          .selectFrom('epic_party_members as p')
          .innerJoin('epics as e', 'e.id', 'p.epic_id')
          .select('p.user_id')
          .where('p.epic_id', '=', epicId)
          .where('e.workspace_id', '=', workspaceId),
      )
      .groupBy('g.user_id'),
  );
}

// SUM と COUNT の結果を数にする（D1 は整数で返す。null と数でない値は 0 として扱う）。合計を読むどの処理もこれを使う
export function amountOf(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

// 名前の昇順、同じ名前は ID の昇順。JavaScript の文字列の比較（UTF-16 の符号単位の順）で並べる。
// 内訳は2つの文の結果を合わせて作るので、SQL では並べない
function byNameThenId(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const experienceSummaryOperation = implement(experienceSummary, async ({ db, actor }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;

  const [grantResult, membershipResult, prospectiveResult, thanksResult] = await db.batch([
    // ワークスペースごとの確定の合計（明細のあるワークスペース）
    db.statement((q) =>
      q
        .selectFrom('xp_grants as g')
        .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
        .select((eb) => ['w.id', 'w.name', eb.fn.sum<number>('g.amount').as('total')])
        .where('g.user_id', '=', userId)
        .where('w.organization_id', '=', organizationId)
        .groupBy(['w.id', 'w.name']),
    ),
    // 今所属しているワークスペース（閉じたものも含む）。明細が無くても内訳に 0 で出す
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id', 'w.name'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', organizationId),
    ),
    // 見込み。今所属している閉じていないワークスペースで、自分が手で作った、未完了の、削除していない、ポイントが1以上のタスクの件数。
    // 実行計画は、部分索引 tasks_created_by_open（created_by, completed_at）から本人の未完了のタスクだけを引き、memberships_current で今の所属を確かめる。
    // 手で作ったタスクはいつもバックログにある（tasks の CHECK）ので、tray = 'backlog' は結果を変えない念押しの条件
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .innerJoin('tasks as t', 't.workspace_id', 'm.workspace_id')
        .select((eb) => ['m.workspace_id', eb.fn.countAll<number>().as('count')])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', organizationId)
        .where('w.closed_at', 'is', null)
        .where('t.tray', '=', 'backlog')
        .where('t.deleted_at', 'is', null)
        .where('t.is_imported', '=', 0)
        .where('t.created_by', '=', userId)
        .where('t.completed_at', 'is', null)
        .where('t.points', '>=', MIN_POINTS_FOR_EXPERIENCE)
        .groupBy('m.workspace_id'),
    ),
    // 受け取った感謝の数。送られた相手が本人の行だけを、ワークスペースごとに数える（抜けたワークスペースも含む）。
    // 索引 thanks_recipient_user で本人の行を引き、結合した workspaces.organization_id を入口の組織で絞る
    db.statement((q) =>
      q
        .selectFrom('thanks as th')
        .innerJoin('workspaces as w', 'w.id', 'th.workspace_id')
        .select((eb) => ['w.id', 'w.name', eb.fn.countAll<number>().as('count')])
        .where('th.recipient_user_id', '=', userId)
        .where('w.organization_id', '=', organizationId)
        .groupBy(['w.id', 'w.name']),
    ),
  ] as const);

  const workspaces = new Map<
    string,
    { id: string; name: string; total: number; prospective: number; thanks_received: number }
  >();
  const empty = (id: string, name: string) => ({ id, name, total: 0, prospective: 0, thanks_received: 0 });
  for (const row of grantResult.rows) {
    workspaces.set(row.id, { ...empty(row.id, row.name), total: amountOf(row.total) });
  }
  for (const row of membershipResult.rows) {
    if (!workspaces.has(row.id)) workspaces.set(row.id, empty(row.id, row.name));
  }
  for (const row of thanksResult.rows) {
    const workspace = workspaces.get(row.id) ?? empty(row.id, row.name);
    workspace.thanks_received = amountOf(row.count);
    workspaces.set(row.id, workspace);
  }
  for (const row of prospectiveResult.rows) {
    const workspace = workspaces.get(row.workspace_id);
    if (workspace !== undefined) workspace.prospective = amountOf(row.count) * XP_TASK_CREATED;
  }

  const rows = [...workspaces.values()].sort(byNameThenId);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const prospective = rows.reduce((sum, row) => sum + row.prospective, 0);
  const thanksReceived = rows.reduce((sum, row) => sum + row.thanks_received, 0);
  const level = levelOf(total);
  return {
    total,
    level,
    level_start: levelStartOf(level),
    next_level_at: levelStartOf(level + 1),
    prospective,
    thanks_received: thanksReceived,
    workspaces: rows,
  };
});

export const experienceGrantsOperation = implement(experienceGrants, async ({ db, actor, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const before = input.before;

  // 1件多く読んで、続きがあるかを知る。内容は、付与が指すタスク、ストーリー、エピックのタイトル（削除したものも、論理削除なので残る）。
  // 結合する行も、付与と同じワークスペースのものに絞る。今所属していないワークスペース（抜けた、所属していない管理者）の行は、
  // 内容を null にして content_hidden を立てる（抜けた後のタイトルを読ませない）。ワークスペースの名前と値は出す
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants as g')
        .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
        .leftJoin('tasks as t', (join) =>
          join.onRef('t.id', '=', 'g.task_id').onRef('t.workspace_id', '=', 'g.workspace_id'),
        )
        .leftJoin('stories as s', (join) =>
          join.onRef('s.id', '=', 'g.story_id').onRef('s.workspace_id', '=', 'g.workspace_id'),
        )
        .leftJoin('epics as e', (join) =>
          join.onRef('e.id', '=', 'g.epic_id').onRef('e.workspace_id', '=', 'g.workspace_id'),
        )
        // 今の所属（memberships_current で一意）
        .leftJoin('memberships as m', (join) =>
          join.onRef('m.workspace_id', '=', 'g.workspace_id').on('m.user_id', '=', userId).on('m.left_at', 'is', null),
        )
        .select((eb) => [
          'g.id',
          'g.confirmed_at',
          'g.workspace_id',
          'w.name as workspace_name',
          'g.action',
          'g.amount',
          'm.id as membership_id',
          eb
            .case()
            .when('m.id', 'is', null)
            .then(eb.val<string | null>(null))
            .else(eb.fn.coalesce('t.title', 's.title', 'e.title'))
            .end()
            .as('content'),
        ])
        .where('g.user_id', '=', userId)
        .where('w.organization_id', '=', organizationId)
        // 行値の比較にすると、SQLite が索引 xp_grants_user_confirmed の範囲にできる（OR に展開した書き方は範囲にならず、
        // カーソルより新しい側の項目を先頭から読み捨てる）
        .$if(before !== undefined, (qb) =>
          qb.where((eb) => eb(eb.refTuple('g.confirmed_at', 'g.id'), '<', eb.tuple(before!.confirmed_at, before!.id))),
        )
        .orderBy('g.confirmed_at', 'desc')
        .orderBy('g.id', 'desc')
        .limit(EXPERIENCE_GRANTS_PAGE_SIZE + 1),
    ),
  );

  const page = rows.slice(0, EXPERIENCE_GRANTS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    grants: page.map((row) => ({
      id: row.id,
      confirmed_at: row.confirmed_at,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      // action は列の CHECK が守る値。列挙に無い値が来ても、出力のスキーマ（z.enum）が 500 で止める
      action: row.action as ExperienceAction,
      content: row.membership_id === null ? null : row.content,
      content_hidden: row.membership_id === null,
      amount: row.amount,
    })),
    next:
      rows.length > EXPERIENCE_GRANTS_PAGE_SIZE && last !== undefined
        ? { confirmed_at: last.confirmed_at, id: last.id }
        : null,
  };
});

// チーム全体の合計。そのワークスペースの全員の明細の SUM(amount)（抜けた人の分も含む）。索引 xp_grants_workspace_user に乗る
export const experienceTeamTotalOperation = implement(experienceTeamTotal, async ({ db, workspace }) => {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('xp_grants as g')
        .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('g.amount'), eb.lit(0)).as('total'))
        .where('g.workspace_id', '=', workspace.workspaceId)
        .where('w.organization_id', '=', workspace.organizationId),
    ),
  );
  return { total: amountOf(row?.total) };
});
