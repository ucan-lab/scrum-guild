# 運用の手順書

本番を用意し、出し、戻す手順。決めた理由は `docs/development.md` の「CD」と「Cloudflare のアカウントとドメイン」にある。

自動のデプロイは Workers Builds だけが行う。この文書の手で行う操作（用意、手での rollback、DB の復元）は人が手元で行い、Claude のセッションは実行しない（フックが止める）。

## 用意

### 手元の準備

手で wrangler を動かす操作（D1 を作る、rollback、DB の復元、triggers の当て直し）の前に行う。

1. `pnpm install` を済ませ、リポジトリのルートで実行する。wrangler はルートの `wrangler.jsonc` を読む
2. `pnpm exec wrangler login` でログインする
3. `pnpm exec wrangler whoami` で、ucan-lab のアカウント（`71293a3c23974c311b4c82b3f977049b`）を選んでいることを確かめる。複数のアカウントを持っていると、別のアカウントに作ったり戻したりする

### Cloudflare のアカウント

- ucan-lab 用のアカウントは Workers Paid（2026-10-25 にした）。Workers & Pages の「Workers plans」で変える
- `workers.dev` のサブドメインは `ucan-lab`。本番の URL は `https://scrum-guild.ucan-lab.workers.dev/`。Workers & Pages の Account details の Subdomain で変えられるが、変えるとアカウントのすべての Worker の URL が変わるので触らない
- 請求の通知: 予算 $10（自動で作られていたもの）と、使用量の通知（Workers のリクエスト 500万、CPU 時間 1,500万 ms、D1 の書き込み 2,500万行）。届け先はアカウントのメール
- Zero Trust は無料の枠で有効にしてある。チーム名は `ucan-lab`、ログインの手段にワンタイム PIN を足した。使うのは見本の Worker の Access（`docs/development.md` の「見本の Worker」）

### D1

1. ダッシュボードの D1 の「Create Database」か、手元の `wrangler d1 create scrum-guild` で、本番の D1 を作る。置き場所は自動（作った人に近い地域）のまま。今の D1 は Asia Pacific にある（2026-10-25）
2. D1 の ID を `wrangler.jsonc` の `d1_databases` の `database_id` に入れ、PR で `main` に入れる
3. マイグレーションは手で当てない。次のデプロイが `migrations/` の全部を当てる

### Workers Builds の接続

Workers & Pages の「Create application」→「Continue with GitHub」で、リポジトリ `ucan-lab/scrum-guild` を選び、Project name を `scrum-guild`（`wrangler.jsonc` の `name` と同じ）にして作る。Worker が既にあるときは、その Worker の Settings の Builds でつなぐ。GitHub の Cloudflare のアプリには、このリポジトリだけを許可してある。

| 項目 | 値 |
| --- | --- |
| ブランチ | `main` |
| ビルドのコマンド | `APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build` |
| デプロイのコマンド | `node scripts/deploy-production.ts` |
| ルートのディレクトリ（Path） | `/`（リポジトリのルート） |
| preview builds（Enable Preview builds） | 無効 |
| build watch paths | Include は `*`。Exclude は `docs/*`、`CLAUDE.md`、`.claude/skills/*`、`.claude/agents/*`、`.claude/checklists/*`、`.github/ISSUE_TEMPLATE/*`（`docs/development.md` の「文書だけの PR」と同じ範囲） |
| API トークン | 下の「API トークン」 |

- Node の版は `.node-version`、pnpm の版は `package.json` の `packageManager` から入る（2026-10-25 に確かめた）
- デプロイのスクリプトは、Workers Builds が入れる `WORKERS_CI=1` が無いか、`git rev-parse HEAD` で版を取れないと、本番に触らずに止まる。どちらもデプロイのコマンドで使えることを、2026-10-25 のビルド `ab64e8c1` で確かめた
- Create application で作ると、Cloudflare が Worker を作るときに初期の版を出す。最初のデプロイは「戻し先無し」にならず、この版を戻し先として控える（2026-10-25 は `56208d33`）。初期の版はこのリポジトリのコードではない
- 作った直後に `main` のビルドが1回走る。この初回のビルドは手で動かしたビルドの扱いになる
- ビルドのコマンドは、`git rev-parse HEAD` が失敗したらビルドを始めない。`APP_VERSION=$(...) pnpm build` の1行では git の失敗が無視され、画面の版が `dev` のまま出るため
- 版に `WORKERS_CI_COMMIT_SHA` は使わない。接続した直後の初回のビルドで、コミットの SHA ではなくブランチ名（`main`）が入っていた

