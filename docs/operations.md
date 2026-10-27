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

Worker のシークレットは、ダッシュボードの Worker の Settings → Variables and Secrets か `wrangler secret put` で入れる。ダッシュボードでは Type を `Secret` にする。`Variable` で入れると、Workers Builds の次のデプロイで、`wrangler.jsonc` の `vars` に無い名前として消える。消えても `/api/health` は 200 のままで、運用者がいない状態になるか、GitHub のログインが「いまログインを受け付けられません」になるだけなので、気づいたら `Secret` として入れ直す。どちらで入れても、保存するとその場で新しい版が本番に出る。値は git に入れず、手元の開発用の値は、本体の作業コピーで `.dev.vars.example` を `.dev.vars` に写して入れる。ワークツリーの `.dev.vars` は本体へのリンクなので、そこで写すと本体の値を上書きする（`docs/development.md` の「ワークツリーで作業する」）。

| 名前 | 中身 |
| --- | --- |
| `OPERATOR_LOGIN_IDS` | 運用者のログインの ID の一覧。`github:<数字>` か `google:<数字>` を、空白を含めずカンマで区切る（例 `github:12345,google:67890`）。GitHub の数字はユーザー ID（ユーザー名ではない。`gh api user --jq .id` で分かる）、Google の数字は `sub`（調べ方は下の「運用者の Google の `sub` の調べ方」） |
| `GITHUB_CLIENT_ID` | GitHub のログインの OAuth App のクライアント ID（下の「GitHub OAuth App」） |
| `GITHUB_CLIENT_SECRET` | 同じ OAuth App のクライアントシークレット |
| `GOOGLE_CLIENT_ID` | Google のログインの OAuth クライアントのクライアント ID（下の「Google の OAuth クライアント」） |
| `GOOGLE_CLIENT_SECRET` | 同じ OAuth クライアントのクライアントシークレット |

`GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET` の決まり。

- どちらかが未設定か空だと、ログインの画面の GitHub のボタンは「いまログインを受け付けられません」に戻る。API は動き続け、`/api/health` は 200 のまま。Workers Logs にはログインの開始のログ（`route: "auth"`、`step: "start"`、`outcome: "unavailable"`）が出る
- 初めてのデプロイの前に、本番の OAuth App を作ってシークレットに入れる。入れずに出しても、ほかの機能は動くが、誰もログインできない
- クライアントシークレットを入れ替えるときは、OAuth App で新しいシークレットを作ってシークレットを書き換え、動くことを確かめてから古いシークレットを OAuth App で消す。書き換えの間は、ログインの途中の人が1度失敗することがある

`GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` も同じ決まり。どちらかが未設定か空だと、ログインの画面の Google のボタンだけが「いまログインを受け付けられません」に戻り、GitHub のログインは動き続ける。Workers Logs にはログインの開始のログ（`provider: "google"`、`step: "start"`、`outcome: "unavailable"`）が出る。

`OPERATOR_LOGIN_IDS` の決まり。

- 空の項目、形に合わない項目、前後の空白、大文字の手段名が1つでもあると、`/api/health` を含むすべての API が 500 の `internal` を返す。運用者でない人に運用者の権限を渡さないよう、一覧を部分的に読まずに止める。ログ（Workers Logs）に項目の位置（`invalidPositions`）だけが出て、値は出ない
- 未設定は「運用者がいない」として扱う。設定してあって空の文字列にすると、500 になる
- 最初の運用者は、初めてログインする前に自分の ID をこの一覧に入れる（形と調べ方は上の表）。組織も招待も無い本番では、運用者でない人は GitHub の認可を通っても `/login?error=denied` に戻る（Workers Logs には `step: "callback"`、`outcome: "denied"` が出る）。組織は運用者が作るので、一覧が未設定のままだと誰も入れない
- シークレットを入れるか変えたら、すぐに `https://scrum-guild.ucan-lab.workers.dev/api/health` を開き、200 で版が返ることを確かめる。500 なら、直前の変更を直す
- 運用者を外したら、一覧を変えた版より前の版へ rollback しない。rollback はシークレットも戻し先の版の値に戻すので、外した運用者が戻る（下の「戻るもの、戻らないもの」）
- 運用者を外すと、入れる組織も無い人は、次に組織の外の操作（`logout` を除く）を呼んだときにセッションが消え、ログインできなくなる

