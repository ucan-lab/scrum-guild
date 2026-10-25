// 操作の定義と、確かめたワークスペースの型の検査。実行はしない（vitest の対象は *.test.ts）。
// pnpm check の tsc が検査し、期待したエラーの行が型の検査に通るようになると、使われていない期待として落ちる
import { z } from 'zod';
import { callOperation } from '../src/lib/api.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import * as db from '../src/server/db/index.ts';
import type { VerifiedWorkspace } from '../src/server/db/index.ts';
import { implement } from '../src/server/operations/implement.ts';

const base = { description: 'x', mode: 'read', output: z.object({}) } as const;

// ワークスペースの下の操作は、入力に workspace_id が要る
defineOperation({
  ...base,
  name: 'ok-workspace',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: z.string() }),
});
// @ts-expect-error 入力に workspace_id が無い
defineOperation({
  ...base,
  name: 'no-workspace-id',
  permission: 'member',
  workspace: true,
  input: z.object({ title: z.string() }),
});
// @ts-expect-error workspace_id は文字列
defineOperation({
  ...base,
  name: 'number-workspace-id',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: z.number() }),
});
// @ts-expect-error メンバーとリーダーの権限はワークスペースの下の操作に限る
defineOperation({ ...base, name: 'member-without-workspace', permission: 'member', input: z.object({}) });
// @ts-expect-error 組織の外の操作はワークスペースの下に置けない
defineOperation({ ...base, name: 'login-workspace', permission: 'login', workspace: true, input: z.object({}) });
// @ts-expect-error 権限の種類にない値
defineOperation({ ...base, name: 'unknown-permission', permission: 'owner', input: z.object({}) });
// 招待の操作（invitee）は組織の直下に置く
defineOperation({ ...base, name: 'invitee-ok', permission: 'invitee', input: z.object({}) });
// @ts-expect-error invitee はワークスペースの下に置けない
defineOperation({
  ...base,
  name: 'invitee-workspace',
  permission: 'invitee',
  workspace: true,
  input: z.object({ workspace_id: z.string() }),
});
// 閉じたワークスペースでも通す印は、ワークスペースの下の操作だけに付けられる
defineOperation({
  ...base,
  name: 'reopen-ok',
  mode: 'write',
  permission: 'admin',
  workspace: true,
  allowClosed: true,
  input: z.object({ workspace_id: z.string() }),
});

// 処理が受け取る文脈は、定義の種類で決まる
const inWorkspace = defineOperation({
  ...base,
  name: 'in-workspace',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: z.string(), name: z.string() }),
});
const inOrganization = defineOperation({
  ...base,
  name: 'in-organization',
  permission: 'organization',
  input: z.object({ name: z.string() }),
});
const outside = defineOperation({ ...base, name: 'outside', permission: 'login', input: z.object({}) });

implement(inWorkspace, async ({ workspace, input }) => {
  workspace satisfies VerifiedWorkspace;
  input.name satisfies string;
  return {};
});
implement(inOrganization, async (context) => {
  // @ts-expect-error ワークスペースの下の操作ではないので、確かめたワークスペースは渡らない
  void context.workspace;
  context.db.organizationId satisfies string;
  return {};
});
implement(outside, async (context) => {
  // @ts-expect-error 組織の外の操作には、組織の中の入口は渡らない
  void context.actor;
  context.accountId satisfies string;
  return {};
});

// 確かめたワークスペースは db/ の外では作れない。同じ形のオブジェクトも、値の import もできない
// @ts-expect-error 同じ形のオブジェクトは確かめた結果にならない
const forged: VerifiedWorkspace = { workspaceId: 'x', organizationId: 'y', actorRole: null, closed: false };
void forged;
// @ts-expect-error 入口のモジュールは型だけを出し、クラスの値は出さない
void db.VerifiedWorkspace;

// 画面から呼ぶ関数は、組織の中の操作だけ slug を要る
void callOperation(outside, {});
// @ts-expect-error 組織の中の操作には slug が要る
void callOperation(inOrganization, { name: 'x' });
void callOperation(inOrganization, { name: 'x' }, { slug: 'aoba' });
// @ts-expect-error 入力の型は定義から決まる
void callOperation(inOrganization, { name: 1 }, { slug: 'aoba' });
void callOperation(inWorkspace, { workspace_id: 'w', name: 'x' }, { slug: 'aoba' });