### API トークン

Workers Builds のビルドでは、devDependencies のコードがトークンのある環境で動く。依存が1つ乗っ取られるとトークンが外へ出るので、権限はデプロイに要るものだけにする。

Workers Builds が使えるのは、Builds が自分で作ったトークンだけ。「My Profile」で自分で作ったユーザーのトークンも、「Account API tokens」で作ったアカウントのトークンも、Builds の「API token」の選択肢に出なかった（2026-10-25、2026-10-23）。Builds は値を持っていないトークンを使えないため。権限は、Builds が作ったトークンを編集して絞る。

本番のトークンは `scrum-guild build token`（接続のときに Builds が作った）。2026-10-25 に次の5つへ絞り、デプロイ（rollback の戻し先を控える、版を上げる、煙のテスト）が通ることを Retry build で確かめた。

| 範囲 | 権限 |
| --- | --- |
| Account（ucan-lab のアカウントだけ） | Workers Scripts: Edit、D1: Edit、Account Settings: Read |
| User | User Details: Read、Memberships: Read |

- 作られたときは、Workers AI、Queues、Containers、Secrets Store、R2、KV、AI Gateway などの編集と、全アカウントの全ゾーンの Email Routing Rules、Workers Routes、SSL and Certificates の編集まで、30 の権限を持っていた
- マイグレーション（`d1 time-travel info`、`d1 migrations apply`）は D1: Edit で動く見込みで、最初のマイグレーションのデプロイで確かめる
- 機能を足して権限が要るようになったら（R2 の添付ファイル、Queues など）、そのときに足す

権限を変える手順:

1. 右上のユーザーのメニューの「My Profile」→「API Tokens」で、`scrum-guild build token` の「⋯」→「Edit」を開く
2. 権限を足すか外し、「Continue to summary」→「Update token」で保存する。トークンの値は変わらないので、Builds の設定は触らない
3. Worker の「Deployments」で最新のビルドの「Retry build」を押し、デプロイが通ることを確かめる。権限が足りないときの止まり方は、本番に触る前の失敗

編集の画面では、名前の出ない権限の行（`Select...` と出る）がある。本番のトークンの `User` の `Select...` の行は Memberships: Read なので消さない。行の中身は「View summary」で確かめる。

### シークレット

Worker のシークレットは、ダッシュボードの Worker の Settings → Variables and Secrets か `wrangler secret put` で入れる。値は git に入れず、手元の開発用の値は `.dev.vars.example` を `.dev.vars` に写して入れる。

| 名前 | 中身 |
| --- | --- |
| `OPERATOR_LOGIN_IDS` | 運用者のログインの ID の一覧。`github:<数字>` か `google:<数字>` を、空白を含めずカンマで区切る（例 `github:12345,google:67890`）。GitHub の数字はユーザー ID（ユーザー名ではない）、Google の数字は `sub` |

`OPERATOR_LOGIN_IDS` の決まり。

- 空の項目、形に合わない項目、前後の空白、大文字の手段名が1つでもあると、`/api/health` を含むすべての API が 500 の `internal` を返す。運用者でない人に運用者の権限を渡さないよう、一覧を部分的に読まずに止める。ログ（Workers Logs）に項目の位置（`invalidPositions`）だけが出て、値は出ない
- 未設定は「運用者がいない」として扱う。設定してあって空の文字列にすると、500 になる
- シークレットを入れるか変えたら、すぐに `https://scrum-guild.ucan-lab.workers.dev/api/health` を開き、200 で版が返ることを確かめる。500 なら、直前の変更を直す
- 運用者を外したら、一覧を変えた版より前の版へ rollback しない。rollback はシークレットも戻し先の版の値に戻すので、外した運用者が戻る（下の「戻るもの、戻らないもの」）

## 出し方

`main` に入ると Workers Builds がビルドし、デプロイのコマンドが `scripts/deploy.ts` の手順を動かす。人の操作は要らない。変わったファイルがすべて build watch paths の Exclude に当たるマージ（文書だけの PR）では、ビルドは走らない。