### GitHub OAuth App

ログインは共通の1つの GitHub OAuth App で行う（`docs/development.md` の「GitHub のログインと取り込み」）。本番用と開発用を別に作る。スコープは `read:user` だけで、アプリがログインのたびに求める。OAuth App の側に設定する項目ではない。

1. GitHub の Settings → Developer settings → OAuth Apps → New OAuth App を開く。本番は運用者の GitHub アカウントか、組織の下に作る
2. 値を入れる。Device Flow は有効にしない。Expire user access tokens は既定のままでよい（アプリはトークンを読んだ直後に取り消す）

   | 項目 | 本番 | 開発用 |
   | --- | --- | --- |
   | Application name | Scrum Guild | Scrum Guild (dev) |
   | Homepage URL | `https://scrum-guild.ucan-lab.workers.dev` | `http://localhost:5173` |
   | Redirect URI | `https://scrum-guild.ucan-lab.workers.dev/api/auth/github/callback` | `http://localhost:5173/api/auth/github/callback` |

3. 作った OAuth App の「Client ID」を控え、「Generate a new client secret」で作ったシークレットを控える。シークレットは作った直後にしか見えない
4. 本番は `wrangler secret put GITHUB_CLIENT_ID` と `wrangler secret put GITHUB_CLIENT_SECRET`（か、ダッシュボードの Worker の Settings → Variables and Secrets）で入れる。開発用は、本体の作業コピーで `.dev.vars.example` を `.dev.vars` に写して `GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET` に入れる（ワークツリーの `.dev.vars` は本体へのリンクなので、直すのは本体の側。`docs/development.md` の「ワークツリーで作業する」）。本番で初めて入れるときは `OPERATOR_LOGIN_IDS` にも自分の ID を入れ、入れないと次の手順のログインは `/login?error=denied` で終わる（上の「シークレット」の `OPERATOR_LOGIN_IDS` の決まり）
5. 入れたら、本番は `https://scrum-guild.ucan-lab.workers.dev/api/health` を開き、200 が返ることを確かめる。ログインの画面から GitHub のボタンを押し、GitHub の同意画面に戻り先の URL の不一致（`redirect_uri` の誤り）が出ないことを見る

決まり。

- 戻り先の URL は、アプリが開始のときに渡す `redirect_uri`（`PUBLIC_ORIGIN` に `/api/auth/github/callback` を足した値）と、OAuth App に登録した Redirect URI のどれかが合う必要がある。独自ドメインへ移すときは、OAuth App の Homepage URL と Redirect URI も直す（上の「ドメインへ移す」）
- 開発用の戻り先は、`pnpm dev` の画面の URL（`http://localhost:5173`。ワークツリーのポートは名前からずれるので、本物のログインはワークツリーの `.dev-port-offset` に 0 を書いて確かめる。`docs/development.md` の「ポート」）。`DEV_PORT_OFFSET` で明示してポートをずらして確かめるときは、OAuth App の「Add redirect URI」で、そのポートの戻り先（例 `http://localhost:5183/api/auth/github/callback`）を足す（10個まで登録できる）
- 開発用の OAuth App で確かめるのは、本物のログインとログアウトだけ。e2e は seed のセッションの Cookie で通し、OAuth App の値を渡さない（`docs/development.md` の「開発とテストでのログイン」）
- シークレットは git、ログ、Issue、PR に書かない。漏れたと分かったら、OAuth App でシークレットを作り直して入れ替える

### Google の OAuth クライアント

ログインは、種類が「ウェブ アプリケーション」の OAuth クライアント1つで行う（`docs/development.md` の「Google のログイン」）。本番用と開発用は別の Google Cloud プロジェクトに作る。同意画面の公開の状態が違い、開発用を「テスト」のままにしておくため。スコープは `openid`、`email`、`profile` だけで、機密のスコープを使わないので Google の審査は要らない。

