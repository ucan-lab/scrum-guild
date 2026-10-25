# 運用の手順書

本番を用意し、出し、戻す手順。決めた理由は `docs/development.md` の「CD」と「Cloudflare のアカウントとドメイン」にある。

自動のデプロイは Workers Builds だけが行う。この文書の手で行う操作（用意、手での rollback、DB の復元）は人が手元で行い、Claude のセッションは実行しない（フックが止める）。

## 用意

### Cloudflare のアカウント

- ucan-lab 用のアカウントを Workers Paid にする
- `workers.dev` のサブドメインは `ucan-lab`。本番の URL は `https://scrum-guild.ucan-lab.workers.dev/`

### D1

1. ダッシュボードの D1 の「Create Database」か、手元の `wrangler d1 create scrum-guild` で、本番の D1 を作る。置き場所は自動（作った人に近い地域）のまま。今の D1 は Asia Pacific にある（2026-10-25）
2. D1 の ID を `wrangler.jsonc` の `d1_databases` の `database_id` に入れ、PR で `main` に入れる

### Workers Builds の接続

Worker の設定の Builds で、GitHub のリポジトリ `ucan-lab/scrum-guild` をつなぐ。

| 項目 | 値 |
| --- | --- |
| ブランチ | `main` |
| ビルドのコマンド | `APP_VERSION=$(git rev-parse HEAD) pnpm build` |
| デプロイのコマンド | `node scripts/deploy-production.ts` |
| ルートのディレクトリ | 空（リポジトリのルート） |
| preview builds | 無効 |
| API トークン | 権限を最小にしたトークン（`docs/development.md` の「CD」） |

- Node の版は `.node-version`、pnpm の版は `package.json` の `packageManager` から。Workers Builds で入らないときの扱いは `docs/development.md` の「CD」
- デプロイのスクリプトは、Workers Builds が入れる `WORKERS_CI=1` が無いか、`git rev-parse HEAD` で版を取れないと、本番に触らずに止まる。`WORKERS_CI` はデプロイのコマンドにも渡る（2026-10-25 の最初の接続で確かめた）
- 版に `WORKERS_CI_COMMIT_SHA` は使わない。接続した直後の初回のビルドと Retry build のような手で動かしたビルドでは、コミットの SHA ではなくブランチ名（`main`）が入る

### API トークン

Workers Builds のビルドでは、devDependencies のコードがトークンのある環境で動く。依存が1つ乗っ取られるとトークンが外へ出るので、権限はデプロイに要るものだけにする。

- 最小の権限のトークンを選べなければ、自動で作られたトークンでつないでよい。ただし、本番の D1 に自分のチームのデータを入れる前に、最小の権限のトークンへ入れ替える
- 入れ替えたら、自動で作られたトークンを Cloudflare の API トークンの一覧で失効させる

## 出し方

`main` に入ると Workers Builds がビルドし、デプロイのコマンドが `scripts/deploy.ts` の手順を動かす。人の操作は要らない。

1. 今 100% で動いている版の ID を、戻し先として控える。初回は戻し先無し
2. `migrations/` にファイルがあれば、Time Travel のブックマークをログに出してから、マイグレーションを当てる
3. 版を上げる直前に今の版を取り直し、控えた版と違えば止める（別のビルドの割り込み）
4. `wrangler deploy` で版（コミットの SHA）を上げ、100% に切り替える
5. 煙のテストで、`/api/health` の `version` が SHA になるまで最大2分待つ
6. ならなければ、控えた版へ戻し、ビルドを失敗で終える

ビルドのログで見るもの:

- `戻し先の版:` の行。失敗したときに戻す先
- `マイグレーションを当てる前の Time Travel のブックマーク:` の行。DB を戻すときに使う
- `煙のテスト:` の行。何回目、何秒で版が一致したか

続けてマージするときは、前のデプロイが終わってから次をマージする。ビルドが並んで走ると、スクリプトは別のビルドを潰さないよう戻さずに止まり、どちらの版が本番に残ったかを人が確かめることになる。ダッシュボードから古いコミットのビルドをやり直すのも、本番のコードを巻き戻すことになるので行わない。

## 戻し方

### コードを戻す

煙のテストに落ちたときは、スクリプトが自動で戻す。手で戻すのは、煙のテストを通ったが本番で壊れていると分かったときと、自動の rollback が失敗したとき。

1. ダッシュボードの Worker の Deployments か `wrangler deployments list` で、戻したい版の ID を確かめる。シークレットを入れ替えた後なら、入れ替えより前の版は選ばない（下の「戻るもの、戻らないもの」）
2. 手元で `wrangler rollback <版の ID> --message "<理由>"` を実行する。版の ID は必ず渡す。渡さないと wrangler が履歴から戻し先を選び、意図した版とずれることがある
3. `https://scrum-guild.ucan-lab.workers.dev/api/health` の `version` が戻した版の SHA になったことを確かめる

戻し先が無い（初回の版が煙のテストに落ちた）ときは、ビルドのログに「戻し先が無く、壊れた版が残っています」と出る。直したコミットを `main` に入れて出し直す。

### 戻るもの、戻らないもの

rollback で戻るのは、版が持つものすべて。コードと設定の値に加え、シークレットも戻し先の版の値に戻る。漏れた鍵を入れ替えた後に、入れ替えより前の版へ戻すと、漏れた鍵が本番で再び有効になる。

次のものは戻らない。

- D1 のデータとスキーマ（下の「DB を戻す」）
- cron やルート（triggers）の変更。`wrangler deploy` が版と一緒に反映する。triggers を変えた版を戻すときは、戻し先の版のコミットを checkout し、その `wrangler.jsonc` で `wrangler triggers deploy` を実行して当て直す。今の `main` で実行すると、戻したい triggers をもう一度当てるだけになる

### DB を戻す

マイグレーションは自動では戻さない。戻すかは人が決める。

1. 戻した DB で動く版へ、先にコードを戻す（上の「コードを戻す」）。DB を先に戻すと、その間は新しいスキーマを前提にしたコードが古いスキーマの上で動く
2. 戻したい時点のブックマークを、ビルドのログの `マイグレーションを当てる前の Time Travel のブックマーク:` の行から取る
3. 手元で `wrangler d1 time-travel restore scrum-guild --bookmark=<ブックマーク>` を実行する。ブックマークより後に書かれたデータは消える

マイグレーションは「広げてから縮める」に従うので、コードだけを戻せば足りることが多い。DB まで戻すのは、データを壊したときに限る。

## ドメインへ移す

`scrum-guild.dev` へ移すときは、次を同じ PR で直す。

- `scripts/deploy.ts` の `PRODUCTION_URL`（煙のテストが叩く URL）

## 組織

## 鍵の入れ替え

## 本番で壊れたとき
