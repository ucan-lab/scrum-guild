# Scrum Guild の開発の進め方

状態: 方針（2026-10-22 に決めた）。土台を作るときに、道具の名前や設定の細部を足す。

前提: 作るのはほぼ1人で、実装の多くは Claude のセッション（手元のワークツリーか、クラウド）が受け持つ。ステージングは持たず（`requirements.md` の「運用」）、D1 のマイグレーションは戻せない。全組織が1つの D1 に入る。

## 技術の選択

`requirements.md` の「技術の前提」に加えて、土台を作る前に次を決めた（2026-10-22）。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| パッケージマネージャー | pnpm。`package.json` の `packageManager` で版を固定する | 速く、依存が厳密 |
| Node | 26。`.node-version` で固定する。`package.json` の `engines` は、`scripts/` の `.ts` を型の除去で直に動かせる下限の 22.18 にし、`engine-strict` は使わない（クラウドのセッションの Node は環境の版で動き、`.node-version` に従わないため）。Node 25 からは corepack が同梱されないので、pnpm は `packageManager` の版を corepack に頼らずに入れる | 長く使える LTS |
| リポジトリの形 | 1つのパッケージ。`src/server`（Hono の API と定期処理）、`src/shared`（操作の定義、スキーマ、言葉の辞書）、SvelteKit の既定の場所（`src/routes`、`src/lib`、`src/app.html`）に分ける。SvelteKit の設定は `vite.config.ts` の `sveltekit()` に書く（SvelteKit 3 は `svelte.config.js` を読まない） | Worker が1つなので、ワークスペースに分ける設定の手間に見合わない。画面を別の場所に移す `kit.files` は非推奨 |
| lint と整形 | ESLint と Prettier（`eslint-plugin-svelte`、`prettier-plugin-svelte`） | Svelte のテンプレートの中まで見られる。下の「入口を守る規則」を自前で書ける |
| 画面 | SvelteKit の SPA モード。SSR を切り、静的に書き出す。API は Hono のまま | 組織、ワークスペース、画面の入れ子をレイアウトで表せる。画面と API の版のずれを `version.pollInterval` と `updated` で検知できる。AI が書き慣れている |
| D1 への問い合わせ | Kysely。マイグレーションは SQL のファイルで手書きし、wrangler で当てる | 型付きで SQL に近い。組織を確かめた入口からしか組織の中の表を引けない型を作れる |
| スキーマ | zod | Hono のバリデーター、Claude の道具や MCP の定義（JSON Schema）への変換など、周りの道具が揃っている |
| 操作の定義 | 自前の定義から形を推論する。コードの生成はしない | 下の「操作の定義」 |
| 言葉の切り替え | 型付きの辞書を自前で持つ | 下の「言葉の辞書」 |
| 並べ替えの並び（`position`） | `fractional-indexing`（分数の並びの文字列を作る定番のパッケージ） | 間に入れても他の行を書き換えない並びを自前で書かずに済む。ワークスペースを作るときの最初の列と、並べ替えの操作が同じものを使う |
| 架空のデータ | seed とファクトリーの両方 | 下の「架空のデータ」 |

### 操作の定義

`ai.md` の「操作の定義を1か所に持つ」の形。

- 定義: 操作ごとに、名前、説明、入力と出力の zod のスキーマ、`read` か `write`、要る権限を1つのオブジェクトに書き、`src/shared/operations/` に置く（`defineOperation()`）。一覧は `src/shared/operations/index.ts`。運用者の操作は `src/shared/operations/operator/`（人が差分を読む領域）、ログインしている人自身の操作（`me`、`logout`）は `src/shared/operations/session/`。定義は処理を持たない。画面の束に Worker のコードを入れないため。定義は画面の束にも入るので、`define.ts` が `src/shared/zod-config.ts` を先に読み込み、zod の eval の試し（`new Function`）を止める（`jitless`）。画面の CSP に `'unsafe-eval'` が無く、試しが違反として報告されるため。
- 回数の上限: 重い操作（手動の同期など）には、定義に `rateLimit: { max, windowSeconds }` を付ける。登録の関数が、権限の検査の後、入力を読む前に、アカウントと操作ごとに `rate_limits` の `operation:<操作の名前>:<アカウントの ID>` で数え、窓の中で `max` を超えた呼び出しは 429 の `rate_limited` で断る（処理は動かない）。窓の最初の呼び出しから `windowSeconds` たつと数え直す。数えるのは1文の upsert で、並行した呼び出しも取りこぼさない（`src/server/auth/rate-limit.ts`）。アプリ側のレート制限は、ログインと手動の同期にだけ設ける（`docs/requirements.md` の「運用」）。ログインは GET の例外なので定義に付けず、`login:<IP>` で数える（「GitHub のログインと取り込み」）。手動の同期の「接続ごとに5分に1回」は `connections.last_manual_sync_at` で判定し、この項目とは別。
- 処理: `src/server/operations/` で `implement(定義, 処理)` の形に書き、`src/server/operations/index.ts` の一覧に足す。Hono のルートは、この一覧を `createApp()` が1つの関数（`operationsApp()`）で登録する。ルートを直に書かない。仮の操作は本番の一覧に入れず、テストの中で定義する。
- 直に書く例外（GET のルート）: `/api/health` と、ログインの開始 `GET /api/auth/<手段>/start?return_to=<パス>` と戻り先 `GET /api/auth/<手段>/callback`（`src/server/auth/login-routes.ts`）。後の2つは GitHub へ移し、GitHub から戻るブラウザの GET のリダイレクトで、JSON の応答を返す操作の形に合わない。Origin の検査は掛けず（ほかのサイトからの移動で呼ばれる）、ログインの CSRF は state の Cookie で止める（「GitHub のログインと取り込み」）。失敗は JSON のエラーではなく `/login?error=<理由>` へのリダイレクトで返す。ログアウトと「自分」を返す口（`logout`、`me`）は例外にせず、操作の定義で作る（`src/shared/operations/session/`）。
- URL: `POST /api/<slug>/<操作の名前>`。組織の外の操作（ログインだけ、運用者）は `POST /api/<操作の名前>`。読む操作も POST にする。API の応答はどれもキャッシュしないので、GET にしない損は小さく、Origin の検査をすべての操作に同じに掛けられる。入力は JSON の本文だけで、`Content-Type: application/json` を要る。URL は名前から作り、定義に持たせない。名前は英小文字と数字をハイフンでつないだ1語（`task-title` など）で、一覧で重ならない。URL の形は `operationPath()` に1つだけ持ち、画面と登録の関数が同じ値を使う。
- 権限の種類（`permission`）:

  | 権限 | 範囲 | 通る人 |
  | --- | --- | --- |
  | `login` | 組織の外 | ログインしていて、入れる組織がある人（か運用者）。`skipsLoginAccess` を付けた操作は、入れる組織を失った人も通す |
  | `operator` | 組織の外 | シークレット `OPERATOR_LOGIN_IDS` に載った運用者 |
  | `invitee` | 組織の中 | 組織に入れる人すべて。承諾待ちの招待だけを持つ人を含む。招待の一覧、承諾、辞退に使う |
  | `organization` | 組織の中 | `users` の行がある人。無効でない管理者か、いずれかのワークスペースに今所属している人。承諾待ちの招待だけの人は通さない（404） |
  | `member` | ワークスペースの下 | そのワークスペースに今所属している人と、管理者 |
  | `leader` | ワークスペースの下 | そのワークスペースのリーダーと、管理者 |
  | `admin` | 組織の中（`workspace: true` を付ければワークスペースの下） | 管理者 |

  組織の中を読む操作を承諾待ちの招待だけの人に見せないため、`invitee` と `organization` を分ける。`member` と `leader` には `workspace: true` が必須で、入力のスキーマに文字列の `workspace_id` が無いと型で落ちる。管理者は所属していないワークスペースでもリーダーと同じ操作ができるので、`member` と `leader` の操作も通す。運用者であることは組織の中の操作の権限にならない。入れる組織は一般の人と同じ条件で決まる。
  - 権限の種類と範囲は `src/shared/operations/define.ts` の1つの表から、型と実行時の検査を導く。登録のときに、権限の種類が一覧にあること、`member` と `leader` に `workspace: true` が付くこと、組織の外の操作に `workspace` が付かないことを確かめ、合わなければ起動のときに落とす。
  - 閉じたワークスペースは読み取り専用。`write` の操作は、閉じていれば 409 の `workspace_closed` で止まる。開き直す操作のように閉じていても書く操作には、定義に `allowClosed: true` を付ける（ワークスペースの下の `write` だけに付けられる）。権限の検査が先で、権限の無い人には 403 を返す。
- 登録の関数が行う順: Origin の検査、セッションの読み取り、組織の確かめ（組織の中の操作）と運用者や管理者の検査、回数の上限、入力の検証、ワークスペースの確かめとメンバーやリーダーの検査（ワークスペースの下の操作）、処理、出力の検証。ワークスペースの確かめが入力の検証の後になるのは、検証した入力の `workspace_id` から取り出すため。
  - ログインできる条件（`requireLoginAccess()`、`src/server/operations/register.ts`）:
    - 組織の外の操作は、既定で確かめる対象（`me` を含む）。運用者の権限（`operator`）の操作も、403 の検査より前に確かめる。入れる組織を失った非運用者には、403 でなく 401 を返す
    - 例外は、定義に `skipsLoginAccess: true` を付けた操作で、今は `logout` だけ。入れる組織を失った人にも使わせたいため
    - `skipsLoginAccess` を付けられるのは組織の外の操作のみで、組織の中の操作や `true` 以外の値は、登録のときの検査で弾く。確かめは DB を3〜4回引く仕事なので、付ける操作は絞る方針
    - 組織の中の操作は、組織に入れなかった（404 にする）ときだけ確かめる。入れた操作では不要（入れる組織があると分かっているため）
    - 運用者（`OPERATOR_LOGIN_IDS` に載った人）は、確かめずに通す。入れる組織も届いた招待も無く、運用者でもなければ、確かめた時刻までに作られたその人のセッションを消し（確かめた後に作られたものは残す）、Cookie も消して 401 の `unauthenticated` を返す
    - 応答のセッションの Set-Cookie は、期限を延ばす1本か、消す1本のどちらかだけにする。同じ名前の2本（Max-Age 30日と Max-Age=0）が並ぶと、受け取る側の処理の順に頼ることになるため。Cookie は応答を作る直前に付け、失敗の応答にも付く
    - 判定の元は、組織の選択（`my-organizations`）と同じ結果（`account.organizations()`。組織をまたぐ読み取り `readAccountOrganizations`）で、1回のリクエストの中で1回だけ引き、判定と `my-organizations` の処理が使い回す。入れる組織か届いた招待が、停止していない組織に1つでもあれば通す。基準は `enterOrganization` と同じ（管理者、今の所属、承諾待ちの招待を数え、停止した組織と無効にされた人は除く）
    - アカウントに結ばれる前の指名の行（`account_id` が空で、ログインの手段と ID が同じ行）を数えるのは、ログインのとき（`completeLogin` が呼ぶ `hasLoginAccess()`）だけ。初めてのログインにはアカウントも無く、ログインのたびに結ぶ行だから。セッションの判定と組織の選択には数えない。数えると、組織を失った人が別の組織に結ばれる前の行で指名されたとき、組織の一覧も組織の枠も `account_id` で引くので、どこにも入れないまま、セッションが30日以上続く。数えなければ、その人は 401 でセッションが消えてログインの画面に戻り、もう一度ログインすると `linkLoginToAccount()` で結ばれて入れる。セッションの途中で結ぶ形にはしない
    - 問い合わせの形（`users_login` などの索引に乗せる、組の数で文を分ける、束縛の上限で区切る）は、組織の選択と共通。`test/organization.test.ts` が EXPLAIN QUERY PLAN と101件の境界を確かめる
    - アカウントのログインの手段と ID は、1回のリクエストで1回だけ引く（`account.logins()`）
  - Origin: すべての操作に掛ける。`wrangler.jsonc` の `vars` の `PUBLIC_ORIGIN`（`scripts/dev.ts` が `pnpm dev` と `pnpm preview` の画面の URL で上書きする。`DEV_PORT_OFFSET` でずらした値も）と一致しない、または Origin の無い呼び出しは 403 の `forbidden`。検査は本文を読む前。`curl` で呼ぶときの付け方は `-H "Origin: http://localhost:5173"`。`PUBLIC_ORIGIN` に使えるのは、https と、ループバックのホスト（`localhost`、`127.0.0.1`、`[::1]`）への http だけ。それ以外（本番の設定が http になった、値が無い、解釈できない）は、`OPERATOR_LOGIN_IDS` の検査と同じく app のミドルウェアが、`/api/health` を含むすべてのリクエストを 500 にして、デプロイの煙のテストで見つけさせる。綴りだけで決めると、Cookie の Secure と `__Host-` が黙って外れるため。
  - セッション: Cookie のトークンを SHA-256 にして `sessions` を引く（`src/server/auth/session.ts`）。Cookie の名前は `sessionCookieName(PUBLIC_ORIGIN)`（`src/shared/session-cookie.ts`）で決め、https の公開 URL では `__Host-sg_session`、http の localhost（`pnpm dev`、`pnpm preview`）では `sg_session`。読む側とログインの発行（`src/server/auth/login-routes.ts`）と e2e が同じ関数を使う。無い、形が違う、期限を過ぎた、のどれも 401 の `unauthenticated`。`last_used_at` は前回から1時間以上たったときだけ、読んだ値が変わっていないことを条件に書き直し（並行した呼び出しの片方だけが書く）、`expires_at` を30日後にして、書けたときだけ Cookie を同じ属性で出し直す。書き直しの失敗はログに例外の名前だけを残し、リクエストは続ける。
  - 組織: `src/server/db/enter-organization.ts` が、slug から `organizations` を引き（共通の入口）、停止していないこと、その人が入れることを確かめる（組織の中の入口）。共通の表と組織の中の表は別の問い合わせで、結合しない。`users` はセッションのアカウントの ID と `users.account_id` の一致で引き、無効にされた人は断る。管理者でも所属もない人は、アカウントに結んだログインの手段と ID で承諾待ちの招待に当てる（このときだけ `account_logins` を引く）。ログインの手段と ID が一致する `users` の行が無効なら、アカウントに結ばれる前の行でも断る。招待だけで入った人は `invitedOnly` になり、`invitee` の操作以外は 404 で返す。組織が無い、停止している、入れない、のどれも 404 の `not_found`。
  - ワークスペース: `workspace_id` を入口の組織で絞り、その人の今の所属と一緒に1つの問い合わせで引く。別の組織のものと存在しないものは 404。引けたものが「確かめたワークスペース」（`VerifiedWorkspace`。閉じているか、その人のロールを持つ）になり、処理に渡す直前に `assertVerifiedWorkspace()` で実行時にも確かめる。
  - 入力: ID の入力は `src/shared/id.ts` の `idSchema`（64字まで）で書き、DB に問い合わせる前に桁違いに長い値を止める。壊れた JSON や形の違う入力は 400 の `invalid_input` で、`details` に項目ごとの `path`、`code`、`message` を入れる。本文は 1MiB までで、`Content-Length` の無い本文も読んだ分を数えて止め、超えれば 413（`code` は `invalid_input`）。未ログインの呼び出しには本文を読ませない。
  - 出力: 戻り値を出力のスキーマで検証し、スキーマに無い項目は落とす。形が合わなければ 500。検証した値（変換を通した出力）をそのまま送り、画面は同じスキーマで検証し直さない。
  - ログ: 「API のエラーとログ」の項目を操作ごとに1行出す。413 を含め、失敗の `code` と `status` も残る。