1. Google Cloud コンソールでプロジェクトを作る（本番は `Scrum Guild`、開発用は `Scrum Guild (dev)` など）
2. Google Auth Platform の「ブランディング」で、アプリ名、ユーザーサポートメール、デベロッパーの連絡先を入れる
3. 「対象」で、ユーザーの種類を「外部」にする。公開の状態は、本番は「本番環境」に進める。開発用は「テスト」のままにして、確かめる人の Google アカウントを「テストユーザー」に登録する（「テスト」の間は、登録したテストユーザーしかログインできない）
4. 「データへのアクセス」で、スコープに `openid`、`.../auth/userinfo.email`、`.../auth/userinfo.profile` の3つだけを足す
5. 「クライアント」でクライアントを作る。アプリケーションの種類は「ウェブ アプリケーション」。「承認済みの JavaScript 生成元」は空にし、「承認済みのリダイレクト URI」に次を入れる

   | 項目 | 本番 | 開発用 |
   | --- | --- | --- |
   | 承認済みのリダイレクト URI | `https://scrum-guild.ucan-lab.workers.dev/api/auth/google/callback` | `http://localhost:5173/api/auth/google/callback` |

6. 作ったクライアントの「クライアント ID」と「クライアント シークレット」を控える。クライアントシークレットは作った直後にしか全体が見えない
7. 本番は `wrangler secret put GOOGLE_CLIENT_ID` と `wrangler secret put GOOGLE_CLIENT_SECRET`（か、ダッシュボードの Worker の Settings → Variables and Secrets）で入れる。開発用は `.dev.vars.example` を `.dev.vars` に写して `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` に入れる。自分の Google でログインを確かめるときは、`OPERATOR_LOGIN_IDS` に `google:<自分の sub>` も足す（次の節）
8. 入れたら、本番は `https://scrum-guild.ucan-lab.workers.dev/api/health` を開き、200 が返ることを確かめる。ログインの画面から Google のボタンを押し、Google の画面に `redirect_uri_mismatch` が出ないことを見る

決まり。

- 戻り先の URL は、アプリが開始のときに渡す `redirect_uri`（`PUBLIC_ORIGIN` に `/api/auth/google/callback` を足した値）と、クライアントに登録した承認済みのリダイレクト URI が完全に合う必要がある。独自ドメインへ移すときは、リダイレクト URI も直す（上の「ドメインへ移す」）
- 開発用の戻り先は、`pnpm dev` の画面の URL（`http://localhost:5173`。ワークツリーのポートは名前からずれるので、本物のログインはワークツリーの `.dev-port-offset` に 0 を書いて確かめる）。`DEV_PORT_OFFSET` で明示してポートをずらして確かめるときは、そのポートの戻り先（例 `http://localhost:5183/api/auth/google/callback`）も承認済みのリダイレクト URI に足す。`pnpm preview` で確かめるときは `http://localhost:8787/api/auth/google/callback` も足す
- Google で指名した組織の招待の URL を失った、または期限が切れたときは、指名し直し（#60）が入るまで直す操作が無い。招待の URL は作った直後の画面にだけ出て、DB には SHA-256 のハッシュしか無いので、運用者にも取り出せない
- 開発用のクライアントで確かめるのは、本物のログインとログアウトだけ。e2e は seed のセッションの Cookie で通し、クライアントの値を渡さない（`docs/development.md` の「開発とテストでのログイン」）
- アプリは Google のアクセストークンを使わず、取り消しもしない。Google 側の許可を消すと、その人はログインのたびに同意画面が出直す
- クライアントシークレットは git、ログ、Issue、PR に書かない。漏れたと分かったら、クライアントで新しいシークレットを作って入れ替え、動くことを確かめてから古いシークレットを無効にして消す

### 運用者の Google の `sub` の調べ方

`OPERATOR_LOGIN_IDS` に入れる `google:<sub>` の `sub` は、Google アカウントごとに決まった数字の文字列で、メールアドレスを変えても変わらない。ログインに失敗した画面やログには出ないので、次の手順で調べる。

