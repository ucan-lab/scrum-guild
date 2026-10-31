---
name: add-operation
description: API の操作を1つ足す型紙。権限の選択、定義（src/shared/operations/）、処理（src/server/operations/）、一覧への登録、組織の分離のテスト用の関数、画面から呼ぶ口までを一続きで作る。ルートを直に書かず、組織の中の表を必ず組織かワークスペースで絞る。API を足す、エンドポイントを足す、操作を足す、操作の定義を書くときに使う。
---

# add-operation

## 仕事

操作の定義を1つ足し、処理を結び、組織の分離のテストと権限のテストが定義の一覧から回る状態にする。
終わりは「定義、処理、一覧への登録、テスト用の関数が揃い、`pnpm check`、`pnpm lint`、`pnpm test` が通る」状態。

前提（理由も含めて守る）。

- ルートを直に書かない。権限の検査と入力の検証は登録の関数（`src/server/operations/register.ts`）が行い、処理に渡るのは検証済みの入力と確かめた DB の入口だけになる。ルートを直に書くと、Origin、セッション、組織の確かめが素通りする
- 組織の中の入口は問い合わせを組織で絞らない。処理が、組織の直下の表は `db.organizationId`、ワークスペースの下の表は `workspace.workspaceId` で自分の文を絞る。入力の ID だけで引くと、別の組織の行を読める
- 仕組みの詳細は `docs/development.md` の「操作の定義」と「入口を守る規則」。このスキルは手順を書く

## 手順

### 1. 権限を決める

| 権限 | 使うとき |
| --- | --- |
| `login` | ログインしていて、入れる組織がある人（か運用者）。組織の外（`/api/<名前>`）。入れる組織を失った人は、セッションを消して 401 にする。入れる組織を失った人にも使わせる操作（ログアウトなど）だけ、定義に `skipsLoginAccess: true` を付ける（組織の中の操作には付けられない） |
| `operator` | 運用者だけ。組織の外。定義は `src/shared/operations/operator/` に置く（人が差分を読む領域） |
| `invitee` | 招待の一覧、承諾、辞退。承諾待ちの招待だけの人も通す。`actor.userId` は null がありうる。組織の中のデータを読む操作には使わない |
| `organization` | `users` の行がある人（無効でない管理者か、ワークスペースに今所属している人）。承諾待ちの招待だけの人には 404 |
| `member` | ワークスペースに今所属している人。管理者も通る。`workspace: true` を付ける |
| `leader` | ワークスペースのリーダー。管理者も通る。`workspace: true` を付ける |
| `admin` | 組織の管理者だけ。ワークスペースを指すなら `workspace: true` も付ける |

読むだけなら `mode: 'read'`、書くなら `'write'`。どちらも POST で、Origin の検査が掛かる。
ワークスペースの下の `write` は、閉じたワークスペースでは 409 の `workspace_closed` で止まる。閉じていても書く操作（開き直すなど）だけ、定義に `allowClosed: true` を付ける。

### 2. 定義を書く

`src/shared/operations/<機能>.ts` に書き、`src/shared/operations/index.ts` の一覧に足す（運用者の操作は `operator/index.ts`）。

```ts
import { z } from 'zod';
import { defineOperation } from './define.ts';

export const renameWorkspace = defineOperation({
  name: 'rename-workspace', // URL は POST /api/<slug>/rename-workspace。英小文字と数字をハイフンでつないだ1語
  description: 'ワークスペースの名前を変える',
  mode: 'write',
  permission: 'leader',
  workspace: true, // 入力に string の workspace_id が無いと型で落ちる
  input: z.object({ workspace_id: z.string(), name: z.string().min(1).max(40) }),
  output: z.object({ workspace_id: z.string(), name: z.string() }),
});
```

- 入力と出力の項目名は DB の列と同じスネークケース
- 出力は画面が使う項目だけを書く。出力のスキーマに無い項目は応答から落ちるので、行をそのまま返しても余計な列は出ないが、返す形は定義で決める
- 画面ごとの値の整形は定義に持たせない
- 重い操作（手動の同期など）には `rateLimit: { max: 5, windowSeconds: 300 }` を付ける。登録の関数がアカウントと操作ごとに数え、超えた呼び出しは 429 の `rate_limited` で断る（処理は動かない）。軽い操作に付けない（アプリ側のレート制限は、ログイン、手動の同期、GitHub に問い合わせる招待する人の解決にだけ設ける）