- 処理が受け取るもの: 検証済みの入力 `input` と、確かめた DB の入口だけ。組織の外の操作は共通の入口 `db` と `accountId` と `account`（入れる組織と届いた招待を組織をまたいで読む `organizations()`、運用者かを返す `isOperator()`、アカウントに結んだログインの手段と ID を返す `logins()`。`src/server/operations/account.ts`）と今のセッション `session`（`tokenHash`。`clearCookie()` を呼ぶと、応答でセッションの Cookie も消す。ログアウトが使う）、組織の中の操作は組織の中の入口 `db`（組織を確かめないと作れない）と `actor`（`userId`、`isAdmin`、`invitedOnly`。`invitee` の操作では `userId` が null になりうる）と `organization`（入るときに引いた組織の slug、名前、言葉づかい、既定のテーマ）と `defer`（応答を待たせずに続ける仕事を渡す。`waitUntil` に渡り、`ExecutionContext` が無いテストでは応答の前に待つ。失敗は登録の関数がログに例外の名前だけを残し、応答は変えない）、ワークスペースの下の操作はさらに `workspace`。`read` の操作が副作用として書くもの（`organization` の `last_seen_at`）は、定義の `description` に書き、`defer` で送る。画面の値を読む文と書く文は別の `batch()` にし、書き込みの失敗で画面が開かなくならないようにする。`workspace` の型 `VerifiedWorkspace` は `VerifiedOrganization` と同じ作りで、`src/server/db/` の外では作れない（`test/operations-types.ts` が `@ts-expect-error` で確かめる）。組織の中の入口は問い合わせを絞らないので、処理は自分の文を、入口の `organizationId`（組織の直下の表）か、`workspace.workspaceId`（ワークスペースの下の表）で絞る。入力の ID だけで引かない。
- 日時: 操作の処理は、今の日時を `src/shared/clock.ts` の `now()` から取る。タイムゾーンでの今日（`todayIn`、`YYYY-MM-DD`）と今月（`monthIn`、`YYYY-MM`）もここで作り、`joined_on` や `effective_month` のようなワークスペースの日付と月はこれで数える。開発用の値での差し替えは、`now()` の1か所に足す。タイムゾーンの検査は `src/shared/timezone.ts` の `normalizeTimezone`（時差の表記を断り、`Intl.DateTimeFormat` で作れる名前を正規の名前にそろえる）で、ワークスペースの作成と設定の画面が同じものを使う。
- 画面からは、`src/lib/api.ts` の `callOperation(定義, 入力, { slug })` で呼ぶ。入力と出力の型は定義から推論し、組織の中の操作は `slug` を要る。結果は `ApiResult` で、応答が JSON でなければ失敗として扱う（出力の形はサーバーが検証済み）。出力のスキーマの変換は JSON にできる値を返すものに限る。
- 組織の分離のテストと権限のテストは、定義の一覧を回して全操作に当てる（`test/operation-registry.test.ts`）。新しい操作を足しても、回すテストを書き足す必要はない。足すのは、組織の中の操作ごとのテスト用の関数だけで、`test/operations/pointers.ts` に操作の名前をキーにして書く。
  - テスト用の関数は、対象の組織（`Target`。組織、管理者、リーダー、一般のメンバー、別のワークスペースのメンバー、承諾待ちの招待だけの人）を受け取り、その組織の行を指す成功する入力を返す。別の組織の対象を渡した入力が 404 になり、自分の組織の対象を渡した入力が成功することを、同じ関数で確かめる（404 が入力の誤りや権限の不足ではないと言えるようにするため）。
  - 入力が組織の中の行を指さない操作は、関数の代わりに `{ noReference: <成功する入力> }` を書く。別の組織の slug と権限のテストだけを回す。入力に `_id` で終わる項目がある操作には書けない。
  - 一覧にある組織の中の操作に関数が無いと、一覧に無い操作の関数があると、`noReference` を付けた操作の入力に `_id` で終わる項目があると、テストが落ちる。組織で絞らない処理を同じ検査に通すと落ちることも、別のテストの対象にした。
  - 権限のテストも一覧から回る。Origin の違い、未ログイン（401）、別の組織の人（404）、承諾待ちの招待だけの人（`invitee` 以外は 404）、権限の種類ごとの許可と拒否（一般がリーダーの操作を呼ぶと 403 など）、閉じたワークスペース（書き込みは 409、`allowClosed` の操作は成功）。
- 後で足すアシスタントの道具と MCP の道具も、同じ定義から作る。

### 入口を守る規則

置き場所は `src/server/db/`（人が差分を読む領域。「マージの判定」）。外から import してよいのは入口のモジュール `db/index.ts` だけ。

- 入口は2つ。`commonDb(env)` は共通の6表だけを型に持ち、`orgDb(env, organization)` は組織の中の16表だけを型に持つ。`organization` は `VerifiedOrganization`（組織を確かめた結果）で、private な印を持つクラスなので、同じ形のオブジェクトは型の検査を通らず、値は凍結されて `organizationId` も書き換えられない。`index.ts` が出すのは型だけである。作る関数 `issueVerifiedOrganization()` は `db/verify-organization.ts` のモジュールの関数で、クラスの static にはしていないため、手に入れた値から辿れない。コンストラクターは作る関数だけが持つ札を要求し、値の `constructor` からは作り直せない。`orgDb` は、作る関数が登録したものだけを実行時に受け取る。組織を確かめる処理は `db/enter-organization.ts`（「操作の定義」）
- `orgDb` は組織の絞り込みを付けない。呼び出し側が、自分の文を `organization_id` か、確かめたワークスペース（`VerifiedWorkspace`。作りは `VerifiedOrganization` と同じで、`db/verify-workspace.ts` の外では作れない）の `workspaceId` で絞る。絞り込みに使う組織の ID は、リクエストの入力ではなく、入口の `organizationId`（確かめた組織の ID。読み取り専用）から取る。絞り込みを入口に寄せない。ワークスペースの下の表は、ワークスペースの ID で絞るのが組織の分離の単位になるため。すべての組織の中の操作に、別の組織の ID で 404 になることを確かめるテストを、定義の一覧から回す
- 表の型は `db/tables.ts` の定数（列名、型、NULL を許すか、DEFAULT があるか）から導く。DEFAULT のある列と NULL を許す列は INSERT で省ける。列名は DB と同じスネークケースのままで、`CamelCasePlugin` は使わない。表を足すときは、マイグレーションと同じ PR で定数に足す
- 表の型の照合: `test/table-columns.test.ts` が、全マイグレーションを当てた D1 の `sqlite_master` と `PRAGMA table_info` を定数と突き合わせる。表の一覧、列名、型、NOT NULL、DEFAULT の有無、主キーの NOT NULL がずれると落ちる
- 文を作る部分: Kysely は SQL を組み立てるだけに使い（`DummyDriver` と `SqliteQueryCompiler`。D1 の方言のパッケージは入れない）、実行しない。`db.statement((q) => q.selectFrom(...))` の `q` は、その入口の表だけを型に持つので、別の入口の表を引くと型の検査で落ちる。生の SQL（`kysely` の `sql`）は `db/` の中だけで使い、入口は出さない（`/api/health` の `SELECT 1` は `pingDatabase(env)`）
- 文（`Statement`）: private な印を持つので、形だけのオブジェクトや `{ ...statement }` は型の検査を通らない。実行時には、文を作った入口のインスタンスに結び付けて持ち、別の入口（同じ範囲の別の組織の入口、作り直した入口を含む）の文、付け替えた文、形だけのオブジェクトを拒む。文は作った入口のインスタンスで実行する。RETURNING の無い INSERT、UPDATE、DELETE の文は読める行を持たず、`rows` と `first` に渡せない。結果は `changes` で見る
- 送る部分: `db/send.ts` が、組み立てた `CompiledQuery` を D1 の `prepare(sql).bind(...parameters)` にして送る。値は SQL に埋めず束縛する。1件の問い合わせ（`rows`、`first`、`run`）も `batch()` も同じ道を通り、結果の行と `meta.changes` を文ごとに返す。1文の束縛が D1 の上限（100）を超えたら、送る前に文の番号を添えたエラーを投げる（SQL と値はメッセージに入れない）
- `batch()` の形: `db.batch([文, 文, ...])`。入口ごとに、その入口の `statement()` が作った文だけを受け取り、共通の文と組織の中の文を同じ配列に入れると型の検査で落ちる。D1 の `batch()` は全部の文を1つのトランザクションで流すので、途中の文が失敗すると前の文も書かれない。ただし件数 0 の文では戻さない。先に読んだ値で判定した書き込みは、後ろの文にも同じ条件を入れる（前の文が書いた値を見る `WHERE EXISTS (...)` など。`docs/data-model.md` の「書き込みの単位」と「メールアドレスで待つ指名と招待」の 6 と同じ決まり）。文ごとの `changes` を見るのは 409 を返すためで、見つけても書き込みは戻らない
- 置き場所: 組織から DB を選ぶ関数は `db/select-database.ts`（今はどの組織でも同じ DB）、組織をまたいで読む関数は `db/cross-organization.ts`
- 入口の外から D1 の binding や Kysely を直接使うことを、ESLint の規則で禁じる。禁止の定義と例外は `eslint.config.db-entry.js` の1つの規則（`db-entry/guard`）に置く。`no-restricted-imports` などを設定ごとに並べると、後ろの設定が前を置き換えて黙って消えるため、ファイルごとの違いは規則の中で判定する。`src/server/db/` の外で次を使うと落ちる
  - `kysely` の import（静的、`import()`、型の `import('kysely')`、`require`、`export from`）。型は `db/index.ts` から取る
  - `db/` の内部のファイルの import（入口のモジュール `db/index.ts` 以外）。`db/testing.ts` は `test/` からだけ
  - 引数が文字列のリテラルでない `import()`、`createRequire`、`process.getBuiltinModule`。import の検査を抜けられるため
  - D1 の binding: `env.DB`、`env['DB']`、``env[`DB`]``、`{ DB }`、`{ 'DB': d }`、`{ ['DB']: d }` の取り出し、`Reflect.get(env, 'DB')`、`Env['DB']`
  - `D1Database` の型
- 規則の例外は、入口を通さない次の2つのテストだけ。`test/apply-migrations.ts`（全マイグレーションを binding に直に当てる）と `test/schema.test.ts`（CHECK や一意を確かめるため、型を外れた生の INSERT を送る）。ほかのテストは入口とファクトリーを通す
- 規則のテスト: `scripts/eslint-db-entry.test.ts` が、`ESLint` クラスに文字列を渡して、禁じる形が `src/server/`、`src/lib/`、`src/routes/`、`src/shared/`、`scripts/`、`e2e/`、`test/` で落ち、`db/` の中、入口のモジュールの import、`test/` からの `db/testing.ts`、例外の2ファイルが通ることを確かめる。解析できない形（`env[key]` など、キーが変数のもの）は規則で止められないので、差分を読む人が見る
- テスト用の口: `db/testing.ts` が、確かめずに `VerifiedOrganization` を作る `verifiedOrganizationForTest`、表の照合に使う列の定数（`commonTableColumns`、`organizationTableColumns`、`ColumnSpec`）と DB のカタログを読む関数、組み立てた SQL を読む `compiledQueryForTest` を出す。`test/` からだけ import でき、ほかの場所から import すると ESLint が落とす。Worker の束にも入らない
- 型の検査: `test/db-types.ts` が `@ts-expect-error` で、共通の入口から組織の中の表、組織の中の入口から共通の表、`batch()` への混在、形だけの文、書き込みの文の `rows`、確かめた結果を持たない `orgDb` を型の検査で落とす。`pnpm check` が検査する
- `.claude/hooks/file-rules.mjs` の `env.DB` と `D1Database` の判定は、書く時点で止めるつなぎとして残す

### 言葉の辞書

- 辞書は `src/shared/vocabulary.ts` に置く。キーごとに、ゲームの言葉（`game`）とスクラムの言葉（`scrum`）の両方を必須にする。`workspace('パーティ', 'ワークスペース')` のように2つ渡す形なので、片方を消すと `pnpm check` が落ちる。言葉が同じ項目（`reward` など）も両方書く。
- キーには、言葉づかいを決める単位（`scope`）がある。`workspace` はワークスペースの設定で切り替わる。`organization` は管理者が決める組織の設定で切り替わり、冒険者ギルド、ギルドマスター、ギルドの書記のほか、ワークスペースの外の画面の名前（自分の今日、通知、自分の設定、組織の管理）と、枠の共通の文言（閉じる、件など）を入れる（`docs/requirements.md` の「ゲームの仕組み」）。`word(key, { workspace, organization })` が引く。
- 語順や記号を含む文は、`{名前}` の置き換えを持つ1項目にする（`pageTitle` の `{page} - {app}`、`apiStatus` など）。`t(key, { 名前: 値 })` で埋める。ゲームとスクラムで置き換えの名前をそろえることは `scripts/vocabulary.test.ts` が確かめる。テンプレートに語順や記号を直に書かない。
- 画面は `src/lib/vocabulary.svelte.ts` の `t(key)` で文言を出し、直に書かない。今の言葉づかいはここのストアが持ち、既定は両方ともゲームの言葉。組織の枠（`src/routes/[slug]/+layout.svelte`）が、組織の操作の結果の `organization.vocabulary` を、組織の言葉とワークスペースの言葉の両方に入れる（`src/lib/organization.svelte.ts`）。ワークスペースの中の画面は、そのワークスペースの `vocabulary` でワークスペースの言葉を上書きする（`/[slug]/w/[id]` のレイアウトが `setWorkspaceVocabulary()` で入れ、離れるときに戻す。上書きは組織の値とは別の状態で持つので、組織の値を入れ直しても消えない）。今の言葉づかいとは別の言葉づかいで引くときは `tIn(key, { workspace: 'scrum' }, params)`（ワークスペースを作るダイアログが、選んだ言葉づかいの列と決まった欄の名前を見せるのに使う）。列と決まった欄に付けた名前は、辞書を通さず、作るときの言葉づかいで決めた値を保存する（`src/shared/workspace.ts`）。
- 辞書の型の保証は `src/shared/vocabulary.typecheck.ts` が持つ。片方の言葉が欠けた項目が型で落ちることを `@ts-expect-error` で確かめ、落ちなくなると `pnpm check` が落ちる。
- 見本の `design/kit.js` の `DICT` にあるキーは、本番も同じ中身で持つ。`scripts/design-parity.test.ts` が突き合わせる（`docs/design.md` の「デザインシステムの構成」）。

### 書体