1. OAuth 2.0 Playground（`https://developers.google.com/oauthplayground/`）を開く
2. Step 1 の入力欄に `openid` と書き、「Authorize APIs」を押す。運用者にする Google アカウントを選んで許可する
3. Step 2 の「Exchange authorization code for tokens」を押す
4. Step 3 の Request URI に `https://openidconnect.googleapis.com/v1/userinfo` を入れ、「Send the request」を押す。Playground がアクセストークンを付けて送る。返る JSON の `sub` が、`google:` の後ろに入れる値

決まり。

- `sub` は数字だけの長い文字列で、数値として扱うと桁が落ちる。表示された文字列をそのまま、`google:` の後ろに入れる（例 `google:118234567890123456789`）
- Step 2 の応答に出るトークンはコピーせず、jwt.io など別のサイトにも貼らない。調べ終えたら Playground のタブを閉じ、要らなければ Google アカウントの「サードパーティ製のアプリとサービス」から Playground への許可を外す
- 断られたログインの `sub` をログや画面に出す機能は作らない。試した人全員の ID を扱うことになるため

### ログインのレート制限が見る IP

ログインの開始と戻り先は、リクエストの `CF-Connecting-IP` ごとに数える（`docs/development.md` の「ログインの実装」）。

- Cloudflare のダッシュボードの Network にある Pseudo IPv4 は、有効にしない。「Add header」は `CF-Pseudo-IPv4` を足すだけで済むが、「Overwrite headers」にすると、IPv6 のリクエストの `CF-Connecting-IP` が、アドレスから作った疑似の IPv4 に置き換わる。置き換わった値は、アプリが IPv6 の /64 と /48 に丸める前の別の値になり、枠の数え方が崩れる（IPv6 の利用者が、疑似の IPv4 を共有する別の人と枠を分け合う、あるいは同じ人が /64 を変えて枠を避ける）。変えたときは、ログインの枠の数え方を見直す
- 変更したか確かめる場所は、ダッシュボードの Network の Pseudo IPv4。既定は Off
- `CF-Connecting-IP` が無いリクエスト（手元の開発）と、解釈できない値は、`login:unknown` の1つの枠にまとめて数える。本番で `login:unknown` の行が増えたら、ヘッダーが付いていない経路が無いかを見る
- ログインの開始は、全部の IP を合わせた全体の枠（`login:global`、10分に600回）でも数え、当たったことを知らせる通知は無い。「ログインできない」と言われたら、Workers Logs で `outcome: "too_many_global"` を引く。叩かれているときは、攻撃が止まってから窓の10分の後に開始が通るようになり、続いているあいだは止まったまま。止まるのは運用者を含む全員の新しいログインで、ログイン済みのセッション（使うたびに30日延びる）は使える。止まっている間に枠を避けて入る手段は無い。続くようなら、ダッシュボードの D1 で `rate_limits` の `login:` と `login48:` の行の偏りを見て、WAF のレート制限ルール（ドメインを取った後）を検討する。正規の利用が増えて当たっているときは、`src/server/auth/rate-limit.ts` の値を上げる

## 出し方

`main` に入ると Workers Builds がビルドし、デプロイのコマンドが `scripts/deploy.ts` の手順を動かす。人の操作は要らない。変わったファイルがすべて build watch paths の Exclude に当たるマージ（文書だけの PR）では、ビルドは走らない。

