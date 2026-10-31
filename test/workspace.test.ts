// ワークスペースの作成、一覧、最初のリーダーの候補、枠の操作の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  workspaceCreate,
  workspaceInfo,
  workspaceLeaderCandidates,
  workspaceList,
} from '../src/shared/operations/workspace/index.ts';
import { ID_MAX_LENGTH } from '../src/shared/id.ts';
import { WORKSPACE_NAME_MAX_LENGTH } from '../src/shared/workspace.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  hash64,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 作る操作が書く6表
type WrittenTable =
  'workspaces' | 'workspace_point_rates' | 'board_columns' | 'detail_fields' | 'memberships' | 'change_logs';

// 組織の、作る操作が書く6表の行の数。作る前後で比べて、書かれていないことを確かめる。
// 組織で絞る（workspaces と change_logs は organization_id、ほかは workspace_id から辿る）
async function countRows(organization: OrganizationFixture): Promise<Record<WrittenTable, number>> {
  const db = orgDb(env, organization.verified);
  const organizationId = organization.id;
  const [workspaces, rates, columns, fields, memberships, logs] = await db.batch([
    db.statement((q) => q.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId)),
    db.statement((q) =>
      q
        .selectFrom('workspace_point_rates')
        .select('workspace_id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .select('id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) =>
      q
        .selectFrom('detail_fields')
        .select('id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) =>
      q
        .selectFrom('memberships')
        .select('id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) => q.selectFrom('change_logs').select('id').where('organization_id', '=', organizationId)),
  ] as const);
  return {
    workspaces: workspaces.rows.length,
    workspace_point_rates: rates.rows.length,
    board_columns: columns.rows.length,
    detail_fields: fields.rows.length,
    memberships: memberships.rows.length,
    change_logs: logs.rows.length,
  };
}

async function readCreated(organization: OrganizationFixture, workspaceId: string) {
  const db = orgDb(env, organization.verified);
  const [workspaces, rates, columns, fields, memberships, logs] = await db.batch([
    db.statement((q) => q.selectFrom('workspaces').selectAll().where('id', '=', workspaceId)),
    db.statement((q) => q.selectFrom('workspace_point_rates').selectAll().where('workspace_id', '=', workspaceId)),
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .orderBy('is_done')
        .orderBy('position'),
    ),
    db.statement((q) => q.selectFrom('detail_fields').selectAll().where('workspace_id', '=', workspaceId)),
    db.statement((q) => q.selectFrom('memberships').selectAll().where('workspace_id', '=', workspaceId)),
    db.statement((q) =>
      q.selectFrom('change_logs').selectAll().where('workspace_id', '=', workspaceId).orderBy('entity_type', 'desc'),
    ),
  ] as const);
  return {
    workspace: workspaces.rows[0],
    rates: rates.rows,
    columns: columns.rows,
    fields: fields.rows,
    memberships: memberships.rows,
    logs: logs.rows,
  };
}

type CreateInput = { name?: string; timezone?: string; leader_user_id: string };

function create(target: Target, token: string, input: CreateInput) {
  return post(app, workspaceCreate, {
    slug: target.slug,
    token,
    body: { name: '保守チーム', timezone: 'Asia/Tokyo', ...input },
  });
}

async function created(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspace_id: string }).workspace_id;
}