- 書体は `@fontsource` の4つのパッケージ（`biz-udpgothic`、`zen-old-mincho`、`ibm-plex-mono`、`chakra-petch`）から、`src/routes/+layout.svelte` が使う太さだけを import する。太さは見本（`design/today.html`）の Google Fonts の URL と同じ（BIZ UDPGothic 400 と 700、Zen Old Mincho 700 と 900、IBM Plex Mono 400 と 500、Chakra Petch 500、600、700）。
- Google Fonts は使わない。利用者の IP を外へ出さず、CSP に外の先を足さない。書体のファイルは build が `build/_app/immutable/assets/` に書き出し、自分の Worker から配る。
- パッケージは `devDependencies` に置く。書体のファイルは build のときに CSS から拾って `build/` に書き出すだけで、Worker の実行時には要らない。
- 日本語の書体は文字の範囲ごとに約120のファイルに分かれ（`unicode-range`）、ブラウザは使う文字のファイルだけを読む。build の出力は woff2 が514ファイル、`build/` 全体で約530ファイル、約13MB になる（Workers Static Assets の上限は20,000ファイル）。
- `@fontsource` の CSS は woff2 と woff の両方を `src` に書くが、woff は使われない。woff を `build/` に出さないため、`scripts/fontsource-woff2.ts` の Vite プラグインが、CSS を Vite に渡す前に woff の指定を外す（実際の CSS での確認は `scripts/fontsource-woff2.test.ts`）。
- 書体の CSS は1本にまとまり、約440KB（gzip で約136KB）。`index.html` の `<link rel="stylesheet">` から読むので描画を止めるが、この大きさと止まることは受け入れた。理由は2つ。1つは、日本語の書体を文字の範囲で分けて読む以上、範囲の一覧（`unicode-range`）を CSS に持つ構造が避けられないこと（Google Fonts の CSS も同じ構造）。もう1つは、ファイル名にハッシュが入って `immutable` でキャッシュされ、2回目からの読み込みが軽いこと。
- Vite は小さいファイルを `data:` の URI にして CSS へ埋め込むが、CSP の `font-src`（`default-src 'self'`）は `data:` を通さない。`vite.config.ts` の `build.assetsInlineLimit` を 0 にして、すべてファイルとして出す。
- 太さを足すときは、見本の Google Fonts の URL も同じ PR で直す。

### テーマの先当て

- `html` の `data-theme` の値は `src/shared/theme.ts` の `themes`（DB の列挙と同じ5つ）。属性がなければシンプル（自動）。
- 当てたテーマは `localStorage` の `sg-theme` に覚える（`src/lib/theme.svelte.ts` の `setTheme`）。
- 描く前の先当ては `static/theme-init.js` の役目。`src/app.html` の head が同期（`async` と `defer` なし）で読み、覚えている値を `data-theme` に入れる。インラインにすると CSP のハッシュから漏れて止まるので、自分のオリジンのファイルにしてある。`localStorage` が使えない、値が壊れているときは何もせず、属性なしで描く。
- `static/theme-init.js` は同期で読むので、小さなファイルでも読み終えるまで HTML の解析が止まる。`_headers` では `Cache-Control` を指定せず、Cloudflare の既定（毎回確かめる）のまま配る。描画のたびに「変わっていないか」の問い合わせが1往復増えるが、ファイルは数百バイトで、ちらつきを無くす利点が上回るので受け入れた。名前にハッシュを入れて `immutable` にすれば往復は無くなる一方、`app.html` から名前を引く仕掛けが要り、遅れが問題になってから足せば足りる。
- キーと値は `src/shared/theme.ts` と同じにする。`scripts/theme.test.ts` が、`static/theme-init.js` を偽の `localStorage` で動かして確かめる。
- 画面が動き出してからの切り替えとストアは `src/lib/theme.svelte.ts`。本物の値は組織の枠が入れる。組織の操作の結果の `me.theme`（`users.theme`）、なければ `organization.theme`（`organizations.theme`）を `setTheme` に渡すので、`data-theme` と `localStorage` が同じ値になる（`src/lib/organization.svelte.ts`）。組織を切り替えたときも同じで、切り替えた先の値に替わる。

### 架空のデータ

- seed: `design/sample-data.js` を元に、組織を2つ以上入れたデータを作る。ローカルの D1 と e2e に入れる。組織の分離を画面で確かめられるようにするため。
- ファクトリー: 単体と結合のテストは、テストごとにファクトリーの関数で必要な行だけを作る。seed を直してもテストが壊れないようにするため。
- どちらも架空の名前だけを使う。

### API のエラーとログ

- エラーの応答は `{ "error": { "code": "...", "message": "...", "details": ... } }` の自前の形にする。`code` は `src/shared` の列挙で持ち、画面は `code` で分岐して、文言は言葉の辞書から出す。`message` は開発者向けで、画面にそのまま出さない。
- 別の組織の ID を指定されたときは、存在しないときと同じ `not_found` の 404 を返す。
- 入力の誤りは 400 の `invalid_input` で、`details` に zod の検証の結果を項目ごとに入れる。権限が無いのは 403、先に読んだ値で判定した書き込みの競合（`meta.changes` が 0）は 409 にする。
- ログインしていない（セッションが無いか切れた）のは 401 の `unauthenticated`。画面はこれを見てログインの画面へ戻す。権限が無い 403 の `forbidden` とは分ける。Origin が公開する URL と合わないときは 403 の `forbidden`。
- 閉じたワークスペースへの書き込みは、409 の `workspace_closed`（先に読んだ値の競合の `conflict` とは分ける）。
- 定義の `rateLimit` を超えた呼び出しは、429 の `rate_limited`。
- 本文が 1MiB を超えたときは、413 で `code` は `invalid_input`。
- D1 に届かないとき（`/api/health` の疎通）は 503 の `unavailable`。
- 想定していないエラーは `app.onError` で 500 の `internal` にし、中身は応答に出さずログにだけ出す。
- ログは Workers Logs に JSON の1行で出す。操作ごとの項目は `requestId`（`cf-ray`。無ければ乱数。エラーのログと同じ値）、`operation`、`organizationId`、`userId`（組織の中の `users` の ID）、`accountId`、`code`（成功は `ok`）、`status`、`durationMs`。本文、コメント、取り込んだ内容、認証情報（招待の URL の秘密、ID トークン、Google のメールアドレスを含む）は出さない。ログインの開始と戻り先（GET の例外）は、操作ごとのログとは別に、`route: "auth"`、`step`（`start` か `callback`）、`provider`、`outcome`（`ok`、`denied`、`too_many` など）、成功のときの `accountId` を1行出す。OAuth の `code`、`state`、トークン、Cookie の値、クライアントの秘密は出さない（`test/login-security.test.ts` が確かめる）。

## 初版の作る順

最初の一本は、運用者が組織を作る → GitHub でログインする → ワークスペースを作る → タスクを1件作って完了する、の一本道にする（2026-10-22 に決めた）。認証、組織の分離、操作の定義、`batch()` での書き込み、画面を一度に通し、CI/CD と本番へのデプロイもこの一本に含める。Issue への分け方は `issue-plan` で決める。目安は次のとおり。

1. 土台: pnpm、SvelteKit の SPA モード、Hono、wrangler の設定、ESLint と Prettier、`CLAUDE.md` の「コマンド」、セキュリティのヘッダー、`/api/health`。Claude の設定とフック（下の「Claude の設定とフック」）は先に入れる
2. CI と CD: `ci-ok`、Workers Builds とデプロイのスクリプト、煙のテスト、`docs/operations.md`
3. 一本道に要る表のマイグレーションと seed。Google で待つための列（`users` と `invitations` の `login_email`、`claim_token_hash`、`claim_expires_at`、空にできる `login_subject`、`oauth_states` の `nonce` と `claim_token_hash`）も最初から入れる。SQLite では後から NOT NULL を外すのに表の作り直しが要るため。入れる表は、一本道が触る表と、その表が外部キーか CHECK で指す表（指される表が欠けると、後で表の作り直しが要るため）。入口より先にするのは、入口のテストが表なしには書けず、マイグレーションは `docs/data-model.md` だけを見て読める差分になるため
4. 入口: Kysely の2つの入口と `batch()` の関数、操作の定義を登録する関数、エラーの形、組織の分離のテストの仕組み。`/api/health` に DB への疎通を足し、デプロイの煙のテストで確かめる。`src/shared/health.ts` の `Health` と `isHealth`、`scripts/deploy.ts` の煙のテストを合わせて直す
5. 運用者の組織の作成、GitHub OAuth とセッション、組織の選択
6. Google のログイン（招待の URL から、メールアドレスで待つ指名と招待を `sub` に結ぶところまで）。5 のログインの手段の型に、2つ目の実装として足す
7. ワークスペースの作成、タスクの作成と完了（完了の記録、経験値、変更の履歴を1回の `batch()` で書く）

### DB を作り直してよい期間

ベータ（自分のチーム以外の組織）が始まるまでは、本番の D1 を作り直し、マイグレーションをまとめ直してよい（2026-10-22 に決めた）。

- 作り直すかは人が決める。AI は既にあるマイグレーションのファイルを書き換えず、まとめ直すときは人が決めた Issue の中でだけ行う。
- 自分のチームのデータは作り直しのたびに入れ直す。取り込み元から入れ直せないもの（完了の記録、経験値、手で作ったタスク）は消える前提で使う。
- ベータを始める日に、CI の migration のジョブで既にあるファイルの書き換えを落とす検査を有効にし、この節を「済み」にする。

## ブランチ戦略

短命なブランチを `main` へ PR で入れる。`main` は常にデプロイできる状態に保つ。

| 項目 | 決まり |
| --- | --- |
| 長く残すブランチ | `main` だけ。`develop` や `release` は作らない。ステージングが無いので、分けても受け皿がない |
| 作業ブランチ | 1 Issue に 1 ブランチ、1 PR。クラウドのセッションが作る `claude/*` はそのまま使う。手で切るときは `<Issue番号>-<短い名前>`（例 `12-org-create`）。スラッシュを使わず、ワークツリーと同じ名前にする。種別は PR のタイトルで表す |
| マージ方法 | squash merge だけ。PR のタイトルが `main` のコミットの件名になり、本文は空にする |
| PR のタイトル | 今のコミットと同じ書き方（`feat:`、`fix:`、`docs:`、`design:`、`refactor:`、`chore:`、`test:`、`ci:` の後に日本語） |
| マージ後 | ブランチを自動で消す |
| 文書だけの変更 | ほかの変更と同じく PR を通す。CI は重いジョブを飛ばし（下の「文書だけの PR」）、マージの後に Workers Builds はビルドしない |

### `main` を守る仕組み

GitHub は無料のプランのまま使う（2026-10-23 に決めた）。無料のプランの private のリポジトリでは、ブランチ保護、Rulesets、auto-merge、Environment が使えない。そのため、守りは次のように置く。

- リポジトリの設定で squash merge だけを許し、マージ後にブランチを消す。squash のコミットの件名は PR のタイトルにし、本文は空にする（設定済み）
- `main` の上のコミット、`main` への直接の push、`--force-with-lease` 以外の force push は、PreToolUse のフック（`.claude/hooks/guard-bash.mjs`）でセッションから止める
- セッションは、`main` にいる作業コピーのファイルを Write と Edit で書き換えられない（`.claude/hooks/guard-files.mjs`）。手元のセッションはワークツリーを切ってから書き、クラウドのセッションは `claude/*` のブランチで書く
- 人の操作は、`.githooks/` の git のフックで止める。`pre-commit`、`pre-merge-commit`、`prepare-commit-msg`、`pre-applypatch` が `main` の上のコミット（マージ、`cherry-pick`、`revert`、`am` も含む）を、`pre-push` がリモートの `main` への push（削除と force push も含む）を拒む。`main` を `pull --ff-only` で進めるのは通す。同じ場所の `post-checkout` は止めるためのものではなく、番号付きのブランチのワークツリーを切ったときに Issue を作業中にする（下の「Issue の状態」）。`pnpm install` の `prepare`（`scripts/git-hooks.ts`）が `core.hooksPath` を `.githooks` にする。設定はワークツリーで共有し、フックは各ワークツリーのブランチにある `.githooks/` が動く。`pnpm install` をしていない clone と、`.githooks/` の無い古いブランチでは効かない。別の `core.hooksPath` が既にあれば上書きせず、警告だけ出す。取り出したブランチの `.githooks/` がそのまま動き、`post-checkout` は checkout と switch の時点で動くので、信頼できない人のブランチは作業コピーに取り出さず、中身は `git diff` か GitHub で読む。どうしても取り出すときは、`git -c core.hooksPath=/dev/null checkout <ブランチ>` のようにフックを切る。`core.hooksPath` の上書きや `git commit-tree` で抜けられる踏み線なので、人も同じ決まりで PR を通す
- 必須のチェックは設定できない。マージする人かセッションが `ci-ok` の成功を確かめてからマージする
- マージは人が決める。人が押すか、人の指示でセッションが `gh pr merge` を打つ。承認の数は求めず、人のレビューは「人がマージを決める」ことで表す（下の「マージの判定」）
- 本番へデプロイする鍵は GitHub に置かない（下の「CD」）。リポジトリのシークレットは PR のブランチのワークフローからも読め、Environment で `main` だけに絞れないため

### 並行して作業するときの決まり

- マイグレーションを含む PR は同時に1本まで。番号がぶつかるため。Issue に `migration` のラベルを付けて見分ける
- スタック PR は原則使わない。squash merge と相性が悪く、force push が増える
- 2つの Issue を並べる前に、それぞれの「やること」から変えるファイルを比べる。共通の層（権限の検査の `src/server/operations/register.ts`、組織で絞る層の `src/server/db/`、root のレイアウトの `src/routes/+layout.svelte`、言葉の辞書の `src/shared/vocabulary.ts`）を両方が形を変えるなら並べず、先の方のマージを待ってから着手する。操作の一覧に1行ずつ足すだけなら並べてよい（同じ位置に足したコンフリクトは rebase で解ける）。`area:` のラベルが違っても共通の層は重なる。#52 と #53 は、両方が `register.ts` と `cross-organization.ts` を別の形に広げ、10ファイルのコンフリクトの解消とレビューのやり直しになった
- 1つのセッションが受け持つ Issue は、始めてから終えるまでで2つまでにする。受け持った Issue の PR がマージされるか閉じられたら、次の Issue は新しいセッションで始める。4つを続けて回したセッションは途中で会話が要約され、2つを並べたセッションは要約されずに済んだ。決めたことと申し送りは Issue の本文かコメントに書き、会話だけに残さない
- 着手したら、Issue にブランチ名とセッションの識別をコメントで残す。並べたセッションのどれが受け持っているかを、人が Issue から引けるようにするため。手元のセッションはスクラッチパッドのパス（`.../<セッション ID>/scratchpad`）の `scratchpad` の1つ上の名前を、クラウドのセッションはセッションの URL を書く
- ベースが進んだら `sync-base` で rebase して取り込み、`--force-with-lease` で push する（2026-10-25 に決めた）。PR のコミットをベースの最新の上に一直線に並べ、コミットごとの差分にベースの変更を混ぜないため。squash merge なので `main` の履歴には影響しない
- force push はベースの取り込み（`sync-base`、スタック PR の `gh stack`）のときだけ使う。PR の指摘への対応と self-review の修正は通常の push で積む。取り込みの force push でもレビュワーが前に読んだコミットは書き換わるので、レビューの途中なら取り込んだことを PR にコメントで残す