1. 今 100% で動いている版の ID を、戻し先として控える。Worker が無いか、デプロイが1つも無ければ戻し先無し
2. `migrations/` にファイルがあれば、Time Travel のブックマークをログに出してから、マイグレーションを当てる
3. 版を上げる直前に今の版を取り直し、控えた版と違えば止める（別のビルドの割り込み）
4. `wrangler deploy` で版（コミットの SHA）を上げ、100% に切り替える
5. 煙のテストで、`/api/health` の `version` が SHA になるまで最大2分待つ。なったら、seed のセッションのトークン（`seed/sessions.ts` にある全部）を本番の `POST /api/logout` に送り、どれも 401 で、本文の code が `unauthenticated` になることを確かめる（5xx、429、届かないときは3回まで繰り返す）
6. ならなければ、または seed のトークンが受け付けられるか確かめられなければ、控えた版へ戻し、ビルドを失敗で終える

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
| `煙のテスト: 本番が seed のトークン（…）を受け付けました` | 控えた版へ戻した（戻ったのはコードだけ） | 直ちに下の「seed のセッションが本番に入ったとき」の手順で、本番の `sessions` の seed の行を消す。報告された名前（`admin` など）は全部で、受け付けられなかったトークンの行も、手順で確かめる |
| `煙のテスト: seed のトークン（…）を本番が拒むことを確かめられませんでした`、`… への本番の応答が … でした`、`seed のトークンの確認が例外で終わりました` | 控えた版へ戻した | 本番の `/api/health` と、ログの `seed のトークンの確認:` の行を見る。5xx と 429 と届かないときは3回まで繰り返した後の失敗。直ってからビルドをやり直し、続くなら下の手順で `sessions` を確かめる |

### seed のセッションが本番に入ったとき

seed のセッションのトークン（`seed/sessions.ts`）は公開された開発用の値で、本番の `sessions` に行があれば、誰でも管理者と運用者として入れる。デプロイの煙のテストが、全部のトークンを本番の `POST /api/logout` に送って確かめる（`docs/development.md` の「開発とテストでのログイン」）。`logout` は入れる組織があるかを判定しない操作なので、seed の行が残っていれば、入れる組織が無くても 2xx で通る（判定をする `me` では、行があっても 401 になり、見逃す）。受け付けたトークンがあっても、残りのトークンも全部確かめてから失敗にする。ビルドのログの `本番が seed のトークンを受け付けました: admin（200）、operator（200）` には、受け付けられたトークンの名前（`seed/sessions.ts` のキー）だけを全部並べ、値は出さない。`logout` は受け付けたトークンの行を消す副作用を持つが、確かめた後で、行が残っていないことを下の手順の3で確かめる。スクリプトが前の版へ戻しても、戻るのはコードだけで、DB の行は残る。次の手順は人が手元（上の「手元の準備」）で実行する。Claude のセッションと自動のデプロイは `--remote` の `wrangler d1` を実行しない。

1. 使われた形跡を、ビルドのログの `seed のトークン（…）を受け付けました` と、Workers Logs の `operation: "logout"` と `operation: "me"` や、`accountId` が下の seed のアカウントの ID のログで見る
2. seed のセッションの行を消す。アカウントの ID は `seed/sessions.ts` の `accountId`（`019a0000-0000-7000-8000-000000000101` から `…104` の4つ）

   ```bash
   pnpm exec wrangler d1 execute scrum-guild --remote --command "DELETE FROM sessions WHERE account_id IN ('019a0000-0000-7000-8000-000000000101', '019a0000-0000-7000-8000-000000000102', '019a0000-0000-7000-8000-000000000103', '019a0000-0000-7000-8000-000000000104')"
   ```

3. 行が消えたことと、seed のほかの行（`seed/data.sql`）が本番に残っていないことを確かめる。

   ```bash
   pnpm exec wrangler d1 execute scrum-guild --remote --command "SELECT count(*) AS n FROM sessions WHERE account_id LIKE '019a0000-0000-7000-8000-%'"
   pnpm exec wrangler d1 execute scrum-guild --remote --command "SELECT id, slug FROM organizations WHERE id LIKE '019a0000-0000-7000-8000-%'"
   ```

   組織やアカウントなどの seed の行が残っていれば、seed が本番に流れている。`seed/data.sql` の行を手で消す方法と、流れる前の時刻まで Time Travel で戻す方法（下の「DB を戻す」）があり、確実さは後者が上。ただし後者は、その後に書かれた本物のデータも失う。選ぶのは人