describe('workspace-create', () => {
  test('ワークスペース、換算比率、列4つ、決まった欄、最初のリーダーの所属、変更の履歴2行を1回で書く', async () => {
    const target = await createTarget();
    const leader = target.leader.userId!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T03:00:00.000Z'));

    const id = await created(await create(target, target.admin.token, { leader_user_id: leader }));
    const { workspace, rates, columns, fields, memberships, logs } = await readCreated(target.organization, id);

    expect(workspace).toMatchObject({
      id,
      organization_id: target.organization.id,
      name: '保守チーム',
      timezone: 'Asia/Tokyo',
      week_start: 1,
      vocabulary: 'scrum',
      definition_of_done_md: null,
      closed_at: null,
      created_by: target.admin.userId,
      created_at: '2026-10-25T03:00:00.000Z',
      updated_at: '2026-10-25T03:00:00.000Z',
    });
    expect(rates).toEqual([
      { workspace_id: id, effective_month: '2026-10', hours_per_point: 4, created_at: '2026-10-25T03:00:00.000Z' },
    ]);
    // 完了の列が末尾。完了の列は name が空で、位置は他の列より後
    expect(columns.map((column) => [column.name, column.is_done])).toEqual([
      ['未着手', 0],
      ['作業中', 0],
      ['レビュー', 0],
      [null, 1],
    ]);
    expect(new Set(columns.map((column) => column.position)).size).toBe(4);
    const ordered = [...columns].sort((a, b) => (a.position < b.position ? -1 : 1));
    expect(ordered.map((column) => column.is_done)).toEqual([0, 0, 0, 1]);
    expect(fields.map((field) => field.name)).toEqual(['受け入れ基準']);
    expect(fields[0]?.position).toBeTruthy();
    expect(memberships).toEqual([
      {
        id: expect.any(String),
        workspace_id: id,
        user_id: leader,
        role: 'leader',
        joined_on: '2026-10-25',
        left_on: null,
        joined_at: '2026-10-25T03:00:00.000Z',
        left_at: null,
      },
    ]);

    // 変更の履歴は2行だけ。既定の列、欄、換算比率は残さない
    expect(logs).toHaveLength(2);
    const [workspaceLog, membershipLog] = logs;
    expect(workspaceLog).toMatchObject({
      organization_id: target.organization.id,
      workspace_id: id,
      actor_user_id: target.admin.userId,
      operator: null,
      entity_type: 'workspace',
      entity_id: id,
      action: 'create',
    });
    // vocabulary が入らないことも、完全一致で固定する
    expect(JSON.parse(workspaceLog!.changes_json)).toEqual({
      name: [null, '保守チーム'],
      timezone: [null, 'Asia/Tokyo'],
    });
    expect(membershipLog).toMatchObject({
      actor_user_id: target.admin.userId,
      entity_type: 'membership',
      entity_id: memberships[0]?.id,
      action: 'create',
    });
    expect(JSON.parse(membershipLog!.changes_json)).toEqual({
      user: [null, { id: leader, name: expect.any(String) }],
      role: [null, 'leader'],
    });
  });

  test('入力に vocabulary を足して送っても捨てられ、DB の vocabulary 列は scrum で、列と決まった欄の名前もスクラムの言葉になる', async () => {
    const target = await createTarget();
    const res = await post(app, workspaceCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { name: '保守チーム', timezone: 'Asia/Tokyo', vocabulary: 'game', leader_user_id: target.leader.userId! },
    });
    const id = await created(res);
    const { workspace, columns, fields } = await readCreated(target.organization, id);
    expect(workspace?.vocabulary).toBe('scrum');
    expect(columns.map((column) => column.name)).toEqual(['未着手', '作業中', 'レビュー', null]);
    expect(fields.map((field) => field.name)).toEqual(['受け入れ基準']);
  });

  test('自分を最初のリーダーにすると、管理者の所属ができる。別の人にすると、管理者の所属の行はできない', async () => {
    const target = await createTarget();
    const self = await created(await create(target, target.admin.token, { leader_user_id: target.admin.userId! }));
    expect((await readCreated(target.organization, self)).memberships.map((row) => row.user_id)).toEqual([
      target.admin.userId,
    ]);

    const other = await created(await create(target, target.admin.token, { leader_user_id: target.member.userId! }));
    const { memberships } = await readCreated(target.organization, other);
    expect(memberships.map((row) => [row.user_id, row.role])).toEqual([[target.member.userId, 'leader']]);

    // 所属していない管理者は、そのワークスペースを開ける。ロールは空
    const info = await post(app, workspaceInfo, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: other },
    });
    expect(info.status).toBe(200);
    // 作った直後の完成の定義は空
    expect(await info.json()).toEqual({
      name: '保守チーム',
      closed_at: null,
      definition_of_done_md: null,
      role: null,
    });
    // 所属しない一般のユーザーは入れない
    const denied = await post(app, workspaceInfo, {
      slug: target.slug,
      token: target.bystander.token,
      body: { workspace_id: other },
    });
    expect(denied.status).toBe(403);
  });

  test('一般のユーザー（リーダー、メンバー、所属なし）は 403 で、行が入らない', async () => {
    const target = await createTarget();
    const before = await countRows(target.organization);
    for (const person of [target.leader, target.member, target.bystander]) {
      const res = await create(target, person.token, { leader_user_id: person.userId! });
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect(await countRows(target.organization)).toEqual(before);
  });

  describe('最初のリーダーが候補でないと、404 の not_found で、どの表にも行が入らない', () => {
    async function expectRejected(target: Target, leaderUserId: string): Promise<void> {
      const before = await countRows(target.organization);
      const res = await create(target, target.admin.token, { leader_user_id: leaderUserId });
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
      expect(await countRows(target.organization)).toEqual(before);
    }

    test('別の組織のユーザー', async () => {
      const [target, other] = await Promise.all([createTarget(), createTarget()]);
      await expectRejected(target, other.admin.userId!);
    });

    test('存在しないユーザー', async () => {
      await expectRejected(await createTarget(), 'no-such-user');
    });

    test('無効にされたユーザー', async () => {
      const target = await createTarget();
      const disabled = await createPerson({ organization: target.organization, disabled: true });
      await expectRejected(target, disabled.userId!);
    });

    test('Google で待っている行（login_subject が空）', async () => {
      const target = await createTarget();
      const waiting = await createUser(target.organization, {
        login_provider: 'google',
        login_subject: null,
        login_email: 'waiting@example.com',
        claim_token_hash: hash64(),
        claim_expires_at: '2026-11-19T00:00:00.000Z',
        name: 'waiting@example.com',
      });
      await expectRejected(target, waiting.id);
    });

    test('どのワークスペースにも所属していない一般のユーザー（組織に入れない人）', async () => {
      const target = await createTarget();
      const unaffiliated = await createUser(target.organization, { name: 'あおい' });
      await expectRejected(target, unaffiliated.id);
    });

    // 最初のリーダーを読む問い合わせの直後に、users の行を書き換える（読んでから書くまでの間に起きる変更）。
    // 入口の first は DbEntry.prototype にある
    function changeUserAfterLeaderRead(
      target: Target,
      leaderUserId: string,
      changedUserId: string,
      change: { disabled_at: string } | { is_admin: 0 },
    ): () => boolean {
      const entry = orgDb(env, target.organization.verified);
      const prototype = Object.getPrototypeOf(Object.getPrototypeOf(entry)) as {
        first: (this: unknown, ...args: unknown[]) => Promise<unknown>;
      };
      const original = prototype.first;
      let changed = false;
      vi.spyOn(prototype, 'first').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        const row = await original.apply(this, args);
        if (!changed && (row as { id?: string } | undefined)?.id === leaderUserId) {
          changed = true;
          const db = orgDb(env, target.organization.verified);
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('users')
                .set(change)
                .where('id', '=', changedUserId)
                .where('organization_id', '=', target.organization.id),
            ),
          ]);
        }
        return row;
      });
      return () => changed;
    }

    test('読んだ後に最初のリーダーが無効にされて、書く文の条件で行が入らなかったとき', async () => {
      const target = await createTarget();
      // 候補は今の所属がある人なので、ワークスペースのメンバーを指す
      const leader = target.member;
      const before = await countRows(target.organization);
      const changed = changeUserAfterLeaderRead(target, leader.userId!, leader.userId!, {
        disabled_at: '2026-10-25T00:00:00.000Z',
      });

      const res = await create(target, target.admin.token, { leader_user_id: leader.userId! });
      expect(changed()).toBe(true);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
      expect(await countRows(target.organization)).toEqual(before);
    });

    test.each([
      ['管理者を外された', { is_admin: 0 } as const],
      ['無効にされた', { disabled_at: '2026-10-25T00:00:00.000Z' }],
    ])('読んだ後に作る人が%sとき、書く文の条件で行が入らない', async (_label, change) => {
      const target = await createTarget();
      const leader = target.member;
      const before = await countRows(target.organization);
      const changed = changeUserAfterLeaderRead(target, leader.userId!, target.admin.userId!, change);

      const res = await create(target, target.admin.token, { leader_user_id: leader.userId! });
      expect(changed()).toBe(true);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
      expect(await countRows(target.organization)).toEqual(before);
    });
  });

  describe('タイムゾーン', () => {
    test.each(['Mars/Olympus', '+09:00', '-05:00', '+0900', '+9', '−05:00', '', ' Asia/Tokyo'])(
      '%j は 400 の invalid_input で、行が入らない',
      async (timezone) => {
        const target = await createTarget();
        const before = await countRows(target.organization);
        const res = await create(target, target.admin.token, { timezone, leader_user_id: target.leader.userId! });
        expect(res.status).toBe(400);
        expect(await errorCodeOf(res)).toBe('invalid_input');
        expect(await countRows(target.organization)).toEqual(before);
      },
    );

    test('大文字小文字は正規の名前で保存する（asia/tokyo は Asia/Tokyo）', async () => {
      const target = await createTarget();
      const id = await created(
        await create(target, target.admin.token, { timezone: 'asia/tokyo', leader_user_id: target.leader.userId! }),
      );
      expect((await readCreated(target.organization, id)).workspace?.timezone).toBe('Asia/Tokyo');
    });

    test('ブラウザが返す旧名（Asia/Calcutta）と UTC も受ける', async () => {
      const target = await createTarget();
      for (const timezone of ['Asia/Calcutta', 'UTC']) {
        const id = await created(
          await create(target, target.admin.token, { timezone, leader_user_id: target.leader.userId! }),
        );
        const saved = (await readCreated(target.organization, id)).workspace?.timezone;
        // Intl が解決した名前を保存する。時差の表記にはならない
        expect(saved).toBe(new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone);
        expect(saved).not.toMatch(/^[+-]/);
      }
    });
  });

  describe('名前', () => {
    test.each([
      ['空', ''],
      ['空白だけ', ' 　 \t'],
      [`${WORKSPACE_NAME_MAX_LENGTH + 1}字`, 'あ'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1)],
      [`絵文字の${WORKSPACE_NAME_MAX_LENGTH + 1}字`, '😀'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1)],
      ['ゼロ幅のスペースを含む', '保守\u{200B}チーム'],
      ['向きを変える文字を含む', '保守\u{202E}チーム'],
      ['行の区切りを含む', '保守\u{2028}チーム'],
      ['U+3164 だけ', '\u{3164}'],
      ['ゼロ幅のスペースだけ', '\u{200B}'],
      ['途中に改行を含む', '保守\nチーム'],
    ])('%s は 400 の invalid_input で、行が入らない', async (_label, name) => {
      const target = await createTarget();
      const before = await countRows(target.organization);
      const res = await create(target, target.admin.token, { name, leader_user_id: target.leader.userId! });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
      expect(await countRows(target.organization)).toEqual(before);
    });

    test('1字と上限ちょうどの字数は作れ、前後の空白は除いて保存する。同じ名前も作れる', async () => {
      const target = await createTarget();
      const names = new Map<string, string>([
        ['あ', 'あ'],
        ['あ'.repeat(WORKSPACE_NAME_MAX_LENGTH), 'あ'.repeat(WORKSPACE_NAME_MAX_LENGTH)],
        ['  保守チーム　', '保守チーム'],
        [` ${'あ'.repeat(WORKSPACE_NAME_MAX_LENGTH)} `, 'あ'.repeat(WORKSPACE_NAME_MAX_LENGTH)],
        // 字数はコードポイントで数える。絵文字は1字
        ['😀'.repeat(WORKSPACE_NAME_MAX_LENGTH), '😀'.repeat(WORKSPACE_NAME_MAX_LENGTH)],
      ]);
      for (const [sent, saved] of names) {
        const id = await created(
          await create(target, target.admin.token, { name: sent, leader_user_id: target.leader.userId! }),
        );
        expect((await readCreated(target.organization, id)).workspace?.name).toBe(saved);
      }
    });
  });

  test('ID の入力は長さの上限を超えると 400 の invalid_input', async () => {
    const target = await createTarget();
    const before = await countRows(target.organization);
    const res = await create(target, target.admin.token, { leader_user_id: 'a'.repeat(ID_MAX_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    const info = await post(app, workspaceInfo, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: 'a'.repeat(ID_MAX_LENGTH + 1) },
    });
    expect(info.status).toBe(400);
    expect(await countRows(target.organization)).toEqual(before);
  });

  describe('日付はワークスペースのタイムゾーンで決まる', () => {
    async function createAt(
      isoTime: string,
      timezone: string,
    ): Promise<{ joinedOn: string | undefined; effectiveMonth: string | undefined }> {
      const target = await createTarget();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(isoTime));
      const id = await created(
        await create(target, target.admin.token, { timezone, leader_user_id: target.leader.userId! }),
      );
      const { memberships, rates } = await readCreated(target.organization, id);
      vi.useRealTimers();
      return { joinedOn: memberships[0]?.joined_on, effectiveMonth: rates[0]?.effective_month };
    }

    test('日付の境目の前後で、東京は翌日になる', async () => {
      // 東京の 2026-10-25 23:59:59 と 2026-10-26 00:00:00
      expect(await createAt('2026-10-25T14:59:59.000Z', 'Asia/Tokyo')).toEqual({
        joinedOn: '2026-10-25',
        effectiveMonth: '2026-10',
      });
      expect(await createAt('2026-10-25T15:00:00.000Z', 'Asia/Tokyo')).toEqual({
        joinedOn: '2026-10-26',
        effectiveMonth: '2026-10',
      });
    });

    test('月の境目の前後で、作った月が変わる', async () => {
      expect(await createAt('2026-10-31T14:59:59.000Z', 'Asia/Tokyo')).toEqual({
        joinedOn: '2026-10-31',
        effectiveMonth: '2026-10',
      });
      expect(await createAt('2026-10-31T15:00:00.000Z', 'Asia/Tokyo')).toEqual({
        joinedOn: '2026-11-01',
        effectiveMonth: '2026-11',
      });
    });

    test('UTC より西のタイムゾーンでは、UTC の日付より前になる', async () => {
      // UTC では 2026-11-01 05:30。ロサンゼルスはまだ夏時間で 10-31 22:30
      expect(await createAt('2026-11-01T05:30:00.000Z', 'America/Los_Angeles')).toEqual({
        joinedOn: '2026-10-31',
        effectiveMonth: '2026-10',
      });
      expect(await createAt('2026-11-01T05:30:00.000Z', 'UTC')).toEqual({
        joinedOn: '2026-11-01',
        effectiveMonth: '2026-11',
      });
    });
  });
});