### ワークツリーで作業する

手元のセッションは、Issue ごとにワークツリーを切って作業する。メインの作業コピーは `main` のまま置き、並行するセッションが同じファイルを書き換え合わないようにする。クラウドのセッションは環境が分かれているので、ワークツリーを切らない。

- 置き場所は `./worktrees/<ブランチ名>`。ワークツリーの名前とブランチ名を同じにする（例 `worktrees/12-org-create` に `12-org-create`）
- 切るときは最新の `main` から作る: `git fetch origin` のあと `git worktree add worktrees/<名前> -b <名前> origin/main`
- `worktrees/` はリポジトリの `.gitignore` で git の管理から外してある
- 依存はワークツリーごとに入れる。ローカルの D1（`.wrangler/state`）もワークツリーごとに分かれるので、seed もそれぞれで当てる。並べて `pnpm dev` を立てるときはポートをずらす（下の「手元で動かす」）
- vitest（vite 8 の oxc）は、変換するファイルを `include` に含む tsconfig を、ファイルのディレクトリから上の階層へ探す。隣のディレクトリの tsconfig は見ないので、`src/server/tsconfig.json` が `test/` を含んでいても `test/` からは見つからない。リポジトリの中に見つからないとワークツリーの外へ上り、本体の作業コピーの `tsconfig.json` を読む。本体に依存が無ければ、継ぎ先の `$app/tsconfig`（`svelte-kit sync` が作る）が無く `[TSCONFIG_ERROR] Failed to load tsconfig '$app/tsconfig'` で落ち、依存があれば本体の版の設定を黙って読む。`test/tsconfig.json` はそれを止めるために置いてある。テストが読むファイルを新しいトップレベルのディレクトリに置くときは、そのディレクトリにも `test/tsconfig.json` と同じように tsconfig を置く
- PR がマージされたら、`~/.claude/scripts/git-cleanup-merged.sh <名前>` でワークツリーと手元のブランチを消す（`pr-feedback` の後片付け）。人がマージするときも、手元のセッションは PR が閉じるのを待っていて、知らせを受けずに後片付けと、受け持つほかの PR の追従まで続ける。クラウドのセッションは手番を終えると再開できないので、人がマージを知らせる。squash merge では SHA が変わり `git branch -d` が拒むため、PR がマージ済みで head の SHA が手元と一致するときだけ `-D` で消す。スクリプトは dotfiles にあり、無い環境では人が消す

## 手元で動かす

コマンドの一覧は `CLAUDE.md` の「コマンド」にある。

### 開発用のサーバー

`pnpm dev` は、SvelteKit の `vite dev`（画面と HMR）と `wrangler dev`（API）の2つを立てる（`scripts/dev.ts`）。vite が `/api` を `wrangler dev` へ転送するので、画面と API は同じオリジンのままになり、Cookie がそのまま使える。片方が止まると、もう片方も止まる。

- Worker を vite の中で動かす `@cloudflare/vite-plugin` は使わない。SvelteKit との同居を公式に支持していると確かめられず、2つのプラグインが dev サーバーと build の両方を触るので、片方の更新で壊れやすいため
- `pnpm preview` は、build した `build/` と API を `wrangler dev` だけで配る。本番と同じ配り方（Workers Static Assets、`_headers`、SPA の fallback）を確かめる口で、HMR は効かない
- 開発の URL は2つある。`pnpm dev` は `http://localhost:5173`、`pnpm preview` は `http://localhost:8787`。Origin の検査は、この URL を `PUBLIC_ORIGIN` として `wrangler dev` に渡して行う（`scripts/dev.ts`）。ブラウザが送る Origin と合わない URL（`127.0.0.1` など）で開くと、更新系の API は 403 になる。GitHub の OAuth の戻り先もこの URL から作る（`<画面の URL>/api/auth/github/callback`）ので、開発用の OAuth App の Redirect URI とポートまで合わせる（`docs/operations.md` の「GitHub OAuth App」）

`pnpm dev` と `pnpm preview` の `wrangler dev` は、API のポートの `/cdn-cgi/handler/scheduled?cron=*+*+*+*+*` を常に開いている（wrangler の既定）。開くと、毎分の定期処理（期限切れの行の掃除）を起こせる。`/__scheduled` は `assets` の `not_found_handling` が先に答えて SPA の画面が返るので使わない。`cron` は `wrangler.jsonc` の `triggers.crons` にある式で、`+` は空白の代わり。表に無い式では例外になる。

### ポート

| もの | 既定 |
| --- | --- |
| vite（`pnpm dev` の画面） | 5173 |
| `wrangler dev`（API、`pnpm preview`） | 8787 |
| wrangler のデバッガー | 9229 |

ワークツリーを並べて立てるときは、`DEV_PORT_OFFSET` で3つを同じ幅だけずらす（例 `DEV_PORT_OFFSET=10 pnpm dev` で 5183、8797、9239）。vite の転送先も同じ値から作るので、画面は自分のワークツリーの API を呼ぶ。ポートがぶつかったら、勝手に空いたポートへずれずに落ちる（vite の `strictPort`）。ずれた vite が別のワークツリーの API につながると、エラーにならないまま別のブランチの API を叩くため。

ワークツリーを並べて本物のログインを確かめるときの注意: ワークツリーごとに、別のブラウザのプロファイル（Chrome のプロファイル、別のブラウザ、シークレットウィンドウ）で開く。`localhost` の Cookie はポートで分かれず、`sg_session` と `sg_oauth_state` は、ポートの違うワークツリーのあいだで共有される。同じブラウザで開くと、片方のログインがもう片方の Cookie を上書きし、ログインが失敗するか、別のワークツリーのセッションで動いてしまう。

### 版

版はコミットの SHA にする。build のときの環境変数 `APP_VERSION` を、画面には SvelteKit の `kit.version.name` として、API には wrangler の `vars` の上書き（`--var APP_VERSION:<SHA>`）として渡し、`/api/health` の `version` と画面の版を同じ値にする。手元で埋めなければ `dev` になる。本番では Workers Builds が checkout したコミットの `git rev-parse HEAD` を渡す（下の「CD」）。

### 依存を入れたばかりの作業コピー

`pnpm install` の後（`prepare`）と、`pnpm dev`、`pnpm test`、`pnpm check` の前に、`scripts/prepare.ts` が `svelte-kit sync` と `wrangler types` を走らせ、空の `build/` を作る。`tsconfig.json` は `svelte-kit sync` が作る `$app/tsconfig` を継ぎ、Worker の型は `wrangler types` が作る `worker-configuration.d.ts`（git に入れない）を読み、wrangler の設定の `assets` は `build/` を指す。どれも、`pnpm build` より先に型の検査とテストを通すための準備。

## AI 開発の分担

人が決め、AI が作り、別の AI が点検する。マージするかは、パスの規則と人が決める。

| 工程 | 担い手 | 道具 |
| --- | --- | --- |
| 何を作るか、仕様の判断 | 人 | `grill-me` で詰め、`docs/` に書く |
| Issue と完了条件 | AI が書き、人が確かめる | `issue-plan` |
| 実装とテスト | AI（手元のセッションはワークツリー、クラウドのセッションはそのままの環境。受け持つ Issue の数は「並行して作業するときの決まり」） | `CLAUDE.md`、リポジトリのスキル |
| 点検 | 実装したのとは別のエージェント | `self-review`、CI の AI レビュー |
| マージ | パスの規則と人 | 下の「マージの判定」 |

### AI の誤りを機械で止める

決まりはプロンプトに頼らず、テストと設定に置く。

1. **組織の分離のテストを CI で必須にする。** 一番起こりやすく、一番重い事故は `organization_id` での絞り込み漏れ。すべての API の操作について「別の組織の ID で呼ぶと 404 になる」ことを確かめるテストを、操作の定義（`ai.md` の「操作の定義を1か所に持つ」）から作る。組織の中の表に触るクエリは、組織で絞る入口の関数からしか書けないようにする。
2. **型で境界を固める。** 操作の入力と出力をスキーマで1か所に持ち、Hono と Svelte の両方で使う。片方だけ直したずれを型の検査で落とす。
3. **本番に触る操作をセッションから拒否する。** `.claude/settings.json` に登録した PreToolUse のフックで止める。本番に触るのは Cloudflare の Workers Builds だけ。下の「Claude の設定とフック」。
4. **AI への決まりは `CLAUDE.md` に短く置く。** コマンドと、守らないと事故になる決まりだけを書き、詳しいことは `docs/` を指す。

### Claude の設定とフック

クラウドのセッションにはユーザーの設定が届かず、効くのはリポジトリの `.claude/settings.json` だけ。そこで、permission のモードに関係なく効く `permissions.deny` とフックで守る。

| 仕組み | 中身 |
| --- | --- |
| `permissions.allow` | `git push --force-with-lease`（`sync-base` の rebase の後の push。auto モードでも確認なしに通す。`main` への push はフックが先に止める） |
| `permissions.deny` | `.dev.vars`、`.env` とその環境ごとのファイル（`.local`、`.production` など）の読み取り、`.dev.vars` と `.env` の書き込み、wrangler の資格情報のディレクトリの読み取り |
| `env` | `WRANGLER_SEND_METRICS=false`（テレメトリを送らない） |
| `guard-bash.mjs` と `bash-rules.mjs`（PreToolUse、Bash と Monitor） | 止める: wrangler の本番に触る操作（許すのは `dev`、`types`、`whoami`、版と help、`--local` を付けた D1、R2、KV の操作だけ）、`--remote` と `-r` とリモートの binding、本番のログ（`tail`）、`WORKERS_CI` の設定（値は問わない。道具の前の代入、`env`、`cross-env`、`pnpm exec` などの経由先の前置き、`export`、`declare`、`typeset`、`readonly`、`local`、単独の代入、`+=` の形、引数を実行しない道具（`echo`、`grep`、`git`、`gh` など）以外の引数のどこかにある `WORKERS_CI=…`（`npx dotenv -v WORKERS_CI=1 -- node …`）。`WORKERS_CI_COMMIT_SHA` など別の名前、引数を実行しない道具の引数、ヒアドキュメントの本文は見ない）、デプロイのスクリプト（実行の道具（`node`、`nodejs`、`tsx`、`ts-node`、`bun`、`deno`）と、スクリプトを読む道具（シェル（`bash`、`sh`、`zsh`、`dash`）、`source`、`.`）の位置引数を全部見る。`npx`、`pnpm exec`、`pnpm dlx`、`npm exec`、`npm x`、`yarn`、`yarn run`、`corepack` を前に付けた形は、経由先のコマンドを前置き（`env`、`cross-env`、代入、`timeout`）ごと同じ規則で見る。`pnpm -C`、`--dir`、`--cwd`、`--prefix` は作業場所として解決し直し、`pnpm exec -c "…"` と `npm exec --call="…"` の文字列は Bash のコマンドとして見る。実行の道具は、`--import=` のような `--flag=値` の右側、`-e` と `-p` の値、`<` の読み込み元、ヒアドキュメントとヒアストリングの本文も、空白、引用符、括弧で区切った語ごとに見る。書かれた語は小文字にして見る。パスの形の語（`/` を含むか `.拡張子` で終わる）は、作業場所から解決した絶対パスも見るので、`scripts//`、`scripts/./`、`cd scripts &&`、大文字小文字の違いも止まる。`*`、`?`、`[`、`{`、extglob（`!(`、`+(`、`@(`）を含む語（`*` と `**` だけの語は除く）は、`scripts/deploy.ts` と `scripts/deploy-production.ts` に当たるかを見る。括弧で区切る前の語も見る。解決した glob を、作業場所から見つかる根（`scripts/deploy-production.ts` のあるディレクトリ）と、glob の固定の部分から見つかる根（別のチェックアウトや絶対パスの先）の 2 つの入口だけに照合する。`worktrees/*/scripts/*.ts` のように、変数の区間の後ろが `scripts/` で入口の名前に当たる glob も止める。どちらの根も見つからないときは、書かれた形と解決した形の固定の部分とその祖先に入口を付けて照合する。展開が 256 を超える語（`{1..1000}`、`{a,b}` を何個も並べた形）は、照合せずに確認を挟み、それ以下の `{1..3}` は展開して照合する。最初に止める語が見つかった時点で打ち切る。`env -C` と `env --chdir` も作業場所として解決し直す。`--test-name-pattern` と `--test-skip-pattern` の値は見ない。テストの `scripts/deploy*.test.ts` は、変数や記号を含まないパスで書いたときだけ除く）と名前に `deploy` を含む `package.json` のスクリプト、`main` の上でコミットを作る操作（`commit`、`merge`、`pull`、`cherry-pick`、`revert`、`am`。オプションが `--ff-only`、`--abort`、`--quit` だけなら通す）、`main` への push、`--force-with-lease` 以外の force push（`--force`、`-f`、`+` で始まる refspec、`--mirror`、lease の無い `--force-if-includes`）、`gh pr merge` を通さない PR のマージと、`--match-head-commit` の無いか `--auto`、`--admin` を付けた `gh pr merge`（`gh api` と `curl` の merge、`gh stack merge`、`gh alias set` と `gh alias import`、main の ref の書き換え、contents API の書き込み）、シークレットとログイン、`.dev.vars` と `.env` の中身を読むか送るコマンドと `git add`。確認を挟む: `gh pr merge`、依存の追加、削除、更新、マイグレーションの作成、`gh stack` の push 系、ブランチを判定できない push（`cd ~` や変数の先、変数か glob を含む refspec）と、作業コピーを判定できないコミットと、作業場所を判定できない（`cd ~` や変数の先）ときの、デプロイのスクリプトの判定と同じ道具に渡した、名前が `deploy` で始まるパスの形の相対の語（道具そのものの語も含む）と、展開の大きい glob（デプロイのスクリプトに当たるかを判定しない）、Bash からの `.claude/settings*.json` と `.claude/hooks/` と `.githooks/` と `migrations/` の書き換え、`core.hooksPath` の書き換え（読むだけなら通す） |
| `guard-files.mjs` と `file-rules.mjs`（PreToolUse、Write と Edit と MultiEdit） | 止める（ほかの判定より先）: このリポジトリの作業コピーのうち `main` にいるもの（本体の detached も含む。ワークツリーの detached とクラウドのセッションは除く）のファイルの書き換え（文書と ignore されたファイルも含む。別のリポジトリと git の外のファイルは見ない。セッションの場所を引けなければ止める）、`origin/main` にあるマイグレーションの書き換え、`+page.server`、`+layout.server`、`+server`、`hooks.server`、`src/` のうち `src/server/db/` の外での `env.DB` と `D1Database`（テストも含む。テストの土台は `test/` に置く）、`.svelte` の `<style>`、wrangler の設定の `remote: true`。確認を挟む: `.claude/settings*.json` の書き換えと、セッションが使っている `.claude/hooks/` と `.githooks/` の書き換え。セッションを起動した場所（`$CLAUDE_PROJECT_DIR`）とは別のワークツリーの `.claude/hooks/` と `.githooks/` は、確認を挟まない（セッションが使うのは起動した場所のフックで、別のワークツリーでの書き換えは PR で人が読むまで効かない）。ファイル自体のシンボリックリンクはリンク先で判定し、ワークツリーか判定できないときは確認を挟む。Bash からの `.claude/hooks/` の書き換えは、ワークツリーでも確認を挟む |
| `format.mjs`（PostToolUse、Write と Edit と MultiEdit） | このリポジトリのファイルを Prettier で整える。依存が入るまでは何もしない |
| `session-start.sh`（SessionStart の起動と再開） | クラウドのセッションだけで、`pnpm install --frozen-lockfile` を行う。pnpm が無ければ corepack で用意し、corepack も無ければ（Node 25 から同梱されない）`packageManager` の版を `npm install -g` で入れる |