4. どうして本番に入ったかを調べる。seed は `wrangler d1 execute --local` だけで流す（`scripts/db-seed.ts`）。`--remote` で流した操作が無かったかを、手元のシェルの履歴と、CI の設定から見る
5. ビルドをやり直し、煙のテストが通ることを確かめる

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
- cron やルート（triggers）の変更。`wrangler deploy` が版と一緒に反映する。triggers を変えた版を戻すときは、手元（上の「手元の準備」）で戻し先の版のコミットを checkout し、その `wrangler.jsonc` で `wrangler triggers deploy` を実行して当て直す。今の `main` で実行すると、戻したい triggers をもう一度当てるだけになる。今の `wrangler.jsonc` の triggers は、毎分（`* * * * *`）の期限切れの行の掃除だけ

### DB を戻す

マイグレーションは自動では戻さない。戻すかは人が決める。Time Travel で戻せるのは Workers Paid で直近30日まで。それより前に戻す手段（定期の書き出し）はまだ無い。

1. 戻した DB で動く版へ、先にコードを戻す（上の「コードを戻す」）。DB を先に戻すと、その間は新しいスキーマを前提にしたコードが古いスキーマの上で動く
2. 戻したい時点のブックマークを、ビルドのログの `マイグレーションを当てる前の Time Travel のブックマーク:` の行の JSON の `bookmark` から取る。データを壊したときは、壊れた時刻より前の、いちばん新しいビルドの行を使う。ログに無い時刻へ戻すときは、`wrangler d1 time-travel info scrum-guild --timestamp=<時刻>` でその時刻のブックマークを引く
3. 手元（上の「手元の準備」）で `wrangler d1 time-travel restore scrum-guild --bookmark=<ブックマーク>` を実行する。ブックマークより後に書かれたデータは消える
4. 上の「戻したあと」に進む

マイグレーションは「広げてから縮める」に従うので、コードだけを戻せば足りることが多い。DB まで戻すのは、データを壊したときに限る。

### 期限切れの行の掃除

毎分の cron（`* * * * *`）が、`oauth_states`、`sessions`、`rate_limits` の期限を過ぎた行を消す（`src/server/scheduled/`、条件と上限は `docs/data-model.md` の「期限切れの行の掃除」）。掃除の失敗や遅れを知らせる通知は無い。D1 の書き込みの使用量の通知（上の「Cloudflare のアカウント」）が届いたら、Workers Logs で `job: "cleanup-expired"` のログを見る。

- `level: "warn"`: 回数か時間の予算を使い切っても、消すのが追いついていない。`behind` が追いついていない表。1回の warn では動かない。毎分続いたときに、行が増えている原因（攻撃や設定の誤り）を調べる
- `level: "error"`: その表の掃除が失敗した。`table` が表の名前、`error` が例外の種類。cron の失敗にも残る。ほかの表は消えている
- `level: "info"`: 1行以上消した回の件数（`deleted` は表ごとの合計、`rounds` は表ごとに文を送った回数）。掃除が動いていることは、このログが出ることで分かる。行が無い回は何も出ない
- 掃除だけが静かに止まったときは、通知が来ないので気づきにくい

## ドメインへ移す

`scrum-guild.dev` へ移すときは、次を同じ PR で直す。

- `scripts/deploy.ts` の `PRODUCTION_URL`（煙のテストが叩く URL）
- `wrangler.jsonc` の `vars` の `PUBLIC_ORIGIN`（更新系の API の Origin の検査。新しい URL と一致しない呼び出しは 403 になる。https の URL だけを入れる。http の URL（手元のループバックのホスト以外）を入れると、`/api/health` を含むすべての API が 500 になり、煙のテストで見つかる）
- GitHub OAuth App の Redirect URI（`https://scrum-guild.dev/api/auth/github/callback`）と、Google の OAuth クライアントの承認済みのリダイレクト URI（`https://scrum-guild.dev/api/auth/google/callback`）を、新しい URL に直す（上の「GitHub OAuth App」と「Google の OAuth クライアント」）。アプリが開始のときに渡す `redirect_uri` は `PUBLIC_ORIGIN` から作るので、登録の URL と完全に合わないと、Google の同意画面が `redirect_uri_mismatch` を出す
- 運用者が作った招待の URL（`<公開 URL>/invite#<秘密>`）は、古いドメインを指したまま残る。移した後は、まだ結ばれていない指名（運用者の一覧で「指名済み、ログイン待ち」と「期限切れ」）を、新しいドメインで作り直す
- ほかに直すもの（Cookie）は `docs/development.md` の「Cloudflare のアカウントとドメイン」