describe('workspace-list', () => {
  test('組織の全ワークスペース（閉じたものを含む）を、人数と作った日つきで返し、別の組織のものは返さない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const { organization, admin } = target;
    // 作った日はワークスペースのタイムゾーンの日付（UTC では 10-25 でも、東京では 10-26）
    const open = await createWorkspace(organization, admin.userId!, {
      name: '社内ツール',
      timezone: 'Asia/Tokyo',
      created_at: '2026-10-25T15:30:00.000Z',
    });
    const closed = await createWorkspace(organization, admin.userId!, {
      name: '旧サイト保守',
      timezone: 'America/Los_Angeles',
      created_at: '2026-10-01T03:00:00.000Z',
      closed_at: '2026-10-20T00:00:00.000Z',
    });
    const a = await createPerson({ organization });
    const b = await createPerson({ organization });
    const gone = await createPerson({ organization });
    await createMembership(organization, open.id, a.userId!, { role: 'leader' });
    await createMembership(organization, open.id, b.userId!, { role: 'member' });
    // 離れた人は数えない
    await createMembership(organization, open.id, gone.userId!, {
      role: 'leader',
      left_on: '2026-10-10',
      left_at: '2026-10-10T00:00:00.000Z',
    });
    // 無効の人と、login_subject が空の人（Google で待っている行）も数えない。メンバーの一覧に出ない人と数をそろえる
    const disabled = await createPerson({ organization, disabled: true });
    await createMembership(organization, open.id, disabled.userId!, { role: 'leader' });
    const waiting = await createUser(organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'waiting@example.com',
      claim_token_hash: hash64(),
      claim_expires_at: '2099-01-01T00:00:00.000Z',
      name: 'waiting@example.com',
    });
    await createMembership(organization, open.id, waiting.id, { role: 'member' });

    const res = await post(app, workspaceList, { slug: target.slug, token: admin.token });
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as {
      workspaces: {
        id: string;
        name: string;
        member_count: number;
        leader_count: number;
        created_on: string;
        closed_at: string | null;
      }[];
    };
    expect(workspaces.find((row) => row.id === open.id)).toEqual({
      id: open.id,
      name: '社内ツール',
      member_count: 2,
      leader_count: 1,
      created_on: '2026-10-26',
      closed_at: null,
    });
    expect(workspaces.find((row) => row.id === closed.id)).toEqual({
      id: closed.id,
      name: '旧サイト保守',
      member_count: 0,
      leader_count: 0,
      created_on: '2026-09-30',
      closed_at: '2026-10-20T00:00:00.000Z',
    });
    // 組織のワークスペースだけ（createTarget の2つと、上の2つ）
    expect(workspaces.map((row) => row.id).sort()).toEqual(
      [target.workspace.id, target.otherWorkspace.id, open.id, closed.id].sort(),
    );
    expect(workspaces.some((row) => row.id === other.workspace.id)).toBe(false);
  });

  test('保存されたタイムゾーンが Intl で作れない行があっても、一覧は 200 で、その行だけ UTC の日付にする', async () => {
    const target = await createTarget();
    const broken = await createWorkspace(target.organization, target.admin.userId!, {
      name: '壊れたタイムゾーン',
      timezone: 'Mars/Olympus',
      created_at: '2026-10-25T15:30:00.000Z',
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(app, workspaceList, { slug: target.slug, token: target.admin.token });
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as { workspaces: { id: string; created_on: string }[] };
    expect(workspaces.find((row) => row.id === broken.id)?.created_on).toBe('2026-10-25');
    // 例外の名前だけをログに残し、タイムゾーンの値と名前は出さない
    const logged = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('保存されたタイムゾーン'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ level: 'error', operation: 'workspace-list', error: 'RangeError' });
    expect(logged[0]).not.toContain('Mars');
    expect(logged[0]).not.toContain('壊れたタイムゾーン');
    // ほかの行は、それぞれのタイムゾーンの日付のまま
    expect(workspaces.find((row) => row.id === target.workspace.id)?.created_on).toBe('2026-10-20');
  });

  test('ワークスペースが無い組織は空の一覧を返す', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const res = await post(app, workspaceList, { slug: organization.slug, token: admin.token });
    expect(await res.json()).toEqual({ workspaces: [] });
  });
});