Bash の判定を `permissions.deny` に置かないのは、規則が前方一致で、`npx wrangler` や `pnpm exec wrangler` の言い換えを取りこぼすため。先頭に `*` を付けると、`grep "wrangler deploy"` のような読むだけのコマンドまで止まる。フックはコマンドを区切りごとに分け（コメント、行継続、`$(...)` とバッククォート、`bash -c` と `bash <<EOF` と `eval` の中身も読む）、実行する道具の名前で判定する。同じコマンドの中の `cd` と `git checkout` の後の push は移った先のブランチで、`package.json` のスクリプトは pre と post も含めた中身で見る。判定できないときは、フックが exit 2 で止める。判定を変えたら `node --test .claude/hooks/*.test.mjs` を通す。

どれも踏み線で、本当の守りは、セッションが動く環境に Cloudflare の資格情報を置かないこと。フックからは、変数の中身、パイプで `sh` に流す中身、`gh api graphql` と `gh api --input` が読むファイルの中身、`gh` の設定ファイルに直に書いたエイリアス、`gh extension` が中で打つコマンドが見えない。コードの中で `WORKERS_CI` を設定する形（`node -e "process.env.WORKERS_CI='1'"`）、`.env` からの読み込み、`scripts/deploy.ts` の書き換え、`deploy()` の直の呼び出し、シンボリックリンクで `*.test.ts` に見せた `scripts/deploy-production.ts`（Node がリンク先を本体として動かすので `import.meta.main` が真になる）も追わない。

- クラウドのセッションの環境には、Cloudflare の API トークンを置かない
- 手元の機械では `wrangler login` しない（したら `wrangler logout` しておく）。シェルに `CLOUDFLARE_API_TOKEN` を置かない。手元のセッションは、人が置いた資格情報をそのまま使えるため

止められた操作を人が行うときは、Claude Code の入力欄で先頭に `!` を付けて打つ（フックを通らない）。`.dev.vars` は人が `.dev.vars.example` を写して値を入れる。

## リポジトリのスキル

### 今あるもの

2026-10-22 に下のとおり整えた。原本は `ucan-lab/claude-skills`。クラウドのセッションでも動くよう、残したスキルの GitHub の操作は REST（`gh api`）に書き換えた。レビューのエージェントとチェックリストはこのリポジトリ向けに書き直したので、原本とは別物。

| スキル、エージェント | 扱い |
| --- | --- |
| `issue-plan`、`pr-create`、`pr-feedback`、`self-review`、`grill-me`、`ui-polish`、`japanese-tech-writing` | 残す |
| `sync-base` | `rebase-base` をこのリポジトリ向けに書き換えた。rebase で取り込み、lease の SHA を明示した `--force-with-lease` で push まで行う |
| `d1-migration` | 足した（2026-10-25）。戻せないマイグレーションを書く手順。変更を広げると縮めるに分け、縮める変更は先に使わなくする版を出してから別の PR で行う。マイグレーションを当てた後に `wrangler rollback` しても、古いコードが新しいスキーマで動くようにするため。並行の確かめ、`data-model.md` を同じ PR で直すこと、表の作り直し、空の D1 と行の入った D1 での確かめも扱う |
| `requirements` | 外した。Backlog の要望を要件に落とす受託向けのスキルで、このリポジトリでは使い道が薄い |
| `database-reviewer` | D1（SQLite）向けに書き直した。`batch()` の原子性、共通の表と組織の中の表の混在、組織での絞り込み、マイグレーションを戻せるか、インデックスを見る。観点を当てた後に、PR の保証を疑ってデータを壊す筋書きを組み立てる |
| `code-reviewer`、`security-reviewer` | PHP と Laravel の記述を外し、Workers、Hono、D1、R2、Svelte を前提にした。どちらも `multi-tenant.md` と `cloudflare-workers.md` を読む。観点を当てた後に、PR の主張を疑って差分を壊す筋書きを組み立てる（`security-reviewer` は攻撃者を決めて組み立てる） |
| `finding-verifier` | 足した。CRITICAL と HIGH の指摘の前提をコードと文書で確かめ、成り立たないと示せたものだけを反証とする。CI の AI レビューはすべての CRITICAL と HIGH を、`self-review` は直さないつもりのものを渡す |
| `ui-reviewer` | 足した。画面の差分のコードを `docs/design.md` とチェックリストの `ui.md` に突き合わせ、色の役割、テーマ、言葉の切り替え、状態、アクセシビリティ、狭い幅での崩れを見る。観点を当てた後に、PR の確認を疑って画面を壊す筋書きを組み立てる。撮った画像での採点は `screen-review` が受け持つ |
| `add-operation` | 足した（2026-10-25）。操作の定義を1つ足す型紙。定義、処理、一覧への登録、組織の分離のテスト用の関数、権限のテスト、画面から呼ぶ口までを一続きで作る |
| `.claude/checklists/` | `cloudflare-workers.md` と `multi-tenant.md` を足した。`database.md` を D1 向けに書き直し、`languages/typescript.md` から使わないフレームワーク（Vue、Nuxt、Express、Sequelize）の節を外し、SvelteKit の節を SPA モード向けに直した |

### 新しく作るもの

作る順に並べる。

| スキル | 中身 | 時期 |
| --- | --- | --- |
| `screen-review` | 画面の自己レビュー（#74） | 最初の数画面が動いてから |
| `incident` | 本番で壊れたときの手順。Workers Logs を読む、`wrangler rollback` で戻す、D1 の Time Travel を使う | 運用の手順書と一緒に |

クラウドのセッションで依存を入れる SessionStart のフックは、上の「Claude の設定とフック」にある。

## 開発の流れ

1. アイディアは `docs/ideas.md` か Issue に置く
2. `issue-plan` で Issue を書く。エピック、ストーリー、タスクのどれかと親を決め（下の「Issue の運用」）、完了条件、触る領域、マイグレーションの有無を書く
3. 人が着手を決める。ほかの Issue と並べるときは、上の「並行して作業するときの決まり」で変えるファイルの重なりを見る
4. Issue の本文に書かれていない難所があれば、`grill-me` で人と詰め（詰める間は `status:refining`、下の「Issue の状態」）、決めたことを `issue-plan` で Issue の本文に足す。後の Issue に関わることはその Issue にコメントで申し送る。難所が無い Issue と、人に聞けない実行では飛ばし、置いた前提を PR に書く
5. 着手したことを Issue にコメントで残し（上の「並行して作業するときの決まり」）、手元のセッションは Issue ごとのワークツリーで（切ると `status:in-progress` が付く）、クラウドのセッションはそのままの環境で（`status:in-progress` を自分で付ける。下の「Issue の状態」）実装する（上の「ワークツリーで作業する」）。テストは実装と一緒に書く
6. `self-review` で点検し、`pr-create` で PR を出す
7. CI と AI レビューを待ち、指摘には `pr-feedback` で応える
8. セッションが、Issue と PR でしたことをその場限りの Artifact の説明資料で見せ、人が判断すべきことと、マージするかを `AskUserQuestion` で聞く
9. 下の「マージの判定」に従って、人がマージする。人の指示があれば、セッションがマージする
10. `main` から Workers Builds で自動でデプロイされる（下の「CD」）

仕様を変える実装は、同じ PR で `docs/` も直す。

### マージの判定

マージするかは人が決める。auto-merge は使わない（上の「`main` を守る仕組み」）。

人がその PR のマージを指示したときは、セッションが `gh pr merge <番号> --squash --match-head-commit <確かめた head>` でマージしてよい。打つ前に、PR のベースが `main` であること、`needs-human` が付いていないこと、その head で `label` と `ci-ok` が成功していることを確かめる（手順は `pr-feedback` の「マージを依頼して後片付けする」）。`needs-human` の PR と、`label` か `ci-ok` が成功していない PR は、指示があっても人がマージする。

フックは `gh pr merge` のたびに確認を挟み、`--auto` と `--admin`、`gh api` や `curl` でのマージ、`gh` のエイリアスの作成を止める。クラウドのセッションでは `gh pr merge` が GraphQL で 403 になるので、人がマージする。確認を人に出せない実行（`claude -p` などの非対話の実行、CI の中）でも、セッションはマージしない。

次のどれかに触れた PR には、GitHub Actions（CI の `label`）が機械的に `needs-human` のラベルを付ける。AI には判断させない。パスの規則は `.github/labeler.yml` にある。各領域のコードは右の列の場所に置き、ほかの場所に散らさない。

