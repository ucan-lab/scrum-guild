// 組織の変更の履歴（organization-history）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { WAITING_USER_NAME_IN_LOG } from '../src/shared/claim-token.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  ORGANIZATION_HISTORY_PAGE_SIZE,
  organizationHistory,
} from '../src/shared/operations/organization/organization-history.ts';
import { workspaceClose, workspaceCreate, workspaceReopen } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { designateAdmin } from '../src/server/organizations/designate-admin.ts';
import { createAccount, createChangeLog, createUser, uuidv7, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, OPERATOR_LOGIN_ID, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type History = OutputOf<typeof organizationHistory>;
type Cursor = NonNullable<History['next']>;

function call(target: Target, body: unknown = {}, token: string = target.admin.token) {
  return post(app, organizationHistory, { slug: target.slug, token, body });
}

async function read(target: Target, before?: Cursor): Promise<History> {
  const res = await call(target, before === undefined ? {} : { before });
  expect(res.status).toBe(200);
  return (await res.json()) as History;
}

// 2030-01-01T00:00:00.000Z から minutes 分後
function minutesLater(minutes: number): string {
  return new Date(Date.UTC(2030, 0, 1) + minutes * 60_000).toISOString();
}

function log(organization: OrganizationFixture, overrides: Parameters<typeof createChangeLog>[1]) {
  return createChangeLog(organization, overrides);
}

describe('organization-history', () => {
  test('組織の変更とワークスペースの作成・終了・再開を新しい順に返し、ワークスペースの中の行と別の組織の行は出さない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const { organization } = target;
    const workspaceId = target.workspace.id;
    const created = await log(organization, {
      operator: OPERATOR_LOGIN_ID,
      action: 'create',
      changes_json: JSON.stringify({ slug: [null, organization.slug], name: [null, '青葉工房'] }),
      created_at: minutesLater(1),
    });
    const workspaceCreated = await log(organization, {
      workspace_id: workspaceId,
      actor_user_id: target.admin.userId,
      entity_type: 'workspace',
      entity_id: workspaceId,
      action: 'create',
      changes_json: JSON.stringify({
        name: [null, '青葉チーム'],
        timezone: [null, 'Asia/Tokyo'],
        vocabulary: [null, 'game'],
      }),
      created_at: minutesLater(2),
    });
    const closed = await log(organization, {
      workspace_id: workspaceId,
      actor_user_id: target.admin.userId,
      entity_type: 'workspace',
      entity_id: workspaceId,
      action: 'close',
      changes_json: JSON.stringify({ closed_at: [null, minutesLater(4)] }),
      created_at: minutesLater(4),
    });
    // ワークスペースの中の行（所属、招待、タスク、ワークスペースの設定の変更）
    for (const [entityType, action] of [
      ['membership', 'create'],
      ['invitation', 'update'],
      ['task', 'create'],
      ['workspace', 'update'],
    ] as const) {
      await log(organization, {
        workspace_id: workspaceId,
        actor_user_id: target.admin.userId,
        entity_type: entityType,
        entity_id: uuidv7(),
        action,
        created_at: minutesLater(3),
      });
    }
    // 別の組織の行
    await log(other.organization, { operator: OPERATOR_LOGIN_ID, action: 'suspend', created_at: minutesLater(5) });

    const history = await read(target);
    expect(history.entries.map((entry) => entry.id)).toEqual([closed.id, workspaceCreated.id, created.id]);
    expect(history.entries.map((entry) => entry.event)).toEqual([
      { kind: 'workspace_closed', workspace_name: '青葉チーム' },
      { kind: 'workspace_created', workspace_name: '青葉チーム' },
      { kind: 'organization_created', name: '青葉工房' },
    ]);
    expect(history.entries[0]!.created_at).toBe(minutesLater(4));
    expect(history.next).toBeNull();
  });

  test('ワークスペースの作成、終了、再開の操作が書いた行を、そのときの名前と今の名前で返す', async () => {
    const target = await createTarget();
    const createRes = await post(app, workspaceCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { name: '保守チーム', timezone: 'Asia/Tokyo', vocabulary: 'game', leader_user_id: target.admin.userId },
    });
    expect(createRes.status).toBe(200);
    const workspaceId = ((await createRes.json()) as { workspace_id: string }).workspace_id;
    const body = { workspace_id: workspaceId };
    expect((await post(app, workspaceClose, { slug: target.slug, token: target.admin.token, body })).status).toBe(200);
    expect((await post(app, workspaceReopen, { slug: target.slug, token: target.admin.token, body })).status).toBe(200);
    // 作った後に名前を変えても、作成の行はそのときの名前、終了と再開は今の名前
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ name: '保守チーム（旧）' })
          .where('id', '=', workspaceId)
          .where('organization_id', '=', target.organization.id),
      ),
    );

    const history = await read(target);
    // 同じミリ秒に書いた行は id の順に並ぶので、ここでは種類の組だけを見る（所属の行は出ない）
    expect(history.entries).toHaveLength(3);
    expect(history.entries.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        { kind: 'workspace_created', workspace_name: '保守チーム' },
        { kind: 'workspace_closed', workspace_name: '保守チーム（旧）' },
        { kind: 'workspace_reopened', workspace_name: '保守チーム（旧）' },
      ]),
    );
    for (const entry of history.entries) {
      expect(entry.actor).toEqual({ kind: 'user', id: target.admin.userId, name: '星野 澪' });
    }
  });

  test(`${ORGANIZATION_HISTORY_PAGE_SIZE} 件ずつ返し、カーソルで続きを重なりも抜けも無く読める（同じ日時は id で並ぶ）`, async () => {
    const target = await createTarget();
    const total = ORGANIZATION_HISTORY_PAGE_SIZE * 2 + 7;
    const ids: { id: string; created_at: string }[] = [];
    for (let i = 0; i < total; i++) {
      // 3 行ずつ同じ日時にし、ページの境目が同じ日時の行の途中に来るようにする
      const row = await log(target.organization, { created_at: minutesLater(Math.floor(i / 3)) });
      ids.push({ id: row.id, created_at: row.created_at });
    }
    const expected = ids
      .toSorted((a, b) =>
        a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1,
      )
      .map((row) => row.id);

    const first = await read(target);
    expect(first.entries).toHaveLength(ORGANIZATION_HISTORY_PAGE_SIZE);
    const last = first.entries.at(-1)!;
    expect(first.next).toEqual({ created_at: last.created_at, id: last.id });
    const second = await read(target, first.next!);
    expect(second.entries).toHaveLength(ORGANIZATION_HISTORY_PAGE_SIZE);
    const third = await read(target, second.next!);
    expect(third.entries).toHaveLength(7);
    expect(third.next).toBeNull();

    const seen = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.id);
    expect(seen).toEqual(expected);
  });

  test('ちょうど1ページ分なら続きのカーソルは null', async () => {
    const target = await createTarget();
    for (let i = 0; i < ORGANIZATION_HISTORY_PAGE_SIZE; i++) {
      await log(target.organization, { created_at: minutesLater(i) });
    }
    const history = await read(target);
    expect(history.entries).toHaveLength(ORGANIZATION_HISTORY_PAGE_SIZE);
    expect(history.next).toBeNull();
  });

  test('した人: users は今の名前、運用者は「運用者」とだけ分かり（ログインの ID は返さない）、どちらも空なら自動の処理', async () => {
    const target = await createTarget();
    const renamed = await createUser(target.organization, { name: '朝霧 ユウ', is_admin: 1 });
    await log(target.organization, { actor_user_id: renamed.id, created_at: minutesLater(3) });
    await log(target.organization, { operator: OPERATOR_LOGIN_ID, created_at: minutesLater(2) });
    await log(target.organization, { created_at: minutesLater(1) });
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ name: '朝霧 ユウキ' })
          .where('id', '=', renamed.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );

    const res = await call(target);
    const text = await res.text();
    expect(text).not.toContain(OPERATOR_LOGIN_ID);
    expect(text).not.toContain(OPERATOR_LOGIN_ID.split(':')[1]);
    const history = JSON.parse(text) as History;
    expect(history.entries.map((entry) => entry.actor)).toEqual([
      { kind: 'user', id: renamed.id, name: '朝霧 ユウキ' },
      { kind: 'operator' },
      { kind: 'system' },
    ]);
  });

  test('管理者の指名（運用者）は、指名したときの名前を返し、ログインの ID とアカウントの ID は返さない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const accountId = (await createAccount()).id;
    await designateAdmin(db, {
      nominee: { provider: 'github', subject: '9000000000077001', name: 'kaze--test', accountId },
      operatorLoginId: OPERATOR_LOGIN_ID,
      now: new Date(minutesLater(1)),
    });

    const res = await call(target);
    const text = await res.text();
    expect(text).not.toContain('9000000000077001');
    expect(text).not.toContain(accountId);
    expect(text).not.toContain(OPERATOR_LOGIN_ID);
    const history = JSON.parse(text) as History;
    expect(history.entries).toEqual([
      {
        id: expect.any(String),
        created_at: minutesLater(1),
        actor: { kind: 'operator' },
        event: { kind: 'admin_designated', name: 'kaze--test' },
      },
    ]);
  });

  test('Google の招待で待つ指名は、ログインするまで名前を null で返し、メールアドレスを返さない。結んだ後は今の名前', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const email = 'nagi.test@example.com';
    const { userId } = await designateAdmin(db, {
      nominee: {
        provider: 'google',
        waiting: { email, claimTokenHash: 'a'.repeat(64), claimExpiresAt: minutesLater(60 * 24) },
        name: email,
        accountId: null,
      },
      operatorLoginId: OPERATOR_LOGIN_ID,
      now: new Date(minutesLater(1)),
    });

    const waiting = await call(target);
    const waitingText = await waiting.text();
    expect(waitingText).not.toContain(email);
    expect(waitingText).not.toContain(WAITING_USER_NAME_IN_LOG);
    expect((JSON.parse(waitingText) as History).entries.map((entry) => entry.event)).toEqual([
      { kind: 'admin_designated', name: null },
    ]);

    // 本人が初めてログインして結んだ（src/server/db/cross-organization.ts と同じ形の記録）
    await db.run(
      db.statement((q) =>
        q
          .updateTable('users')
          .set({
            login_subject: '424242000001',
            login_email: null,
            claim_token_hash: null,
            claim_expires_at: null,
            name: '凪 サキ',
          })
          .where('id', '=', userId)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    await log(target.organization, {
      actor_user_id: userId,
      entity_type: 'user',
      entity_id: userId,
      action: 'update',
      changes_json: JSON.stringify({
        login_subject: [null, '424242000001'],
        name: [WAITING_USER_NAME_IN_LOG, '凪 サキ'],
      }),
      created_at: minutesLater(2),
    });

    const linked = await call(target);
    const linkedText = await linked.text();
    expect(linkedText).not.toContain('424242000001');
    expect((JSON.parse(linkedText) as History).entries.map((entry) => [entry.actor, entry.event])).toEqual([
      [
        { kind: 'user', id: userId, name: '凪 サキ' },
        { kind: 'admin_login_linked', name: '凪 サキ' },
      ],
      [{ kind: 'operator' }, { kind: 'admin_designated', name: '凪 サキ' }],
    ]);
  });

  test('ログインを待つ行がした人なら、名前（メールアドレス）を返さない', async () => {
    const target = await createTarget();
    const email = 'yoru.test@example.com';
    const waiting = await createUser(target.organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: email,
      claim_token_hash: 'b'.repeat(64),
      claim_expires_at: minutesLater(60 * 24),
      name: email,
      is_admin: 1,
    });
    await log(target.organization, { actor_user_id: waiting.id, entity_type: 'user', entity_id: waiting.id });
    const res = await call(target);
    const text = await res.text();
    expect(text).not.toContain(email);
    expect((JSON.parse(text) as History).entries[0]!.actor).toEqual({ kind: 'user', id: waiting.id, name: null });
  });

  test('種類ごとに、画面の文に要る値だけを取り出す。知らない組は other', async () => {
    const target = await createTarget();
    const { organization } = target;
    const person = await createUser(organization, { name: '汐見 アオイ' });
    const userLog = (changes: unknown, action = 'update') => ({
      actor_user_id: target.admin.userId,
      entity_type: 'user',
      entity_id: person.id,
      action,
      changes_json: JSON.stringify(changes),
    });
    const operatorLog = (action: string, changes: unknown) => ({
      operator: OPERATOR_LOGIN_ID,
      action,
      changes_json: JSON.stringify(changes),
    });
    const cases: [Parameters<typeof createChangeLog>[1], History['entries'][number]['event']][] = [
      [
        operatorLog('suspend', { suspended_at: [null, minutesLater(0)], purge_on: [null, '2030-01-31'] }),
        { kind: 'organization_suspended', purge_on: '2030-01-31' },
      ],
      [
        operatorLog('suspend', { suspended_at: [null, minutesLater(0)], purge_on: [null, null] }),
        { kind: 'organization_suspended', purge_on: null },
      ],
      [
        operatorLog('resume', { suspended_at: [minutesLater(0), null], purge_on: ['2030-01-31', null] }),
        { kind: 'organization_resumed' },
      ],
      [
        operatorLog('update', { purge_on: [null, '2030-02-01'] }),
        { kind: 'organization_suspension_changed', purge_on: '2030-02-01' },
      ],
      [
        operatorLog('update', { purge_on: ['2030-02-01', null] }),
        { kind: 'organization_suspension_changed', purge_on: null },
      ],
      [
        { actor_user_id: target.admin.userId, changes_json: JSON.stringify({ vocabulary: ['game', 'scrum'] }) },
        { kind: 'organization_settings_changed' },
      ],
      [userLog({ is_admin: [0, 1] }), { kind: 'admin_designated', name: '汐見 アオイ' }],
      [userLog({ is_admin: [1, 0] }), { kind: 'admin_revoked', name: '汐見 アオイ' }],
      [userLog({ disabled_at: [null, minutesLater(0)] }), { kind: 'user_disabled', name: '汐見 アオイ' }],
      [userLog({ disabled_at: [minutesLater(0), null] }), { kind: 'user_enabled', name: '汐見 アオイ' }],
      // Google の招待で指名した人が、同じ組織に既にいた（cross-organization.ts の統合の記録）
      [
        userLog({ is_admin: [0, 1], disabled_at: [minutesLater(0), null] }),
        { kind: 'admin_designation_merged', name: '汐見 アオイ' },
      ],
      // 知らない組
      [userLog({ theme: [null, 'simple'] }), { kind: 'other' }],
      [userLog({}, 'delete'), { kind: 'other' }],
      [{ action: 'archive' }, { kind: 'other' }],
      [{ entity_type: 'connection', entity_id: uuidv7(), action: 'update' }, { kind: 'other' }],
      // 列の形でない changes_json も other にして、行は出す
      [{ action: 'update', changes_json: '[1, 2]' }, { kind: 'other' }],
    ];
    for (const [index, [overrides]] of cases.entries()) {
      await log(organization, { ...overrides, created_at: minutesLater(cases.length - index) });
    }
    const history = await read(target);
    expect(history.entries.map((entry) => entry.event)).toEqual(cases.map(([, event]) => event));
    // 名前の無い組（other）にも、値は足さない
    for (const entry of history.entries) {
      expect(Object.keys(entry).toSorted()).toEqual(['actor', 'created_at', 'event', 'id']);
    }
  });

  test('リーダーと一般のメンバーは 403', async () => {
    const target = await createTarget();
    for (const person of [target.leader, target.member]) {
      const res = await call(target, {}, person.token);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
  });

  test('形の合わないカーソルは 400', async () => {
    const target = await createTarget();
    const valid = { created_at: minutesLater(0), id: uuidv7() };
    for (const before of [
      { ...valid, created_at: '2030-01-01' },
      { ...valid, created_at: '2030-01-01T00:00:00Z' },
      { ...valid, created_at: '2030-01-01T09:00:00.000+09:00' },
      { created_at: valid.created_at },
      { ...valid, id: '' },
      { ...valid, id: 'x'.repeat(65) },
      'abc',
      123,
    ]) {
      const res = await call(target, { before });
      expect(res.status, JSON.stringify(before)).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    // null は最新から
    expect((await call(target, { before: null })).status).toBe(200);
  });
});
