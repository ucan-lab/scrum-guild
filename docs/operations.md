# 運用の手順書

本番を用意し、出し、戻す手順。決めた理由は `docs/development.md` の「CD」と「Cloudflare のアカウントとドメイン」にある。本番に触る操作は人が行い、Claude のセッションからはフックが止める。

## 用意

### Cloudflare のアカウント

- ucan-lab 用のアカウントを Workers Paid にする
- `workers.dev` のサブドメインは `ucan-lab`。本番の URL は `https://scrum-guild.ucan-lab.workers.dev/`

### D1

1. 手元で `wrangler d1 create scrum-guild` を実行し、本番の D1 を作る
2. 出力された `database_id` を `wrangler.jsonc` の `d1_databases` に入れ、PR で `main` に入れる

### Workers Builds の接続

Worker の設定の Builds で、GitHub のリポジトリ `ucan-lab/scrum-guild` をつなぐ。

| 項目 | 値 |
| --- | --- |
| ブランチ | `main` |
| ビルドのコマンド | `APP_VERSION=$WORKERS_CI_COMMIT_SHA pnpm build` |
| デプロイのコマンド | `node scripts/deploy-production.ts` |
| ルートのディレクトリ | 空（リポジトリのルート） |
| preview builds | 無効 |
| API トークン | 権限を最小にしたトークン（`docs/development.md` の「CD」） |

- Node の版は `.node-version`、pnpm の版は `package.json` の `packageManager` で決まる。Workers Builds で入らなければ、`docs/development.md` の「CD」の決まりに従って、手元、CI、本番の版をそろえる
- 最小の権限のトークンを選べなければ、自動で作られたトークンでつなぎ、ベータの前に入れ替える

## 出し方

`main` に入ると Workers Builds がビルドし、デプロイのコマンドが `scripts/deploy.ts` の手順を動かす。人の操作は要らない。

1. 今 100% で動いている版の ID を、戻し先として控える。初回は戻し先無し
2. `migrations/` にファイルがあれば、Time Travel のブックマークをログに出してから、マイグレーションを当てる
3. `wrangler deploy` で版（コミットの SHA）を上げ、100% に切り替える
4. 煙のテストで、`/api/health` の `version` が SHA になるまで最大2分待つ
5. ならなければ、控えた版へ戻し、ビルドを失敗で終える

ビルドのログで見るもの:

- `戻し先の版:` の行。失敗したときに戻す先
- `マイグレーションを当てる前の Time Travel のブックマーク:` の行。DB を戻すときに使う
- `煙のテスト:` の行。何回目、何秒で版が一致したか

## 戻し方

### コードを戻す

煙のテストに落ちたときは、スクリプトが自動で戻す。手で戻すのは、煙のテストを通ったが本番で壊れていると分かったときと、自動の rollback が失敗したとき。

1. ダッシュボードの Worker の Deployments か `wrangler deployments list` で、戻したい版の ID を確かめる
2. 手元で `wrangler rollback <版の ID> --message "<理由>"` を実行する。版の ID は必ず渡す。渡さないと「最新の一つ前に上げた版」に戻り、壊れた版へ戻ることがある
3. `https://scrum-guild.ucan-lab.workers.dev/api/health` の `version` が戻した版の SHA になったことを確かめる

rollback で戻るのはコードと設定の値だけ。次のものは戻らない。

- D1 のデータとスキーマ（下の「DB を戻す」）
- cron やルート（triggers）の変更。`wrangler deploy` が版と一緒に反映するので、triggers を変えた版を戻すときは、前の triggers を `wrangler triggers deploy` で当て直す

戻し先が無い（初回の版が煙のテストに落ちた）ときは、ビルドのログに「戻し先が無く、壊れた版が残っています」と出る。直したコミットを `main` に入れて出し直す。

### DB を戻す

マイグレーションは自動では戻さない。戻すかは人が決める。

1. 戻したい時点のブックマークを、ビルドのログの `マイグレーションを当てる前の Time Travel のブックマーク:` の行から取る
2. 手元で `wrangler d1 time-travel restore scrum-guild --bookmark=<ブックマーク>` を実行する。ブックマークより後に書かれたデータは消える
3. 戻した DB で動く版へコードも戻す（上の「コードを戻す」）

マイグレーションは「広げてから縮める」に従うので、コードだけを戻せば足りることが多い。DB まで戻すのは、データを壊したときに限る。

## ドメインへ移す

`scrum-guild.dev` へ移すときは、次を同じ PR で直す。

- `scripts/deploy.ts` の `PRODUCTION_URL`（煙のテストが叩く URL）

## 組織

## 鍵の入れ替え

## 本番で壊れたとき
