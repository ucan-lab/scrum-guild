import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 組織のユーザーの管理（docs/data-model.md の users と「書き込みの単位」の管理者の指名と解除、ユーザーの無効化と有効化）。管理者だけ。
// 相手は同じ組織の login_subject のある行だけで、ほかは 404（別の組織の ID、Google の指名でログインを待つ行）。

// 409 の conflict で断った理由（details.reason）。
// last_admin は最後の管理者（ほかに無効でなく login_subject のある管理者がいない人）を解除か無効にしようとした、
// self は自分を無効にしようとした、disabled は無効の人を管理者に指名しようとした、
// member_limit は組織の人数が上限（member_limit）に達していて、まだ人数に数えられていない人を管理者に指名しようとした
export const userConflictReasons = ['last_admin', 'self', 'disabled', 'member_limit'] as const;
export type UserConflictReason = (typeof userConflictReasons)[number];

export function userConflictReasonOf(details: unknown): UserConflictReason | undefined {
  return conflictReasonOf(details, userConflictReasons);
}

// 書いた後（何も書かなかったときは今）の相手の状態
const userState = z.object({ user_id: z.string(), is_admin: z.boolean(), disabled_at: z.string().nullable() });

// 組織のユーザーの一覧。同じ組織の login_subject のある行を、有効な人を先に、無効の人を後ろに、それぞれ名前、ID の順に全部返す
// （件数は組織の users の行数。抜けた人と無効の人も残るので member_limit では抑えられない。想定は数十〜数百）。
// workspace_count は閉じていないワークスペースの今の所属の数、last_seen_at はこの組織に最後に入った日時（入ったことが無ければ null）
export const userList = defineOperation({
  name: 'user-list',
  description:
    '組織のユーザー（ログインを待つ行を除く）を、名前、アバター、管理者か、無効にした日時、所属の数、最後に入った日時とともに名前の順に返す',
  mode: 'read',
  permission: 'admin',
  input: z.object({}),
  output: z.object({
    users: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        avatar_url: z.string().nullable(),
        is_admin: z.boolean(),
        disabled_at: z.string().nullable(),
        workspace_count: z.number().int(),
        last_seen_at: z.string().nullable(),
      }),
    ),
  }),
});

// 管理者に指名するか、解除する。同じ値なら書かずに今の値を返す。無効の人の指名は 409（disabled）、
// 人数が上限に達していて、まだ人数に数えられていない人の指名は 409（member_limit）、
// 最後の管理者の解除は 409（last_admin）。自分の解除は、最後の管理者でなければできる
export const userAdminUpdate = defineOperation({
  name: 'user-admin-update',
  description:
    'ユーザーを管理者に指名するか、管理者を解除し、組織の変更の履歴に残す。無効の人の指名と最後の管理者の解除は 409 の conflict',
  mode: 'write',
  permission: 'admin',
  input: z.object({ user_id: idSchema, is_admin: z.boolean() }),
  output: userState,
});

// ユーザーを無効にする。管理者なら同じ文で解除し、承諾待ちの招待を取り消し、閉じたものを含むすべてのワークスペースから外し、担当を外す。
// 自分は 409（self）、最後の管理者は 409（last_admin）。無効の人なら書かずに今の値を返す
export const userDisable = defineOperation({
  name: 'user-disable',
  description:
    'ユーザーを無効にする。管理者なら解除し、承諾待ちの招待を取り消し、すべてのワークスペースから外して未完了のタスクの担当を外し、変更の履歴に残す',
  mode: 'write',
  permission: 'admin',
  input: z.object({ user_id: idSchema }),
  output: userState,
});

// 無効のユーザーを有効に戻す。所属と管理者は戻らないので、組織に入るには招待し直すか指名し直す。有効な人なら書かずに今の値を返す。
// 無効の間に招待し直した承諾待ちの招待（開いたワークスペース、期限内）は、有効に戻すとその人が新しく人数に数えられる。
// その人（adding。同じ人への招待が複数でも 1 人）を今の人数に足すと member_limit を超えるときは、何も書かずに
// 409 の member_limit_reached（details は { used, limit, adding }）で断り、招待は残す。招待が無い（adding が 0）有効化は、
// 段階を下げて人数が上限を超えている組織でも通す。ちょうど上限に達する有効化も通す
export const userEnable = defineOperation({
  name: 'user-enable',
  description:
    '無効のユーザーを有効に戻し、組織の変更の履歴に残す。所属と管理者は戻らない（入るには招待し直すか、管理者に指名し直す）。無効の間の招待で新しく人数に数えられる人がいて、足すと組織の人数の上限を超えるときは、何も書かずに 409 の member_limit_reached（details は { used, limit, adding }）',
  mode: 'write',
  permission: 'admin',
  input: z.object({ user_id: idSchema }),
  output: userState,
});
