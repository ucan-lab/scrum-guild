// 履歴のまとめと、書き始める前の値の照合の共通の処理（src/server/operations/change-log-merge.ts）。
// タスク、ストーリー、エピックの更新が使う。それぞれの操作の通しの振る舞いは test/task-edit.test.ts、test/story.test.ts、test/epic.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import {
  asIs,
  HISTORY_MERGE_WINDOW_MS,
  linkUrl,
  longText,
  mergeTargetOf,
  readMergeTarget,
  staleFields,
  trimmed,
  type ChangeMap,
  type LatestChangeLog,
} from '../src/server/operations/change-log-merge.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import { createChangeLog } from './factories.ts';
import { createTarget } from './operations/world.ts';

const WRITTEN_AT = Date.parse('2026-10-26T01:00:00.000Z');
const ACTOR = 'actor-1';

function latestLog(overrides: Partial<LatestChangeLog> = {}): LatestChangeLog {
  return {
    id: uuidv7(WRITTEN_AT),
    actor_user_id: ACTOR,
    action: 'update',
    changes_json: JSON.stringify({ body_md: ['元', '一回目'] }),
    created_at: new Date(WRITTEN_AT).toISOString(),
    ...overrides,
  };
}

// 「一回目」を「二回目」に直す変更
const next: ChangeMap = { body_md: ['一回目', '二回目'] };
const after = (ms: number) => new Date(WRITTEN_AT + ms);

describe('mergeTargetOf', () => {
  test('同じ人が間の中で同じ欄を続けて直すなら、直前の行を「前」を残してまとめる', () => {
    const latest = latestLog();
    expect(mergeTargetOf(latest, 'body_md', ACTOR, next, after(1000))).toEqual({
      id: latest.id,
      createdAt: latest.created_at,
      changesJson: latest.changes_json,
      field: 'body_md',
      before: '元',
    });
  });

  test('間の起点は最初に書いた時刻。created_at を進めた行でも、起点から間を過ぎればまとめない', () => {
    // まとめるたびに created_at だけが進む。起点は ID の時刻のまま
    const merged = latestLog({ created_at: after(HISTORY_MERGE_WINDOW_MS - 1000).toISOString() });
    expect(mergeTargetOf(merged, 'body_md', ACTOR, next, after(HISTORY_MERGE_WINDOW_MS))).toBeDefined();
    expect(mergeTargetOf(merged, 'body_md', ACTOR, next, after(HISTORY_MERGE_WINDOW_MS + 1))).toBeUndefined();
  });

  test('最初に書いたのと同じミリ秒なら、まとめる', () => {
    expect(mergeTargetOf(latestLog(), 'body_md', ACTOR, next, after(0))).toBeDefined();
  });

  test('時計が最初に書いた時刻より戻っているときは、まとめない', () => {
    // created_at が ID の時刻より前の行で、最新の行の created_at の確認でなく、最初に書いた時刻の確認が断る
    const early = latestLog({ created_at: after(-5000).toISOString() });
    expect(mergeTargetOf(early, 'body_md', ACTOR, next, after(-1))).toBeUndefined();
    expect(mergeTargetOf(latestLog(), 'body_md', ACTOR, next, after(-1))).toBeUndefined();
  });

  test('時計が最新の行の created_at より戻っているときは、まとめない', () => {
    const merged = latestLog({ created_at: after(60_000).toISOString() });
    expect(mergeTargetOf(merged, 'body_md', ACTOR, next, after(59_999))).toBeUndefined();
    expect(mergeTargetOf(merged, 'body_md', ACTOR, next, after(60_000))).toBeDefined();
  });

  test('元の値へ戻す変更は、まとめない', () => {
    expect(mergeTargetOf(latestLog(), 'body_md', ACTOR, { body_md: ['一回目', '元'] }, after(1000))).toBeUndefined();
  });

  test.each([
    ['UUIDv7 でない ID', { id: '00000000-0000-4000-8000-000000000000' }],
    ['ハイフンの無い短い ID', { id: 'seed-story-log' }],
    // 先頭48ビットが今の時刻でも、バージョンの桁が 7 でなければ時刻と読めない
    ['バージョンの桁が 7 でない ID', { id: uuidv7(WRITTEN_AT).replace(/^(.{14})7/, '$14') }],
    ['先頭が 16 進でない ID', { id: 'zzzzzzzz-zzzz-7zzz-8zzz-zzzzzzzzzzzz' }],
    ['「前」「後」が3要素の行', { changes_json: JSON.stringify({ body_md: ['元', '一回目', '余分'] }) }],
    ['「前」「後」が配列でない行', { changes_json: JSON.stringify({ body_md: '一回目' }) }],
    ['読めない日時', { created_at: 'いつか' }],
    ['別の人の行', { actor_user_id: 'actor-2' }],
    ['人でない行', { actor_user_id: null }],
    ['更新でない行', { action: 'delete' }],
    ['読めない changes_json', { changes_json: '{' }],
    ['配列の changes_json', { changes_json: '[]' }],
    ['別の欄の行', { changes_json: JSON.stringify({ title: ['元', '一回目'] }) }],
    ['2つの欄の行', { changes_json: JSON.stringify({ body_md: ['元', '一回目'], title: ['a', 'b'] }) }],
    ['「後」が今の値と合わない行', { changes_json: JSON.stringify({ body_md: ['元', '別の人が書いた'] }) }],
  ] as const)('%s なら、まとめない', (_name, overrides) => {
    expect(mergeTargetOf(latestLog(overrides), 'body_md', ACTOR, next, after(1000))).toBeUndefined();
  });

  test('履歴が無ければ、まとめない', () => {
    expect(mergeTargetOf(undefined, 'body_md', ACTOR, next, after(1000))).toBeUndefined();
  });
});