1. 今 100% で動いている版の ID を、戻し先として控える。Worker が無いか、デプロイが1つも無ければ戻し先無し
2. `migrations/` にファイルがあれば、Time Travel のブックマークをログに出してから、マイグレーションを当てる
3. 版を上げる直前に今の版を取り直し、控えた版と違えば止める（別のビルドの割り込み）
4. `wrangler deploy` で版（コミットの SHA）を上げ、100% に切り替える
5. 煙のテストで、`/api/health` の `version` が SHA になるまで最大2分待つ
6. ならなければ、控えた版へ戻し、ビルドを失敗で終える

ビルドの状態とログは、ダッシュボードの Worker の「Deployments」で見る。ビルドの行の「Build」を開くとログが出る。一覧の状態が Ready なら成功、Failed なら失敗。ログで見るもの:

- `戻し先の版:` の行。失敗したときに戻す先
- `マイグレーションを当てる前の Time Travel のブックマーク:` の行。続く数行の JSON の `bookmark` の値を、DB を戻すときに使う
- `煙のテスト:` の行。何回目、何秒で版が一致したか

続けてマージするときは、前のデプロイが終わってから次をマージする。Workers Builds はビルドを一列に並べず同時に走らせる（2026-10-25 に確かめた）。デプロイの段が重なると、スクリプトは別のビルドを潰さないよう戻さずに止まり、どちらの版が本番に残ったかを人が確かめることになる。ダッシュボードから古いコミットのビルドをやり直すのも、本番のコードを巻き戻すことになるので行わない。

### デプロイが失敗で終わったとき

何が起きたかは、ログの最後の行で分かる。本番の今の版は、Deployments の一番上の「Active deployment」か `wrangler deployments status` で見る。スクリプトが `--message <SHA>` を付けるので、版の message がコミットの SHA。

| ログの文言 | 本番 | すること |
| --- | --- | --- |
| `Workers Builds の外では動かしません`、`版がコミットの SHA ではありません` | 触っていない | ビルドの設定（デプロイのコマンド、ビルドのコマンド）を上の表と見比べる |
| `今の版を取れませんでした`、`今の版の JSON を…`、`今の版が 100% で動いていません` | 触っていない | 人がダッシュボードで版を分けていないか、API トークンが失効していないかを見る。版が分かれていれば1つに戻してから、ビルドをやり直す |
| `Time Travel のブックマークを取れませんでした` | 触っていない | D1 の状態とトークンの D1 の権限を見て、ビルドをやり直す |
| `マイグレーションを当てられませんでした` | コードはそのまま。DB は途中まで当たっていることがある | ログの wrangler の出力で、どのマイグレーションで落ちたかを見る。当たった分は `d1_migrations` に記録されるので、直した PR を入れれば次のデプロイが残りを当てる |
| `控えた後に本番の版が変わりました` | 別のビルドが上げた版のまま | 別のビルドが終わるのを待ち、今の版の SHA が `main` の先頭と同じかを見る。違えば、`main` の先頭でビルドをやり直す |
| `版を上げられませんでした。版は切り替わっていません` | 触っていない | wrangler の出力を見て直し、ビルドをやり直す |
| `本番の版が、上げた版（…）から … に変わっています` | 別のビルドが上げた版のまま | 上の「控えた後に本番の版が変わりました」と同じ |
| `… へ戻しました` | 控えた版に戻った | 下の「戻したあと」に進む |
| `… へ戻せませんでした`、`戻し先が無く、壊れた版が残っています` | 壊れた版のまま | 下の「コードを戻す」で手で戻すか、直した PR を入れて出し直す |

## 戻し方

### コードを戻す

煙のテストに落ちたときは、スクリプトが自動で戻す。手で戻すのは、煙のテストを通ったが本番で壊れていると分かったときと、自動の rollback が失敗したとき。

1. ダッシュボードの Worker の Deployments か `wrangler deployments list` で、戻したい版の ID を確かめる。版の message がコミットの SHA。シークレットを入れ替えた後なら、入れ替えより前の版は選ばない（下の「戻るもの、戻らないもの」）。Create application が出した初期の版（message が無い）は選ばない
2. 手元（上の「手元の準備」）で `wrangler rollback <版の ID> --message "<理由>"` を実行する。確認が出たら版の ID を見て進める。版の ID は必ず渡す。渡さないと wrangler が履歴から戻し先を選び、意図した版とずれることがある
3. `https://scrum-guild.ucan-lab.workers.dev/api/health` の `version` が戻した版の SHA になったことを確かめる
4. 下の「戻したあと」に進む