## 組織

### 停止と再開

運用の画面（`/operator`。運用者だけが開ける）の組織の一覧から行う。

停止する。

1. 組織の行の「停止する」を押す。確認のダイアログが開く
2. 停止の理由を選ぶ。支払いの遅れなどで止めるだけなら「一時的に止める」、解約なら「解約」
3. 「停止する」を押す。一覧の組織の名前の横に「停止 <日>」が出る。解約なら「<日> に消す」も出る

- 停止した組織には、管理者を含め誰も入れない。停止していなければ入れた人の画面は「この組織は停止しています。運用者に問い合わせてください。」で、ほかの人の画面は「見つかりません」。問い合わせの窓口は運用者
- 停止した組織にしか入れない人は、停止するとセッションが消え、ログインし直すと「所属しているか招待されている組織は停止しています」が出る。再開した後も、もう一度ログインが要る
- 「解約」の消す予定日は、停止した日時の UTC の日付の30日後。停止中に解約へ切り替えたときの数え方は、下の「停止の理由を変える」。一覧に出る日付（停止した日も UTC の日付）と、`organizations.purge_on` が同じ値
- 取り込み（#67）と日をまたぐ処理を作るときに、`suspended_at` の組織を飛ばす。今は止める定期処理が無い

停止の理由を変える（再開しない）。

1. 停止中の組織の行の「停止の理由を変える」を押す。今の理由を選んだ状態でダイアログが開く
2. もう一方の理由を選び、「変える」を押す。停止した日時は変わらない

- 解約に変えると、変えた日の UTC の日付の30日後が消す予定日になる。一時的な停止に変えると、消す予定日の印が消える
- 今と同じ理由には変えられない

再開する。

1. 停止中の組織の行の「再開する」を押す。確認は出ない
2. 一覧の印が消え、元どおり入れる

- 解約で消す予定日を過ぎていても、データを消すまでは再開できる
- 停止、再開、停止の理由の変更は、その組織の変更の履歴（`change_logs`。`entity_type` が `organization`、`action` が `suspend`、`resume`、`update`、`operator` に運用者のログインの ID）に残る
- 履歴の書き込みに失敗しても、操作は成功する。このとき `organizations` の状態を正とし、Workers Logs の `reason: "組織の状態は書けたが、変更の履歴を書けなかった"` の行（`operation`、`action`、`organizationId`、`changes`（`changes_json` と同じ前後の値）、`at`（操作の日時）、`error`（例外の名前）が付く）を見て、欠けた履歴の行を手で補う
- 一覧が「状態が変わっていました」と出したときは、別の画面で先に操作が済んでいる。読み直した一覧を見て、必要なら操作し直す

データを消す手順は、解約した組織が出る前に、ここに書く。

## 鍵の入れ替え

まだ書いていない。シークレットを持つ機能ができたら書く。

## 本番で壊れたとき

書いてあるのは下の「画面のエラー」の探し方だけで、ほかはまだ書いていない。気づく手段は `docs/development.md` の「本番で壊れたことに気づく」、戻す手順は上の「戻し方」。

### 画面のエラー

画面で捕まえていない例外と Promise の拒否は、Workers Logs に `level: "error"`、`source: "client"` の1行で残る（送り方と受け方は `docs/development.md` の「本番で壊れたことに気づく」）。届いたことを知らせる通知は無いので、出した後や「画面が動かない」と言われたときに見る。

探し方: Cloudflare のダッシュボードの Workers & Pages で `scrum-guild` の Observability を開き、Events（Workers Logs）で `source` が `client` のものに絞る。版ごとに見るなら `version`（Worker の版）か `clientVersion`（画面の版）、画面ごとなら `route` で絞り、`name` と `message` でまとめる。

項目の意味:

