---
name: done-check
description: 自分の差分を点検する。Issue の完了条件との突き合わせ、規約違反の確認、レビューエージェントによる指摘出しを行い、直してからコミットする。PR 作成後は、rebase・push・CI・レビューコメントの解決を確認してから点検する。「セルフレビュー」「PR 前に見て」「実装終わったので確認して」と言われたときに使う。PR を作る段階は pr-create、PR に付いた指摘への対応は pr-feedback を使う。
---

# done-check

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
`gh` が無いか認証で失敗するときは、`pr-create/github-mcp.md` に従い、GitHub の MCP ツールで代える。

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
| 最新のベースを取り込み済み | `git fetch origin && git merge-base --is-ancestor origin/<base> HEAD` | 終了コード 0 |
| 最新のコミットを push 済み | `git rev-parse HEAD` と `head_sha` を比べる。`git status --short` も見る | 一致し、未コミットの変更が無い |
| CI が成功 | 下の check-runs | `review` を除き、全て `status` が `completed` で、`conclusion` が `success`、`skipped`、`neutral` のどれか |
| レビューコメントを解決済み | 下の GraphQL | `isResolved: false` のスレッドが 0 件 |

```bash
gh api "repos/{owner}/{repo}/commits/<head_sha>/check-runs" --jq '.check_runs[] | {name, status, conclusion, url: .html_url}'
```

`review` は AI レビュー（`.github/workflows/ai-review.yml`）のチェックで、助言なので `ci-ok` に含めず、落ちてもマージの判定を止めない（`docs/development.md` の「CI」）。
`review` の `status` と `conclusion` が何でも、この前提は満たすものとして扱う（理由: 回した先の pr-feedback も `review` の失敗は直さないので、数に入れると done-check が先へ進めない）。
実行中の `review` が後から付ける指摘は、pr-feedback の手順 1 が完了を待って拾う。

```bash
gh api graphql -f query='{ repository(owner:"<owner>", name:"<repo>") { pullRequest(number:<number>) { reviewThreads(first:100) { nodes { isResolved path comments(first:1) { nodes { body author { login } } } } } } } }'
```

スレッドの解決状態は GraphQL でしか取れない。403（クラウド）が返ったら、`gh api "repos/{owner}/{repo}/pulls/<number>/comments" --paginate` でレビューコメントを読み、自分の返信が付いていないスレッドの先頭を数える。この前提は「解決状態は確かめられなかった」と出力に書いて先へ進む。

満たさない前提が 1 つでもあれば、レビューに進まず止まり、満たさない前提と次の経路を出力する。

- ベースの取り込みが未了: `sync-base` で rebase して `--force-with-lease` で push する
- push が未了: `git push` を提案する
- CI が失敗: pr-feedback で直す。`review` を除いて `status` が `completed` でないものがあれば、間を空けて check-runs を取り直し、結果が出てから再確認する
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

### 5. 動かして確かめる

Issue の「確認方法」を自分で実行し、完了条件を満たすかを実際の挙動で確かめる。
確認方法が書かれていなければ、完了条件から手順を組み立てる。
ログインが要るものは、seed がローカルの D1 に入れたセッションの Cookie を使う（`docs/development.md` の「開発とテストでのログイン」）。

| 変更の及ぶ先 | 確かめ方 |
| --- | --- |
| API | `wrangler dev` を立て、Cookie を付けてリクエストを送り、レスポンスと D1 の中身を見る。組織をまたぐ操作は、別の組織の ID で呼んで 404 になることも見る |
| 画面 | 手元は `terminal-browser` で Cookie を置いて開き、操作して表示と状態を見る。ブラウザの無いクラウドのセッションは、変えた画面の e2e のファイルを走らせてスクリーンショットを見る（絞り方は `increment-build` の受け入れ条件と同じ） |
| 挙動の変わらない変更（リファクタ、型、ドキュメント、設定） | 手順 4 で足りる。省いた旨を出力に書く |

動かせなかった項目は、確かめられなかった項目として出力に書く（理由: 確認済みと書くと、マージの判定で人が動作確認を省く）。

### 6. レビューエージェントに渡す

エージェントの定義はこのリポジトリの `.claude/agents/` にある。

| 対象 | エージェント |
| --- | --- |
| すべて | `code-reviewer` |
| 認証、認可、API エンドポイントの追加や変更、外部入力を SQL、シェル、ファイル、HTML、外部 URL に渡す処理、秘密情報を含む | `security-reviewer` |
| マイグレーション、クエリ、スキーマの変更を含む | `database-reviewer` |
| 画面（`.svelte`、CSS、`design/`、言葉の辞書）の変更を含む | `ui-reviewer` |

該当するエージェントは、1つのメッセージで同時に呼ぶ。