| 領域 | 置き場所 |
| --- | --- |
| マイグレーション | `migrations/` |
| seed（公開された開発用のトークンのセッションを入れる。本番に入ると誰でもログインできる） | `seed/` |
| 認証とログインの手段（GitHub OAuth、Google）、セッションの読み取り、運用者の判定、暗号、シークレット | `src/server/auth/`、`src/server/crypto/`、`.dev.vars*` |
| 組織で絞る層（組織をまたぐデータの分離。Kysely の2つの入口と `batch()` の関数、組織とワークスペースを確かめる処理） | `src/server/db/` |
| 運用者の権限（運用者だけの操作の定義） | `src/shared/operations/operator/` |
| 権限の検査（操作の定義を登録する関数。Origin、セッション、権限、組織とワークスペースの確かめを順に行う）と、それが頼るもの | `src/server/operations/register.ts`、`guards.ts`、`implement.ts`、`operation-log.ts`（権限の検査と処理に渡すもの、ログの項目）、`src/server/app.ts`、`src/server/errors.ts`（応答の形、運用者の一覧が壊れたときの 500）、`src/shared/operations/define.ts`（権限の種類と実行時の検査）、`src/shared/session-cookie.ts`（Cookie の名前と属性） |
| 取り込み元の処理（顧客のデータ） | `src/server/import/` |
| wrangler の設定（見本の Worker の `wrangler.design.jsonc` も含む）、デプロイのスクリプト、依存 | `wrangler*.jsonc` など、`scripts/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、`.npmrc`、Node の版の指定 |
| lint の設定（組織で絞る層を守る規則を含む） | `eslint.config.*` |
| GitHub と Claude の設定、git のフック | `.github/`、`.claude/settings.json`、`.claude/hooks/`、`.mcp.json`、`.githooks/` |

ファイルのリネームを含む PR と、変更したファイルが 3000 を超える PR にも付ける。パスの規則は移動先の名前しか見ず、変更したファイルの一覧も 3000 件までしか取れないため。

ラベルは付けるだけで、機械は外さない。人が外したときは、パスに当たっていれば付け直す。新しい領域を足すときや置き場所を変えるときは、`.github/labeler.yml` と上の表を同じ PR で直す。運用者の権限を確かめるコードは、判定が `src/server/auth/operators.ts`、検査が操作の定義を登録する関数（`src/server/operations/register.ts`）にあり、どちらもこの表の領域に入る。登録の関数と同じ `src/server/operations/` に置く各操作の処理は、この表の領域に入れない。

`needs-human` の PR は、AI レビューが通っていても人が差分を読んでからマージする。マイグレーションを含む PR では、このマージが本番に当てる承認になる（下の「CD」）。`label` のチェックが成功していない PR も、`needs-human` と同じに扱う（ジョブが落ちるとラベルが付かず、付いていない PR と見分けが付かないため）。付いていない PR は、`label` の成功を確かめたうえで、`ci-ok`、AI レビューの指摘、e2e のスクリーンショットを見て決めてよい。

この仕組みが守るのは PR を通る変更だけで、GitHub の側では `main` への直接の push を止められない。手元の git のフックで止める（上の「`main` を守る仕組み」）。

## CI

PR ごとに GitHub Actions で回す。`.github/workflows/ci.yml` の各ジョブは `package.json` のスクリプトを呼ぶだけにし、手順をワークフローに持たない。

| ジョブ | 中身 |
| --- | --- |
| changes | 変わったファイルを見て、文書だけの PR かを判定する（下の「文書だけの PR」） |
| setup | 各ジョブの先頭で動く共通の用意（`.github/actions/setup`）。Node を `.node-version` から、pnpm を `packageManager` から入れ（corepack に頼らない）、ロックファイルどおりに依存を入れる |
| check | 型の検査（`tsc`、`svelte-check`）、lint、整形、Claude のフックのテスト（`node --test .claude/hooks/*.test.mjs`） |
| test | Workers の実行環境で動かす（`@cloudflare/vitest-plugin`。`@cloudflare/vitest-pool-workers` から名前が変わった）。テストの D1 には `test/apply-migrations.ts` が全マイグレーションを当てる。1つのテストファイルの中では、前のテストが入れた行が残るので、一意の列にはテストごとに新しい値を使う。組織の分離のテストを含む。`scripts/` の `node --test` は、seed を一時の D1 に2回流して中身を数える |
| migration | 空の D1 に全マイグレーションを順に当てて通るか確かめ、続けて同じ D1 に seed を2回流す（`pnpm db:migrate:fresh`）。マイグレーションと seed のずれと、seed を流し直せることを PR ごとに確かめるため。0件なら当てずに成功で終える。ベータが始まったら、既にあるマイグレーションのファイルの書き換えも落とす（上の「DB を作り直してよい期間」） |
| e2e | `pnpm e2e`。`pnpm preview` で build して `wrangler dev` を立て、サーバーが立ってから `e2e/global-setup.ts` が `pnpm db:seed` で手元の D1 に seed を入れ直し（行は消える。立てたままのサーバーを使い回すときも流れる。CI のジョブに seed の段は足さない）、Playwright で、seed の Cookie でログインした組織の選択と組織の枠（組織が1つの人、2つの人、入れない組織を開いた人。`e2e/organizations.test.ts`）、ログインの画面（枠の外、`return_to` の整え方、`?error=` の文言）と seed の Cookie での `me`（`e2e/login.test.ts`）、シェルの表示、`/api/health` の版と D1 への疎通、CSP の違反が無いこと（`securitypolicyviolation` とコンソールのエラー）を確かめる。版には PR の head の SHA を渡し、`/api/health` と画面の build に埋めた版（SvelteKit が書き出す `/_app/version.json`）がどちらもその値になることも見る。スクリーンショットと、失敗したときの trace を成果物の `e2e` に上げる。4つのテーマと2つの言葉の組み合わせのスクリーンショットは、画面ができてから足す。trace は要求と応答と Cookie を丸ごと残し、成果物はリポジトリを読める人が誰でも取れるので、e2e には本物の認証情報を渡さない（ログインは seed のセッションで通す） |
| ai-review | `anthropics/claude-code-action` で、スキル `ai-review` が差分に応じて `.claude/agents/` のレビューのエージェントを呼び分け、CRITICAL と HIGH を `finding-verifier` の反証にかけてから、指摘を PR に書く。`.github/workflows/ai-review.yml` に分けて置く |
| label | パスを見て `needs-human` のラベルを付ける（上の「マージの判定」）。`.github/workflows/label.yml` に分けて置き、`pull_request_target` で動かす。ワークフローも規則も PR のベース（`main`）の版が使われるので、PR の側で書き換えてもラベルは付く。別のブランチをベースに開いてから `main` へ付け替えたときも、判定し直す。PR のコードはチェックアウトしない（書き込みのトークンで PR のコードを動かさないため） |
| ci-ok | ai-review と label を除く上のジョブをまとめる1つのジョブ。マージの前に確かめるのは、これと label |

ai-review は Claude のサブスクリプションで動かす。手元で `claude setup-token` を実行して作った OAuth トークンを、リポジトリのシークレット `CLAUDE_CODE_OAUTH_TOKEN` に置く。従量の費用はかからないが、使用量の上限は手元の対話の利用と共有になる。

- 回すのは、`main` を base にしたドラフトでない PR を作ったとき（`opened`、`ready_for_review`、`reopened`）だけ。push のたびには回さない。直した後にもう一度見せたいときは、人が PR に `ai-review` のラベルを付ける。終わるとラベルは外れる。PR を作るときにはラベルを付けない（作成と付与で2回走る）
- 文書だけの PR（`docs/`、`.md`）、ドラフトの PR、fork と Bot（Dependabot など）の PR では回さない。そこへ付けた `ai-review` のラベルは外れずに残るので、回すときは外してから付け直す
- `ci-ok` に含めない。AI レビューは助言で、サブスクの上限で落ちてもマージの判定を止めない
- PR の上で action が読む `.claude/` と `CLAUDE.md` は、base のブランチのもの。スキルやエージェントの変更は `main` に入ってから効く
- GitHub への書き込みは、ワークフローのトークン（`contents: read`、`pull-requests: write`）で行う。Claude の GitHub App のトークンは `main` に書き込めるため使わない。Claude に許すコマンドは、その PR を読む `gh pr diff` と `gh pr view`、その PR に `--body` で書く `gh pr comment`、`git diff` などの読み取りで、`gh api` は許さない（任意の API と外部の URL を叩けるため）。許可は前方一致なので、`git diff --no-index` でランナーの上のファイルを読むことはできる。Claude が動かすコマンドの環境からは秘密情報を除き（`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`）、外へ送る道具は許さない。指摘は `github-actions[bot]` の名前で付く
- ワークフローは PR の head の版が動く。ワークフローを書き換える PR では、上の守り（ワークフローのトークン、許すコマンド、秘密情報の除去）も同じ PR の中で外せる。`.github/` に触れる PR は `needs-human` にし、人がワークフローの差分を読んでからマージする
- OAuth トークンは長く使え、額の上限を掛けられない。どのブランチにワークフローを置いても（PR の中でも、`on: push` でも）読めるので、リポジトリに push できる人とセッションには、レビューを経ずに読めると考える。漏れた疑いがあれば、`claude setup-token` で作り直してシークレットを入れ替える

確かめるチェックを `ci-ok` の1つにまとめるのは、文書だけの PR で重いジョブを飛ばしても、見る所が1つで済むようにするため。

### 文書だけの PR

`changes` のジョブが、PR の base と head の差分（`git diff --no-renames`）を `scripts/ci.ts` の `isDocsOnly` にかける。変わったファイルがすべて文書の範囲（`docs/`、`CLAUDE.md`、`.claude/` のスキルとエージェントとチェックリスト、`.github/ISSUE_TEMPLATE/`）の `.md` に収まるときだけ、文書だけとみなす。範囲の外に置いた `.md` も、範囲の中に置いた `.md` 以外のファイル（スクリプトや設定）も文書に数えない。範囲の中のスクリプトには `needs-human` も付かないため。Workers Builds の build watch paths の Exclude も同じ範囲にする。範囲を変えるときは、この段落と `scripts/ci.ts` を同じ PR で直し、マージの前に build watch paths（`docs/operations.md` の「Workers Builds の接続」）も直す。

- `ci-ok` の判定の置き場所は `scripts/ci.ts` の `ciOkVerdict`。`needs` のうち `changes` 以外をすべて重いジョブとして扱うので、重いジョブを足すときは `ci-ok` の `needs` に入れるだけでよい
- 文書だけなら check、test、migration、e2e を飛ばし、4つがすべて飛んでいれば `ci-ok` は成功
- 文書だけでなければ、4つがすべて成功のときだけ `ci-ok` が成功で終わる。飛んだもの、落ちたもの、取り消されたものが1つでもあれば失敗
- `changes` そのものが成功しなかったときも、`ci-ok` は失敗で終わる
- リネームは移動元と移動先の両方を見る。`src/` から `docs/` へ移しただけの PR を文書だけとみなさないため
- PR のベースを付け替えたとき（`edited` のうちベースが変わったもの）も判定し直す。head が同じでも差分が変わり、前の実行で文書だけと判定した `ci-ok` の成功が残るため。タイトルや本文の編集では `ci-ok` も skipped で終わり、マージの判定では skipped を数えない。この何もしない実行は、進んでいる実行を取り消さないよう、別の `concurrency` のグループに置く
- ワークフローの `paths-ignore` は使わない。飛ばすとワークフローごと動かず、`ci-ok` そのものが出なくなるため

同じ PR の古い実行は `concurrency` で止める。ワークフローの `permissions` は `contents: read` だけにし、action はすべてコミットの SHA で固定する。

GitHub Actions の無料枠は、private のリポジトリで月 2,000 分。e2e と AI レビューで足りなくなりそうなら、上と同じく対象の PR を絞る。

PR ごとのプレビュー環境は持たず、Workers Builds の preview builds も有効にしない。`wrangler versions upload` のプレビュー URL は本番と同じ D1 につながり、マージ前のコードが本番のデータに触れるため。見た目の確認は e2e のスクリーンショットで行う。

## CD

`main` への push で、Cloudflare の Workers Builds（Git との連携）が動く（2026-10-23 に決めた）。デプロイの鍵を GitHub に置かないため（上の「`main` を守る仕組み」）。

1. ビルドする。checkout したコミットの SHA（`git rev-parse HEAD`）を `APP_VERSION` として `pnpm build` に渡す（上の「版」）。Workers Builds の `WORKERS_CI_COMMIT_SHA` は使わない。接続した直後の初回のビルド（手で動かしたビルド）で、ブランチ名の `main` が入っていたため。git が失敗したらビルドを始めない（ビルドのコマンドは `docs/operations.md` の「Workers Builds の接続」）
2. デプロイのコマンドで、デプロイのスクリプト（`scripts/deploy.ts`、入口は `scripts/deploy-production.ts`）を動かす。スクリプトの手順は次のとおり
   1. Workers Builds の外（`WORKERS_CI` が `1` でない）か、`git rev-parse HEAD` で取った版がコミットの SHA の形（16進の7〜40文字）でなければ、本番に触らずに失敗。手元のログインで作業ツリーを出さず、`dev` や任意の文字列を版にしないため
   2. 本番に触る前に、戻し先として今 100% で動いている版の ID を `wrangler deployments status --json` で控える
      - Worker が無い（API のエラーコード `10007`）か、デプロイが1つも無い: 戻し先無しで進む
      - それ以外のエラー、版が分かれて流れている: 本番に触らずに失敗
   3. `migrations/` にファイルがあれば、D1 の Time Travel のブックマークをログに出してから `wrangler d1 migrations apply --remote` で当てる。未適用が無い回の apply は何もしないので、未適用の有無は見ない。ブックマークが取れないか apply が落ちたら、版は切り替えずに失敗
   4. 版を上げる直前に今の版を取り直し、控えた版と違えば（別のビルドが割り込んだ）版を切り替えずに失敗
   5. `wrangler deploy --var APP_VERSION:<SHA> --message <SHA>` で新しい版を上げ、100% に切り替える。`wrangler deploy` は版を切り替えた後の triggers の反映でも落ちるので、落ちたら今の版を取り直す。控えた版のままなら、そのまま失敗。切り替わっていれば、または確かめられなければ、控えた版へ戻して失敗
   6. 煙のテストで、本番の `/api/health` の `version` が SHA に一致するまで、5秒おきに問い合わせを始め、2分で打ち切る。1回の問い合わせは10秒（期限が近ければ残りの時間）で打ち切り、200 以外（D1 に届かない 503 を含む）と、200 でも版が違うものは失敗として数える。反映にかかった時間をログに出す
   7. 一致しなければ、控えた版の ID を指定して `wrangler rollback <ID>` で戻し、ビルドを失敗で終える。ただし次の2つは戻さずに失敗
      - 上げた直後に控えた自分の版から、本番の版が変わっている（別のビルドが上げた）
      - 戻し先が無い。壊れた版が残っていると書く
3. ビルドの失敗には、Cloudflare の通知と GitHub のコミットの状態で気づく。下の「本番で壊れたことに気づく」の定期の確認でも Issue が立つ

ビルドとデプロイのコマンドは `docs/operations.md` の「Workers Builds の接続」に置く。

- 版は `wrangler deploy` の1回で上げる。`wrangler versions upload` と `versions deploy` の2段にしないのは、`versions upload` が Worker のまだ無い初回に失敗し、cron やルート（triggers）の変更も反映しないため。版を段階的に流さないので、2段に分ける得も無い
- rollback には必ず版の ID を渡す。`wrangler rollback` は版を指定しないと、直近のデプロイを除いた履歴から 100% で動いていた版を選ぶ。その間に別のデプロイが挟まると、このスクリプトが切り替える直前の版とずれるため
- 煙のテストが確かめるのは版と DB への疎通。`/api/health` は共通の入口で `SELECT 1` を送り、届けば 200 の `{ status, database, version }`、届かなければ 503 の `unavailable` を返す。503 は失敗として数えるので、D1 に届かない版は上の rollback で戻る（`versionFromHealth` が応答を読む）
- 煙のテストの URL はスクリプトの定数（`PRODUCTION_URL`）。ドメインへ移すときに直す
- マイグレーションは自動では戻さない。戻すかは人が決め、ログのブックマークで Time Travel から戻す（`docs/operations.md` の「戻し方」）

マイグレーションの承認は別に挟まない。マイグレーションを含む PR には `needs-human` が付き、人が差分を読んでマージするので、そのマージを承認とみなす。`main` への直接の push ではマイグレーションを入れない。

マイグレーションを当ててから版を切り替え、戻すときはコードだけを戻す。どちらの順でも動くように、マイグレーションは `d1-migration` の「広げてから縮める」に従う。

Workers Builds の API トークンは、Builds が作ったトークンの権限を、デプロイに要るものだけに絞って使う。ビルドでは devDependencies のコードがトークンのある環境で動き、依存が1つ乗っ取られるとトークンが外へ出るため。自分で作ったトークン（ユーザーのものもアカウントのものも）は Builds の選択肢に出ないので、入れ替えではなく編集で絞る（2026-10-25 に確かめた）。本番のトークンの権限と変え方は `docs/operations.md` の「API トークン」。

本番をつないだとき（2026-10-25）に確かめたこと。

- Workers Builds は `.node-version` から Node 26.12.1 を、`packageManager` から pnpm 12.12.0 を入れた。corepack を使わずに入るので、ビルドのコマンドで pnpm を入れ直す必要は無い
- `WORKERS_CI=1` と `git rev-parse HEAD` は、ビルドとデプロイの両方のコマンドで使える
- rollback を実地で確かめた。版をずらした PR（#84）のマージのビルドで、煙のテストが2分で打ち切られ、控えた版へ `wrangler rollback` で戻り、ビルドは失敗で終わった。revert の PR（#85）のビルドは成功した
- 文書だけの PR のマージではビルドを飛ばす。build watch paths の Exclude に、上の「文書だけの PR」と同じ範囲を入れた（値は `docs/operations.md` の「Workers Builds の接続」）。build watch paths のワイルドカードは規則の先頭か末尾にしか置けないので、CI のように `.md` だけに絞らず、フォルダごと除く。今の範囲のフォルダには `.md` しか無い。1回の push で 3000 ファイル以上か 20 コミット以上が変わると、Exclude を見ずにビルドが走る
- 続けて push すると、ビルドは一列に並ばず同時に走る（Workers Paid のビルドの枠は6つ）。2つの push を25秒あけたときは、2つ目のビルドが1つ目の途中で始まり、デプロイの段はたまたま重ならずにどちらも通った。重なれば、2つ目はスクリプトの割り込みの検査で止まる。前のデプロイが終わるまで次をマージしない（`docs/operations.md` の「出し方」）

スクリプトは、版を上げる直前に割り込みが見えたら止め、煙のテストに落ちても本番が上げた版から変わっていれば戻さない。別のビルドを潰さないためで、そのときは人が本番の版を確かめる。スクリプトで `main` の先頭と比べる案は、GitHub のトークンを Cloudflare に置くことになるので採らない。

### 見本の Worker

見本（`design/`）を、開発者でない人に見せるための2つ目の Worker で配信する（2026-10-23 に決めた）。

- 設定はリポジトリのルートの `wrangler.design.jsonc`。`design/` を静的なファイルとして返すだけで、コード、D1、R2、シークレットを持たない。設定を `design/` の中に置くと設定そのものが配信されるので、外に置く
- URL は `https://scrum-guild-design.ucan-lab.workers.dev/`。URL の先頭は Worker の名前。名前はダッシュボードの Worker の設定（General の Name）で変え、設定の `name` も同じ名前にそろえる。Access のアプリは URL でなく Worker に付くので、名前を変えた直後から新しい URL を守り、古い URL は 404 を返した（2026-10-24、#17）。設定の `name` だけが先に変わっていた間も、Workers Builds はつないだ Worker へのデプロイを通した。`ucan-lab` はアカウントの `workers.dev` のサブドメインで、変えるとアカウントのすべての Worker の URL が変わる
- 本番と同じく Workers Builds が `main` から反映する。ビルドのコマンドは空で、デプロイのコマンドは `npx wrangler deploy -c wrangler.design.jsonc`。build watch paths は `design/*` と `wrangler.design.jsonc` だけにし、preview builds は有効にしない
- API トークンは、Workers Builds が自動で作ったもの（`scrum-guild-design build token`。もとの名前は `team-leveling-design build token`）を使っている。2026-10-25 に、本番と同じく編集で Workers Scripts: Edit、Account Settings: Read、User Details: Read、Memberships: Read の4つに絞り、名前を改め、Retry build でデプロイが通ることを確かめた。見本は D1 を使わない。Builds の設定の「API token」には、名前を変えた後も古い名前が出る（Builds が名前を写して持っている）
- `workers.dev` の URL を Cloudflare Access（Zero Trust の無料の枠、50人まで）で守る。Access のアプリ（`scrum-guild-design - Cloudflare Workers`）は Worker の本番とプレビューの URL を覆い、セッションは1か月。ログインの手段は Cloudflare アカウントとワンタイム PIN。版ごとのプレビュー URL は設定の `preview_urls` で作らない
- 見る人を足すときは、Zero Trust の Access controls の Applications で見本の Worker のアプリを開き、メールアドレス（Emails）で許可する方針を足す。今の方針は Cloudflare アカウントのメンバーだけを許可する
- 指摘はチャットで受け取り、直すことは Issue にし、決まったことは `docs/design.md` に移す

## 本番で壊れたことに気づく

外部へのテレメトリは送らない方針のまま、自分たちで見る。

- Workers Logs は有効（`wrangler.jsonc` の `observability`）。呼び出しごとのログは切っているので、残るのは Worker がエラーのときに出す JSON の1行だけ。正常な呼び出しではイベントが増えない（2026-10-25 に確かめた）
- GitHub Actions の定期実行で、1時間ごとに本番の `/api/health` と定期処理の最後の成功時刻を確かめ、落ちていたら Issue を立てる
- Cloudflare の Platform Notifications に、Workers のエラー率の通知は無い（2026-10-25）。Observability の Monitors なら、データセット `Workers Logs`、`Workers Real-Time Issues`、`HTTP Requests` への問い合わせにしきい値を置き、メールなどへ送れる。作るのは、エラーのログの形が決まってから
- 請求の通知は設定済み（`docs/operations.md` の「Cloudflare のアカウント」）

## GitHub のログインと取り込み

初版は要件のまま、ログインは共通の1つの GitHub OAuth App（`read:user` だけ）、取り込みは各自が発行する読み取り専用の fine-grained PAT にする（2026-10-22 に決めた）。

GitHub App も比べた。人が抜けても取り込みが止まらない、PAT の発行と更新の手間が消える、Webhook で取り込める、という利点がある。初版で選ばなかったのは次の理由から。

- 払う相手は受託や SES のチームで、リポジトリは発注元の組織にあることが多い。外部のアプリを入れるには発注元の管理者の承認が要る
- インストールは組織ごとに1つなので、2つの組織が同じ組織を使うと1つのインストールを共有する。読めるリポジトリは両方が選んだものの和になり、組織 A が組織 B のために選ばれたリポジトリを読めてしまう
- App の秘密鍵、インストールのトークンの発行、インストールと解除の Webhook が増え、最初の一本道が太くなる
- ログインの同意画面に「あなたに代わって操作する」旨が出て、本人確認だけという要件と見た目が合わない

ベータで「PAT が面倒」「人が抜けて止まった」が多ければ、取り込みだけ GitHub App に移す。そのときは、接続ごとにリポジトリの許可リストを持ち、インストールを組織に結ぶときに確かめる作りを合わせて入れる。

### ログインの実装

置き場所は `src/server/auth/`（人が差分を読む領域）。OAuth App の作り方とシークレットは `docs/operations.md` の「GitHub OAuth App」。

- ログインの手段の型（`login-method.ts`）: 認可の URL を作る `authorizeUrl()`、戻ってきた `code` を確かめて手段の中の ID と表示名とアバターを返す `verify()`、招待する人の指し方 `resolveInvitee()`（GitHub はユーザー名をユーザー ID に解決する）。確かめられないときは `LoginMethodError`（`rejected`: code が使えない。`unavailable`: 届かない、応答が想定と違う、こちらの設定の誤り）を投げ、メッセージは固定の文だけにする。Google（#57）は同じ型に足す
- GitHub の実装（`github.ts`）: 通信先は固定の URL で、設定から読まない（認可 `https://github.com/login/oauth/authorize`、トークン `https://github.com/login/oauth/access_token`、ユーザー `https://api.github.com/user`、ユーザー名の解決 `https://api.github.com/users/<名前>`）。受け取るユーザー ID は正の整数で、10進の文字列にして持つ。ログイン名はユーザー名の形（英数字で始まり、英数字、`-`、`_` を80文字まで。Enterprise Managed Users のログイン名が `_` を含むため）でなければ、応答が想定と違うものとして断る。アバターの URL は `https://avatars.githubusercontent.com/` のものだけを持ち、ほかのホストと http は持たない。使い終えたアクセストークンは、読み終えた直後に GitHub 側でも取り消す（`read:user` のトークンは期限が無い）。取り消しはログインの応答を待たせず（`executionCtx.waitUntil`）、2xx 以外の状態と例外の名前は、固定の文でログに出す（トークンは出さない）。失敗してもログインは止めない。クライアントの ID と秘密は Worker のシークレット `GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET`。`resolveInvitee()` は、認証なしの呼び出しの上限（IP ごとに1時間60回）に Workers の共有の IP が当たらないよう、クライアントの資格情報（Basic 認証）で呼ぶ。使うのは招待の機能を作る Issue で、ユーザー名の形（英数字とハイフンで39文字まで）に合わない値は GitHub に問い合わせない
- 開始 `GET /api/auth/github/start?return_to=<パス>`:
  - 受けるのは、利用者が自分のサイトの画面（ログインの画面のボタン）かアドレス欄から始めた画面の移動だけ。条件は次の4つで、どれかのヘッダーがあって合わないものは、数えず、行も書かず、ログインの画面へ戻す。ほかのサイトのページから、被害者の IP の枠を使い切らせないため
    - `Sec-Fetch-Mode` が `navigate`（`<img>`、`<script>`、`fetch()` は合わない）
    - `Sec-Fetch-Dest` が `document`（`<iframe>` は合わない）
    - `Sec-Fetch-Site` が `same-origin` か `none`（ほかのサイトと、同じサイトの別のオリジンからの移動は合わない）
    - `Sec-Purpose` に `prefetch` と `prerender` を含まない（先読みは、利用者が開いたものではない）
  - ヘッダーを送らない古いブラウザは通す。この場合の限界は `docs/data-model.md` の `rate_limits`
  - 通ったものはレート制限（`login:<IP>`）を数え、`oauth_states` に state、code_verifier（どちらも 32 バイトの乱数の base64url、43文字）、戻る画面のパスを入れる（10分で切れる）
  - 同じ state を HttpOnly、SameSite=Lax の Cookie にも置く。https では Secure を付けた `__Host-sg_oauth_state`。http の localhost では、Safari が Secure の Cookie を保存しないので、Secure も `__Host-` も付けず `sg_oauth_state`（セッションの Cookie も同じ）
  - PKCE（`S256`）の `code_challenge` を付けた GitHub の認可の URL へ 302 で移す
  - `return_to` は自分のサイトのパスだけを受け付ける（`src/shared/return-to.ts`）。条件は、`/` で始まり、`//` で始まらず、`\` を含まず、`.` と `..` の区間（`%2e` を含む）を持たず、印字できる ASCII だけで、2000字まで。最初の区間が `api` と `login` のものも除く。`/.//evil.example` のように、URL の解決が区間を畳んで `//evil.example` になる書き方を止めるためで、除いた値は `/` に直す
  - ログインの後に移す先は、URL を解決した後の値（パス、クエリ、フラグメント）も同じ検査に通す。通らなければ `/` を使う。ログインの画面の `return_to` も、同じ関数で整える
- 戻り先 `GET /api/auth/github/callback?code=&state=`:
  - 最初に、クエリの state と Cookie の state が揃い、形が 43 文字の base64url で、値が一致することを確かめる（比較は `crypto.subtle.timingSafeEqual`）
  - 合わない戻りは、`retry` で断る。レート制限には数えず、`oauth_states` の行にも state の Cookie にも触れない。DB の行だけで確かめると、攻撃者が自分で始めたログインの code と state を付けた戻り先の URL を踏ませて、被害者のブラウザを攻撃者のアカウントでログインさせられる（ログインの CSRF）。数えればほかのサイトのページから被害者の IP の枠を使い切らせられ、Cookie を消せば被害者が始めたログインが壊れる
  - 合った戻りだけが、state の Cookie を消し（成功でも失敗でも）、レート制限を数え、`oauth_states` の行を `DELETE ... RETURNING` で消して読む。並行した戻りでも、通るのは1回だけ
  - 行が無い（使い済み）、別の手段の行、10分を過ぎた行は、`retry` で断る。`error` が付いた戻り（GitHub 側で拒否）と code の無い戻りも同じ
- 分かれ道（`login.ts`）: GitHub の ID で `account_logins` を引き、入れる組織があるか調べ（`hasLoginAccess()`。アカウントができる前の指名の行と招待は、ログインの手段と ID で当てる）、運用者の一覧にも無ければ `denied` で断る（`accounts` も `account_logins` も作らない）。初めての人（`account_logins` が無い）は `accounts` と `account_logins` を1回の `batch()` で作る。2回目以降は `account_logins` の `login_name`、`display_name`、`avatar_url` と `accounts.last_login_at` を書き直す。続けて、組織の DB の `users.account_id` が空で、ログインの手段と ID が同じ行を、そのアカウントに結ぶ（`linkLoginToAccount()`。ログインのたびに流す。何度流しても同じ結果。結ぶ行を先に読み、当たったときだけ書くので、空振りのログインで組織の DB に書かない）。共通の表と組織の中の表は別の `batch()` で書く。結ぶ書き込みが失敗したら、セッションを作らず `retry` を出し、次のログインで結ぶ（`docs/data-model.md` の「書き込みの単位」）。最後にセッションを作る（32 バイトの乱数の base64url を Cookie に入れ、SHA-256 の16進を `sessions` に入れる。このリクエストが持っていた古いセッションは、同じ `batch()` で消す）。並行した最初のログインでは、アカウントが無いと読んだ後に、もう片方がアカウントを作り、指名の行を結ぶことがある（結んだ行は、アカウントが無い側からは当たらなくなる）。判定が落ちたら `account_logins` を読み直し、できていればその ID で判定し直す。権限の無い人のアカウントを先に作ることはしない。両方がアカウントを作る側に回ったときは、片方が `account_logins` の主キーで落ちて、`accounts` ごと戻る。落ちた側は読み直して続ける
- ログインの画面への理由（`/login?error=`）: `denied`（入れる組織も招待も無い）、`retry`（state が合わない、使えない code、結ぶ書き込みの失敗）、`too_many`（レート制限）、`unavailable`（GitHub に届かない、応答が想定と違う、クライアントの ID と秘密が未設定）。再度ログインできるときは `return_to` も付ける
- レート制限: ログインの開始（画面の移動だけ）と戻り先（state の Cookie が合ったものだけ）を、同じ IP（`CF-Connecting-IP`。無いリクエストは `unknown` の1つの枠。IPv4 はそのまま。IPv6 は、1人が /64 の中の無数のアドレスを使えるので、上位 64 ビット（/64）で数え、事業者の単位の /48 も、より緩い上限で数える。IPv4 を写した IPv6 は、16進と全部を書いた形も含めて IPv4 に直す。解釈できない値は `unknown` の枠）から10分に60回まで（`src/server/auth/rate-limit.ts` の `LOGIN_RATE_LIMIT`）。1回のログインで2回数えるので30人分。同じオフィスの15人のチームが一斉に入っても詰まらない値にした。IPv6 の /48 は10分に600回まで（`LOGIN_RATE_LIMIT_IPV6_SITE`）。どれかを超えたら `too_many`。戻りが超えたときは GitHub に問い合わせない。IP は `CF-Connecting-IP` を使うので、Cloudflare の Pseudo IPv4 を Overwrite で有効にしない（`docs/operations.md`）
- ログアウト（操作 `logout`）: 今のセッションの行を消し、Cookie を消す。ほかの端末のセッションは残す

## Google のログイン

エンジニアでない人もチームに入るため、ログインの手段に Google を足す（2026-10-25 に決めた）。

- OAuth クライアント: Google Cloud のプロジェクトに、種類が「ウェブ アプリケーション」のものを1つ作り、承認済みのリダイレクト URI は本番の公開 URL の戻り先だけにする
- 同意画面: ユーザーの種類は「外部」、公開の状態は「本番」。「テスト」のままだと、登録したテストユーザーしかログインできない
- スコープ: `openid`、`email`、`profile` だけ。機密のスコープを使わないので、Google の審査を待たずに出せる
- フロー: 認可コードのフロー（`response_type=code`）に state、PKCE（`S256`）、nonce を付け、`prompt=select_account` で Google のアカウントを選ばせる。複数の Google アカウントでログインしている人が、招待されたのと別のアカウントで戻らないようにするため。受け取る ID トークンは、固定の `https://oauth2.googleapis.com/token` に Worker から送った応答の `id_token` だけ。エンドポイントを発見の文書や設定から読まず、戻り先の URL や画面から ID トークンを受け取らない
- ID トークンの検証: TLS でトークンのエンドポイントから直接受け取るので、OpenID Connect Core の決まりに沿って署名の検証は省く。確かめるのは次の5つ
  - `iss` が `https://accounts.google.com` か `accounts.google.com` に完全一致する
  - `aud` がクライアント ID に完全一致する（配列なら `azp` もクライアント ID）
  - `exp` が過ぎていない
  - `nonce` が `oauth_states` の値に一致する
  - `email_verified` が真偽値の `true`（文字列の `"true"` は通さない）。メールアドレスで待つ指名と招待に結ぶときだけ要る
- `sub`: 受け取った文字列のまま扱い、数値に直さない
- ドメイン: 個人の Google アカウントの人も入るため、`hd`（Google Workspace のドメイン）では絞らない。入れるかどうかは、ほかの手段と同じく指名と招待で決まる。Google が管理していないアドレスでも横取りされないよう、指名と招待は招待の URL の秘密とメールアドレスの両方がそろったときだけ結ぶ（`data-model.md` の「メールアドレスで待つ指名と招待」）
- 運用者のログインの ID: シークレットの一覧の各項目は `github:<数字>` か `google:<数字>` の形だけを受け付け、合わない項目があれば起動を止める。比べるのは手段と ID の文字列の完全一致だけ。自分の Google の `sub` の調べ方は運用の手順書に書く
- ログインのボタンの見た目は、Google のブランドの決まり（Sign in with Google のボタン）に合わせる。見本の Google のボタンは仮の見た目

## 開発とテストでのログイン

ログインを飛ばす口は作らない（2026-10-22 に決めた）。本番に罠として残るコードを無くすため。

- seed（`pnpm db:seed`）が、決まったトークンのセッションをローカルの D1 に入れる。e2e と画面の自己レビューは、その Cookie を置いてログインした画面を開く。トークンは開発用の値で、本番の D1 には入れない
  - セッションは4つ: あおば開発の管理者、あおば開発の一般のユーザー、ひばり工房だけに入れる管理者、どの組織にも属さない運用者（`OPERATOR_LOGIN_IDS` の開発用の値、`.dev.vars.example`）
  - トークンは `seed/sessions.ts` の1か所に置き、seed はそこから SHA-256 の16進を計算して入れる。e2e も同じ定数を import し、Cookie の名前は `sessionCookieName()` で決める（e2e は `pnpm preview` の http の localhost なので `sg_session`）。中身と流し方は `seed/README.md`
  - セッションの `last_used_at` と `expires_at` は seed を流した時刻から数える。ほかの日時は固定の値にする。切れたら seed を流し直す
  - seed は全部の表の行を消してから入れる。手で足した行も消える
  - seed のセッションが入った手元の `wrangler dev` を、`--ip 0.0.0.0` やトンネルで外に開かない。公開されたトークンで、誰でも管理者と運用者として入れるため
  - 本番に入れない守りは、seed のスクリプトが `--local` だけを付けることと、フック（`guard-bash.mjs`）が `--remote` を止めること。本番が seed のトークンを拒むことは、デプロイの煙のテストで確かめる。版が一致した後、seed のトークン（`seed/sessions.ts` の数だけ）を本番の `POST /api/logout` に Cookie で送り（Origin は本番の URL）、どれも 401 で、本文の code が `unauthenticated` でなければ、煙のテストの失敗として前の版へ戻す（`scripts/deploy.ts`）。確かめる口を `logout` にしたのは、入れる組織があるかの判定をしない操作（`skipsLoginAccess`）だから。判定をする `me` などだと、seed の行が本番に残っていても、入れる組織が無いために 401 になって、見逃す。5xx、429、届かないときは、答えられていないだけなので3回まで繰り返す。2xx（受け付けた）、そのほかの 4xx、3xx（リダイレクトは辿らない）は、繰り返さずに失敗にする。受け付けたトークンがあっても、残りのトークンも全部確かめてから失敗にし、受け付けた名前（`admin` など。値は出さない）をすべて報告する。受け付けられたときは、前の版へ戻しても本番の `sessions` に seed の行が残っていれば直らないので、専用の文言で、人が実行する消す手順（`docs/operations.md` の「seed のセッションが本番に入ったとき」）を指す。トークンは `seed/sessions.ts` から import し、本番のコードには書かない
- テーマと言葉は、本物の設定の API（自分の設定、組織の設定）で切り替えてから撮る。撮影のための URL のパラメータは作らない
- 「今日」は、開発用の設定の値（wrangler の開発用の値）で固定できるようにし、スクリーンショットが日付で変わらないようにする。本番でこの値が設定されていたら起動を止める
- 開発用の GitHub OAuth App と Google の OAuth クライアントを別に作り、手で本物のログインを確かめるときに使う。Google の開発用のクライアントは同意画面を「テスト」のままにし、確かめる人をテストユーザーに登録する

## Issue の運用

Issue はエピック、ストーリー、タスクの3階層にし、親子はサブ Issue でつなぐ（2026-10-25 に決めた）。親子の形は Scrum Guild 自体の木（`docs/requirements.md` の「概念」）と同じにする。タスクの親は無しかストーリー、ストーリーの親は無しかエピックで、タスクをエピックの直下に置かない。リポジトリは個人の持ち物で GitHub の Issue Types が使えないので、種別はラベルで表す。

| 階層 | GitHub での表し方 | 中身 | 閉じる人と条件 |
| --- | --- | --- | --- |
| リリース | マイルストーン | 「初版」（自分のチームで使い始めるまで）。次のリリースのマイルストーンは、初版を閉じるときに人が作る | 入れた Issue がすべて閉じたとき |
| エピック | `epic` のラベル | 成果のまとまり。ストーリーをサブ Issue に持つ | 人が、サブ Issue がすべて閉じ、エピックの完了条件を満たしたことを確かめて閉じる |
| ストーリー | `story` のラベル。エピックのサブ Issue | 確かめられる1つのふるまい。タスクをサブ Issue に持つ | 人が、受け入れ条件を本番か e2e で確かめて閉じる |
| タスク | `epic` も `story` も付けない（`area:` などほかのラベルは付ける）。ストーリーのサブ Issue | 1つの PR で入れる変更（1 Issue に 1 ブランチ、1 PR） | PR のマージで閉じる |

- マイルストーンはリリースの区切りにだけ使い、エピックの分類には使わない。1つの Issue に1つしか付かず、エピックに使うとリリースを表す場所が無くなるため。エピック、ストーリー、タスクのそれぞれに、入るリリースのマイルストーンを付ける。配下が2つのリリースにまたがるエピックは、リリースごとに分ける
- ストーリーの受け入れ条件は、利用者（土台のストーリーは運用者か開発者）から見えるふるまいで書く（「管理者として、招待の URL から Google でログインして組織に入れる」）。テーブルや関数の名前で書かない
- 利用者から見えるふるまいにならない土台の作業（マイグレーション、入口、CI）は、土台のストーリーにまとめる。受け入れ条件は、運用者か開発者が確かめられるふるまいで書く（「運用者として、本番の `/api/health` で DB に届くことを確かめられる」）
- 1つの PR で収まるストーリーは、タスクに分けずにストーリーのまま実装してよい。そのときはタスクの節（やること、確認方法、マイグレーション）もストーリーに書き、PR では閉じず、人が確かめて閉じる
- 親の無いタスクも置いてよい（不具合、定期の確認で立つ Issue、`d1-migration` の縮める Issue）。PR のマージで閉じる。この運用を決める前に立てた Issue は、着手するときに親を決めてつなぐ
- PR の本文は、タスクを `Closes #<番号>` で指す。ストーリーとエピックは `Refs #<番号>` で指し、`Closes` を使わない。マージで閉じると、人が受け入れ条件を確かめる前に閉じるため
- ストーリーの最後のタスクの PR では、`pr-feedback` の説明資料で親のストーリーの受け入れ条件を示し、人に確かめて閉じてもらう
- ラベル: 階層の `epic`、`story`、状態の `status:refining`、`status:in-progress`（下の「Issue の状態」）、人が差分を読む `needs-human`、マイグレーションの `migration`、領域の `area:auth`、`area:organization`、`area:workspace`、`area:task`、`area:import`、`area:attachment`、`area:ui`、`area:infra`、`area:docs`、不具合の `bug`、AI レビューをもう一度回す `ai-review`。GitHub に作り、`bug` 以外の既定のラベルは消した（2026-10-22）。重複や対応しないものは、ラベルではなく Issue を閉じるときの理由で表す
- テンプレート: タスクは `.github/ISSUE_TEMPLATE/plan.md`、ストーリーは `.github/ISSUE_TEMPLATE/story.md`。`issue-plan` が書く形と同じにする
- 領域のラベルは、並行して作業するときのぶつかりを見分けるのにも使う。同じ領域の PR を同時に何本も開かない。ラベルが違っても重なる共通の層は、「並行して作業するときの決まり」で変えるファイルを比べて見る

### Issue の状態

開いた Issue の状態は、ラベルと開いた PR で表す（2026-10-25 に決めた）。並行するセッションが、人と詰めている Issue や実装中の Issue を取らないようにするためと、セッションが進み具合を一覧にするとき（人の手元の進捗の図など、リポジトリの外のもの）に、PR やワークツリーから推測せずに状態を読めるようにするため。一覧ではこの表のとおりに状態を出す。

| 状態 | 表し方 | 付け替えるきっかけ |
| --- | --- | --- |
| 要件整理中 | `status:refining` | `grill-me` で Issue を詰め始めたとき、`issue-plan` の書くモードで既にある Issue の計画を書き始めたとき。セッションが付ける |
| 作業中 | `status:in-progress` | 番号付きのブランチ（`<番号>-<名前>`）のワークツリーを新しく切ったとき。`.githooks/post-checkout` が付け、`status:refining` を外す。クラウドのセッションはワークツリーを切らないので、着手したときに `gh api -X POST repos/{owner}/{repo}/issues/<番号>/labels -f 'labels[]=status:in-progress'` で付け、`status:refining` を外す |
| レビュー中 | その Issue を指す開いた PR があること。ラベルは使わない | PR の作成 |
| 済み | Issue が閉じたこと | タスクは PR のマージ、ストーリーとエピックは人が閉じる |

- 表の上の行より下の行が勝つ。開いた PR があれば、`status:in-progress` が付いたままでもレビュー中とみなす（PR を出してもラベルは外さない）
- 両方のラベルが付いていれば作業中とみなす。セッションが `status:refining` を付けるのは、`status:in-progress` の無い Issue だけ
- 閉じた Issue は、ラベルにかかわらず済みとして扱う。閉じた後にラベルを外す手間はかけない
- ラベルは `gh api` の REST で付け外しする（付ける `POST repos/{owner}/{repo}/issues/<番号>/labels`、外す `DELETE …/labels/<名前>`）。GraphQL の `gh issue edit` はクラウドのセッションで 403 になるため
- `post-checkout` は、前の HEAD が null の SHA になる checkout のうち、追加のワークツリーでだけ動く。clone、本体の作業コピー、既にある作業コピーでの `git switch -c`、detached のワークツリーでは付かないので、着手を表すなら手で付ける。既にあるブランチでワークツリーを切り直したときも付く。付けるのは、その番号が開いた Issue（PR ではない）だと確かめられたときだけ。`gh` が無い、認証が無い、通信が落ちたときは理由を知らせるだけで、checkout は続ける。`timeout` のある環境（Linux、coreutils を入れた macOS）では `gh` の1回の呼び出しを10秒で切り、無い環境では上限なしで待つ。書き込み先は `ucan-lab/scrum-guild` に固定してある
- 詰めるのをやめて着手しない Issue は、`status:refining` を手で外す。ワークツリーを捨てて着手をやめたとき、PR をマージせずに閉じて Issue を開いたまま残すときは、`status:in-progress` を手で外す。外し忘れると、並行するセッションから着手済みに見え続ける

## 運用の手順書

`docs/operations.md` の1つにまとめる（2026-10-22 に決めた）。最初のデプロイの PR で作り、手順を変える PR で同じ差分の中で直す。

- 用意: Cloudflare のアカウント、GitHub OAuth App、Google の OAuth クライアントと同意画面、D1 と R2 のバケット、シークレットの一覧と登録、Workers Builds の接続と API トークン
- 出し方: Workers Builds とデプロイのスクリプト、マイグレーション、煙のテスト
- 戻し方: `wrangler rollback`、D1 の Time Travel、定期の書き出しからの戻し
- 組織: 作成、停止と再開、解約と30日後の消去（R2 のファイルを含む）
- 鍵の入れ替え: 接続の認証情報の暗号鍵
- 本番で壊れたとき: Workers Logs の見方、定期の確認の Issue が立ったときにすること

後で作る `incident` のスキルは、この文書の「戻し方」と「本番で壊れたとき」を手順として読む。

## セキュリティのヘッダー

最初の一本道から厳しく入れる（2026-10-22 に決めた）。後から締めると、壊れる所を探す手間が大きいため。

- CSP: SvelteKit の `csp` の設定（ハッシュ）で、`script-src` を自分のものだけにする。`default-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`frame-ancestors 'none'`、`form-action 'self'` を基本にする。外を読む必要が出たら、その先だけを足す。書体は自分の Worker から配るので足していない（上の「書体」）
- `style-src` は `'self'` に加え、SvelteKit が差し込む読み上げ用の要素（`svelte-announcer`）の `style` 属性だけを `'unsafe-hashes'` とハッシュで通す。止めると、画面を移るたびに読み上げ用の文が見えてしまうため
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Strict-Transport-Security: max-age=31536000; includeSubDomains`
- e2e で、CSP の違反が出ないことを確かめる

値は `src/shared/security-headers.ts` の1か所に持ち、画面の資産と API の両方がそこから付ける。

### 画面の資産

Workers Static Assets の `_headers` で付ける。資産の配信には Worker を起動させない（`run_worker_first` は `/api` と `/api/*` だけ。`/api/*` だけだと末尾にスラッシュの無い `/api` が SPA の `index.html` を 200 で返す）。

- CSP の出どころは SvelteKit の `kit.csp`（`mode: 'hash'`）。SvelteKit が書き出した `build/index.html` の meta の CSP を、`pnpm build` の最後に `scripts/write-headers.ts` が `build/_headers` に写す。ハッシュは build ごとに変わるので、コミットした `_headers` には書けない
- SvelteKit は meta で出すときに `frame-ancestors`、`report-uri`、`sandbox` を捨てる（meta では効かないため）。写すときに、捨てられた `frame-ancestors 'none'` を末尾に足す
- 写すスクリプトは、meta が見つからないとき、書き出した JS の `style` 属性が `style-src` のハッシュに無いとき（SvelteKit を上げて読み上げ用の要素の `style` が変わったときなど）に build を失敗させる
- `/_app/immutable/*` は `Cache-Control: public, max-age=31536000, immutable`。ファイル名にハッシュが入り中身が変わらないため。`index.html` は Cloudflare の既定（毎回確かめる）のままにして、新しい版をすぐ拾う
- `inline` の script と style を `src/app.html` とコンポーネントに書かない。ハッシュから漏れて CSP で止まる

### API

Hono のミドルウェアで、404 と 500 を含む全応答に付ける。

- CSP は `default-src 'none'; frame-ancestors 'none'`。JSON にスクリプトは無いので、何も読ませず、埋め込ませない
- ほかの固定のヘッダーは画面と同じ
- `Cache-Control: no-store`。ログインした人のデータを返すので、どの応答もキャッシュに残さない

## 添付ファイルの配信

画面と同じオリジンから、Worker が権限を確かめて返す（2026-10-22 に決めた）。別のドメインと署名付き URL は使わない。

- 画面で表示するのは、決まった型の画像と動画（MP4、WebM）だけにする。型は上げたときの申告ではなく、ファイルの先頭のバイトで確かめる
- SVG と HTML を含め、それ以外はすべて `Content-Disposition: attachment` で落とす
- 添付ファイルの応答には `Content-Security-Policy: sandbox; default-src 'none'` と `nosniff` を付ける
- 決まりの外れは `.claude/checklists/cloudflare-workers.md` の「画面の配信」で見る

## Cloudflare のアカウントとドメイン

- 本番の Cloudflare アカウントは ucan-lab 用に新しく作る（2026-10-22 に決めた）。請求と権限を個人のものと分け、法人化や人を足すときに移しやすくする
- ドメイン `scrum-guild.dev` はベータの前に取る（2026-10-22 に決めた）。それまでは `workers.dev` の URL で動かす
- 本番の Worker の名前は `scrum-guild` で、ドメインを取るまでの URL は `https://scrum-guild.ucan-lab.workers.dev/`（2026-10-24 に決めた）。GitHub OAuth App の戻り先もこの URL にする
- アカウントは、本番に初めてデプロイする Issue（上の「初版の作る順」の2）で Workers Paid にする（2026-10-24 に決めた）。無料の枠は1回の CPU の時間や外への通信の回数の上限が厳しく、`wrangler dev` ではその上限で止まらないので、本番でだけ落ちる差を最初から無くすため
- 本番の `workers.dev` は Cloudflare Access で守らない（2026-10-24 に決めた）。アプリに GitHub のログインがあり、入れる組織か届いた招待が無い人は入れないため。Access を挟むと、煙のテストの `/api/health` を通す除外が要り、ドメインを移すときに Access のアプリも作り直すことになる
- ドメインへ移すときは、公開する URL の設定、GitHub OAuth App の戻り先、Cookie を直し、移した後にもう一度ログインしてもらう。手順は `docs/operations.md` に書く
- 組織を示す URL の形（`/<slug>/...`）は、`workers.dev` の上でも変えない

## 定期の作業

- 依存の更新は Renovate か Dependabot で週に1回、まとめて出す。`needs-human` が付くので、人が差分を読んでマージする
- `wrangler d1 export` の定期の書き出しは、顧客のデータなので GitHub の成果物に置かず、R2 の別のバケットに置く
