// 組織の言葉づかいと既定のテーマの変更（organization-settings-update）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// ここでは、書いた値と変更の履歴、同じ値の扱い、競合の 409、履歴を書けなくても成功すること、組織の枠の値への効き方を確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { organizationInfo, organizationSettingsUpdate } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import type { OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

type SettingsInput = { vocabulary?: string; theme?: string };
type UpdateOptions = { token?: string; env?: Env; from?: { vocabulary?: string; theme?: string } };

// 書く値（to）だけを受け取り、画面が見ていた値（from）は作った組織の既定（game、simple）か options.from で補う
function update(target: Target, body: SettingsInput, options: UpdateOptions = {}) {
  const from = { vocabulary: 'game', theme: 'simple', ...options.from };
  return send(
    target,
    {
      ...(body.vocabulary === undefined ? {} : { vocabulary: { from: from.vocabulary, to: body.vocabulary } }),
      ...(body.theme === undefined ? {} : { theme: { from: from.theme, to: body.theme } }),
    },
    options,
  );
}

function send(target: Target, body: unknown, options: UpdateOptions = {}) {
  return post(app, organizationSettingsUpdate, {
    slug: target.slug,
    token: options.token ?? target.admin.token,
    body,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

async function organizationRow(organization: OrganizationFixture) {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('organizations').select(['vocabulary', 'theme', 'updated_at']).where('id', '=', organization.id),
    ),
  );
  return row!;
}

async function changeLogsOf(organization: OrganizationFixture) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('change_logs').selectAll().where('organization_id', '=', organization.id).orderBy('id'),
    ),
  );
}

async function organizationOf(target: Target, token: string) {
  const res = await post(app, organizationInfo, { slug: target.slug, token });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    organization: { vocabulary: string; theme: string };
    me: { theme: string | null };
  };
}