describe('workspace-leader-candidates', () => {
  test('いまこの組織に入れる人（管理者か、今の所属がある人）のうち、無効でなく login_subject のある人だけを、名前順に返す', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const { organization } = target;
    // どのワークスペースにも所属していない一般のユーザー（組織に入れない）
    const unaffiliated = await createUser(organization, { name: 'あおい' });
    const disabled = await createUser(organization, { name: 'かえで', disabled_at: '2026-10-21T00:00:00.000Z' });
    const waiting = await createUser(organization, {
      name: 'waiting@example.com',
      login_provider: 'google',
      login_subject: null,
      login_email: 'waiting@example.com',
      claim_token_hash: hash64(),
      claim_expires_at: '2026-11-19T00:00:00.000Z',
    });

    const res = await post(app, workspaceLeaderCandidates, { slug: target.slug, token: target.admin.token });
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as { users: { id: string; name: string }[] };
    const ids = users.map((user) => user.id);
    // 管理者と、どれかのワークスペースに今所属している人（リーダー、メンバー、別のワークスペースのメンバー）
    for (const person of [target.admin, target.leader, target.member, target.bystander]) {
      expect(ids).toContain(person.userId);
    }
    expect(ids).not.toContain(unaffiliated.id);
    expect(ids).not.toContain(disabled.id);
    expect(ids).not.toContain(waiting.id);
    expect(ids).not.toContain(other.admin.userId);
    expect(Object.keys(users[0]!).sort()).toEqual(['id', 'name']);
    const names = users.map((user) => user.name);
    expect(names).toEqual([...names].sort());
  });

  test('一般のユーザーは 403', async () => {
    const target = await createTarget();
    for (const person of [target.leader, target.member, target.bystander]) {
      const res = await post(app, workspaceLeaderCandidates, { slug: target.slug, token: person.token });
      expect(res.status).toBe(403);
    }
  });
});

