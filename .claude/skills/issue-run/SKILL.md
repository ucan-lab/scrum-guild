---
name: issue-run
description: 1つの Issue を、着手前の確かめ、grill-me、Issue への記録、ワークツリー、実装の委譲を経て self-review と PR まで進める。「#123 を進めて」「この Issue に着手して」「/issue-run 123」と言われたときに使う。何に着手するかを選ぶのは next-up、Issue を分けるのは issue-plan。
---

# issue-run

## 仕事

1つのタスク（または子の無いストーリー）の Issue を、PR を作って `pr-feedback` に渡すところまで進める。
終わりは「PR があり、`pr-feedback` が人にマージを聞いている」状態。PR の後は `self-review` → `pr-create` → `pr-feedback` が受け持つ。
人が担うのは判断だけにする。判断が要る点は推す案を先頭にした `AskUserQuestion` で聞き、チャットの文章で選ばせない。

## 入力

Issue の番号。並べて進めているほかの Issue があれば、その番号と重なりうるファイル。

## 手順

### 1. 着手してよいかを確かめる

```bash
gh api repos/{owner}/{repo}/issues/<番号> --jq '{state, labels: [.labels[].name], blocked: .issue_dependencies_summary.blocked_by, subs: .sub_issues_summary.total}'
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[].head.ref'
```

次のどれかなら止まり、理由を伝える。

- 閉じている、`status:in-progress` が付いている、その番号のブランチの PR が開いている（ほかのセッションが受け持っている）
- `blocked` が 0 でない（前に要るものが開いている）
- 子を持つ（子のタスクを進める）

並べている相手がいれば、両方の「やること」から変えるファイルを比べ、`docs/development.md` の「並行して作業するときの決まり」で並べてよいかを確かめる。

### 2. 詰める

Issue の本文、コメント、親の Issue、本文が指す `docs/` を読む。
`grill-me` で、本文に書かれていない難所だけを1つずつ聞く。調べれば分かることは聞かずに決めて伝える。
詰め始めたら `status:refining` を付ける（`status:in-progress` が無いときだけ）。

### 3. 記録する

決めたことを Issue の本文に「着手前に詰めたこと（日付、grill-me）」の節で足し、やることと完了条件も直す。
後の Issue に関わることは、その Issue にコメントで申し送る。決めたことを会話だけに残さない（並べたセッションと次のセッションが読めないため）。

### 4. ワークツリーを切る

ブランチとワークツリーの名前 `<番号>-<短い名前>` を、ファイルを書き始める前に決める（後で名前を変えると、フックが自分の変更と数えなくなる）。

```bash
git fetch origin
git worktree add worktrees/<名前> -b <名前> origin/main
```

`post-checkout` が `status:in-progress` を付けて `status:refining` を外す。クラウドのセッションはワークツリーを切らず、ラベルを手で付け替える（`docs/development.md` の「Issue の状態」）。
Issue に、ブランチ名とセッションの識別をコメントで残す（同じ文書の「並行して作業するときの決まり」）。

### 5. 実装を委譲する

`ucan:implementer` に渡す。渡すのは、ワークツリーの絶対パス、Issue の番号とやること、完了条件、変えてよい範囲、受け入れ条件の5つ。

受け入れ条件は次のとおり。触る範囲に合わないものは外し、外した理由を渡す。

- `pnpm check`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build` が通る
- マイグレーションを足したら `pnpm db:migrate:fresh` が通る（書き方は `d1-migration`）
- 画面か API の流れを変えたら `pnpm e2e` が通る
- コミットしない。ファイルは Edit と Write で書く（Bash で書いたファイルはフックがコミットを止める）。`pkill` を使わない

API の操作を足すなら `add-operation` を、画面を作るなら `ui-polish` を読ませる。

### 6. 受け取る

戻ったら、受け入れ条件の検査を自分で走らせ直す。エージェントの報告を検査の結果として扱わない。
`git status --short` に身に覚えのない変更があれば止まり、人に確かめる。
通ったらコミットし、Skill ツールで `self-review` を起動する。`self-review` が4つのレビュー（該当するエージェントと `codex-review`）を回し、`pr-create` と `pr-feedback` へ続ける。
MEDIUM 以上の指摘は、実装したエージェントに SendMessage でまとめて直させる。

### 7. マージの後

`pr-feedback` の後片付けまで済んだら、ストーリーの最後のタスクなら受け入れ条件を人に確かめてもらう（`pr-feedback` の説明資料）。
受け持ちが2つに達したら、次の Issue は新しいセッションで始めるよう伝える。

## 止まる条件

- 手順 1 のどれかに当てはまる
- 詰めた結果、Issue を分けたほうがよい（`issue-plan` に戻す）
- 検査が落ちて、原因が分からない