describe('organization-settings-update', () => {
  test('言葉づかいと既定のテーマを書き、書いた後の値を返す。変更の履歴に、変えた項目の前後を管理者の操作として1行残す', async () => {
    const target = await createTarget();
    const res = await update(target, { vocabulary: 'scrum', theme: 'medieval' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vocabulary: 'scrum', theme: 'medieval' });

    const row = await organizationRow(target.organization);
    expect(row).toMatchObject({ vocabulary: 'scrum', theme: 'medieval' });
    expect(row.updated_at).not.toBe(target.organization.updated_at);

    const logs = await changeLogsOf(target.organization);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organization_id: target.organization.id,
      workspace_id: null,
      actor_user_id: target.admin.userId,
      operator: null,
      entity_type: 'organization',
      entity_id: target.organization.id,
      action: 'update',
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ vocabulary: ['game', 'scrum'], theme: ['simple', 'medieval'] });
  });

  test('見ていた値と同じ値の項目は書かず、履歴にも残さない', async () => {
    const target = await createTarget();
    const res = await update(target, { vocabulary: 'game', theme: 'modern' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vocabulary: 'game', theme: 'modern' });

    const logs = await changeLogsOf(target.organization);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ theme: ['simple', 'modern'] });
  });

  test('書く項目が無ければ何も書かず、今の値を返す', async () => {
    const target = await createTarget();
    const res = await update(target, { theme: 'simple' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vocabulary: 'game', theme: 'simple' });

    expect((await organizationRow(target.organization)).updated_at).toBe(target.organization.updated_at);
    expect(await changeLogsOf(target.organization)).toEqual([]);
  });

  test('空の入力と、知らない値は 400 の invalid_input', async () => {
    const target = await createTarget();
    for (const body of [
      {},
      { theme: { from: 'simple', to: 'neon' } },
      { vocabulary: { from: 'game', to: 'agile' } },
      { theme: 'medieval' },
      { vocabulary: { to: 'scrum' } },
    ]) {
      const res = await send(target, body);
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    expect(await changeLogsOf(target.organization)).toEqual([]);
  });

  test('画面が見ていた値が今の値と違えば（ほかの管理者が先に変えた）409 の conflict で、どの項目も書かない', async () => {
    const target = await createTarget();
    // 見ていた言葉づかいが古い。テーマは今の値のまま
    const res = await update(target, { vocabulary: 'game', theme: 'modern' }, { from: { vocabulary: 'scrum' } });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await organizationRow(target.organization)).toMatchObject({ vocabulary: 'game', theme: 'simple' });
    expect(await changeLogsOf(target.organization)).toEqual([]);
  });

  test('管理者でない人は書けず、組織の値は変わらない', async () => {
    const target = await createTarget();
    for (const person of [target.leader, target.member, target.bystander]) {
      const res = await update(target, { theme: 'medieval' }, { token: person.token });
      expect(res.status).toBe(403);
    }
    expect(await organizationRow(target.organization)).toMatchObject({ vocabulary: 'game', theme: 'simple' });
  });

  test('別の組織の値と履歴は変わらない', async () => {
    const own = await createTarget();
    const other = await createTarget();
    expect((await update(own, { vocabulary: 'scrum', theme: 'modern' })).status).toBe(200);

    expect(await organizationRow(other.organization)).toMatchObject({ vocabulary: 'game', theme: 'simple' });
    expect(await changeLogsOf(other.organization)).toEqual([]);
  });

  test('入ってから書くまでに別の要求が同じ項目を変えていたら 409 の conflict で、履歴は書かない', async () => {
    const target = await createTarget();
    let interrupted = false;
    const racing = envWithD1Hooks(testEnv, {
      // 入るときに組織の行を引いた直後に、別の要求が既定のテーマを変える
      afterQuery: async (sql) => {
        if (interrupted || !sql.includes('from "organizations"')) return;
        interrupted = true;
        const db = commonDb(env);
        await db.run(
          db.statement((q) =>
            q.updateTable('organizations').set({ theme: 'modern' }).where('id', '=', target.organization.id),
          ),
        );
      },
    });
    const res = await update(target, { theme: 'medieval' }, { env: racing });
    expect(interrupted).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect((await organizationRow(target.organization)).theme).toBe('modern');
    expect(await changeLogsOf(target.organization)).toEqual([]);
  });

  test('両方を送り、片方だけを別の要求が先に変えていたら、もう片方も書かず 409 の conflict にする', async () => {
    const target = await createTarget();
    let interrupted = false;
    const racing = envWithD1Hooks(testEnv, {
      // 入るときに組織の行を引いた直後に、別の要求が言葉づかいだけを変える
      afterQuery: async (sql) => {
        if (interrupted || !sql.includes('from "organizations"')) return;
        interrupted = true;
        const db = commonDb(env);
        await db.run(
          db.statement((q) =>
            q.updateTable('organizations').set({ vocabulary: 'scrum' }).where('id', '=', target.organization.id),
          ),
        );
      },
    });
    const res = await update(target, { vocabulary: 'scrum', theme: 'medieval' }, { env: racing });
    expect(interrupted).toBe(true);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await organizationRow(target.organization)).toMatchObject({ vocabulary: 'scrum', theme: 'simple' });
    expect(await changeLogsOf(target.organization)).toEqual([]);
  });

  test('履歴を書けなくても成功し、ログに操作、組織の ID、前後の値、日時、例外の名前だけを残す', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = await createTarget();
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "change_logs"'))) throw new Error('secret SQL detail');
      },
    });
    const res = await update(target, { vocabulary: 'scrum' }, { env: failing });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vocabulary: 'scrum', theme: 'simple' });
    expect((await organizationRow(target.organization)).vocabulary).toBe('scrum');
    expect(await changeLogsOf(target.organization)).toEqual([]);

    const logged = errorLog.mock.calls.map((call) => String(call[0]));
    const line = logged.find((text) => text.includes('organization-settings-update'));
    expect(line).toBeDefined();
    expect(line).not.toContain('secret SQL detail');
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      operation: 'organization-settings-update',
      action: 'update',
      organizationId: target.organization.id,
      changes: { vocabulary: ['game', 'scrum'] },
      error: 'Error',
    });
    expect(Number.isNaN(Date.parse(String(parsed.at)))).toBe(false);
  });

  test('組織の枠の値が変わる。テーマを選んでいない人の me.theme は空のまま、選んでいる人の me.theme は変わらない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ theme: 'simple_dark' })
          .where('organization_id', '=', target.organization.id)
          .where('id', '=', target.leader.userId!),
      ),
    );

    expect((await update(target, { vocabulary: 'scrum', theme: 'medieval' })).status).toBe(200);

    const member = await organizationOf(target, target.member.token);
    expect(member.organization).toMatchObject({ vocabulary: 'scrum', theme: 'medieval' });
    expect(member.me.theme).toBeNull();
    const leader = await organizationOf(target, target.leader.token);
    expect(leader.organization.theme).toBe('medieval');
    expect(leader.me.theme).toBe('simple_dark');
  });
});