describe('workspace', () => {
  async function read(target: Target, person: Person, workspaceId: string) {
    return post(app, workspaceInfo, { slug: target.slug, token: person.token, body: { workspace_id: workspaceId } });
  }

  test('名前、閉じた日時と、自分のロールを返す（vocabulary を含まない）', async () => {
    const target = await createTarget();
    const workspace = await createWorkspace(target.organization, target.admin.userId!, {
      name: '社内ツール',
      vocabulary: 'scrum',
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    await createMembership(target.organization, workspace.id, target.member.userId!, { role: 'member' });
    await createMembership(target.organization, workspace.id, target.leader.userId!, { role: 'leader' });

    const expected = {
      name: '社内ツール',
      closed_at: '2026-10-22T00:00:00.000Z',
      definition_of_done_md: null,
    };
    expect(await (await read(target, target.member, workspace.id)).json()).toEqual({ ...expected, role: 'member' });
    expect(await (await read(target, target.leader, workspace.id)).json()).toEqual({ ...expected, role: 'leader' });
    expect(await (await read(target, target.admin, workspace.id)).json()).toEqual({ ...expected, role: null });
  });

  test('存在しない ID と別の組織の ID は 404', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    for (const id of ['no-such-workspace', other.workspace.id]) {
      const res = await read(target, target.admin, id);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });
});