describe('staleFields', () => {
  const fields = { title: trimmed, body_md: longText, due_on: asIs, link_url: linkUrl };
  const current = { title: '題', body_md: '本文', due_on: '2026-10-30', link_url: 'https://example.com/a' };

  test('expected が無ければ、照合しない', () => {
    expect(staleFields(fields, current, { title: '新' }, undefined)).toEqual({});
  });

  test('書く欄で、expected が今の値と違うものだけを、今の値で返す', () => {
    expect(
      staleFields(
        fields,
        current,
        { title: '新', body_md: '新', due_on: '2026-11-01' },
        { title: '古い題', body_md: '本文', due_on: '2026-10-01' },
      ),
    ).toEqual({ title: '題', due_on: '2026-10-30' });
  });

  test('書かない欄と、expected を送っていない欄は見ない', () => {
    expect(staleFields(fields, current, { title: '新' }, { body_md: '違う本文' })).toEqual({});
    expect(staleFields(fields, current, { title: '新' }, { title: '題', body_md: '違う本文' })).toEqual({});
  });

  test('今の値を、expected と同じ決まりで正規化してから比べる', () => {
    const stored = { title: '  題  ', body_md: '本文\r\n', due_on: null, link_url: 'HTTPS://Example.com/a' };
    expect(
      staleFields(
        fields,
        stored,
        { title: '新', body_md: '新', link_url: null },
        { title: '題', body_md: '本文', link_url: 'https://example.com/a' },
      ),
    ).toEqual({});
    // 違うときは、正規化する前の今の値を返す
    expect(staleFields(fields, stored, { title: '新' }, { title: '別の題' })).toEqual({ title: '  題  ' });
  });

  test('リンクとして正規化できない今の値は、例外を投げず、そのまま比べる', () => {
    const broken = { ...current, link_url: 'http://[' };
    expect(staleFields(fields, broken, { link_url: null }, { link_url: 'https://example.com/a' })).toEqual({
      link_url: 'http://[',
    });
  });

  test('空の値（null）は正規化せず、そのまま比べる', () => {
    const empty = { ...current, body_md: null };
    expect(staleFields(fields, empty, { body_md: '新' }, { body_md: null })).toEqual({});
    expect(staleFields(fields, empty, { body_md: '新' }, { body_md: '本文' })).toEqual({ body_md: null });
  });
});

