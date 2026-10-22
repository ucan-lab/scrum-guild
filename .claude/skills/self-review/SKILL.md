---
name: self-review
description: 自分の差分を点検する。Issue の完了条件との突き合わせ、規約違反の確認、レビューエージェントによる指摘出しを行い、直してからコミットする。PR 作成後は、rebase・push・CI・レビューコメントの解決を確認してから点検する。「セルフレビュー」「PR 前に見て」「実装終わったので確認して」と言われたときに使う。PR を作る段階は pr-create、PR に付いた指摘への対応は pr-feedback を使う。
---

# self-review

## 仕事

自分の差分を点検し、レビュワーに渡す前に直せるものを直す。
PR 作成前と作成後の両方で使う。作成後は、PR が最新の状態にあることを確かめてから点検する。
指摘を並べて終わりにしない。直すところまでが仕事。

## 絶対にやらないこと

- 指摘を出して直さずに終わらない（理由: レビュワーに渡す前に潰すのがこの工程の目的）
- 差分に無い箇所をついでに直さない（理由: PR の差分が膨らみ、レビューの負荷が上がる）
- テストと lint を通さずに完了としない（理由: CI が落ちてからレビュワーを待たせる）

## GitHub の操作

PR の状態は `gh api` の REST で取る。クラウドのセッションでは、GraphQL を使う `gh pr` が 403 で止まるため。
`{owner}` `{repo}` `{branch}` は `gh` がカレントのリポジトリとブランチに置き換える。置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く。

## 入力

作業ブランチの差分。対象の Issue 番号が分かれば合わせて。

## 手順

### 0. PR の有無で分岐する

```bash
gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0] | {number, url: .html_url, base: .base.ref, head_sha: .head.sha}'
```

`number` が `null` なら PR は無い。手順 1 へ進む。ベースブランチは慣習（通常 `origin/main`）から決める。

PR があれば、ベースは `origin/<base>` とし、次の前提をすべて確認する。

| 前提 | 確認 | 満たすとき |
| --- | --- | --- |
| 最新のベースを rebase 済み | `git fetch origin && git merge-base --is-ancestor origin/<base> HEAD` | 終了コード 0 |
| 最新のコミットを push 済み | `git rev-parse HEAD` と `head_sha` を比べる。`git status --short` も見る | 一致し、未コミットの変更が無い |
| CI が成功 | 下の check-runs | 全て `status` が `completed` で、`conclusion` が `success`、`skipped`、`neutral` のどれか |
| レビューコメントを解決済み | 下の GraphQL | `isResolved: false` のスレッドが 0 件 |

```bash
gh api "repos/{owner}/{repo}/commits/<head_sha>/check-runs" --jq '.check_runs[] | {name, status, conclusion, url: .html_url}'
```

```bash
gh api graphql -f query='{ repository(owner:"<owner>", name:"<repo>") { pullRequest(number:<number>) { reviewThreads(first:100) { nodes { isResolved path comments(first:1) { nodes { body author { login } } } } } } } }'
```

スレッドの解決状態は GraphQL でしか取れない。403（クラウド）が返ったら、`gh api "repos/{owner}/{repo}/pulls/<number>/comments" --paginate` でレビューコメントを読み、自分の返信が付いていないスレッドの先頭を数える。この前提は「解決状態は確かめられなかった」と出力に書いて先へ進む。

満たさない前提が 1 つでもあれば、レビューに進まず止まり、満たさない前提と次の経路を出力する。

- rebase が未了: ユーザーに rebase と force push を依頼する（履歴の書き換えはユーザーの判断に委ねる）
- push が未了: `git push` を提案する
- CI が失敗: pr-feedback で直す。`status` が `completed` でないものがあれば、間を空けて check-runs を取り直し、結果が出てから再確認する
- 未解決のスレッドがある: pr-feedback で対応する

全て満たせば手順 1 へ進む。