戻し先が無い（デプロイの無い Worker に出した版が煙のテストに落ちた）ときは、ビルドのログに「戻し先が無く、壊れた版が残っています」と出る。直したコミットを `main` に入れて出し直す。

### 戻したあと

rollback も DB の復元も `main` には触らない。`main` には壊れたコミットが残り、次に `main` へ文書だけでない PR が入ると、そのデプロイが壊れたコードをもう一度出す。自動で戻ったときも同じ。

1. 直す PR か revert の PR が入るまで、`main` へのマージと push を止める
2. 壊れたコミットを revert する PR を作り、マージする（2026-10-25 の実地の試しでは #84 を #85 で戻した）。DB も戻したなら、戻した時点より後のマイグレーションのファイルも revert に含める。含めないと、`d1_migrations` も戻っているので、次のデプロイが同じマイグレーションをまた当てる
3. revert のデプロイが成功し、`/api/health` の `version` が revert のコミットの SHA になったことを確かめる

### 戻るもの、戻らないもの

rollback で戻るのは、版が持つものすべて。コードと設定の値に加え、シークレットも戻し先の版の値に戻る。漏れた鍵を入れ替えた後に、入れ替えより前の版へ戻すと、漏れた鍵が本番で再び有効になる。運用者の一覧（`OPERATOR_LOGIN_IDS`）から外した人も、外す前の版へ戻すと運用者に戻ってしまう。

次のものは戻らない。

- D1 のデータとスキーマ（下の「DB を戻す」）
- cron やルート（triggers）の変更。`wrangler deploy` が版と一緒に反映する。triggers を変えた版を戻すときは、手元（上の「手元の準備」）で戻し先の版のコミットを checkout し、その `wrangler.jsonc` で `wrangler triggers deploy` を実行して当て直す。今の `main` で実行すると、戻したい triggers をもう一度当てるだけになる。今の `wrangler.jsonc` に triggers は無い

### DB を戻す

マイグレーションは自動では戻さない。戻すかは人が決める。Time Travel で戻せるのは Workers Paid で直近30日まで。それより前に戻す手段（定期の書き出し）はまだ無い。

1. 戻した DB で動く版へ、先にコードを戻す（上の「コードを戻す」）。DB を先に戻すと、その間は新しいスキーマを前提にしたコードが古いスキーマの上で動く
2. 戻したい時点のブックマークを、ビルドのログの `マイグレーションを当てる前の Time Travel のブックマーク:` の行の JSON の `bookmark` から取る。データを壊したときは、壊れた時刻より前の、いちばん新しいビルドの行を使う。ログに無い時刻へ戻すときは、`wrangler d1 time-travel info scrum-guild --timestamp=<時刻>` でその時刻のブックマークを引く
3. 手元（上の「手元の準備」）で `wrangler d1 time-travel restore scrum-guild --bookmark=<ブックマーク>` を実行する。ブックマークより後に書かれたデータは消える
4. 上の「戻したあと」に進む

マイグレーションは「広げてから縮める」に従うので、コードだけを戻せば足りることが多い。DB まで戻すのは、データを壊したときに限る。

## ドメインへ移す

`scrum-guild.dev` へ移すときは、次を同じ PR で直す。

- `scripts/deploy.ts` の `PRODUCTION_URL`（煙のテストが叩く URL）
- `wrangler.jsonc` の `vars` の `PUBLIC_ORIGIN`（更新系の API の Origin の検査。新しい URL と一致しない呼び出しは 403 になる）
- ほかに直すもの（GitHub OAuth App の戻り先、Cookie）は `docs/development.md` の「Cloudflare のアカウントとドメイン」

## 組織

まだ書いていない。組織を作る機能ができたら書く。

## 鍵の入れ替え

まだ書いていない。シークレットを持つ機能ができたら書く。

## 本番で壊れたとき

まだ書いていない。気づく手段は `docs/development.md` の「本番で壊れたことに気づく」、戻す手順は上の「戻し方」。