### 3. 処理を書く

`src/server/operations/<機能>.ts` に `implement(定義, 処理)` で書き、`src/server/operations/index.ts` の一覧に足す。

```ts
import { implement } from './implement.ts';

export const renameWorkspaceOperation = implement(renameWorkspace, async ({ db, workspace, input }) => {
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ name: input.name })
        .where('id', '=', workspace.workspaceId)
        .where('organization_id', '=', workspace.organizationId),
    ),
  ]);
  return { workspace_id: workspace.workspaceId, name: input.name };
});
```

- 渡るもの: 組織の外は `db`（共通の入口）と `accountId` と `account`（`organizations()` は入れる組織と届いた招待、`isOperator()` は運用者か、`logins()` はアカウントに結んだログインの手段と ID。どれも1回のリクエストで1回だけ引く）と `session`（今のセッション。ログアウトのように、セッションを終える操作だけが使う）。組織の中は `db`（組織の中の入口）と `actor` と `organization`（入るときに引いた組織の slug、名前、既定のテーマ）と `defer`（応答を待たせずに続ける仕事。`read` の操作が副作用として書くものに使う）。ワークスペースの下はさらに `workspace`（確かめたワークスペース）。どれも `input` は検証済み
- 組織の直下の表は `db.organizationId` で、ワークスペースの下の表は `workspace.workspaceId` で絞る。ID を入力から受ける組織の中の操作（`workspace_id` を持たないもの）は、結合した `workspaces.organization_id` を `db.organizationId` で絞り、行が無ければ `throw new ApiError(404, 'not_found')` を返す。別の組織の行と存在しない行を区別しない
- 書き込みは文を並べて `db.batch([...])` で1回に送る。先に読んだ値で判定する書き込みは、書く文の `WHERE` に同じ条件を入れる（`docs/development.md` の「入口を守る規則」）
- 競合は `throw new ApiError(409, 'conflict')`。ログに本文を出さない。`console.log` に入力や行を渡さない

### 4. 組織の分離のテスト用の関数を足す

組織の中の操作（`invitee`、`organization`、`member`、`leader`、`admin`）は、`test/operations/pointers.ts` に操作の名前をキーにして足す。足し忘れると `test/operation-registry.test.ts` が落ちる。

```ts
'rename-workspace': async (target) => ({ workspace_id: target.workspace.id, name: '青葉チーム' }),
```

- 関数は対象の組織（`Target`）を受け取り、その組織の行を指す成功する入力を返す。行が要るなら、ファクトリー（`test/factories.ts`）でその組織に作る
- 別の組織の `Target` を渡した入力が 404 になり、自分の組織の `Target` を渡した入力が成功することを、同じ関数で確かめる
- 入力が組織の中の行を指さない操作は、`{ noReference: <成功する入力> }` を書く。入力に `_id` で終わる項目がある操作には書けない（行を指しているので、関数で作る）
- 組織の外の操作（`login`、`operator`）は、入力が空で通るなら書かなくてよい。入力が必須の項目を持つなら、同じ形で足す（足さないと、一覧のテストが空の入力で呼んで 400 になり落ちる）

### 5. テストを足す

- 組織の分離、Origin、未ログイン、権限の種類ごとの許可と拒否は、一覧から自動で回る。書き足さない
- 処理の固有の振る舞い（計算、状態の遷移、競合）は、ほかのテストと同じく `test/` に書く。入口を通してファクトリーで行を作る

### 6. 画面から呼ぶ口を足す

画面からは `src/lib/api.ts` の `callOperation(定義, 入力, { slug })` を呼ぶ。入力と出力の型は定義から推論される。組織の外の操作は `slug` が要らない。結果は `ApiResult` で、失敗は `error.code` で分岐し、文言は言葉の辞書から出す。画面でルートを直に呼ばない。

### 7. 文書と確かめ

- 仕様を変える操作は、同じ PR で `docs/` も直す
- `pnpm check`、`pnpm lint`、`pnpm test` を通す
- 運用者の定義を足した PR と登録の関数に触れた PR は `needs-human` が付く。PR の本文に、権限をどう決めたかを書く