### 1. 差分を確認する

```bash
git status --short
git diff <base>...HEAD
```

身に覚えのない変更があれば止まる（並行セッションの可能性）。

### 2. 完了条件と突き合わせる

Issue の完了条件を 1 つずつ、差分のどこで満たされているかを確認する。
満たせていないものがあれば、実装に戻る。

### 3. 規約を読む

リポジトリの CLAUDE.md、AGENTS.md、README、lint 設定、既存の近いコードを読む。
プロジェクトの書き方に合っているかを見る。自分の好みに寄せない。

### 4. 機械で判定できるものを先に通す

lint、フォーマッタ、テストを走らせる。落ちたらここで直す。

### 5. レビューエージェントに渡す

エージェントの定義はこのリポジトリの `.claude/agents/` にある。

| 対象 | エージェント |
| --- | --- |
| すべて | `code-reviewer` |
| 認証、認可、API エンドポイントの追加や変更、外部入力を SQL、シェル、ファイル、HTML、外部 URL に渡す処理、秘密情報を含む | `security-reviewer` |
| マイグレーション、クエリ、スキーマの変更を含む | `database-reviewer` |

該当するエージェントは、1つのメッセージで同時に呼ぶ。

エージェントには範囲として「ベースは `<base>`。コミット済みと未コミットを合わせた `git diff <base>` を見る」と渡す。
範囲を渡さないと、エージェントは未コミットの差分しか見ない。

差分が依存のバージョン指定とロックファイル（`package.json` と `package-lock.json` など）だけなら、エージェントを省いてよい。
省いたときは、出力に「依存ファイルだけの差分のためエージェントを省略」と書く。
それ以外の差分では、`code-reviewer` を必ず呼ぶ。

別の視点を足したいときは、手元なら codex-review を使う。

### 6. 直す

出た指摘を、直すものと直さないものに分ける。

- CRITICAL と HIGH: 直す。直さないなら、その理由を出力に残す（pr-create が PR 本文の `## 補足` に書く）
- MEDIUM と LOW: 直すか、理由を残さずに落としてよい（全件に理由を書くと PR 本文が膨らむ）

エージェントの報告の「変更外」節は、この PR では直さない（差分に無い箇所を直すと PR が膨らむ）。
CRITICAL と HIGH は、別の Issue にするかをユーザーに提案する。

### 7. コミットする

`git add <paths> && git commit -m "..."` のように 1 コマンドにまとめる。
件名には、変更した対象と内容を書く（例: `fix: fill_results.py で結果の未指定と不正値を検出する`）。「レビュー指摘に対応する」のように、指摘への対応であることしか分からない件名にしない（理由: squash merge ではコミットメッセージが本文に残り、マージ後は直せない）。
PR 作成後は `git push` まで行い、手順 0 の check-runs で CI が通ることを確かめる（force push はしない）。

### 8. pr-create に引き継ぐ

PR 作成前なら、Skill ツールで `pr-create` を起動する。
pr-create の手順から呼ばれた self-review なら、起動せずに pr-create の続きに戻る（互いに呼び合って止まらなくなるため）。
PR 作成後はここで終える。

## 出力

- 完了条件ごとの充足状況
- 直した指摘と、直さなかった指摘とその理由

## 完了条件

- PR 作成後なら、手順 0 の前提が全て満たされている（スレッドの解決状態を確かめられなかったときは、その旨が出力に書かれている）
- 完了条件が全て満たされている、または満たさない理由が書かれている
- lint とテストが通っている
- レビューエージェントの CRITICAL と HIGH が、直されているか、直さない理由が出力に書かれている

## 止まる条件

- PR 作成後で、手順 0 の前提を満たさない。満たさない前提と経路を出力する
- 完了条件を満たせない。実装計画に戻る
- テストが落ちて原因が分からない
- 規約と実装方針が食い違う。どちらを取るか確認する