describe('readMergeTarget（履歴の最新の行を読む）', () => {
  const fields = { title: trimmed, body_md: longText };
  const changes: ChangeMap = { body_md: ['一回目', '二回目'] };

  async function setup() {
    const target = await createTarget();
    const entity = { entityType: 'story', workspaceId: target.workspace.id, entityId: uuidv7(WRITTEN_AT + 1) } as const;
    const log = (overrides: Parameters<typeof createChangeLog>[1] = {}) =>
      createChangeLog(target.organization, {
        workspace_id: target.workspace.id,
        actor_user_id: target.member.userId,
        entity_type: 'story',
        entity_id: entity.entityId,
        id: uuidv7(WRITTEN_AT),
        created_at: new Date(WRITTEN_AT).toISOString(),
        changes_json: JSON.stringify({ body_md: ['元', '一回目'] }),
        ...overrides,
      });
    const read = (at: Date, allowMerge?: boolean) =>
      readMergeTarget(
        orgDb(env, target.organization.verified),
        fields,
        entity,
        target.member.userId,
        changes,
        at,
        allowMerge,
      );
    return { target, entity, log, read };
  }

  test('最新の行が同じ人の同じ欄の更新なら、その行を返す', async () => {
    const { log, read } = await setup();
    const row = await log();
    expect(await read(after(1000))).toMatchObject({ id: row.id, field: 'body_md', before: '元' });
  });

  test('間に別の人の履歴が挟まっていれば（最新の行が別の人なら）、まとめない', async () => {
    const { target, log, read } = await setup();
    await log();
    await log({
      id: uuidv7(WRITTEN_AT + 500),
      created_at: after(500).toISOString(),
      actor_user_id: target.leader.userId,
      changes_json: JSON.stringify({ title: ['a', 'b'] }),
    });
    expect(await read(after(1000))).toBeUndefined();
  });

  test('履歴が無ければ、まとめない', async () => {
    const { read } = await setup();
    expect(await read(after(1000))).toBeUndefined();
  });

  test('allowMerge が false なら、まとめない', async () => {
    const { log, read } = await setup();
    await log();
    expect(await read(after(1000), false)).toBeUndefined();
  });

  test('2つの欄を直すときは、まとめない', async () => {
    const { target, entity, log } = await setup();
    await log();
    expect(
      await readMergeTarget(
        orgDb(env, target.organization.verified),
        fields,
        entity,
        target.member.userId,
        { body_md: ['一回目', '二回目'], title: ['a', 'b'] },
        after(1000),
      ),
    ).toBeUndefined();
  });

  test('まとめる欄の一覧に無い欄（区分など）の続けた変更は、まとめない', async () => {
    const { target, entity, log } = await setup();
    await log({ changes_json: JSON.stringify({ category: [{ id: 'a' }, { id: 'b' }] }) });
    expect(
      await readMergeTarget(
        orgDb(env, target.organization.verified),
        fields,
        entity,
        target.member.userId,
        { category: [{ id: 'b' }, { id: 'c' }] },
        after(1000),
      ),
    ).toBeUndefined();
  });

  test('同じ ID の別の種類（task）の新しい履歴は、最新の行に数えない', async () => {
    const { log, read } = await setup();
    const row = await log();
    await log({ id: uuidv7(WRITTEN_AT + 500), created_at: after(500).toISOString(), entity_type: 'task' });
    expect(await read(after(1000))).toMatchObject({ id: row.id });
  });

  test('最新の行は created_at の新しい順で選ぶ', async () => {
    const { log, read } = await setup();
    // ID は新しいが created_at が古い行と、ID は古いが created_at が新しい行
    await log({ id: uuidv7(WRITTEN_AT + 30_000), created_at: after(30_000).toISOString() });
    const newest = await log({ id: uuidv7(WRITTEN_AT), created_at: after(60_000).toISOString() });
    expect(await read(after(61_000))).toMatchObject({ id: newest.id });
  });

  test('created_at が同じなら、ID の大きい方を最新の行にする', async () => {
    const { log, read } = await setup();
    const sameAt = after(30_000).toISOString();
    // 大きい ID を先に入れても、入れた順でなく ID で選ぶ
    const larger = await log({ id: uuidv7(WRITTEN_AT + 1), created_at: sameAt });
    await log({ id: uuidv7(WRITTEN_AT), created_at: sameAt });
    expect(await read(after(31_000))).toMatchObject({ id: larger.id });
  });

  test('別の組織の履歴は読まない', async () => {
    const { target, entity, log } = await setup();
    await log();
    const other = await createTarget();
    expect(
      await readMergeTarget(
        orgDb(env, other.organization.verified),
        fields,
        { ...entity, workspaceId: target.workspace.id },
        target.member.userId,
        changes,
        after(1000),
      ),
    ).toBeUndefined();
  });
});