| 項目 | 意味 |
| --- | --- |
| `requestId` | 送信を受けた呼び出しの `cf-ray` |
| `kind` | `error`（捕まえていない例外）か `unhandledrejection`（捕まえていない Promise の拒否） |
| `name` | 例外の名前（`TypeError` など）。英字40字までに合わなければ `Error` |
| `message` | メッセージ。サーバーが次の順に `…` に伏せた先頭200字: 1. `スキーム://` から末尾までと、V8 の `Invalid regular expression: /…/` の元の文字列 2. 引用符の種類ごとに最初の引用符から最後の引用符まで（1つだけなら末尾まで） 3. 最初の「`: `」か「` in `」の後ろを末尾まで 4. 英字だけでない語（数字、`@`、`/`、`.`、`-`、`_`、英字でない文字を含む語）と UUID。伏せすぎることが多い（`can't save 'x'` は `can'…'`、`Unexpected token "x" in JSON` は `Unexpected token "…" in …` になる）ので、元の文言は `name` と場所から、手元で再現して確かめる。Error でない拒否は文字列ならそのまま、ほかは `Non-Error rejection (<型>)` |
| `location` | 起きた場所の1か所（`file`、`line`、`column`）。`file` は `/_app/` の下のファイルで、ほかのオリジンや拡張機能なら `external`。場所が取れなければ `null` |
| `route` | 画面の `route.id`（`/[slug]/w/[id]/plan` など）。当たらない経路は `null` |
| `clientVersion` | 画面の版（build のコミットの SHA）。開いたままの古い画面からは、前の版の SHA が来る。形の合わない値（英数字と `.`、`_`、`-` の64字まででない）は `invalid` |
| `version` | 受けた Worker の版 |
| `browser` | `family`（`chrome`、`firefox`、`safari`、`edge`、`other`）、`major`（主な版）、`mobile` |

誰のエラーか、IP、URL のクエリはログに残らない。ただし、回数の上限を数える D1 の `rate_limits` には、IP のキー（`client-error:<IP>`、IPv6 は /64 と /48）が、最長の窓（10分）を過ぎて毎分の掃除が消すまで残る（`docs/data-model.md` の `rate_limits`）。送信は10分に、同じ IP（IPv6 は /64）から20回、IPv6 の /48 から40回、全体で300回までで、超えた分と、同じページで同じエラーの2回目からは残らない。数が少ないから影響が小さいとは限らない。Origin の検査はブラウザの外（`curl` など）からは偽れるので、行は誰でも作れる。画面の外から来た行を見分ける手段は無く、手元で再現できるかで確かめる。

残る危険（受け入れた）: `message` の伏せ方は、引用符、区切り（`: `、` in `）、英字でない文字を目印にする。英字だけの値（人の名前や英単語のパスワードなど）が、引用符の外で、区切りに当たらない位置に入る文言は、伏せられずに残りうる。ログを読めるのは運用者（Cloudflare のアカウントのメンバー）だけ。読んだ行を Issue などに貼るときは、`message` に利用者の値が残っていないかを見てから貼る。

元の位置へ戻す: `file` は build で圧縮したファイルなので、`clientVersion` の SHA を手元で同じに build し、ソースマップで元のファイルと行に戻す。

1. その SHA のワークツリーを切る: `git fetch origin && git worktree add worktrees/client-error-<SHA の先頭7字> <SHA>`。切ったワークツリーで `pnpm install`
2. 本番と同じ版で、ソースマップを出して build する: `APP_VERSION=<SHA> pnpm exec vite build --sourcemap hidden`。`hidden` は JS に参照を足さないので、出る JS は本番と同じ（2026-10-27 に確かめた）。`build<file>` があることを確かめる。無ければ SHA か依存が違う
3. 行と列を戻す（`column` は1から数え、ソースマップは0から数えるので1を引く）

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/node_modules/.pnpm/node_modules/');
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
const [file, line, column] = process.argv.slice(1);
console.log(originalPositionFor(new TraceMap(readFileSync('build' + file + '.map', 'utf8')), { line: Number(line), column: Number(column) - 1 }));
" <file> <line> <column>
```

4. 終わったら `git worktree remove worktrees/client-error-<SHA の先頭7字>` で消す
