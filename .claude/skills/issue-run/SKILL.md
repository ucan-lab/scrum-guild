---
name: issue-run
description: 1つの Issue を、着手前の確かめ、grill-me、Issue への記録、ワークツリー、実装の委譲を経て self-review と PR まで進める。「#123 を進めて」「この Issue に着手して」「/issue-run 123」と言われたときに使う。何に着手するかを選ぶのは next-up、Issue を分けるのは issue-plan。
---

# issue-run

## 仕事

1つのタスク（または子の無いストーリー）の Issue を、実装して `self-review` に渡す。`self-review` が `pr-create` と `pr-feedback` へ続け、PR、レビューへの対応、マージの後片付けまでを受け持つ。
終わりは「`pr-feedback` が後片付けを終えている」状態。
人が担うのは判断だけにする。判断が要る点は推す案を先頭にした `AskUserQuestion` で聞き、チャットの文章で選ばせない。

## 入力

Issue の番号。並べて進めているほかの Issue があれば、その番号と重なりうるファイル、`DEV_PORT_OFFSET` の値（`next-up` のプロンプトが渡す）。

## 手順

### 1. 着手してよいかを確かめる

```bash
gh api repos/{owner}/{repo}/issues/<番号> --jq '{state, title, pr: (.pull_request != null), labels: [.labels[].name], blocked: .issue_dependencies_summary.blocked_by, subs: .sub_issues_summary.total, parent: (.parent_issue_url // "" | split("/") | last)}'
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[] | {number, head: .head.ref, refs: ([.body // "" | scan("(?i)(?:closes|fixes|refs) #([0-9]+)") | .[0]])}'
```

次のどれかなら止まり、理由を伝える。

- 閉じている、PR の番号だった、`epic` か子を持つ（子のタスクを進める）
- その Issue を指す開いた PR がある（ブランチ名の `<番号>-` の先頭か、本文の `Closes` と `Refs`）
- `status:in-progress` か `status:refining` が付いている（ほかのセッションか人が受け持っている）。前のセッションが落ちて残ったもの、人がこのセッションで続けるよう言ったものだけ続ける。手元のワークツリーが残っていれば、それを使う
- `blocked` が 0 でない、または親のストーリーの `blocked` が 0 でない（前に要るものが開いている）
- 人が行う Issue（題が「確認:」で始まる、要件を決める、本番やアカウントやドメインの操作）
- `migration` が付いていて、ほかに `migration` の付いた作業中の Issue か開いた PR がある
- このセッションが既に2つの Issue を受け持った（次は新しいセッションで始める）

並べている相手がいれば、両方の「やること」から変えるファイルを比べ、`docs/development.md` の「並行して作業するときの決まり」で並べてよいかを確かめる。

### 2. 詰める

Issue の本文、コメント、親の Issue、本文が指す `docs/` を読む。
本文に書かれていない難所があれば、`status:refining` を付けてから `grill-me` で1つずつ聞く。調べれば分かることは聞かずに決めて伝える。`grill-me` の落とし先は、手順 3 の Issue の本文と決まっている。
難所が無ければ飛ばす。人に聞けない実行では、前提を自分で置いて手順 3 で Issue に書き、PR の本文にも書く（`pr-create` に渡す）。

### 3. 記録する

決めたことを Issue の本文に「着手前に詰めたこと（日付、grill-me）」の節で足し、やることと完了条件も直す。
後の Issue に関わることは、その Issue にコメントで申し送る。決めたことを会話だけに残さない（並べたセッションと次のセッションが読めないため）。

### 4. ワークツリーを切る

ブランチとワークツリーの名前 `<番号>-<短い名前>` を、ファイルを書き始める前に決める（後で名前を変えると、フックが自分の変更と数えなくなる）。

```bash
git fetch origin
git worktree add worktrees/<名前> -b <名前> origin/main
```

`post-checkout` が `status:in-progress` を付けて `status:refining` を外す。
ワークツリーで `pnpm install` を走らせる（依存はワークツリーごとに入れる。`docs/development.md` の「ワークツリーで作業する」）。
以降の git、`pnpm`、`self-review` は、ワークツリーの絶対パスの中で行う。Bash のカレントは呼び出しごとに本体へ戻るので、コマンドごとに `cd <絶対パス> ||` を付けるか `git -C <絶対パス>` で打つ。

クラウドのセッションはワークツリーを切らず、ラベルを手で付け替える（`docs/development.md` の「Issue の状態」）。
Issue に、ブランチ名とセッションの識別をコメントで残す（同じ文書の「並行して作業するときの決まり」）。

### 5. 実装を委譲する

`ucan:implementer` に渡す。無い環境（クラウド）では Agent ツールの汎用のサブエージェントに渡す。渡すのは、ワークツリーの絶対パス、Issue の番号とやること、完了条件、変えてよい範囲、受け入れ条件の5つ。

受け入れ条件は次のとおり。触る範囲に合わないものは外し、外した理由を渡す。

- 完了条件を確かめるテストを実装と一緒に書く。API の操作を足したら、権限と組織の分離のテストが通る（`add-operation`）
- 仕様を変えたら、同じ差分で `docs/` を直す
- `pnpm check`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build` が通る
- マイグレーションを足したら `pnpm db:migrate:fresh` が通る（書き方は `d1-migration`）
- 画面か API の流れを変えたら、変えた画面と流れに関わる e2e のファイルが通る（`pnpm e2e e2e/members.test.ts` のようにファイルを渡す。e2e のファイルは画面ごとに分かれているので、API だけを変えたときは、その操作を呼ぶ画面のファイルを選ぶ）。全件は CI に任せる。共通の枠、言葉の辞書、テーマ、ログインのような、どの画面にも出るものを変えたときだけ全件を走らせる（`docs/development.md` の「開発の流れ」）。`DEV_PORT_OFFSET` を渡されていれば、`pnpm e2e` と `pnpm dev` に付ける
- `.claude/hooks/` を変えたら `node --test .claude/hooks/*.test.mjs` が通る
- コミットしない。ファイルは Edit と Write で書く（Bash で書いたファイルはフックがコミットを止める）。`pkill` を使わない

画面を作るなら `ui-polish` を読ませる。

### 6. 受け取る

戻ったら、受け入れ条件の検査を自分で走らせ直す。エージェントの報告を検査の結果として扱わない。
`git status --short` に身に覚えのない変更があれば止まり、人に確かめる。
通ったらコミットし、Skill ツールで `self-review` を起動する。レビューと直し方の基準は `self-review` に従う。直す量が多ければ、実装したエージェントに SendMessage でまとめて直させ、戻らなければ自分で直す。

### 7. 渡した後

`self-review` から `pr-create`、`pr-feedback` へ続ける。ストーリーの最後のタスクなら、`pr-feedback` の説明資料で親のストーリーの受け入れ条件を示す。
マージの後は `pr-feedback` の後片付けまで続ける。

## 止まる条件

- 手順 1 のどれかに当てはまる
- 詰めた結果、Issue を分けたほうがよい（`issue-plan` に戻す）
- 検査が落ちて、原因が分からない