エージェントには範囲として「ベースは `<base>`。コミット済みの `git diff <base>...HEAD`（3点。分岐した点からの差分）と、未コミットの `git diff HEAD` を合わせて見る」と渡す。
範囲を渡さないと、エージェントは未コミットの差分しか見ない。
2点の `git diff <base>` と `git diff <base>..HEAD` は使わない（理由: どちらもベースの先端と比べるので、作業中にベースが進むと、ベース側の新しいコミットが逆向きの差分として混ざり、触っていない処理を消したという指摘が出る）。

手元のセッションでは、エージェントの結果を待つ間に Skill ツールで `codex-review` も起動する（理由: `code-reviewer` も CI の AI レビューも Claude 系で、同じ系統のモデルは同じ偏りを持つため、GPT 系の目を必ず1つ入れる）。
codex-review に渡す差分も、エージェントと同じ範囲（3点の差分と未コミットの差分）にする。
codex-review の指摘も、エージェントの指摘とまとめて手順 7 の基準で直す。
クラウドのセッションには `codex` CLI が無いので省き、出力に「クラウドのため codex-review を省略」と書く。手元でも `codex` が動かないときは、止まらずにその旨を書いて続ける。

差分が依存のバージョン指定とロックファイル（`package.json` と `package-lock.json` など）だけなら、エージェントと codex-review を省いてよい。
省いたときは、出力に「依存ファイルだけの差分のためレビューを省略」と書く。
それ以外の差分では、`code-reviewer` を必ず呼ぶ。

### 7. 直す

出た指摘を、直すものと直さないものに分ける。

- CRITICAL と HIGH: 直す。直さないなら、その理由を出力に残す（pr-create が PR 本文の `## 補足` に書く）
- 直さないつもりの CRITICAL と HIGH（誤検知と見たものを含む）は、`finding-verifier` に渡して反証にかける。渡すのは手順 6 と同じ範囲、チェックリストのディレクトリの絶対パス、指摘の本文そのままで、自分の見立ては添えない（理由: 直さない判断を下すのは差分を書いた本人で、自分の差分を守る側に寄る）。`反証` が返れば、その根拠を直さない理由として残す。`維持` が返れば直すか、直さない理由を出力に残す
- MEDIUM と LOW: 直すか、理由を残さずに落としてよい（全件に理由を書くと PR 本文が膨らむ）

エージェントの報告の「変更外」節は、この PR では直さない（差分に無い箇所を直すと PR が膨らむ）。
CRITICAL と HIGH は、別の Issue にするかをユーザーに提案する。

### 8. コミットする

`git add <paths> && git commit -m "..."` のように 1 コマンドにまとめる。
件名には、変更した対象と内容を書く（例: `fix: fill_results.py で結果の未指定と不正値を検出する`）。「レビュー指摘に対応する」のように、指摘への対応であることしか分からない件名にしない（理由: squash merge ではコミットメッセージが本文に残り、マージ後は直せない）。
PR があるときは、手順 7 の直しをすべてコミットしてからまとめて `git push` し、手順 0 の check-runs で CI が通ることを確かめる（`review` は手順 0 と同じく除く。修正は通常の push で積む。force push はベースを取り込む `sync-base` の中だけ）。コミットごとに push しない。CI の失敗を直した後の push は、その直しをまとめてから行う（理由: push のたびに CI のジョブがすべて走り直し、前の実行の取り消しが終わるまで次の実行も始まらない。`docs/development.md` の「開発の流れ」）。

### 9. pr-create に引き継ぐ

PR 作成前なら、Skill ツールで `pr-create` を起動する。
pr-create の手順から呼ばれた done-check なら、起動せずに pr-create の続きに戻る（互いに呼び合って止まらなくなるため）。
PR 作成後はここで終える。

## 出力

- 完了条件ごとの充足状況と、手順 5 で確かめた方法（確かめられなかった項目はその旨）
- 直した指摘と、直さなかった指摘とその理由

## 完了条件

- PR 作成後なら、手順 0 の前提が全て満たされている（スレッドの解決状態を確かめられなかったときは、その旨が出力に書かれている）
- 完了条件が全て満たされている、または満たさない理由が書かれている
- lint とテストが通っている
- 挙動の変わる変更なら、手順 5 で実際に動かして完了条件を確かめている
- レビューエージェントと codex-review（手元のセッションのみ）の CRITICAL と HIGH が、直されているか、直さない理由が出力に書かれている。直さないものには `finding-verifier` の判定が付いている

## 止まる条件

- PR 作成後で、手順 0 の前提を満たさない。満たさない前提と経路を出力する
- 完了条件を満たせない。実装計画に戻る
- テストが落ちて原因が分からない
- 規約と実装方針が食い違う。どちらを取るか確認する
