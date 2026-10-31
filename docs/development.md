# Scrum Guild の開発の進め方

状態: 方針（2026-10-22 に決めた）。土台を作るときに、道具の名前や設定の細部を足す。

前提: 作るのはほぼ1人で、実装の多くは Claude のセッション（手元のワークツリーか、クラウド）が受け持つ。ステージングは持たず（`requirements.md` の「運用」）、D1 のマイグレーションは戻せない。全組織が1つの D1 に入る。

## 技術の選択

`requirements.md` の「技術の前提」に加えて、土台を作る前に次を決めた（2026-10-22）。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| パッケージマネージャー | pnpm。`package.json` の `packageManager` で版を固定する | 速く、依存が厳密 |
| Node | 26。`.node-version` で固定する。`package.json` の `engines` は、`scripts/` の `.ts` を型の除去で直に動かせる下限の 22.18 にし、`engine-strict` は使わない（クラウドのセッションの Node は `.node-version` を読まず、フックと、セットアップスクリプトが 26 を入れられなかったときのセッションは、VM の既定の 22 で動くため。下の「クラウド環境」）。Node 25 からは corepack が同梱されないので、pnpm は `packageManager` の版を corepack に頼らずに入れる | 長く使える LTS |
| リポジトリの形 | 1つのパッケージ。`src/server`（Hono の API と定期処理）、`src/shared`（操作の定義、スキーマ、言葉の辞書）、SvelteKit の既定の場所（`src/routes`、`src/lib`、`src/app.html`）に分ける。SvelteKit の設定は `vite.config.ts` の `sveltekit()` に書く（SvelteKit 3 は `svelte.config.js` を読まない） | Worker が1つなので、ワークスペースに分ける設定の手間に見合わない。画面を別の場所に移す `kit.files` は非推奨 |
| lint と整形 | ESLint と Prettier（`eslint-plugin-svelte`、`prettier-plugin-svelte`） | Svelte のテンプレートの中まで見られる。下の「入口を守る規則」を自前で書ける |
| 画面 | SvelteKit の SPA モード。SSR を切り、静的に書き出す。API は Hono のまま | 組織、ワークスペース、画面の入れ子をレイアウトで表せる。画面と API の版のずれを `version.pollInterval` と `updated` で検知できる。AI が書き慣れている |
| D1 への問い合わせ | Kysely。マイグレーションは SQL のファイルで手書きし、wrangler で当てる | 型付きで SQL に近い。組織を確かめた入口からしか組織の中の表を引けない型を作れる |
| スキーマ | zod | Hono のバリデーター、Claude の道具や MCP の定義（JSON Schema）への変換など、周りの道具が揃っている |
| 操作の定義 | 自前の定義から形を推論する。コードの生成はしない | 下の「操作の定義」 |
| 画面の言葉 | 型付きの辞書を自前で持つ | 下の「言葉の辞書」 |
| 並べ替えの並び（`position`） | `fractional-indexing`（分数の並びの文字列を作る定番のパッケージ） | 間に入れても他の行を書き換えない並びを自前で書かずに済む。ワークスペースを作るときの最初の列と、並べ替えの操作が同じものを使う |
| 行のドラッグ | `@atlaskit/pragmatic-drag-and-drop`（本体）、`-hitbox`、`-auto-scroll`（`src/lib/backlog-dnd.svelte.ts`、`src/lib/list-dnd.svelte.ts`、`src/lib/sprint-dnd.svelte.ts`。落とせる場所の判定は部品に依らない純粋な関数 `src/lib/backlog-drop.ts`、`src/lib/list-drop.ts`、`src/lib/sprint-drop.ts`）。画面は SPA で Svelte に直す | 行の上半分か下半分か、木の間か子にするかの判定と、端での自動スクロールを自前で保たずに済む。React に依存しない。配列を部品が入れ替える `svelte-dnd-action` は、先に画面を動かして押した順に送る並べ替え（`src/lib/move-queue.ts`）と二重になるので使わない |
| Markdown の描画 | `mdast-util-from-markdown` と GFM の拡張4つ（自動リンク、打ち消し線、表、チェックリスト。脚注は入れない）で構文木にし、自前の安全な節に直して Svelte の再帰の部品で描く（`src/lib/markdown.ts`、`src/lib/components/MarkdownBlocks.svelte`）。変換は Web Worker で行い、1秒で終わらない本文は Worker を止めて文字のまま出す（`docs/design.md` の「Markdown の本文」） | HTML の文字列を作らないので無害化器が要らず、リンクと画像の規則を型の上で守れる。悪意のある本文は変換に数秒から分かかるので、画面の本体では走らせない |
| 架空のデータ | seed とファクトリーの両方 | 下の「架空のデータ」 |

### 操作の定義

`ai.md` の「操作の定義を1か所に持つ」の形。

- 定義: 操作ごとに、名前、説明、入力と出力の zod のスキーマ、`read` か `write`、要る権限を1つのオブジェクトに書き、`src/shared/operations/` に置く（`defineOperation()`）。一覧は `src/shared/operations/index.ts`。運用者の操作は `src/shared/operations/operator/`（人が差分を読む領域）、ログインしている人自身の操作（`me`、`logout`、API トークンの操作、`operation-list`）は `src/shared/operations/session/`。定義は処理を持たない。画面の束に Worker のコードを入れないため。定義は画面の束にも入るので、`define.ts` が `src/shared/zod-config.ts` を先に読み込み、zod の eval の試し（`new Function`）を止める（`jitless`）。画面の CSP に `'unsafe-eval'` が無く、試しが違反として報告されるため。
- 回数の上限: 重い操作（手動の同期など）には、定義に `rateLimit: { max, windowSeconds }` を付ける。登録の関数が、権限の検査の後、入力を読む前に、アカウントと操作ごとに `rate_limits` の `operation:<操作の名前>:<アカウントの ID>` で数え、窓の中で `max` を超えた呼び出しは 429 の `rate_limited` で断る（処理は動かない）。窓の最初の呼び出しから `windowSeconds` たつと数え直す。数えるのは1文の upsert で、並行した呼び出しも取りこぼさない（`src/server/auth/rate-limit.ts`）。アプリ側のレート制限は、ログイン、画面のエラーの送信（`POST /api/client-errors`）、手動の同期、招待する人の解決（`invitee-resolve` と `invitation-create`。GitHub に問い合わせる）、完成の定義の変更（`workspace-dod-update`。10 万字の本文を書く）にだけ設ける（`docs/requirements.md` の「運用」）。ログインは GET の例外なので定義に付けず、`login:<IP>` で数える（「GitHub のログインと取り込み」）。パスワードのログインも直に書く例外なので定義に付けず、`password:<IP>` と `password-email:<メールアドレスのハッシュ>` で数える（「パスワードのログイン」）。画面のエラーの送信も直に書く例外なので定義に付けず、`client-error:<IP>` で数える（「本番で壊れたことに気づく」）。手動の同期の「接続ごとに5分に1回」は `connections.last_manual_sync_at` で判定し、この項目とは別。
- 処理: `src/server/operations/` で `implement(定義, 処理)` の形に書き、`src/server/operations/index.ts` の一覧に足す。Hono のルートは、この一覧を `createApp()` が1つの関数（`operationsApp()`）で登録する。ルートを直に書かない。仮の操作は本番の一覧に入れず、テストの中で定義する。
- 直に書く例外（GET のルートと、招待の URL の画面のフォームの POST、画面のエラーの送信）: `/api/health` と、ログインの開始 `GET /api/auth/<手段>/start?return_to=<パス>` と戻り先 `GET /api/auth/<手段>/callback`、招待の URL から Google のログインを始める `POST /api/auth/google/start`（`src/server/auth/login-routes.ts`）。ログインの3つは手段（GitHub か Google）へ移し、手段から戻るブラウザの移動（リダイレクト）で、JSON の応答を返す操作の形に合わない。POST は `/invite` の画面のフォームから送る `application/x-www-form-urlencoded` の本文（欄 `claim_token`）に秘密を持ち、302 で Google へ移す。fetch で認可の URL を JSON で受ける形にしないのは、Google へ移す開始が2通りになり、ほかのサイトからの防ぎを Origin の検査で作り直すことになるため。Origin の検査は掛けず（ほかのサイトからの移動で呼ばれる）、ログインの CSRF は state の Cookie で止める（「GitHub のログインと取り込み」）。失敗は JSON のエラーではなく `/login?error=<理由>` へのリダイレクトで返す。画面で捕まえていない例外と Promise の拒否を送る `POST /api/client-errors`（`src/server/client-errors.ts`）も例外にする。今の操作の定義はどれもログインが前提で、ログインと招待の画面が壊れて誰も入れない故障を拾えないため。Origin の検査は操作と同じに掛け、セッションは読まない（「本番で壊れたことに気づく」）。メールアドレスとパスワードでログインする `POST /api/auth/password/login`（`src/server/auth/password-login.ts`）も、同じ理由（ログイン前の人が呼ぶ）で例外にする。OAuth の道（`login-routes.ts`）の外に置き、ログインの画面が fetch で JSON を送り、JSON で答える。Origin の検査は操作と同じに掛け、加えて `Sec-Fetch-Site` があれば `same-origin` だけを受ける（「パスワードのログイン」）。ログアウトと「自分」を返す口（`logout`、`me`）は例外にせず、操作の定義で作る（`src/shared/operations/session/`）。
- URL: `POST /api/<slug>/<操作の名前>`。組織の外の操作（ログインだけ、運用者）は `POST /api/<操作の名前>`。読む操作も POST にする。API の応答はどれもキャッシュしないので、GET にしない損は小さく、Origin の検査をすべての操作に同じに掛けられる。入力は JSON の本文だけで、`Content-Type: application/json` を要る。URL は名前から作り、定義に持たせない。名前は英小文字と数字をハイフンでつないだ1語（`task-title` など）で、一覧で重ならない。URL の形は `operationPath()` に1つだけ持ち、画面と登録の関数が同じ値を使う。
- 権限の種類（`permission`）:

  | 権限 | 範囲 | 通る人 |
  | --- | --- | --- |
  | `login` | 組織の外 | ログインしていて、入れる組織がある人（か運用者）。`skipsLoginAccess` を付けた操作は、入れる組織を失った人も通す |
  | `operator` | 組織の外 | シークレット `OPERATOR_LOGIN_IDS` に載った運用者。処理には、運用者のログインの ID（`github:12345` の形。複数のログインを結んだ人は一覧に載っているもの）と、運用者の道具（`operator-tools.ts`。ログインの手段、管理者の状態の読み取り、組織の作成の最初の書き込み）が渡る |
  | `invitee` | 組織の中 | 組織に入れる人すべて。承諾待ちの招待だけを持つ人を含む。招待の一覧、承諾、辞退に使う |
  | `organization` | 組織の中 | `users` の行がある人。無効でない管理者か、いずれかのワークスペースに今所属している人。承諾待ちの招待だけの人は通さない（404） |
  | `member` | ワークスペースの下 | そのワークスペースに今所属している人と、管理者 |
  | `leader` | ワークスペースの下 | そのワークスペースのリーダーと、管理者 |
  | `admin` | 組織の中（`workspace: true` を付ければワークスペースの下） | 管理者 |

  組織の中を読む操作を承諾待ちの招待だけの人に見せないため、`invitee` と `organization` を分ける。`member` と `leader` には `workspace: true` が必須で、入力のスキーマに文字列の `workspace_id` が無いと型で落ちる。管理者は所属していないワークスペースでもリーダーと同じ操作ができるので、`member` と `leader` の操作も通す。運用者であることは組織の中の操作の権限にならない。入れる組織は一般の人と同じ条件で決まる。
  - 権限の種類と範囲は `src/shared/operations/define.ts` の1つの表から、型と実行時の検査を導く。登録のときに、権限の種類が一覧にあること、`member` と `leader` に `workspace: true` が付くこと、組織の外の操作に `workspace` が付かないことを確かめ、合わなければ起動のときに落とす。
  - 閉じたワークスペースは読み取り専用。`write` の操作は、閉じていれば 409 の `workspace_closed` で止まる。開き直す操作のように閉じていても書く操作には、定義に `allowClosed: true` を付ける（ワークスペースの下の `write` だけに付けられる）。権限の検査が先で、権限の無い人には 403 を返す。
- 登録の関数が行う順: 認証（`Authorization: Bearer` があれば API トークンの読み取り、無ければ Origin の検査とセッションの読み取り）、組織の確かめ（組織の中の操作）と運用者や管理者の検査、API トークンの範囲の検査、回数の上限、入力の検証、ワークスペースの確かめとメンバーやリーダーの検査（ワークスペースの下の操作）、処理、出力の検証。ワークスペースの確かめが入力の検証の後になるのは、検証した入力の `workspace_id` から取り出すため。
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
  - Origin: Cookie の呼び出しのすべての操作に掛ける（`Authorization: Bearer` の呼び出しには掛けない。下の「API トークン」）。`wrangler.jsonc` の `vars` の `PUBLIC_ORIGIN`（`scripts/dev.ts` が `pnpm dev` と `pnpm preview` の画面の URL で上書きする。下の「ポート」の決め方でずれた値も）と一致しない、または Origin の無い呼び出しは 403 の `forbidden`。検査は本文を読む前。`curl` で呼ぶときの付け方は `-H "Origin: http://localhost:5173"`。`PUBLIC_ORIGIN` に使えるのは、https と、ループバックのホスト（`localhost`、`127.0.0.1`、`[::1]`）への http だけ。それ以外（本番の設定が http になった、値が無い、解釈できない）は、`OPERATOR_LOGIN_IDS` の検査と同じく app のミドルウェアが、`/api/health` を含むすべてのリクエストを 500 にして、デプロイの煙のテストで見つけさせる。綴りだけで決めると、Cookie の Secure と `__Host-` が黙って外れるため。
  - セッション: Cookie のトークンを SHA-256 にして `sessions` を引く（`src/server/auth/session.ts`）。Cookie の名前は `sessionCookieName(PUBLIC_ORIGIN)`（`src/shared/session-cookie.ts`）で決め、https の公開 URL では `__Host-sg_session`、http の localhost（`pnpm dev`、`pnpm preview`）では `sg_session`。読む側とログインの発行（`src/server/auth/login-routes.ts`）と e2e が同じ関数を使う。無い、形が違う、期限を過ぎた、のどれも 401 の `unauthenticated`。`last_used_at` は前回から1時間以上たったときだけ、読んだ値が変わっていないことを条件に書き直し（並行した呼び出しの片方だけが書く）、`expires_at` を30日後にして、書けたときだけ Cookie を同じ属性で出し直す。書き直しの失敗はログに例外の名前だけを残し、リクエストは続ける。
  - API トークン: `Authorization: Bearer sgp_<43文字>` を付けた呼び出しは、API トークンだけで認証する（`src/server/auth/api-token.ts`、`register.ts` の `execute()` の冒頭）。`Authorization` が `Bearer` ちょうどか、`Bearer ` で始まる（大文字小文字を区別する）ヘッダーがあれば、値が空でも Bearer の呼び出し。それ以外の書き方（`bearer`、`Basic`）は Cookie の呼び出しとして扱い、Origin の検査が掛かる。
    - Origin の検査と Cookie の読み取りを飛ばし、応答には Cookie の延長も消去も付けない。ブラウザは `Authorization` を他のサイトからの要求に勝手に付けず、CSRF は成り立たないため
    - トークンの値の形（`API_TOKEN_PATTERN`）を確かめ、SHA-256 にして `api_tokens` を引く。形が違う、行が無い、期限切れ（`expires_at <= now`）、取消済みは、どれも 401 の `unauthenticated`。有効な Cookie が同じリクエストにあっても Cookie に落とさない
    - 読めたら `last_used_at` を今に書き直す（前の値が今より前のときだけ）。`expires_at` は延ばさない。期限は発行のとき固定で、上限は90日（`API_TOKEN_MAX_LIFETIME_DAYS`）
    - 入れる組織を失った人（`requireLoginAccess()` の判定）は、同じ呼び出し点で `endCredentialsOf()`（`src/server/auth/end-credentials.ts`）により、判定した時刻までに作られたその人のセッションの行を消し、トークンを取り消して（`revoked_at`）、401 にする。2つの文は1回の `batch()` で送る。トークンの呼び出しは Cookie を消さない
    - トークンの呼び出しにセッションは無い。処理に渡す `session` は、使うと例外を投げる（`tokenHash`、`clearCookie()`）ので、セッションを使う操作は `cookieOnly` を付ける
    - 回数の上限のキー `operation:<名>:<accountId>` は Cookie と同じ。同じ人の呼び出しを、認証の種類によらず1つの枠で数える
  - API トークンの範囲: 権限の検査（組織の中の操作は `checkOrganizationPermission()`、組織の外の操作は入れる組織の確かめ）の後、回数の上限と入力の読み取りの前に行う。入力を読む前なので、本文が壊れていても範囲の足りない呼び出しは 400 でなく 403 になる。ワークスペースの確かめも入力を使うので、範囲の検査より後
    - `mode: 'write'` の操作は、`write` のトークンだけが通る。`read` のトークンは 403 の `forbidden`
    - `permission: 'operator'` の操作は、運用者かどうかを引く前に、どのトークンでも 403 の `forbidden`
    - 定義に `cookieOnly: true` を付けた操作も、どのトークンでも 403 の `forbidden`。付けるのは Cookie のセッションの行や Cookie を直に扱う操作と、トークンを増やしたり減らしたりする操作で、今は `logout` と `token-create`、`token-list`、`token-revoke`（`src/shared/operations/session/token.ts`。自分の設定の「API トークン」の節が呼ぶ。トークンで呼べると、盗まれたトークンが自分の後継を作れる）。`token-create` は、有効な（取り消していない、期限前の）行が1アカウントに20件（`API_TOKEN_MAX_ACTIVE`）あると 409 の `conflict`（`details.reason` は `limit`）で断る。数の確かめは `INSERT ... SELECT ... WHERE` の1文に入れ、同時の発行でも超えない（`test/api-token-settings-fixes.test.ts`）。名前の NUL は入力の検証で 400 にする。`skipsLoginAccess` と同じく、組織の外の操作にだけ付けられ、組織の中の操作や `true` 以外の値は、登録のときの検査（`assertOperationDefinition`）で弾く
  - 組織: `src/server/db/enter-organization.ts` が、slug から `organizations` を引き（共通の入口）、その人が入れることと、停止していないことを確かめる（組織の中の入口）。共通の表と組織の中の表は別の問い合わせで、結合しない。`users` はセッションのアカウントの ID と `users.account_id` の一致で引き、無効にされた人は断る。管理者でも所属もない人は、アカウントに結んだログインの手段と ID で承諾待ちの招待に当てる（このときだけ `account_logins` を引く）。ログインの手段と ID が一致する `users` の行が無効なら、アカウントに結ばれる前の行でも断る。招待だけで入った人は `invitedOnly` になり、`invitee` の操作以外は 404 で返す。組織が無い、入れない、のどちらも 404 の `not_found`。停止している組織は、停止していなければ入れた人にだけ 403 の `organization_suspended` を返し、入れない人には 404 の `not_found` を返す（「API のエラーとログ」）。
  - ワークスペース: `workspace_id` を入口の組織で絞り、その人の今の所属と一緒に1つの問い合わせで引く。別の組織のものと存在しないものは 404。引けたものが「確かめたワークスペース」（`VerifiedWorkspace`。閉じているか、その人のロールを持つ）になり、処理に渡す直前に `assertVerifiedWorkspace()` で実行時にも確かめる。
  - 入力: ID の入力は `src/shared/id.ts` の `idSchema`（64字まで）で書き、DB に問い合わせる前に桁違いに長い値を止める。壊れた JSON や形の違う入力は 400 の `invalid_input` で、`details` に項目ごとの `path`、`code`、`message` を入れる。本文は 1MiB までで、`Content-Length` の無い本文も読んだ分を数えて止め、超えれば 413（`code` は `invalid_input`）。未ログインの呼び出しには本文を読ませない。
  - 出力: 戻り値を出力のスキーマで検証し、スキーマに無い項目は落とす。形が合わなければ 500。検証した値（変換を通した出力）をそのまま送り、画面は同じスキーマで検証し直さない。
  - ログ: 「API のエラーとログ」の項目を操作ごとに1行出す。413 を含め、失敗の `code` と `status` も残る。
- 処理が受け取るもの: 検証済みの入力 `input` と、確かめた DB の入口だけ。組織の外の操作は共通の入口 `db` と `accountId` と `account`（入れる組織と届いた招待を組織をまたいで読む `organizations()`、運用者かを返す `isOperator()`、アカウントに結んだログインの手段と ID を返す `logins()`。`src/server/operations/account.ts`）と今のセッション `session`（`tokenHash`。`clearCookie()` を呼ぶと、応答でセッションの Cookie も消す。ログアウトが使う。API トークンの呼び出しでは使えず、使うと例外）、組織の中の操作は組織の中の入口 `db`（組織を確かめないと作れない）と `actor`（`userId`、`isAdmin`、`invitedOnly`。`invitee` の操作では `userId` が null になりうる）と `organization`（入るときに引いた組織の slug、名前、既定のテーマ）と `tools`（組織の道具。下の項目）と `defer`（応答を待たせずに続ける仕事を渡す。`waitUntil` に渡り、`ExecutionContext` が無いテストでは応答の前に待つ。失敗は登録の関数がログに例外の名前だけを残し、応答は変えない）、ワークスペースの下の操作はさらに `workspace`。`read` の操作が副作用として書くもの（`organization` の `last_seen_at`）は、定義の `description` に書き、`defer` で送る。画面の値を読む文と書く文は別の `batch()` にし、書き込みの失敗で画面が開かなくならないようにする。`workspace` の型 `VerifiedWorkspace` は `VerifiedOrganization` と同じ作りで、`src/server/db/` の外では作れない（`test/operations-types.ts` が `@ts-expect-error` で確かめる）。組織の中の入口は問い合わせを絞らないので、処理は自分の文を、入口の `organizationId`（組織の直下の表）か、`workspace.workspaceId`（ワークスペースの下の表）で絞る。入力の ID だけで引かない。
- 組織の道具（`tools`。`src/server/operations/organization-tools.ts`）: 組織の中の処理は共通の入口を持たないので、共通の表とログインの手段に触れる決まった呼び出しだけを、運用者の道具（`operator-tools.ts`）と同じ作りで渡す。登録の関数が、組織に入れると確かめた後に、その組織の入口に結んで作る。どの道具も組織の ID を引数に取らず、組織の行は確かめた組織の ID で、組織の中の表は `organization_id` で絞る。道具は権限ごとに分けずに組織の中のすべての操作に渡し、道具の中で入った人（`actor`）を確かめる。承諾待ちの招待だけの人（`invitedOnly`）の操作からは、自分のログインの読み取り（`myLogins()`）のほかの道具を使えず、組織の設定の書き込みは管理者からだけ使える。当たらない呼び出しは処理の誤りとして投げ、500 になる。持つのは次の6つ。
  - `inviteeResolver(provider)`: 招待する人の解決器（GitHub のユーザー名をユーザー ID に。運用者の道具と同じもの）。解決器を持たない手段と、資格情報が未設定の手段は `undefined`
  - `readOrganization()`: 自分の組織の行のうち、入るときに引かない値（人数の上限 `memberLimit`）
  - `writeOrganizationSettings(change, now)`: 自分の組織の既定のテーマを、組織が停止しておらず、先に読んだ値（`from`）のままなら書く（`suspended_at IS NULL` と `theme IS :読んだ値`。`theme` と `updated_at`）。共通の表だけの `batch()` で送り、書けたら `'written'` を返す。同じ `batch()` の後ろで組織の行を読み直し、行が変わらなければ、入ってから書くまでに停止されていたら `'suspended'`（呼び出し側は 403 の `organization_suspended`）、そうでなければ別の要求が先に変えたとして `'conflict'`（409 の `conflict`）を返す。書く項目が無ければ何も書かず `'written'`。変更の記録（`change_logs`）は組織の中の表なので、処理が `'written'` のときだけ別の `batch()` で書く（`docs/data-model.md` の「書き込みの単位」の組織の設定の変更）。書く道具は、管理者の操作（`permission: 'admin'`）の処理からだけ呼ぶ（管理者でない人の操作から呼ぶと投げる）
  - `endSessionsIfLoginLost(userId)`: ログインできる条件を失った人のセッションを消し、API トークンに `revoked_at` を書く（1回の `batch()`）。組織を離れる、無効にするなどの書き込みの `batch()` が通った後に、`defer` に渡して呼ぶ（失敗しても応答を変えない。消し忘れても、組織に入れるかはリクエストのたびに確かめるので入れない）。自分の組織の `users` の行からアカウントを引き（別の組織の ID、アカウントに結ばれていない行は何もしない）、運用者は残し、判定はセッションの判定（`requireLoginAccess`）と同じ基準（結ばれる前の行を数えない `listAccountOrganizations`）で行う。消すのは判定した時刻までに作られたセッション
  - `avatarsOf(userIds)`: 自分の組織の `users` の ID ごとのアバターの URL。組織の中の表（`users`）でアカウントとログインの手段と ID を引き、共通の表（`account_logins`）を別の問い合わせで引いて合わせる（束縛の上限で区切る）。使うのは `users` の行に結んだアカウントの `account_logins` だけで、アカウントに結ばれる前の行は `null`（手段と ID だけで引くと、管理者が任意の GitHub の人にアカウントがあるかを知れてしまう）。別の組織の ID はキーを持たない
  - `myLogins()`: 呼んだ人のアカウント（`actor.accountId`）に結んだログインの手段、ID、ログイン名（`account_logins`）。届いた招待の一覧、承諾、辞退（#187）が、招待の `(login_provider, login_subject)` との突き合わせと、承諾で作る `users` の名前に使う。共通の入口から、組織の中の表とは別の問い合わせで引き、1回のリクエストで1回だけ引く。この道具だけは、承諾待ちの招待だけの人の操作からも使える
  - 共通の表の文は `src/server/db/organization-common.ts` に置き、確かめた組織の入口（`OrganizationDb`）を受け取る（`myLogins()` の1文は `account_logins` をアカウントの ID で引くだけなので、`organization-tools.ts` に置く）
- 日時: 操作の処理は、今の日時を `src/shared/clock.ts` の `now()` から取る。タイムゾーンでの今日（`todayIn`、`YYYY-MM-DD`）と今月（`monthIn`、`YYYY-MM`）もここで作り、`joined_on` や `effective_month` のようなワークスペースの日付と月はこれで数える。開発用の値での差し替えは、`now()` の1か所に足す。タイムゾーンの検査は `src/shared/timezone.ts` の `normalizeTimezone`（時差の表記を断り、`Intl.DateTimeFormat` で作れる名前を正規の名前にそろえる）で、ワークスペースの作成と設定の画面が同じものを使う。
- 画面からは、`src/lib/api.ts` の `callOperation(定義, 入力, { slug })` で呼ぶ。入力と出力の型は定義から推論し、組織の中の操作は `slug` を要る。結果は `ApiResult` で、応答が JSON でなければ失敗として扱う（出力の形はサーバーが検証済み）。出力のスキーマの変換は JSON にできる値を返すものに限る。
- 組織の分離のテストと権限のテストは、定義の一覧を回して全操作に当てる（`test/operation-registry-production-<番号>.test.ts`。一覧を操作の名前で塊に分けて回す。割り方と塊の数は `test/operations/chunks.ts`、塊が全操作を1回ずつ覆うことは `test/operation-registry.test.ts` が確かめる）。新しい操作を足しても、回すテストを書き足す必要はない。足すのは、組織の中の操作ごとのテスト用の関数だけで、`test/operations/pointers.ts` に操作の名前をキーにして書く。
  - テスト用の関数は、対象の組織（`Target`。組織、管理者、リーダー、一般のメンバー、別のワークスペースのメンバー、承諾待ちの招待だけの人）を受け取り、その組織の行を指す成功する入力を返す。別の組織の対象を渡した入力が 404 になり、自分の組織の対象を渡した入力が成功することを、同じ関数で確かめる（404 が入力の誤りや権限の不足ではないと言えるようにするため）。関数は2つ目の引数に、その入力で呼ぶ人（`Person`。省略は対象の組織の管理者）も受け取る。届いた招待の承諾と辞退のように、呼んだ人に宛てた行を指す操作は、呼ぶ人ごとに入力を作る（権限のテストも、呼ぶ人ごとに関数を呼び直す）。
  - 入力が組織の中の行を指さない操作は、関数の代わりに `{ noReference: <成功する入力> }` を書く。別の組織の slug と権限のテストだけを回す。入力に `_id` で終わる項目がある操作には書けない。
  - 一覧にある組織の中の操作に関数が無いと、一覧に無い操作の関数があると、`noReference` を付けた操作の入力に `_id` で終わる項目があると、テストが落ちる。組織で絞らない処理を同じ検査に通すと落ちることも、別のテストの対象にした。
  - 一覧は Cookie と API トークンの2通りで回す（`defineOperationChecks` の `credential`）。トークンでは、Origin の検査の代わりに、Origin が無くても成功すること、無効なトークンが有効な Cookie があっても 401 になること、`read` のトークンが書き込みの操作で入力を読む前に 403 になること、運用者の操作と `cookieOnly` の操作が 403 になることを確かめ、そのほか（分離と権限）は Cookie と同じ結果を求める。
  - 権限のテストも一覧から回る。Origin の違い、未ログイン（401）、別の組織の人（404）、承諾待ちの招待だけの人（`invitee` 以外は 404）、権限の種類ごとの許可と拒否（一般がリーダーの操作を呼ぶと 403 など）、閉じたワークスペース（書き込みは 409、`allowClosed` の操作は成功）。
- 後で足すアシスタントの道具と MCP の道具も、同じ定義から作る。

### 入口を守る規則

置き場所は `src/server/db/`（人が差分を読む領域。「マージの判定」）。外から import してよいのは入口のモジュール `db/index.ts` だけ。

- 入口は2つ。`commonDb(env)` は共通の8表だけを型に持ち、`orgDb(env, organization)` は組織の中の17表だけを型に持つ。`organization` は `VerifiedOrganization`（組織を確かめた結果）で、private な印を持つクラスなので、同じ形のオブジェクトは型の検査を通らず、値は凍結されて `organizationId` も書き換えられない。`index.ts` が出すのは型だけである。作る関数 `issueVerifiedOrganization()` は `db/verify-organization.ts` のモジュールの関数で、クラスの static にはしていないため、手に入れた値から辿れない。コンストラクターは作る関数だけが持つ札を要求し、値の `constructor` からは作り直せない。`orgDb` は、作る関数が登録したものだけを実行時に受け取る。組織を確かめる処理は `db/enter-organization.ts`（「操作の定義」）
- `orgDb` は組織の絞り込みを付けない。呼び出し側が、自分の文を `organization_id` か、確かめたワークスペース（`VerifiedWorkspace`。作りは `VerifiedOrganization` と同じで、`db/verify-workspace.ts` の外では作れない）の `workspaceId` で絞る。絞り込みに使う組織の ID は、リクエストの入力ではなく、入口の `organizationId`（確かめた組織の ID。読み取り専用）から取る。絞り込みを入口に寄せない。ワークスペースの下の表は、ワークスペースの ID で絞るのが組織の分離の単位になるため。すべての組織の中の操作に、別の組織の ID で 404 になることを確かめるテストを、定義の一覧から回す
- 表の型は `db/tables.ts` の定数（列名、型、NULL を許すか、DEFAULT があるか）から導く。DEFAULT のある列と NULL を許す列は INSERT で省ける。列名は DB と同じスネークケースのままで、`CamelCasePlugin` は使わない。表を足すときは、マイグレーションと同じ PR で定数に足す。組織の中の表を足すときは、解約した組織のデータを消す SQL（`scripts/purge-organization-sql.ts`）にも、外部キーの子から順になる位置に消す文を足す（足し忘れると `test/purge-organization.test.ts` が落ちる）
- 表の型の照合: `test/table-columns.test.ts` が、全マイグレーションを当てた D1 の `sqlite_master` と `PRAGMA table_info` を定数と突き合わせる。表の一覧、列名、型、NOT NULL、DEFAULT の有無、主キーの NOT NULL がずれると落ちる
- 文を作る部分: Kysely は SQL を組み立てるだけに使い（`DummyDriver` と `SqliteQueryCompiler`。D1 の方言のパッケージは入れない）、実行しない。`db.statement((q) => q.selectFrom(...))` の `q` は、その入口の表だけを型に持つので、別の入口の表を引くと型の検査で落ちる。生の SQL（`kysely` の `sql`）は `db/` の中だけで使い、入口は出さない（`/api/health` の `SELECT 1` は `pingDatabase(env)`）。外へ出す生の SQL は、固定の式（値を取るときは型の決まった値を束縛で渡すだけ）にし、`db/` の中に名前を付けて置く。今あるのは `previousStatementChanged`（`changes() > 0`。履歴の INSERT を、同じバッチの直前の UPDATE が行を変えたときだけ入れる。`docs/data-model.md` の「直前の文に結ぶ」）、`jsonList`（一覧を1つの値で渡す）、`uuidv7Sql`（`INSERT ... SELECT` で行ごとの UUIDv7 を SQL の中で作る。時刻は束縛で渡す）だけ
- 文（`Statement`）: private な印を持つので、形だけのオブジェクトや `{ ...statement }` は型の検査を通らない。実行時には、文を作った入口のインスタンスに結び付けて持ち、別の入口（同じ範囲の別の組織の入口、作り直した入口を含む）の文、付け替えた文、形だけのオブジェクトを拒む。文は作った入口のインスタンスで実行する。RETURNING の無い INSERT、UPDATE、DELETE の文は読める行を持たず、`rows` と `first` に渡せない。結果は `changes` で見る
- 送る部分: `db/send.ts` が、組み立てた `CompiledQuery` を D1 の `prepare(sql).bind(...parameters)` にして送る。値は SQL に埋めず束縛する。1件の問い合わせ（`rows`、`first`、`run`）も `batch()` も同じ道を通り、結果の行と `meta.changes` を文ごとに返す。1文の束縛が D1 の上限（100）を超えたら、送る前に文の番号を添えたエラーを投げる（SQL と値はメッセージに入れない）
- `batch()` の形: `db.batch([文, 文, ...])`。入口ごとに、その入口の `statement()` が作った文だけを受け取り、共通の文と組織の中の文を同じ配列に入れると型の検査で落ちる。D1 の `batch()` は全部の文を1つのトランザクションで流すので、途中の文が失敗すると前の文も書かれない。ただし件数 0 の文では戻さない。先に読んだ値で判定した書き込みは、後ろの文にも同じ条件を入れる（前の文が書いた値を見る `WHERE EXISTS (...)` など。`docs/data-model.md` の「書き込みの単位」と「メールアドレスで待つ指名と招待」の 6 と同じ決まり）。文ごとの `changes` を見るのは 409 を返すためで、見つけても書き込みは戻らない
- 置き場所: 組織から DB を選ぶ関数は `db/select-database.ts`（今はどの組織でも同じ DB）、組織をまたいで読む関数は `db/cross-organization.ts`、組織の道具が使う共通の表の文は `db/organization-common.ts`
- 入口の外から D1 の binding や Kysely を直接使うことを、ESLint の規則で禁じる。禁止の定義と例外は `eslint.config.db-entry.js` の1つの規則（`db-entry/guard`）に置く。`no-restricted-imports` などを設定ごとに並べると、後ろの設定が前を置き換えて黙って消えるため、ファイルごとの違いは規則の中で判定する。`src/server/db/` の外で次を使うと落ちる
  - `kysely` の import（静的、`import()`、型の `import('kysely')`、`require`、`export from`）。型は `db/index.ts` から取る
  - `db/` の内部のファイルの import（入口のモジュール `db/index.ts` 以外）。`db/testing.ts` は `test/` からだけ
  - 引数が文字列のリテラルでない `import()`、`createRequire`、`process.getBuiltinModule`。import の検査を抜けられるため
  - D1 の binding: `env.DB`、`env['DB']`、``env[`DB`]``、`{ DB }`、`{ 'DB': d }`、`{ ['DB']: d }` の取り出し、`Reflect.get(env, 'DB')`、`Env['DB']`
  - `D1Database` の型
  - 運用者の履歴の関数 `appendOperatorChangeLog`（import、`export from`、名前空間からの参照、取り出し。取り出しは `{ name }` のほか、D1 の binding と同じく `Reflect.get`、`Reflect.getOwnPropertyDescriptor`、`Object.getOwnPropertyDescriptor` に文字列のリテラルで名前を渡す形（動的な `import()` の結果からも）。この項のほかの運用者の道具だけの関数（`reassignOrganizationAdmin`、`adminStatusesOf`、`organizationUsageOf`）にも同じく効く）。使えるのは運用者の道具 `src/server/operations/operator-tools.ts` だけ。既にある組織の中の `change_logs` に運用者が1行足す口で、組織の中の入口は渡さない。処理には、道具が `operator` の列を埋めて包んだ `appendChangeLog` を渡す。管理者の指名し直しの関数 `reassignOrganizationAdmin`（既にある組織の中の `users` と `change_logs` に、前の指名の削除と指名を1回の `batch()` で書く口。処理には道具が包んだ `reassignAdmin` を渡す）も同じ。組織で絞らずにすべての組織の中の表を数える `adminStatusesOf` と `organizationUsageOf`（運用者の組織の一覧）も、同じく運用者の道具だけが使える
- 規則の例外は、入口を通さない次の2つのテストだけ。`test/apply-migrations.ts`（全マイグレーションを binding に直に当てる）と `test/schema.test.ts`（CHECK や一意を確かめるため、型を外れた生の INSERT を送る）。ほかのテストは入口とファクトリーを通す
- 規則のテスト: `scripts/eslint-db-entry.test.ts` が、`ESLint` クラスに文字列を渡して、禁じる形が `src/server/`、`src/lib/`、`src/routes/`、`src/shared/`、`scripts/`、`e2e/`、`test/` で落ち、`db/` の中、入口のモジュールの import、`test/` からの `db/testing.ts`、例外の2ファイルが通ることを確かめる。解析できない形（`env[key]` など、キーが変数のもの）は規則で止められないので、差分を読む人が見る。プロパティを読む関数で見るのは、`Reflect` と `Object` のメソッドを直に呼ぶ形（`Reflect.get(x, 'DB')` など）だけで、`.call` や `.apply` で呼ぶ形、取り出した `get` で呼ぶ形、カンマ式で呼ぶ形（`(0, Reflect.get)(x, 'DB')`）は止めない（D1 の binding も、運用者の道具だけの関数も同じ）。`db/index.ts` の名前空間を `Object.values`、`Object.entries`、`Object.keys` と添字などで列挙して取り出す形も止めない。これらも差分を読む人が見る
- テスト用の口: `db/testing.ts` が、確かめずに `VerifiedOrganization` を作る `verifiedOrganizationForTest`、表の照合に使う列の定数（`commonTableColumns`、`organizationTableColumns`、`ColumnSpec`）と DB のカタログを読む関数、組み立てた SQL を読む `compiledQueryForTest` を出す。`test/` からだけ import でき、ほかの場所から import すると ESLint が落とす。Worker の束にも入らない
- 型の検査: `test/db-types.ts` が `@ts-expect-error` で、共通の入口から組織の中の表、組織の中の入口から共通の表、`batch()` への混在、形だけの文、書き込みの文の `rows`、確かめた結果を持たない `orgDb` を型の検査で落とす。`pnpm check` が検査する
- `.claude/hooks/file-rules.mjs` の `env.DB` と `D1Database` の判定は、書く時点で止めるつなぎとして残す

### 言葉の辞書

- 辞書は `src/shared/vocabulary.ts` に置く。キーごとにスクラムの言葉の文字列を1つ持つ（`task: 'タスク'`）。引くのは `word(key, params?)` で、画面は `src/lib/vocabulary.svelte.ts` の `t(key, params?)` を通す。
- 語順や記号を含む文は、`{名前}` の置き換えを持つ1項目にする（`pageTitle` の `{page} - {app}`、`apiStatus` など）。`t(key, { 名前: 値 })` で埋め、テンプレートには語順や記号を直に書かない。
- 画面は `t(key)` で文言を出す。直に書かず、言葉づかいを選ぶ口も、組織やワークスペースの値も、`localStorage` の記憶も持たない。列と決まった欄に付けた名前は、辞書を通さず、作るときにスクラムの言葉で決めた値を保存する（`src/shared/workspace.ts` の `defaultColumnNames`、`defaultDetailFieldName`）。DB の `vocabulary` の列は使わず、行を作る文が `scrum` を入れる（`src/server/db/vocabulary-column.ts` の `VOCABULARY_COLUMN_VALUE`）。
- 辞書の型の保証は `src/shared/vocabulary.typecheck.ts` が持つ。文字列でない項目（数、オブジェクト、`{ scope, game, scrum }` の旧形式）が型で落ちることを `@ts-expect-error` で確かめ、落ちなくなると `pnpm check` が落ちる。
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
- テーマのキーと値は `src/shared/theme.ts` と同じにする。`scripts/theme.test.ts` が、`static/theme-init.js` を偽の `localStorage` で動かして確かめる。
- 画面が動き出してからの切り替えとストアは `src/lib/theme.svelte.ts`。本物の値は組織の枠が入れる。組織の操作の結果の `me.theme`（`users.theme`）、なければ `organization.theme`（`organizations.theme`）を `setTheme` に渡すので、`data-theme` と `localStorage` が同じ値になる（`src/lib/organization.svelte.ts`）。組織を切り替えたときも同じで、切り替えた先の値に替わる。

### 架空のデータ

- seed: `design/sample-data.js` を元に、組織を2つ以上入れたデータを作る。ローカルの D1 と e2e に入れる。組織の分離を画面で確かめられるようにするため。
- ファクトリー: 単体と結合のテストは、テストごとにファクトリーの関数で必要な行だけを作る。seed を直してもテストが壊れないようにするため。
- どちらも架空の名前だけを使う。

### API のエラーとログ

- エラーの応答は `{ "error": { "code": "...", "message": "...", "details": ... } }` の自前の形にする。`code` は `src/shared` の列挙で持ち、画面は `code` で分岐して、文言は言葉の辞書から出す。`message` は開発者向けで、画面にそのまま出さない。
- 別の組織の ID を指定されたときは、存在しないときと同じ `not_found` の 404 を返す。
- 入力の誤りは 400 の `invalid_input` で、`details` に zod の検証の結果を項目ごとに入れる。権限が無いのは 403、先に読んだ値で判定した書き込みの競合（`meta.changes` が 0）は 409 にする。
- ログインしていない（セッションが無いか切れた）のは 401 の `unauthenticated`。画面はこれを見てログインの画面へ戻す。パスワードのログインの口（`POST /api/auth/password/login`）が、メールアドレスかパスワードが違うときに返す 401 は `invalid_credentials` で、ログインの画面へ戻す合図ではない（下の「パスワードのログイン」）。権限が無い 403 の `forbidden` とは分ける。Origin が公開する URL と合わないときは 403 の `forbidden`。
- 閉じたワークスペースへの書き込みは、409 の `workspace_closed`（先に読んだ値の競合の `conflict` とは分ける）。
- 招待の作成（`invitation-create`）が断るときは 409 で、理由を `code` で分ける（`member_limit_reached`、`invitee_changed`、`already_member`、`already_invited`）。届いた招待の承諾（`invitation-accept`）が断るときも 409 で、承諾待ちでない（`conflict`）、ワークスペースが閉じている（`workspace_closed`）、もう所属している（`already_member`）を分ける。辞退（`invitation-decline`）の 409 は、承諾待ちでない（`conflict`）だけ。どちらも、無い招待と別の人や別の組織の招待は 404 の `not_found`。招待する人の解決（`invitee-resolve`、`invitation-create`）が当たらないときは、運用者の操作と同じ 400 の `invalid_input` で、`details` の `code` が `github_user_not_found` か `github_not_a_user`。Google の招待でそろえられないメールアドレスも 400 の `invalid_input` で、`code` は `email_invalid`（運用者の Google の指名と同じ）。
- 停止した組織の中の操作は、停止していなければ入れた人（無効でない管理者、今の所属がある人、承諾待ちの招待がある人）に 403 の `organization_suspended` を返す。入れない人（無効にされた人を含む）は、組織が無いときと同じ 404 の `not_found`。判定は `enterOrganization` が行い、停止した組織では入口を渡さず、組織の ID だけを持つ `SuspendedOrganization` を返す（操作のログに組織の ID が付く）。登録の関数は、403 を返す前に `requireLoginAccess()` を通す。ほかに入れる組織も届いた招待も無い人（停止した組織にしか入れない人）は、403 を返し続けてセッションが延びないよう、セッションを消して 401 にする。組織の分離のテスト（`test/operations/harness.ts`）が、組織の中のすべての操作について回す。
- 入れる組織を失った人の 401 の `unauthenticated` は、入れたはずの組織が停止しているだけのとき `details: { "reason": "suspended" }` を付ける（`src/shared/errors.ts` の `UNAUTHENTICATED_SUSPENDED`）。画面が `/login?error=suspended` へ移すのに使う。
- 定義の `rateLimit` を超えた呼び出しは、429 の `rate_limited`。
- 本文が 1MiB を超えたときは、413 で `code` は `invalid_input`。画面のエラーの送信（`POST /api/client-errors`）の上限は 4KiB。パスワードのログイン（`POST /api/auth/password/login`）の上限も 4KiB で、超えたときは 413 でなく 400 の `invalid_input` にする（形の誤りと同じ応答にする）。
- D1 に届かないとき（`/api/health` の疎通）と、運用者の操作と招待の操作が問い合わせる GitHub に届かないとき（上限、障害、クライアントの ID と秘密が未設定）は 503 の `unavailable`。入力の誤りの 400 の `invalid_input` とは分け、人がしばらくしてからやり直せる失敗として扱う。
- 運用者の操作（`src/server/operations/operator.ts`）は、入力の誤りの `details` の `code` で理由を分ける（`slug_format`、`slug_reserved`、`github_user_not_found`、`github_not_a_user`、`github_user_changed`、`email_invalid`（Google のメールアドレスの形が合わない）。定義は `src/shared/operations/operator/create-organization.ts`）。画面はこの `code` で文言を選ぶ。重なる slug は 409 の `conflict`。解約で消す予定日（`purge_on`）が今日（UTC）より前の組織の再開（`organization-resume`）と一時的な停止への切り替え（`organization-suspension-update` の `kind: temporary`）と管理者の指名し直し（`organization-admin-reassign`）は、409 の `purge_due` で断る（先に読んだ値の競合の `conflict` とは分ける）。
- 想定していないエラーは `app.onError` で 500 の `internal` にし、中身は応答に出さずログにだけ出す。
- ログは Workers Logs に JSON の1行で出す。操作ごとの項目は `requestId`（`cf-ray`。無ければ乱数。エラーのログと同じ値）、`operation`、`organizationId`、`userId`（組織の中の `users` の ID）、`accountId`、`credential`（認証に使ったもの。Cookie は `cookie`、API トークンは `token`）、`code`（成功は `ok`）、`status`、`durationMs`。トークンの値もそのハッシュも出さない（`test/api-token-operations.test.ts` が確かめる）。本文、コメント、取り込んだ内容、認証情報（招待の URL の秘密、ID トークン、Google のメールアドレスを含む）は出さない。ログインの開始と戻り先（GET の例外）は、操作ごとのログとは別に、`route: "auth"`、`step`（`start` か `callback`）、`provider`、`outcome`（`ok`、`denied`、`too_many` など）、成功のときの `accountId` を1行出す。OAuth の `code`、`state`、トークン、Cookie の値、クライアントの秘密は出さない（`test/login-security.test.ts` が確かめる）。
- 画面のエラー（`POST /api/client-errors` が受けたもの）は `console.error` で1行出す。項目は `level: "error"`、`source: "client"`、`requestId`、`kind`（`error` か `unhandledrejection`）、`name`（英字40字までに合わなければ `Error`）、`message`（次の順に `…` に伏せてから先頭200字。伏せすぎは許す。1. `スキーム://` から末尾まで（ブラウザは解釈できなかった URL や資格情報の入った URL を引用符で囲まずに入れ、解釈できなかった URL は空白を含みうるため）と、V8 の `Invalid regular expression: /<元の文字列>/<フラグ>: <理由>` の元の文字列（最後の `/<フラグ>: ` まで。ほかのパスを巻き込まないよう、この文言に限る）。2. 引用符 `'`、`"`、`` ` `` の種類ごとに、最初に現れた位置から最後に現れた位置まで（1つだけなら末尾まで）。範囲は置き換える前の文字列で求め、重なりをまとめて、両端の引用符の間を `…` にする。開きと閉じの対で読むと、入れ子の引用符（`JSON.parse` が message に入れる本文）、短縮形の `can't`、画面が切って閉じなくなった引用符で中身が漏れるため。3. 最初の「`: `」か「` in `」の後ろを末尾まで（`Invalid time zone specified: <値>`、`Cannot use '…' in <値>` のように、値を区切りの後ろに引用符なしで入れる文言のため）。4. 英字だけでない語（空白で区切った並びのうち、数字、`@`、`/`、`.`、`-`、`_`、英字でない文字を含むもの。前後の引用符、括弧、`…` などの記号は語に数えず残す）と UUID らしい値。続いた `…` は1つにまとめる。英字だけの語が区切りに当たらない位置に入る文言は、なお漏れうる（`docs/operations.md` の「画面のエラー」））、`location`（`file`、`line`、`column`。`file` は `/_app/` の下のパスで、合わなければ `external`。場所が無ければ `null`）、`route`（画面の `route.id`。`src/shared/route-ids.ts` の一覧に無ければ `null`）、`clientVersion`（画面の版。英数字と `.`、`_`、`-` の64字までに合わなければ `invalid`）、`version`（Worker の版）、`browser`（`family` が `chrome`、`firefox`、`safari`、`edge`、`other`、`major`、`mobile`。`User-Agent` から出し、生の文字列は出さない）だけ。IP、Cookie、URL のクエリ、誰のエラーかは出さない。断った送信（Origin の不一致、回数の上限、大きすぎる、形が合わない）はログを出さない（`test/client-errors.test.ts` が確かめる）。

```json
{"level":"error","source":"client","requestId":"…","kind":"error","name":"TypeError",
 "message":"Cannot read properties of undefined (reading '…')",
 "location":{"file":"/_app/immutable/chunks/abc.js","line":1,"column":2345},
 "route":"/[slug]/w/[id]/plan","clientVersion":"<画面の SHA>","version":"<Worker の SHA>",
 "browser":{"family":"chrome","major":141,"mobile":false}}
```

## 初版の作る順

最初の一本は、運用者が組織を作る → GitHub でログインする → ワークスペースを作る → タスクを1件作って完了する、の一本道にする（2026-10-22 に決めた）。認証、組織の分離、操作の定義、`batch()` での書き込み、画面を一度に通し、CI/CD と本番へのデプロイもこの一本に含める。Issue への分け方は `backlog-add` で決める。目安は次のとおり。

1. 土台: pnpm、SvelteKit の SPA モード、Hono、wrangler の設定、ESLint と Prettier、`CLAUDE.md` の「コマンド」、セキュリティのヘッダー、`/api/health`。Claude の設定とフック（下の「Claude の設定とフック」）は先に入れる
2. CI と CD: `ci-ok`、Workers Builds とデプロイのスクリプト、煙のテスト、`docs/operations.md`
3. 一本道に要る表のマイグレーションと seed。Google で待つための列（`users` と `invitations` の `login_email`、`claim_token_hash`、`claim_expires_at`、空にできる `login_subject`、`oauth_states` の `nonce` と `claim_token_hash`）も最初から入れる。SQLite では後から NOT NULL を外すのに表の作り直しが要るため。入れる表は、一本道が触る表と、その表が外部キーか CHECK で指す表（指される表が欠けると、後で表の作り直しが要るため）。入口より先にするのは、入口のテストが表なしには書けず、マイグレーションは `docs/data-model.md` だけを見て読める差分になるため
4. 入口: Kysely の2つの入口と `batch()` の関数、操作の定義を登録する関数、エラーの形、組織の分離のテストの仕組み。`/api/health` に DB への疎通を足し、デプロイの煙のテストで確かめる。`src/shared/health.ts` の `Health` と `isHealth`、`scripts/deploy.ts` の煙のテストを合わせて直す
5. 運用者の組織の作成、GitHub OAuth とセッション、組織の選択
6. Google のログイン（招待の URL から、メールアドレスで待つ指名と招待を `sub` に結ぶところまで）。5 のログインの手段の型に、2つ目の実装として足す
7. ワークスペースの作成、タスクの作成と完了（完了の記録、経験値、変更の履歴を1回の `batch()` で書く）。経験値は起票、完了、手助けだけ。完了を未完了に戻す操作（`task-reopen`、#240）と手助けの経験値（#274。完了のときに感謝1件につき付け、戻すと打ち消す）は、初版の「ゲームの仕組み」（#65）の子として作り済み。詳細の経験値は、同じ「ゲームの仕組み」で作る

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
- `main` の上のコミット、`main` への直接の push、force push は、PreToolUse のフック（`.claude/hooks/guard-bash.mjs`）でセッションから止める
  - force push は `git push` の `--force` 系と `+` の refspec のほか、`gh api` と curl の `/git/refs/` 以下の更新に `force: true` を付ける形、`gh pr update-branch --rebase`、`gh repo sync --force`、GraphQL の `updatePullRequestBranch` の REBASE も止める（deny）
  - 本文や `force` の値を字面で読めない ref の更新（`--input` のファイル、読めない標準入力、`force=1`）、展開で渡す GraphQL の query、glob を含む curl の書き込みは、止めずに確認を挟む（ask）
  - GraphQL の mutation の名前（`mergePullRequest` など）は、宛先を問わず引数と本文のぜんたいで見る。そのため、コメントの本文に `-f body=` やヒアドキュメントで書くと止まる。`--input <ファイル>` なら通る
- セッションは、`main` にいる作業コピーのファイルを Write と Edit で書き換えられない（`.claude/hooks/guard-files.mjs`）。手元のセッションはワークツリーを切ってから書き、クラウドのセッションは `claude/*` のブランチで書く
- 人の操作は、`.githooks/` の git のフックで止める。`pre-commit`、`pre-merge-commit`、`prepare-commit-msg`、`pre-applypatch` が `main` の上のコミット（マージ、`cherry-pick`、`revert`、`am` も含む）を、`pre-push` がリモートの `main` への push（削除と force push も含む）を拒む。`main` を `pull --ff-only` で進めるのは通す。同じ場所の `post-checkout` は止めるためのものではなく、追加のワークツリーを切ったときに `.dev.vars` を本体へのリンクにし（上の「ワークツリーで作業する」）、番号付きのブランチなら Issue を作業中にする（下の「Issue の状態」）。`pnpm install` の `prepare`（`scripts/git-hooks.ts`）が `core.hooksPath` を `.githooks` にする。設定はワークツリーで共有し、フックは各ワークツリーのブランチにある `.githooks/` が動く。`pnpm install` をしていない clone と、`.githooks/` の無い古いブランチでは効かない。別の `core.hooksPath` が既にあれば上書きせず、警告だけ出す。取り出したブランチの `.githooks/` がそのまま動き、`post-checkout` は checkout と switch の時点で動くので、信頼できない人のブランチは作業コピーに取り出さず、中身は `git diff` か GitHub で読む。どうしても取り出すときは、`git -c core.hooksPath=/dev/null checkout <ブランチ>` のようにフックを切る。`core.hooksPath` の上書き、`--no-verify`（`commit` の `-n` も）、`git commit-tree` で抜けられる踏み線なので、人も同じ決まりで PR を通す。セッションの `--no-verify` と `core.hooksPath` の書き換えには、第一の守りの `guard-bash.mjs` が確認を挟む
- 必須のチェックは設定できない。マージする人かセッションが `ci-ok` の成功を確かめてからマージする
- マージは人が決める。人が押すか、人の指示でセッションが `gh pr merge` を打つ。承認の数は求めず、人のレビューは「人がマージを決める」ことで表す（下の「マージの判定」）
- 本番へデプロイする鍵は GitHub に置かない（下の「CD」）。リポジトリのシークレットは PR のブランチのワークフローからも読め、Environment で `main` だけに絞れないため

### 並行して作業するときの決まり

- マイグレーションを含む PR は同時に1本まで。番号がぶつかるため。Issue に `migration` のラベルを付けて見分ける
- スタック PR は原則使わない。squash merge と相性が悪く、force push が増える
- 2つの Issue を並べる前に、それぞれの「やること」から変えるファイルを比べる。共通の層（権限の検査の `src/server/operations/register.ts`、組織で絞る層の `src/server/db/`、root のレイアウトの `src/routes/+layout.svelte`、言葉の辞書の `src/shared/vocabulary.ts`）を両方が形を変えるなら並べず、先の方のマージを待ってから着手する。操作の一覧に1行ずつ足すだけなら並べてよい（同じ位置に足したコンフリクトは merge で解ける）。`area:` のラベルが違っても共通の層は重なる。#52 と #53 は、両方が `register.ts` と `cross-organization.ts` を別の形に広げ、10ファイルのコンフリクトの解消とレビューのやり直しになった
- 1つのセッションが受け持つ Issue は1つにする（2026-10-29 に2つまでから改めた）。受け持った Issue の PR がマージされるか閉じられたら、次の Issue は新しいセッションで始める。4つを続けて回したセッションは途中で会話が要約された。着手する Issue を選ぶ `sprint-pick` のセッションはプロンプトを出すだけにし、選んだ Issue の作業はそのセッションで始めない。決めたことと申し送りは Issue の本文かコメントに書き、会話だけに残さない
- 着手したら、Issue にブランチ名とセッションの識別をコメントで残す。並べたセッションのどれが受け持っているかを、人が Issue から引けるようにするため。手元のセッションはスクラッチパッドのパス（`.../<セッション ID>/scratchpad`）の `scratchpad` の1つ上の名前を、クラウドのセッションはセッションの URL を書く
- セッション名は、受け持つ Issue と PR の番号から始める（2026-10-29 に決めた）。並べたセッションのどれが何を受け持っているかを、セッションの一覧から読めるようにするため。形は次の3つだけにし、番号の後に題を1つ置く。付けるのは `backlog-refine`（Issue を詰め始める前）、`increment-build`（着手してよいと確かめた後）、`pr-create`（PR の番号が分かった後）で、どれも `rename-session` スキルを呼ぶ。クラウドのセッションは `get_session` を `session_id` を渡さずに呼んで自分の ID と今の名前を取り、名前が違うときだけ `set_session_title` で付ける。手元のセッションは、実行中に名前を変える手段がないため、`/rename <名前>` の行をクリップボードに入れて人が貼る。名前はスクリプト（`.claude/skills/rename-session/rename-line.mjs`）が組み、Issue の題の制御文字を取り除く（題は外の人が書き換えられるため）。番号付きのワークツリーで起動または再開したときは、`SessionStart` のフック（`.claude/hooks/session-title.mjs`）が、ブランチ名の Issue の番号から同じ形で自動で付ける（名前が既にあれば上書きしない）
  - PR の前: `#<Issue の番号> <Issue の題>`（例 `#123 メンバーを招待する`）
  - PR の後: `#<Issue の番号> PR #<PR の番号> <Issue の題>`（例 `#123 PR #456 メンバーを招待する`）
  - 紐づく Issue の無い PR: `PR #<PR の番号> <PR のタイトル>`
- ベースが進んだら `sync-base` で merge して取り込み、通常の push をする（2026-10-30 に決めた）。squash merge なので main の履歴に影響せず、force push の確認と、レビューで読んだコミットの SHA とインラインコメントの位置のずれを無くすため
- force push は使わない。ベースの取り込み、PR の指摘への対応、done-check の修正は通常の push で積む

### ワークツリーで作業する

手元のセッションは、Issue ごとにワークツリーを切って作業する。メインの作業コピーは `main` のまま置き、並行するセッションが同じファイルを書き換え合わないようにする。クラウドのセッションは環境が分かれているので、ワークツリーを切らない。

- 置き場所は `./worktrees/<ブランチ名>`。ワークツリーの名前とブランチ名を同じにする（例 `worktrees/12-org-create` に `12-org-create`）
- 切るときは最新の `main` から作る: `git fetch origin` のあと `git worktree add worktrees/<名前> -b <名前> origin/main`
- `worktrees/` はリポジトリの `.gitignore` で git の管理から外してある
- 依存はワークツリーごとに入れる。ローカルの D1（`.wrangler/state`）もワークツリーごとに分かれるので、seed もそれぞれで当てる。ポートはワークツリーの名前から決まるので、並べて `pnpm dev` を立てても重ならない（下の「手元で動かす」の「ポート」）
- `.dev.vars`（wrangler dev の開発用のシークレット）は git の外なので、`git worktree add` で切ったワークツリーには無い。`.githooks/post-checkout` が、ワークツリーの `.dev.vars` を本体の作業コピーの `.dev.vars` への絶対パスのシンボリックリンクにする（番号の無いブランチでも置く）。秘密の実体は本体の1か所で、本体を直せばすべてのワークツリーに効く（立て直しは要る）。直すのは本体の `.dev.vars` で、ワークツリーで書き換えても本体が変わる
  - `.dev.vars.example` を写すのは、本体の作業コピーで行う。ワークツリーの `.dev.vars` はリンクなので、そこで `cp` やリダイレクトで書くと、本体の本物の値を上書きする。セッションの Bash からの書き込みはフックが止めるので、人が書くときも、本体の作業コピーで先頭に `!` を付けて打つ。エディタによっては、保存でリンクが通常のファイルに置き換わり、本体と分かれる（分かれたファイルは、そのファイルだけを直す。本体と合わせるなら下の `ln -sfn` で張り直す）
  - 本体に `.dev.vars` が無いときは、フックがリンクを置かずに案内を出す（人の作業コピーにファイルを作らないため）。本体で `.dev.vars.example` を写して値を入れたあと、ワークツリーで `ln -s <本体>/.dev.vars .dev.vars` を人が先頭に `!` を付けて打つ。切ってあるワークツリーは、本体に後から作ってもリンクが張られず、このコマンドで張る
  - 本体を移してリンクが切れたら、ワークツリーで `ln -sfn <本体>/.dev.vars .dev.vars` と打って張り直す
  - ワークツリーに `.dev.vars`（壊れたリンクも）が既にあれば触らない。本体の根（`.git` の親で、`.dev.vars.example` があるディレクトリ）を確かめられないときも置かない
  - ワークツリーの `.dev.vars` には本体の値が見える。`grep -R` やグロブ、テストなど、セッションの道具から届きうる（読み取りを止める守りは、Read の拒否とフックが見る範囲だけ）。守りはどちらもパスの名前（`.dev.vars`）で判定するので、リンク先が本体にあっても、ワークツリーの `.dev.vars` を名指しした Read と `cat` は止まる（2026-10-26 に仮の値のリンクで確かめた。このリポジトリの設定ではサンドボックスは使っていない）。vitest の `cloudflareTest` は wrangler を通して `.dev.vars` を読み、`cloudflare:test` の `env` に入れる。読み込み先を変える設定はプラグインに無い。そこで本体の `.dev.vars` に置く値は、開発用の OAuth App の値と seed の ID のような、開発用のものだけにする。本番のシークレットは入れない
  - ワークツリーのポートは名前から導いたオフセットでずれるので、GitHub の OAuth の戻り先のポートが開発用の OAuth App の Redirect URI と、Google の戻り先のポートがクライアントの承認済みのリダイレクト URI と合わず、本物のログインは通らない（下の「開発用のサーバー」の `PUBLIC_ORIGIN` の注意）。本物のログインを確かめるときは、ワークツリーの `.dev-port-offset` に `0` を書いて 5173 と 8787 で立てる（下の「ポート」）。seed のセッションで開く `pnpm dev:open` はずれたままでも使える
  - `OPERATOR_LOGIN_IDS` の決まりは「開発とテストでのログイン」
- vitest（vite 8 の oxc）は、変換するファイルを `include` に含む tsconfig を、ファイルのディレクトリから上の階層へ探す。隣のディレクトリの tsconfig は見ないので、`src/server/tsconfig.json` が `test/` を含んでいても `test/` からは見つからない。リポジトリの中に見つからないとワークツリーの外へ上り、本体の作業コピーの `tsconfig.json` を読む。本体に依存が無ければ、継ぎ先の `$app/tsconfig`（`svelte-kit sync` が作る）が無く `[TSCONFIG_ERROR] Failed to load tsconfig '$app/tsconfig'` で落ち、依存があれば本体の版の設定を黙って読む。`test/tsconfig.json` はそれを止めるために置いてある。テストが読むファイルを新しいトップレベルのディレクトリに置くときは、そのディレクトリにも `test/tsconfig.json` と同じように tsconfig を置く
- PR がマージされたら、`~/.claude/scripts/git-cleanup-merged.sh <名前>` でワークツリーと手元のブランチを消す（`pr-feedback` の後片付け）。人がマージするときも、手元のセッションは PR が閉じるのを待っていて、知らせを受けずに後片付けと、受け持つほかの PR の追従まで続ける。クラウドのセッションは手番を終えると再開できないので、人がマージを知らせる。squash merge では SHA が変わり `git branch -d` が拒むため、PR がマージ済みで head の SHA が手元と一致するときだけ `-D` で消す。スクリプトは dotfiles にあり、無い環境では人が消す

## 手元で動かす

コマンドの一覧は `CLAUDE.md` の「コマンド」にある。

### 開発用のサーバー

`pnpm dev` は、SvelteKit の `vite dev`（画面と HMR）と `wrangler dev`（API）の2つを立てる（`scripts/dev.ts`）。vite が `/api` を `wrangler dev` へ転送するので、画面と API は同じオリジンのままになり、Cookie がそのまま使える。片方が止まると、もう片方も止まる。

- vite は、根の `worktrees/`、`playwright-report/`、`build/` を監視しない（`vite.config.ts` の `server.watch.ignored` に `scripts/dev-watch.ts` の述語を渡す。glob にすると、置き場所のパスの `(` や `[` を記号と読んで外れなくなるため。`test-results/` は vite がはじめから外す）。本体で `pnpm dev` を立てたまま、並べたワークツリーのブランチの切り替えや e2e、`pnpm build` が `.html` を書き換えると、開いている画面が読み直されて白くなるため（#367）
- Worker を vite の中で動かす `@cloudflare/vite-plugin` は使わない。SvelteKit との同居を公式に支持していると確かめられず、2つのプラグインが dev サーバーと build の両方を触るので、片方の更新で壊れやすいため
- `pnpm preview` は、build した `build/` と API を `wrangler dev` だけで配る。本番と同じ配り方（Workers Static Assets、`_headers`、SPA の fallback）を確かめる口で、HMR は効かない
- 開発の URL は2つある。`pnpm dev` は `http://localhost:5173`、`pnpm preview` は `http://localhost:8787`。Origin の検査は、この URL を `PUBLIC_ORIGIN` として `wrangler dev` に渡して行う（`scripts/dev.ts`）。ブラウザが送る Origin と合わない URL（`127.0.0.1` など）で開くと、更新系の API は 403 になる。GitHub の OAuth の戻り先もこの URL から作る（`<画面の URL>/api/auth/github/callback`）ので、開発用の OAuth App の Redirect URI とポートまで合わせる（`docs/operations.md` の「GitHub OAuth App」）。Google の戻り先も同じ（`<画面の URL>/api/auth/google/callback`）で、クライアントの承認済みのリダイレクト URI にこの URL（`pnpm dev` の `http://localhost:5173` と `pnpm preview` の `http://localhost:8787`）を足して合わせる（`docs/operations.md` の「Google の OAuth クライアント」）。運用者が作る招待の URL も `PUBLIC_ORIGIN` から作る（`<PUBLIC_ORIGIN>/invite#<秘密>`）

`pnpm dev` と `pnpm preview` の `wrangler dev` は、API のポートの `/cdn-cgi/handler/scheduled?cron=*+*+*+*+*` を常に開いている（wrangler の既定）。開くと、毎分の定期処理（期限切れの行の掃除）を起こせる。`/__scheduled` は `assets` の `not_found_handling` が先に答えて SPA の画面が返るので使わない。`cron` は `wrangler.jsonc` の `triggers.crons` にある式で、`+` は空白の代わり。表に無い式では例外になる。

### ポート

| もの | 既定 |
| --- | --- |
| vite（`pnpm dev` の画面） | 5173 |
| `wrangler dev`（API、`pnpm preview`） | 8787 |
| wrangler のデバッガー | 9229 |

3つは同じ幅（オフセット）だけずれる。`pnpm dev`、`pnpm preview`、`pnpm e2e`、`pnpm dev:open` は、オフセットを次の順で決める（`scripts/dev-ports.ts`）。

1. 環境変数 `DEV_PORT_OFFSET`（例 `DEV_PORT_OFFSET=10 pnpm dev` で 5183、8797、9239）
2. リポジトリの根の `.dev-port-offset`（git の管理外。中身は整数1つで、前後の空白と改行は除く）
3. 根の親ディレクトリの名前が `worktrees` なら、根の名前から導く。`<番号>-<名前>` は `1 + (番号 - 1) mod 441`（`385-x` は 385、`442-x` は 1）。番号が無い名前と、番号が 0 の名前は、名前の FNV-1a（32 ビット）のハッシュを `1 + (hash mod 441)` に落とす
4. どれでもなければ 0（本体の作業コピーと CI）

- 環境変数もファイルも、0 から 441 の整数だけを受け付ける。空、整数でない、負、442 以上は、黙って別の決め方へ落ちずにエラーで止まる（ファイルの誤りはパスを添える）。上限を 441 にするのは、API の 8787 + n が 9228 までに収まり、オフセット 0 のデバッガーの 9229 と重ならないため
- 名前から導くので、ワークツリーを切ってすぐ、環境変数を付けずに並べて立てられる。番号が違えば重ならない。441 を超える番号と、番号の無い名前は、別のワークツリー（番号付きのものも）と同じオフセットになりうる。そのときは次のポートの衝突で落ちるので、片方の `.dev-port-offset` に空いている値を書く
- 本物の OAuth のログインは、Redirect URI に登録した 5173 と 8787（オフセット 0）でしか通らない。確かめるワークツリーの根に `.dev-port-offset` を作り、`0` を書く（`printf '0\n' > .dev-port-offset`）。ほかに 0 で立てているものがあれば同時には確かめられない。確かめ終えたらファイルを消すと、名前からの導出に戻る
- 環境変数でずらして立てたサーバーに `pnpm dev:open` で入るときは、同じ値を付けて打つ。ファイルと名前から決まった値は、同じワークツリーで打てば同じになるので付けない

vite の転送先も同じ値から作るので、画面は自分のワークツリーの API を呼ぶ。ポートがぶつかったら、勝手に空いたポートへずれずに落ちる（vite の `strictPort`）。ずれた vite が別のワークツリーの API につながると、エラーにならないまま別のブランチの API を叩くため。

ワークツリーを並べて本物のログインを確かめるときの注意: ワークツリーごとに、別のブラウザのプロファイル（Chrome のプロファイル、別のブラウザ、シークレットウィンドウ）で開く。`localhost` の Cookie はポートで分かれず、`sg_session` と `sg_oauth_state` は、ポートの違うワークツリーのあいだで共有される。同じブラウザで開くと、片方のログインがもう片方の Cookie を上書きし、ログインが失敗するか、別のワークツリーのセッションで動いてしまう。

### 版

版はコミットの SHA にする。build のときの環境変数 `APP_VERSION` を、画面には SvelteKit の `kit.version.name` として、API には wrangler の `vars` の上書き（`--var APP_VERSION:<SHA>`）として渡し、`/api/health` の `version` と画面の版を同じ値にする。手元で埋めなければ `dev` になる（`pnpm e2e` は除く。下の「e2e のサーバー」）。本番では Workers Builds が checkout したコミットの `git rev-parse HEAD` を渡す（下の「CD」）。

### e2e のサーバー

この節は、人が自分の端末で e2e を調べるときのもの。Claude のセッションは手元で e2e を走らせず、PR の CI に任せる（「開発の流れ」と「CI の e2e が落ちたとき」）。

`pnpm e2e` は、実行のたびに `pnpm preview` と同じ中身（`pnpm build && node scripts/dev.ts --preview`）で build し直してサーバーを立て、終わると止める（`playwright.config.ts`、`scripts/e2e-server.ts`）。通った結果も落ちた結果も、今のコードで build したサーバーのものにするため（#132）。

- 手元では、その実行だけの版（`e2e-<時刻>`。`APP_VERSION` を渡したときは `<渡した版>-e2e-<時刻>`）で build する。サーバーが立った後、`e2e/global-setup.ts` が `/api/health` の版と比べ、違えば seed を入れずに止まる。止まったときの文言は、前の e2e か `pnpm preview` のサーバーが API のポートで答えていることと、探し方（`lsof -i :<ポート>`）を出す。`/api/health` が10秒答えないときも、同じ案内で止まる。2xx 以外を返したときはステータスと立てたサーバーの出力を見る案内で、版の無い応答（JSON でないものを含む）はこのリポジトリでないサーバーを疑う案内で止まる（`scripts/e2e-server.ts` の `e2eGlobalSetup`）。CI は渡した SHA をそのまま使う（ランナーが毎回新しく、前のサーバーが無い）
- 起動の前に API のポートの `/api/health` に答えるサーバーがあれば、Playwright が `... is already used` で止まる。`pnpm dev` も `pnpm preview` も同じポートの `wrangler dev` を使うので、立てたまま e2e を走らせるときは止めるか、`DEV_PORT_OFFSET` か `.dev-port-offset` でずらす（ワークツリーは名前から導いたオフセットで、本体の作業コピーとは重ならない）
- ほかのワークツリーの e2e と並べて走らせるときは、並べたそれぞれの `--workers` の合計を、CPU のコアの数の半分（Playwright の既定のワーカーの数）までに割る。例: 8 コアで 2 本並べるならそれぞれ `--workers=2`、4 コアで 2 本ならそれぞれ `--workers=1`。既定のまま並べると、ワーカーだけでコアを使い切り、その上でそれぞれの `workerd` と build も動く。#325 の確かめでは、ワーカーを絞らずに並べた 110 件のうち 44 件が待ちの時間切れで落ち、`--workers=1` では全件通った（#364）。目安を超えたときの備えに、手元では `expect` の既定の待ちを延ばしてある（下の「e2e の書き方」）
- 立てたままの `pnpm preview` を使い回すのは、`E2E_REUSE_SERVER=1 pnpm e2e` と明示したときだけ。build し直さないので、そのサーバーを立てた後のコードの変更は映らない。版は実行ごとの値を足さず、渡した `APP_VERSION` か、渡さなければ `dev` と比べる（版を渡さずに立てた `pnpm preview` はそのまま使える）。`pnpm dev` は版が `dev` で比べ方を通るが、`PUBLIC_ORIGIN` が vite の URL なので、更新系の API が Origin の検査で 403 になる。使い回せるのは `pnpm preview` だけ。CI は付けても使い回さない
- サーバーを pnpm のスクリプト（`pnpm preview`）で立てないのは、pnpm がスクリプトを別のプロセスグループで動かすため。Playwright は終わりにサーバーのプロセスグループへ `SIGKILL` を送るので、`wrangler` と `workerd` に届かず、前の実行のサーバーが残りうる。2026-10-26 にクラウドの Linux の環境（pnpm 12.12.0、Playwright 1.64.1）で確かめたところ、pnpm を通したサーバーは pnpm の親が死ぬと止まり残らなかったが、pnpm を通さず別のグループに置いたサーバーは残り続けた。pnpm を通さない今の起動の形では、`scripts/dev.ts`、`wrangler`、`workerd` が Playwright の立てたグループに入り、グループへの `SIGKILL` でも、走っている `pnpm e2e` への `SIGINT`（Ctrl+C）でも、サーバーは残らなかった（同じ日に同じ環境で、プロセスのグループと `/api/health` を見て確かめた）。#132 の手元（残った環境）は確かめていないので、原因はこの推定にとどまり、止める守りの主は上の版の比べ方にある。残ったサーバーには、次の実行の build の途中にも Playwright が当たり、build を待たずに先へ進むので、版の比べ方で止める

### e2e の書き方

- `expect` の既定の待ちは、手元（`CI` の環境変数が無いとき）は 15 秒、CI は Playwright の既定の 5 秒（`playwright.config.ts`）。手元はワークツリーを並べて走らせることがあり、混んだマシンでは手を入れていない待ちの5秒が切れて、自分の変更で落ちたのかを見分けにくくなるため（#364）。テストの上限（既定の 30 秒）は変えない。`timeout` を明示した待ちと、`page.evaluate` の中で時間を切る待ち（`e2e/helpers.ts` の `settledScrollY` の5秒など）は、どちらでも同じ値で待つ。手元では壊れたテストが落ちるまで1つの待ちで最大 15 秒かかり、下の繰り返しの確かめも CI の `e2e-repeat` より甘くなるが、`main` に入る前に止めるのは CI の 5 秒の側にする
- `test` と `expect` は `e2e/fixtures.ts` から import する。`@playwright/test` から `test` を直に import すると `pnpm lint` が止める（`eslint.config.js` の `e2e/**/*.test.ts` の `no-restricted-imports`）。型は `@playwright/test` から import してよい
- `fixtures.ts` の `page` は、テストの後で `page.unrouteAll({ behavior: 'ignoreErrors' })` を待つ。`page.route()` の処理の中で `route.fetch()` を待つテストは、画面が終わりに飛ばした読み直しがテストの後に届くと「route.fetch: Test ended」で落ち、その失敗が同じワーカーで次に走るテストに付く。2026-10-27 に、`e2e/members.test.ts` の route の処理に遅れを入れると必ずこの形で落ち、fixture を入れると落ちないことを確かめた（#318）
- fixture が外すのは、テストの引数の `page` に張った route だけ。`browser.newContext()` で作った context と page、`context.route()` には効かない。そこで `route.fetch()` を使うなら、テストの終わりで自分で `unrouteAll({ behavior: 'ignoreErrors' })` を待つ
- `ignoreErrors` は、テストの後に届いた要求の失敗を黙って捨てる。テストの終わりの読み直しそのものを確かめたいときは、`page.waitForResponse()` で応答を待ってから終える
- 書き込みの後で読み直す（`page.reload()`、別の画面へ移る）ときと、送った要求の数を比べるときは、`waitForLoadState('networkidle')` でなく、その書き込みの応答を待つ。`networkidle` は画面の読み込みの後に飛んだ要求を待たずに返り、画面を先に変えてから送る操作（バックログの並べ替え、親の移動）は、書き終わる前に読み直して元の並びに戻る（#325）。`e2e/helpers.ts` の `waitForResponses(page, path, count)` を操作の前に仕掛け、読み直す前に待つ。並べ替えは前の応答の後に次を送るので、続けて動かしたときは件数で最後の応答を待つ。バックログの読み上げと並びの表示は応答より前に出るので、待つ印にしない。送っていないことを確かめるときは、待つ応答が無いので、読み直した後で数を比べる（その時点で送る作りなら、要求は読み直しより前に出る）
- 操作の応答を差し替えるときは、`e2e/operations.ts` のヘルパーを使い、`page.route()` を直に書かない。URL（`operationPath`）、入力の型、出力の型を操作の定義から導くので、操作の名前や出力の形を変えると、ずれたモックで `pnpm check` が落ちる（#319）
  - `mockOperation` は出力を返し、`rewriteOperation` は本物の出力を書き換えて返し、`failOperation` は `status` と `code`（`ErrorCode`）でエラーを返す
  - 数える、止める、n 回目だけ失敗させるなどの形は、土台の `routeOperation` で書く。処理が受け取る `call` は、`input`、`passThrough()`、`fetch()`、`fulfill()`、`fail()`、`abort()` と、Playwright の `route` を持つ。`route` は、スキーマに合わない本文をわざと返すときの抜け道
  - 組織の中の操作は `{ slug }` を必ず渡し、組織の外の操作には渡さない。どちらも型で止める
  - どれも、張った route だけを外す関数を返す。`page.unroute()` の代わりにそれを呼ぶ。テストの後の後始末は fixture がする。自分で `newPage()` した page では、上のとおりテストの終わりに自分で `unrouteAll({ behavior: 'ignoreErrors' })` を待つ
  - 届いた入力と返す出力は、実行時にも定義のスキーマで確かめる。合わなければ、操作の名前と合わない項目の path を添えてそのテストを落とし、画面には 500 を返す。出力に定義に無い項目があっても落とす（`z.object` が黙って落とし、書き換えで名前を間違えた項目は型の検査を抜けることがあるため）。処理が途中で throw したときと、応答を返さずに終わったときも、操作の名前を添えて落とす。定義に無い項目の判定（`droppedPaths`）は `e2e/operations.test.ts` が確かめる。入力の不一致、throw、応答を返さないときの落ち方は、#319 で一時のテストを走らせて確かめた（テストが落ちることを確かめる形なので、残していない）
- 操作の定義の無い直書きのルート（`/api/auth/google/start` などの GET の例外、`/api/health`、`POST /api/auth/password/login`）は、例外として `page.route()` で書く
- 操作を呼ぶ `page.route()` は、まだ多くのファイルに残っている。順にヘルパーへ置き換え、すべて終えた後に lint で止める（#332）。それまでは書き手と点検で守る
- 画面のアクセシビリティは、`e2e/a11y-screens.test.ts`（主な画面）と `e2e/a11y-open.test.ts`（開いた状態）が axe で確かめる。シャードに散るようファイルを分けた。関数は `e2e/helpers.ts` の `expectNoA11yViolationsInThemes`。検査が空振りしないことは `e2e/a11y-check.test.ts` が壊した HTML で確かめる。直せない違反の除外は `e2e/ui-exclusions.ts` に置く（`docs/design.md` の「アクセシビリティを機械で確かめる」）
- `E2E_DEV_BUILD=1` のとき（CI の `e2e-dev` が付ける。読むのは `scripts/e2e-server.ts` の `isDevBuild`）、サーバーは `NODE_ENV=development pnpm build` で build し、Svelte と SvelteKit の開発時の警告（`binding_property_non_reactive`、`link_option_replaced` など）が画面のコンソールに出る。`vite build --mode development` では警告のコードが入らない（mode は変わるが `NODE_ENV` は production のまま）。`e2e/global-setup.ts` は、build した画面の JS に開発時の警告のコード（`DEV_WARNING_CODE`）が無ければ e2e を始めずに止める。Vite や Svelte の更新で開発時のコードが入らなくなったときと、本番の build のサーバーを `E2E_REUSE_SERVER=1` で使い回したときに、警告が出ないまま全件が通るのを防ぐため。`fixtures.ts` は、テストの間に作られたすべての context（テストの引数の `context`、`browser.newContext()` と `browser.newPage()` で作るもの。`auto` の fixture が、テストの間だけ `browser.newContext` を包む）のコンソールから、1行目が `[svelte]` か `[sveltekit]` で始まる warning を集め（読むのは `scripts/dev-warnings.ts`。本文には `%c` と書式の引数が残る。名前の形では絞らず、形の違う新しい警告も数える）、テストの終わりに、警告の名前、中身（ファイルと行）、画面のパスを並べてテストを落とす。`page` を使わないテストでも効く。集める仕組みが空振りしないことは、`e2e/dev-warnings.test.ts` が開発モードの build でだけ確かめる（警告を出すテストに `test.fail()` を付け、テストの引数の page、`browser.newContext()`、`browser.newPage()` のどれで出しても落ちることを見る。集められなくなると、落ちなかったテストとして落ちる）。入れたときに `main` に残っていた警告は、`scripts/dev-warnings.ts` の `KNOWN_DEV_WARNINGS` に名前と、中身か画面のパスで絞って並べ、数えない（`goto_invalidate_all_deprecated` は今使っている3つの画面だけで #388 が直して外す。`hmr_reload_after_error` は、SvelteKit が app の `error()` でないエラー（SvelteKit の 404 か予期しない例外）で開発時に出すので、存在しないパスを開いて 404 の画面を確かめる `e2e/shell.test.ts` の画面と、画面のエラーの送り手がわざと起こした例外も送ることを確かめる `e2e/client-errors-hooks.test.ts` の、ほかの e2e が開かない経路（`/kumo/me` と、無い組織の `/e2e-client-error`）だけを外したままにし、ほかの画面では予期しない例外の印として数える）。数えずに通した警告は、テストの annotation（`known-dev-warning`）に残す。直した Issue の行を一覧から外し忘れていないかは、annotation に出なくなったことで分かる。新しい警告はこの一覧に足さず、直してからマージする。別に、開発モードの build では判定が働かない警告を、同じファイルの `UNJUDGEABLE_DEV_WARNINGS` に名前だけで並べ、どの画面でも数えない。今は `window_fetch_in_load` だけで、SvelteKit は async のスタックが読めるかを `check_stack_trace` という名前の関数で確かめるが、build（Rolldown）がその名前を消すので、build した画面では「`load` の中の `window.fetch`」でなく「`load` が1つでも走っている間の `window.fetch`」をすべて警告にする。保存の後の `invalidate` の `load` と、次の操作のイベントが送る `callOperation` が重なるだけで時機しだいに出た（#393、#429）。代わりに、`src/lib/load-fetch.test.ts` が、`src/routes` の `+page.ts` と `+layout.ts` の `callOperation` と `getHealth`（別名と名前空間の import も含む）に `load` の `fetch` を渡しているか、`load` の `fetch` でない `fetch` を使っていないかを、書いたコードから確かめる。`load` から呼ぶ `src/lib` の関数の中は追わないので、`load` が import する `src/lib` のモジュール（`api.ts` を除く）は API を読まないことも確かめる（API は `load` のファイルに直に書いて読む）。この一覧に足すのは、判定が build で働かないと確かめ、代わりの確かめを置いたものだけにする。この一覧に当たった警告は annotation に残さない（名前ごと捨てるので、ほとんどのテストに付いて印にならない）。代わりに、SvelteKit か Vite を上げたときに、build した画面の JS で判定が働くようになったか（`window_fetch_in_load` なら `check_stack_trace` の名前が残るか）を見て、働くなら一覧から外す。本番の build ではこれらの警告が出ないので、`watchViolations` と既定の e2e では拾えない（#368 は受け入れで初めて気づいた。#375）。画面のコードを変えたときの確かめは、PR の CI の `e2e-dev` に任せる（セッションは手元で走らせない）。人が手元で調べるときは `E2E_DEV_BUILD=1 pnpm e2e <関わるファイル>`。コンパイル時の警告は `pnpm check` の `svelte-check --fail-on-warnings` が落とす
- ダイアログと引き出しの「開くと中にフォーカスが入り、Esc で閉じ、閉じると開いた要素へ戻る」は、`e2e/helpers.ts` の `expectModalFocus` で確かめ、`toBeFocused` を並べて書かない。Esc 以外（ボタン、外側のクリック、戻る）で閉じた後に戻るのは、同じファイルの `expectFocusReturned` で確かめる。閉じた後は、戻ったうえで2回描画した後も留まることまで確かめる（`<dialog>` は `close()` で開いた要素へ戻し、`close` イベントは後で出すので、その中で別の場所へ移すと一瞬だけ戻って見える）。ヘルパーが空振りしないことは `e2e/modal-focus.test.ts` が壊したダイアログ（`page.setContent`）で確かめる（#335）。そこで落ちるはずの確かめは、落とすつもりの段だけを `timeouts` で短くし、前の段は既定の待ちにする（混んだマシンで前の段が時間切れになり、別の文言で落ちないため。#418）
- 狭い幅（390px）の横のはみ出しと 44px の押せる範囲は、`e2e/layout-narrow.test.ts`（ワークスペースの外の画面）と `e2e/layout-narrow-workspace.test.ts`（ワークスペースの中の画面）が確かめる。関数は `e2e/helpers.ts` の `expectNarrowLayout`（中で `findOverflowViolations` と `findTargetSizeViolations` を呼ぶ）。テーマは `data-theme` を書き換えて当てる。検査が空振りしないことは `e2e/layout-narrow-check.test.ts` が壊した HTML で確かめる。除外は axe と同じ `e2e/ui-exclusions.ts`（`docs/design.md` の「狭い幅と押せる範囲を機械で確かめる」）
- テストは繰り返しに耐えるように書く。seed は e2e の初めに1回だけ入れ直し、テストの後にも、`--repeat-each` の繰り返しの間にも入れ直さない。CI の `e2e-repeat` は、PR で足したか変えたテストのファイルを5回回す。5回分は繰り返しの塊ごとに3つのシャードへ散り（1つのファイルなら 2、2、1 回）、シャードの中では同じ D1 の上で続けて回る（下の「CI」）
  - テストが変えるか消すのは、原則としてそのテストが作った行だけにする。作る行の名前（題、本文、メールアドレスなど一意の制約や探す手がかりになるもの）には `test.info().repeatEachIndex` と `test.info().retry` を混ぜる（`e2e/backlog-move.test.ts` と `e2e/comments.test.ts` が既にそうしている）
  - seed の行を変えるしかないテストは、途中で落ちても戻るよう `try`/`finally` か `afterEach` で元へ戻す。戻せない変更（消す、閉じるなど）は、seed の行でなく自分で作った行に対して行う
  - 自分で作れない行（ログアウトで消すセッションは OAuth、承諾か取り消しで閉じる招待は GitHub の解決を通る）は、seed の行に対して行い、テストの前か後で `e2e/local-d1.ts` の関数で seed の状態へ戻す（#459）。関数は e2e の Worker（`wrangler dev`）の手元のエクスプローラー（`POST http://localhost:<API のポート>/cdn-cgi/local/explorer/api/d1/database/<database_id>/raw`）に文を `batch`（1つのトランザクション）で送り、手元の D1 に直に書く（localhost の `wrangler dev` にしか送らない。値は seed の固定の値だけを埋める。組織の中の表の文は組織かワークスペースで絞り、共通の表の `sessions` には seed の `sessionInserts` の文で seed のセッションの行だけを `INSERT OR IGNORE` で入れる）。`wrangler d1 execute --local` を使わないのは、別プロセスが Worker と同じ SQLite のファイルを開いて取り合い、双方に `SQLITE_BUSY` が出て Worker が 500 を返し、隣のテストが落ちたため（#501）。エクスプローラーは同じ workerd の中で Worker と同じ D1 のオブジェクトに文を順に流すので、取り合わない（`pnpm db:seed` は `wrangler d1 execute --local` のまま。e2e の初めの seed は Worker の起動後に流れるが、その間にテストの並行は無いので取り合いは起きにくい）。送り先のポートは `playwright.config.ts` と同じ `devPorts(process.env).api`。`database_id` は、一覧（`GET .../api/d1/database`）から binding 名 `DB` で引き、決め打ちしない（エクスプローラーは無い ID を渡されると空の D1 を新しく作って成功を返し、戻したつもりで何も戻らない）。引くのはモジュールの中で1回で、引けなかったときは次の呼び出しで引き直す。一覧か `raw` が 2xx でないとき（404 はエクスプローラーが無効か、口が変わった。環境変数 `X_LOCAL_EXPLORER` の既定は有効で、miniflare 5.20261019.2-beta、wrangler 4.152.0 で確かめた）、応答の `success` が true でないとき（SQL のエラーはこの版では HTTP 500 と `success: false` で返る。どちらでも `errors` の `message` を添える）、一覧に `DB` が無いときは、テストを落として止める（この失敗の分岐は `scripts/e2e-local-d1.test.ts` が `fetch` を差し替えて守る。`pnpm test` で走る）。打ち切りは 20 秒。画面と API の振る舞いは本物の操作で確かめ、直に書くのは戻すときだけにする。同じファイルの複製が並べて走ると、戻す前の行に別の複製が当たるので、`--repeat-each` は `--workers=1` で回す
  - パスワードのログイン（`e2e/password-login.test.ts`。`PASSWORD_LOGIN_ENABLED` が偽の間は飛ばす）は、seed のパスワードの人（`seed/passwords.ts`）でログインの画面から入る場面（組織が1つの人は組織の画面へ、2つの人は組織の選択へ）と、違うパスワードで理由が出て欄が残る場面を、本物の API に当てて確かめる。同じメールアドレスと IP の枠（10分に10回、30回）を繰り返しで使い切らないよう、場面ごとに `e2e/local-d1.ts` の `resetPasswordLoginRateLimits` で、手元の D1 のパスワードの枠の行（`password` で始まるキー）だけを消す。ログインの画面は主な画面の機械の検査（a11y と狭い幅）に入っていないので、`e2e/login.test.ts` が、フォームの無い版（初版）を 390px のはみ出し、押せる範囲、axe で、理由（`?error=invite` など長い文言）を出した状態も含めて常に確かめ、`e2e/password-login.test.ts` がフォームを出す版（開いているとき）を同じ検査で確かめる
  - 2回目から必ず落ちるなら、揺れでなくこの決まりに反している。1回目と同じ落ち方が毎回出るかを見て見分ける
  - 足したか変えたテストの繰り返しは、PR の CI の `e2e-repeat` に任せる。セッションは手元で回さない。人が手元で調べるときは `pnpm e2e --workers=1 --repeat-each=5 --retries=0 e2e/<名前>.test.ts` と同じ形で回す（`expect` の既定の待ちだけは手元が 15 秒）。ワーカーを絞らずに繰り返すと負荷だけで落ちる（#364）
- `e2e/task-drawer.test.ts` の「担い手は選んで少し待ってから最後の値だけを送り、断られたら理由を出して前の値に戻す」は、手元の macOS の Chromium では必ず落ち、Linux の CI で確かめる。macOS の Chromium は、閉じた `<select>` で矢印キーを押すと値を変えずに選択肢の一覧を開くので、押した後の「保存しました」が出ず、その待ちで落ちる（素の Playwright で、押した後も値が変わらないことを確かめた。#529）。人が手元で調べるときも、このテストの失敗は macOS の挙動と見て、CI の `e2e` と `e2e-repeat` の結果で判断する。macOS でも通る押し方（`selectOption` など）には、矢印キーで続けて替える操作を確かめられなくなるので替えていない

### バックログの木を 5 万件で測る

`pnpm bench:backlog`（`scripts/backlog-bench.ts`）は、使い捨ての場所（`--persist-to` の一時ディレクトリ）の D1 に全マイグレーションと seed と 5 万件のタスクのワークスペース（現実の形と最悪の形）を入れ、その D1 で `wrangler dev`（API はポート 9700、デバッガーは 9701。デバッガーは常に `--port` + 1。`--port` を上の範囲の中に替えると、そのオフセットのワークツリーと重なりうるので、替える側が空きを選ぶ。既定の 2 つは、ワークツリーが使う範囲（画面 5173〜5614、API 8787〜9228、デバッガー 9229〜9670）の外に固定してあるので、どのオフセットの開発用のサーバーや `pnpm e2e` を立てたままでも重ならない。`scripts/dev-ports.ts` の `BENCH_PORTS`）を立てて、`backlog-tree` を絞らない、担当、検索などの読み方ごとに測る（#165）。手元の開発用の D1 と本番には触らない。`--runs` で回数（既定 10）を替える。`--prepare-only <場所>` は、その場所の D1 に入れて終える（測らず、消さない）ので、遅い文を `wrangler d1 execute DB --local --persist-to <場所> --command "EXPLAIN QUERY PLAN ..."` で見るのに使う。測った数と結論は `docs/data-model.md` の `tasks` の節。木を読む文、索引、絞り込みを変えたら流し直し、数が変わったら書き直す。

### 依存を入れたばかりの作業コピー

`pnpm install` の後（`prepare`）と、`pnpm dev`、`pnpm test`、`pnpm check` の前に、`scripts/prepare.ts` が `svelte-kit sync` と `wrangler types` を走らせ、空の `build/` を作る。`tsconfig.json` は `svelte-kit sync` が作る `$app/tsconfig` を継ぎ、Worker の型は `wrangler types` が作る `worker-configuration.d.ts`（git に入れない）を読み、wrangler の設定の `assets` は `build/` を指す。どれも、`pnpm build` より先に型の検査とテストを通すための準備。

## CLI（sg）

`sg`（`cli/`）は API トークンで操作を呼ぶコマンドラインのクライアント。操作の定義を取り込まず、呼ぶたびに `operation-list` で一覧を取り、その JSON Schema から入力を作る。

- 設定: `sg config set url <URL>` と `sg config set token`（トークンは標準入力から読む。引数では受けない）で接続先を設定する。`config set org|workspace <値>` で既定の組織とワークスペース、`config use <名前>` で既定の接続先、`config show` でトークンを伏せた設定を扱う。`config` も `--profile <名前>` で接続先を選ぶ。保存先は `$XDG_CONFIG_HOME/scrum-guild/config.json`（未設定、空、相対パスなら `~/.config/scrum-guild/config.json`）で、0600 で書く。接続先の名前に `__proto__`、`constructor`、`prototype` は使えない
- 環境変数: `SG_URL`、`SG_TOKEN`、`SG_ORG`、`SG_WORKSPACE`、`SG_PROFILE` が設定に勝ち、`--profile` が `SG_PROFILE` に勝つ。空の値は未設定と同じ。`SG_URL` と `SG_TOKEN` は両方を設定する（片方だけなら使い方の誤り）。別の出どころの URL とトークンを組み合わせて、トークンを意図しない宛先へ送らないため
- URL: `https:` か、ループバック（`localhost`、`127.0.0.1`、`[::1]`）への `http:` だけ。認証情報、問い合わせ（`?`）、断片（`#`）を含む URL は使えない（パスは含めてよく、その下に `/api` を足す）。リダイレクトは追わず、3xx は API のエラーにする。30 秒で応答が無ければ打ち切る
- `sg ops` は一覧を、`sg ops <操作名>` は説明と、入力と出力の JSON Schema を出す。`sg call <操作名> [JSON] [--<項目> <値>]...` は入力を作って呼び、`--org` と `--workspace` で既定を上書きする。`workspace_id` は入力に無いときだけ補う。一覧はトークンで絞るので、読み取りのトークンで書き込みの操作を呼ぶと、無い操作と同じく使い方の誤りになる
- 引数の型: 項目の Schema の `type`、`const`、`enum`、`anyOf`、`oneOf` を辿って決める（null を許す項目は `null` で null、数の `const` だけの分岐は数）。入力が `oneOf` の操作は、どれかの分岐にある項目を受け付ける。数は10進の書き方だけを受け、整数は安全な範囲に限る。boolean や数に変えられない値は、string を許す項目なら文字列のまま送り、許さなければ使い方の誤り。`allOf` と `$ref` は辿らないので、その項目は JSON で渡す。同じ `--<項目>` を2回渡すのも使い方の誤り
- 出力と終了コード: 成功は標準出力に JSON で 0。API のエラーは標準エラーに `{"status", "error"}` で 1（応答の形が不正なときの `invalid_response` も 1）。使い方の誤りは `{"error": {"code": "usage", …}}` で 2。サーバーへ送る前の誤り（壊れた JSON、無い操作、余分な引数、設定が無い、設定ファイルを読めないか書けないか形が違う、ヘッダーに置けない文字を含むトークン、使えない URL）が当たる。つながらないときは `connection_failed` で 3。どの出力にもトークンと設定の中身を出さない

手元のサーバーへ向けるときは、`pnpm db:seed` と `pnpm dev` の後に次を打つ。seed のトークンは `seed/api-tokens.ts` にある。URL は `pnpm dev` が出す画面の URL を使う（ワークツリーではポートがずれる。下の「ポート」）。

```bash
printf '%s\n' 'sgp_dev-seed-admin-write00000000000000000000000' | pnpm -s sg config set token
pnpm -s sg config set url http://localhost:5173
pnpm -s sg config set org aoba
pnpm -s sg ops
```

`pnpm -s` を付けると、pnpm の見出しと失敗時の `ELIFECYCLE` が出ない。出力を `jq` に渡すときは `pnpm -s sg` か `node cli/sg.ts` で呼ぶ。

### MCP（sg mcp）

`sg mcp` は stdio の MCP サーバーで、手元の AI（Claude Code など）に操作を道具として見せる。`--profile`、`--org`、`--workspace` と環境変数、設定ファイルは `sg call` と同じ意味で、同じ順に接続先を決める。`--allow-write` は `sg mcp` だけが受ける（下の「権限」）。操作の定義は取り込まず、`tools/list` のたびに `operation-list` を取るので、サーバーに操作の定義を足すと、MCP のコードを書かずに道具が増える。

- 道具: 名前は操作の `name`、説明は `description`、入力は `input_schema`。`mode` が `read` の操作に `readOnlyHint: true` を、`write` に `false` を付ける。`outputSchema` は付けず、成功の本文は JSON の text で返す。入力の最上位が `oneOf`、`anyOf`、`allOf`（`discriminatedUnion` の操作。例: `invitation-create`）の操作は、Claude API が最上位のこれらを受け付けないので、各分岐の項目の和集合の1つの object に平らにする（`required` は全分岐に共通のものだけ。同名で Schema が分かれる項目は `anyOf` でまとめる。分岐ごとの必須は説明の末尾の「分岐: …」に足す）
- 接続先: 組織とワークスペースは接続先から補い、道具の入力に `org` は足さない。接続先がワークスペースを持つと、ワークスペースの下の操作の `workspace_id` は必須から外れる。入力に渡せばその値を使い、`null` か空文字なら省いたものとして接続先のワークスペースで補う（MCP の経路だけ。`sg call` は変えない）。これらは境界ではない。トークンはアカウントのすべての組織に効き、組織にもワークスペースにも絞れない。道具の引数で組織を切り替えられないだけで、`my-organizations` などの操作は道具として見え、`--workspace` も範囲を絞らない（`workspace_id` を渡せば上書きできる）。組織を確実に分けるにはトークンを分ける（ただし今はトークンを組織に絞れない）
- 権限: 呼び出しは `sg call` と同じ経路（トークン付きの API）で、トークンの持ち主の権限の範囲で動く。道具は、既定では読み取り（`mode` が `read`）の操作だけを `tools/list` に出す。書き込みの道具は、`sg mcp --allow-write` で起動したときだけ出る。既定で出さない書き込みの道具を名指しで呼んでも、一覧に無い操作と同じ使い方の誤りの `isError` の結果になる（書き込みのトークンでも同じ）。`--allow-write` を付けても、読み取りのトークンでは書き込みの道具は出ず、名指しで呼ぶと `isError` の結果になる（読み取り／書き込みの範囲はトークンが決め、`--allow-write` はその範囲の中で出すかを決める）。運用者の操作は出ない。`sg call` と `sg ops` に `--allow-write` を付けると使い方の誤りになる。書き込む道具を実行する前の確認は、クライアント（Claude Code の許可の確認）に任せる
- エラー: API のエラーは `isError: true` の結果に、`sg call` の標準エラーと同じ `{"status", "error"}` の JSON を text で返す（権限が無ければ 403、別の組織の ID は 404）。使い方の誤りとつながらない場合も `isError` の結果にし、サーバーは落とさない。一覧が取れないときの `tools/list` はプロトコルのエラーにする
- 起動: 標準出力は MCP のプロトコル専用で、ほかは書かない。接続先の誤り（設定が無い、`--profile` が無いなど）は標準エラーに `{"error": {"code": "usage", …}}` を出して終了コード 2。標準入力が閉じたら終わり、クライアントが先に消えて標準出力が閉じたときも、スタックトレースを出さず静かに終わる。どの出力にもトークンを含めない
- 環境変数: `SG_URL` と `SG_TOKEN` は、`--profile` を明示しても設定に勝つ（`sg call` と同じ）。Claude Code は起動したシェルの環境変数を道具のサーバーに引き継ぐので、読み取りだけで使うなら、`SG_URL` と `SG_TOKEN` を `export` したまま Claude Code を起動しない（書き込みのトークンが `--profile` の読み取りのトークンに勝つ）

Claude Code への登録は、`main` の作業コピーの絶対パスで CLI を直に指すのを勧める（`pnpm` を挟むと、起動したディレクトリの `package.json` のスクリプトが動き、`pnpm` の出力が標準出力に混ざる余地も残る）。

```bash
claude mcp add scrum-guild -- node <main の作業コピーの絶対パス>/cli/sg.ts mcp
```

このリポジトリの作業コピーの中だけで試すなら、`claude mcp add scrum-guild -- pnpm -s sg mcp` でもよい（`pnpm -s` は、`package.json` のあるディレクトリで動くため）。

- 組織ごとに登録を分ける。別の組織は別の名前で、`--org` を付けて登録する: `claude mcp add scrum-guild-aoba -- node <main の作業コピーの絶対パス>/cli/sg.ts mcp --org aoba`。組織ごとに別のトークンを使うなら、`sg config set` で接続先（`--profile`）を作り、`-- node <main の作業コピーの絶対パス>/cli/sg.ts mcp --profile <名前>` と登録する
- 普段は `--allow-write` を付けずに登録し（読み取りの道具だけ）、読み取りのトークンの接続先を使う。書き込みが要るときだけ、書き込みのトークンの接続先に `--allow-write` を付けた登録を足す: `claude mcp add scrum-guild-write -- node <main の作業コピーの絶対パス>/cli/sg.ts mcp --profile <書き込みの接続先> --allow-write`。書き込みの道具が出るのは、`--allow-write` と書き込みのトークンの両方が揃ったときだけ。使い終えたら `claude mcp remove scrum-guild-write` で外す（残すと読み取りの登録と同時に有効のまま）。`--allow-write` は道具の見せ方を決めるだけで、境界ではない（Bash が使える AI は `sg call` で直に書き込める）。書き込みを確実に防ぐのは、読み取りのトークンだけ
- 書き込みの道具（`mcp__scrum-guild__*` のうち書き込むもの）を、Claude Code の許可（`permissions.allow`）に常には入れない。取り込んだ内容や他人が書いたタスクの本文は信頼できない入力で、AI が読むと、本文の指示に従って書き込みの道具を呼びかねない。呼ぶたびに人が確かめる
- どの作業コピーからでも動かすときは、`pnpm -s sg` の代わりに `node <作業コピーの絶対パス>/cli/sg.ts mcp` と登録する。決まった版の CLI（`main` の作業コピーの絶対パス）にしておくことを勧める。作業ブランチのワークツリーを指すと、その作業中のコードが道具の実体になり、ブランチを消すと動かなくなる
- 登録の後、Claude Code の `/mcp` で道具の一覧を見られる。読み取りを1つ頼んで確かめ、書き込みは `--allow-write` を付けた登録で1つ頼んで確かめる

## AI 開発の分担

人が決め、AI が作り、別の AI が点検する。マージするかは、パスの規則と人が決める。

| 工程 | 担い手 | 道具 |
| --- | --- | --- |
| 何を作るか、仕様の判断 | 人 | `backlog-refine` で詰め、`docs/` と Issue の「人が決めたこと」に書く |
| Issue と完了条件 | AI が書き、人が確かめる。人の答えは「人が決めたこと」に言い換えずに写し、AI が調べて決めたことと置いた前提は「セッションが置いた前提」に根拠と一緒に分けて書く。今回やらないことは「やらないこと」に書く | `backlog-add`、`increment-build` |
| 実装とテスト | AI（手元のセッションはワークツリー、クラウドのセッションはそのままの環境。受け持つ Issue の数は「並行して作業するときの決まり」）。守る仕組み、認証、Workers のランタイムに触れる Issue は、テストの書き手、実装の書き手、崩す書き手を別のエージェントにする（下の「開発の流れ」）。実装の書き手は、手元で Codex が使えれば Codex の `implementer`、使えなければ（クラウドのセッションは常に）Claude の `implementer`（Sonnet）で、Codex が利用上限に当たったら Claude の `implementer` が続きを実装する。ただし、Codex を使わず、書き手を分ける対象でもない小さな Issue は、メインのセッションが直接実装する（引き継ぎの読み直しが実装より重いため。2026-10-31 に決めた。条件は `increment-build` の手順 5 の「直接実装する条件」）。テストの書き手と崩す書き手は汎用のサブエージェント | `CLAUDE.md`、`AGENTS.md`、リポジトリのスキル |
| 点検 | 実装したのとは別のエージェント | `done-check`、CI の AI レビュー |
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
| `permissions.allow` | GitHub の MCP の読むだけのツール。決め方は表の下の「allow に入れるもの」 |
| `permissions.deny` | `.dev.vars`、`.env` とその環境ごとのファイル（`.local`、`.production` など）の読み取り、`.dev.vars` と `.env` の書き込み、wrangler の資格情報のディレクトリの読み取り |
| `env` | `WRANGLER_SEND_METRICS=false`（テレメトリを送らない） |
| `guard-bash.mjs` と `bash-rules.mjs`（PreToolUse、Bash と Monitor） | 止める: wrangler の本番に触る操作（許すのは `dev`、`types`、`whoami`、版と help、`--local` か `--local=true` を付けた D1、R2、KV の操作だけ。`--no-local` で始まる語、`--local=<true 以外>`、`--local false` で打ち消したものは、`--local` があっても止める。`--` の後ろの語はフラグに数えず、リダイレクトは語の並びの外（区切りの `redirects`）で読むので引数にも数えない（`--local >/dev/null false` は `--local false`）。`--` より前の語は、`--command` などの値を取るフラグの値も含めて展開を見る。引用符の外の変数、`$(…)`、`{a,b}`、glob、zsh の語の後ろの `(`（`(KV|--no-local)`、`x(N)`、`--(remote|x)`、リダイレクトの後ろの括弧。中身の無い `()` は関数の定義なので除く）を含む語と、語の先頭か `=` の後ろの `~名前`（zsh の `hash -d`、bash の `~-`。`~` だけと `~/` は除く）を含む語と、引用符の中の変数のうち1語のまま展開すると決まっている形（`$NAME`、`${NAME}`、`${NAME:-語}`、`${#NAME}`、`$1`、`$?`）以外（`"$@"`、`"${a[@]}"`、zsh の `"${(f)x}"`、`"$=x"`、`"$x[@]"`）を含む語は、`--binding=$X` のような `=` の形も止める。引用符の中の展開は、先頭が展開の語（`"$X"`、`"$(mktemp)"`）と、`-` で始まり展開を含む語（`"--re$X"`）を止める。展開した結果が `-` で始まると、wrangler は値を取るフラグの次の語でもフラグとして読むため。`--local` の次の語は、展開した結果が `false` になりうるとき（`"fal$X"`）も打ち消しとして止める。値を取るフラグの `=` の形で `=` の右だけに引用符の中の展開がある語（`--file="$(mktemp)"`、`--persist-to="$DIR"`）と、先頭が展開でない語（`"attachments/$K"`、`'{"a":1}'`、`"a b?.png"`）と、文字としての `$`（`'$a.txt'`、`\$a.txt`）は通す。名前に空白、改行、`.` を含むフラグ（`--local.x=1`、引用符の中で改行した `--remote`）は、wrangler がどう読むかを判定できないので止める）、`--remote` と、`=` より前に `r` を含む短いフラグ（`-r`、`-lr`、`-rl`）と、別名の長い形 `--r`（`wrangler dev` の `-r` は `--remote` の別名）とリモートの binding、本番のログ（`tail`）、別名の道具（wrangler 4.152.0 の `bin` は `wrangler`、`wrangler2`、`cf-wrangler` の3つで、2026-10-26 に確かめた。`wrangler2` は wrangler と同じ規則で見る。`cf-wrangler` は `dev` と `build` だけを持ち、引数の読み方が wrangler と違い（`util.parseArgs`）、`dev` は本番の資源に向きうるので、`dev` と `build` も引数を読まずに止める。`node_modules/wrangler/bin/cf-wrangler.js` のパスも同じ）、zsh の数値の glob（`<->`、`<1-10>`、語の途中の `x<1-10>`。リダイレクトではなく展開の印の付いた語として読むので、続く `--remote` を `>--remote` の宛先として隠せない）、`xargs` の後ろの wrangler（別名を含む。`xargs wrangler` のように引数が無くても止める。標準入力から `--remote` が足されうるため）、`WORKERS_CI` の設定（値は問わない。道具の前の代入、`env`、`cross-env`、`pnpm exec` などの経由先の前置き、`export`、`declare`、`typeset`、`readonly`、`local`、単独の代入、`+=` の形、引数を実行しない道具（`echo`、`grep`、`git`、`gh` など）以外の引数のどこかにある `WORKERS_CI=…`（`npx dotenv -v WORKERS_CI=1 -- node …`）。`WORKERS_CI_COMMIT_SHA` など別の名前、引数を実行しない道具の引数、ヒアドキュメントの本文は見ない）、デプロイのスクリプト（実行の道具（`node`、`nodejs`、`tsx`、`ts-node`、`bun`、`deno`）と、スクリプトを読む道具（シェル（`bash`、`sh`、`zsh`、`dash`、`ksh`、`mksh`、`csh`、`tcsh`、`fish`）、`source`、`.`）の位置引数を全部見る。`npx` とパッケージマネージャーを前に付けた形は、経由先のコマンドを前置き（`env`、`cross-env`、代入、`timeout`）ごと同じ規則で見る。パッケージマネージャーの読み方は表の下の「パッケージマネージャーの読み取り」。実行の道具は、`--import=` のような `--flag=値` の右側、`-e` と `-p` の値、`<` の読み込み元、ヒアドキュメントとヒアストリングの本文も、空白、引用符、括弧で区切った語ごとに見る。書かれた語は小文字にして見る。パスの形の語（`/` を含むか `.拡張子` で終わる）は、作業場所から解決した絶対パスも見るので、`scripts//`、`scripts/./`、`cd scripts &&`、大文字小文字の違いも止まる。`*`、`?`、`[`、`{`、extglob（`!(`、`+(`、`@(`）を含む語（`*` と `**` だけの語は除く）は、`scripts/deploy.ts` と `scripts/deploy-production.ts` に当たるかを見る。括弧で区切る前の語も見る。解決した glob を、作業場所から見つかる根（`scripts/deploy-production.ts` のあるディレクトリ）と、glob の固定の部分から見つかる根（別のチェックアウトや絶対パスの先）の 2 つの入口だけに照合する。`worktrees/*/scripts/*.ts` のように、変数の区間の後ろが `scripts/` で入口の名前に当たる glob も止める。どちらの根も見つからないときは、書かれた形と解決した形の固定の部分とその祖先に入口を付けて照合する。展開が 256 を超える語（`{1..1000}`、`{a,b}` を何個も並べた形）は、照合せずに確認を挟み、それ以下の `{1..3}` は展開して照合する。最初に止める語が見つかった時点で打ち切る。`env -C` と `env --chdir`（省略形の `--c`、`--ch=<dir>` も）も作業場所として解決し直す。`--test-name-pattern` と `--test-skip-pattern` の値は見ない。テストの `scripts/deploy*.test.ts` は、変数や記号を含まないパスで書いたときだけ除く）と名前に `deploy` を含む `package.json` のスクリプト、`main` の上でコミットを作る操作（`commit`、`merge`、`pull`、`cherry-pick`、`revert`、`am`。オプションが `--ff-only`、`--abort`、`--quit` だけなら通す）、`main` への push、force push（`--force`、`-f`、`+` で始まる refspec、`--mirror`、`--force-with-lease`、`--force-if-includes`。一意な省略形と、`-4f` のようにまとめた短いフラグも止め、`-o` の値は force に数えない。行き先を判定できないときの確認より先に拒む）、`git push` 以外で ref を force で動かす道（`gh api` と `curl` の ref の更新への `force=true` と本文の `"force": true`、`gh pr update-branch --rebase`、`gh repo sync --force`、`gh api graphql` の `updatePullRequestBranch` の `REBASE`）。ref の更新の本文は、字面で読めて force が無いか false なら通し、読めなければ確認を挟む（ファイル、別の道具の出力、グループの中の標準入力、変数や展開、`curl` の URL の glob）。GraphQL の query を展開で渡す形も確認を挟む。止めないのは、設定で渡す道（`git -c remote.*.push`、`git -c alias.*`）、`git-push` の直呼び、`git send-pack`、httpie、wget の本文、JSON のエスケープ。`gh pr merge` を通さない PR のマージと、`--match-head-commit` の無いか `--auto`、`--admin` を付けた `gh pr merge`（`gh api` と `curl` の merge、`gh stack merge`、`gh alias set` と `gh alias import`、main の ref の書き換え、contents API の書き込み）、シークレットとログイン、`.dev.vars` と `.env` の中身を読むか送るコマンドと `git add`、引数を実行しない道具（`echo`、`printf`、`cat`、`grep`、`rg`、`git`、`gh`、`cp`、`rm`、`touch`、パスを扱うだけの `readlink`、`realpath`、`basename`、`dirname`、条件式の `test`、`[`、`[[` など）と `find` 以外の道具の引数のどこかにある `.dev.vars` と `.env` の名前（表に無い道具の読み書きを列挙しきれないため。`sqlite3 x.db '.output .dev.vars'`、`expect -c 'spawn cat .dev.vars'`、`docker run --env-file .env x`、`ksh -c 'echo x > .dev.vars'`、`osascript -e 'do shell script "…"'` も止まる。`pnpm test -- --grep .env` のような止めすぎは人に任せる。引数を実行しない道具は、読み取り、書き込み、検索の道具ごとの判定で見るので、`git commit -m 'docs: .dev.vars の説明'`、`echo .dev.vars`、`readlink .dev.vars` は通す。`find` は探すだけの形（`find . -name .dev.vars`）を通し、`-exec` などと下の書き込み先で見る）、`xargs` のあるコマンドで、どこかの語が `.dev.vars` か `.env` の名前に当たるもの（`echo .dev.vars | xargs cat`、`xargs --arg-file=.dev.vars cat`。標準入力に流す名前は xargs の後ろの道具から見えないため）、`.dev.vars` と `.env` への書き込み（大文字小文字は区別しない（macOS のファイルシステムが区別しないため）。リダイレクトの先（`>`、`>>`、`>|`、`&>`、zsh の `>!`、`>>!`、`&>!`。道具の無い `> .dev.vars`、`exec > .dev.vars`、`cd` と `pushd` に付けたものも含む。先は引数の位置と同じに `\`、`$'…'`、引用符を解いて見るので、`> .dev\.vars` と `> $'\x2edev.vars'` も止まる。引用符の中の `>` で始まる語（`rg ">.dev.vars" docs`）は引数でリダイレクトではない。先の中の `$(…)` と `` `…` ``（二重引用符の中も）は別の区切りとして判定し、中身の文字列も、そのまま、空白や引用符で区切った語ごと、引用符を解いた語ごとに先と同じ表に掛ける（`> $(echo .dev.vars)`、`> "$(echo .en'v')"` は止め、`> "$(mktemp)"` は通す）。読み込み元（`< "$(echo .env)"`）とヒアストリングの本文（`python3 <<< "$(echo 'open(".env")')"`）の置換の中身も同じに見る。`<>` は読み書きで開くので、読み込み元と書き込み先の両方に数える。置換に文字が続く先（`> $(echo .claude/settings).json`、`> $(echo .githoo)ks/pre-commit`、`< $(echo .dev).vars`、`> ${X:-.dev}.vars`）は、先の実行時に決まる位置を中身の語（と `${X:-既定値}` の既定値）で埋めた文字列も同じ名前に照合する。固定の文字を持たない先（`> "$(mktemp)"`）と、埋めても名前にならない先（`> "$(mktemp -d)/out.log"`、`> /tmp/$(date +%s).log`）は通す。zsh の `>>&|` と `&>>|` も `>` の仲間で、末尾の `|` をパイプとして切らない。ヒアドキュメントは、終わりの印を引数の位置と同じに読む（`<<\EOF`、`<<E\OF`、`<<$'EOF'`、`<<'EOF'`、`<<"EOF"`）。印に引用符か `\` が1つでもあれば、本文は展開されない文字として読む。無ければ、シェルが本文の `$(…)`、`` `…` ``、`${X:-$(…)}` の置換を実行するので、中身を別の区切りとして判定する（`cat <<EOF` の本文の `$(wrangler deploy)`）。終わりの印の行が見つからないものは、後ろのコマンドを全部本文として読むので、確認を挟む。算術（`$((1 << 2))`、`(( x < 3 ))`、`for (( … ))`）の `<<` と `<` はヒアドキュメントとリダイレクトに読まず、中の置換だけを判定する）、`tee`、`truncate`、`rm`、`unlink`、`shred`、`srm`、`sponge`、`ed`、`ex`、`patch`、`touch` の引数（`touch` の `-r`、`-d`、`-t`、`--reference`、`--date` の値は時刻の元なので見ない。`touch -r .claude/hooks/x docs/new.md` は通す）、`cp`、`mv`、`ln`、`rsync`、`install`、`scp`、`ditto` の引数（`install x .dev.vars -m 600` のように宛先が最後でない形も止める）、`dd` の `of=`、`sed -i`、`perl -i`、`find` の `-delete` と `-exec`、`-execdir`、`-ok`、`-okdir`、`git` の `--output=` と `--output`（値が次の語）、`git archive` の `-o` と `git format-patch` の `-o`、`--output-directory` の値、`tar` の作る、足す、更新する、つなぐ、消すとき（`c`、`r`、`u`、`A`、`--delete`。動作を判定できないときも）の `-f` の値（一覧の `-t` と展開の `-x` では読む元なので見ない。`-cf x` のようにまとめた形、`--file x`、`--file=x`、ダッシュの無い古い形は `f` の位置を問わず次の語（`tar cf x`、`tar cvfz x.tgz y`）も）と、展開するとき（`x`、`--extract`、`--get`。動作を判定できないときも）の `-C` の値（`-C x`、`-Cx`、`--directory x`、`--directory=x`。`tar -xf /tmp/x.tar -C .claude/hooks`）、`find` の `-fprint`、`-fprint0`、`-fprintf`、`-fls` の値、`g` を前に付けた Homebrew の GNU coreutils、grep、gawk、gsed（`gcp`、`gmv`、`gln`、`ginstall`、`grm`、`gsed`、`gdd`、`gtee`、`gtruncate`、`gshred`、`gtouch`。読み取りの `gcat`、`ghead`、`gtail`、`ggrep`、`gegrep`、`gfgrep`、`gawk`、`gsort`、`guniq`、`gwc`、`gcut`、`gtr`、`god`、`gbase64`、`gtar`、`gfind`、`gpatch`、`gunlink` と、引数を実行しない `greadlink`、`grealpath`、`gbasename`、`gdirname`、`gls`、`gstat`、`gecho`、`gprintf` も、`g` を外した名前で同じ表を引く。引数を実行しない道具の表は、シークレットの名前、後ろの wrangler、`WORKERS_CI` の判定のどれでも `g` を外して引く（`gls node_modules/.bin/wrangler docs`、`gecho WORKERS_CI=1` は通す）。外すのはこの名前の表にあるものだけで、`git` や `gh` は崩さない）、インタープリタ（`node`、`python`、`python3`、`ruby`、`perl`、`deno`、`bun`、`osascript`、`php`、`tclsh`）。コピーの元の読み取りも、`cp`、`mv`、`ln`、`rsync`、`install`、`scp`、`ditto` で見る。リンクか本物かを区別せず、`cp .dev.vars.example .dev.vars` も止める。`.dev.vars.example` への書き込み、検索だけの `find`、中身を変えない `chmod`、ワークツリーごと消す `rm -rf worktrees/<名前>` は通す。変数、`$(…)`、glob で組んだ名前は見えない）。確認を挟む: `gh pr merge`、`git clean` の `-x` と `-X`（`-fdx` のようにまとめた形も。作業場所を問わない。本体の作業コピーではワークツリーのリンクの先の `.dev.vars`（本体の本物）を、ワークツリーではそのリンクを消すため。`!` で始まる `-e` と `--exclude` の値（ignore を打ち消す。`-e '!*'`）も同じ。試し実行（`-n`、`--dry-run`）なら通すが、後ろの `--no-dry-run` で打ち消せば確認を挟む。`-e` のほかの値と、`--` と `--end-of-options` の後ろのパスは数えない）、依存の追加、削除、更新、マイグレーションの作成、パッケージマネージャーのコマンドのうち、スクリプトを走らせる場所かその package.json を判定できないもの、npm が知らない名前、名前が展開で決まるもの、表に無いフラグの読み方が 8 通りを超えるもの、読めない短いフラグのまとめ（表の下の「パッケージマネージャーの読み取り」）、`gh stack` の push 系、`env` の `-S`（`--split-string`、`-S"…"`、`-iS` のようにまとめた形も。GNU の env は長いオプションを一意な省略形でも受け付けるので、`--s`、`--sp=x` も。`env -S` の分け方はシェルと違うので、中身は読まずに確認を挟む）、`xargs` の後ろの読むだけの道具（`grep`、`egrep`、`fgrep`、`wc`、`ls`、`cat`、`head`、`tail`、`stat`）以外（`node`、`sh`、`git`、`gh`、`rm`、`pnpm`、`sed`、`rg`、`ag`、`file` など。標準入力から引数が足されるので、何を実行するかを判定できない。`rg` は `--pre`、`ag` は `--pager`、`file` は `-C` で、足された引数からコマンドを実行や書き込みをする。読むだけの道具は `xargs` を外したときと同じ判定で通す。`-a`、`--arg-file`（`-afile` や `--arg-file=file` の連結の形も）で引数をファイルから足すときは、読むだけの道具でも確認を挟む。`xargs` の値を取るフラグ（`-a`、`--arg-file`、`--delimiter`、`--process-slot-var`、BSD の `-J`、`-R`、`-S`。長いオプションの省略形も）は値ごと飛ばして道具の名前を探す。`-p` は `xargs` では値を取らない確認のフラグなので飛ばさない（`npx -p` と `sudo -p` は値を取る）。読むだけの道具は、パスの付かない名前（`cat`）に限る（`./cat`、`/tmp/cat` は確認を挟む）。読むだけの道具以外の後ろに wrangler の語があれば止める。Homebrew の GNU 版の `gxargs` と `genv` も `xargs` と `env` と同じに見る）、`wrangler dev` の `-c`、`--config`（`-c=…`、`--config=…`、別名の長い形 `--c`、`-lc` のようにまとめた形も。値は問わない。作業場所の中に Write で置いた設定も渡せるため。`wrangler d1 migrations apply DB --local --config …` のように `dev` 以外は通す）、Bash からの wrangler の設定（`wrangler.json`、`wrangler.jsonc`、`wrangler.toml`）と `.wrangler/deploy/config.json` の書き換え（リダイレクトの先、`sed -i`、`cp` の宛先など、書き込みの道具は下の `.claude/hooks/` と同じ表で見る。書き込み先は `.wrangler//deploy/./config.json` のように正規化して比べ、作業場所が分かるときは作業場所から解決した絶対パスでも比べる（`cd .wrangler/deploy && echo x > config.json`）。コピーの宛先がディレクトリ（末尾が `/`、`.`、`..`、実在するディレクトリ）のときは、元の名前を付けて見る（`cp /tmp/wrangler.jsonc .`。`cp`、`mv`、`ln`、`rsync`、`install`、`scp`、`ditto` の wrangler の設定と、下の `.claude/hooks/` などの守る先の判定）。絶対パスの宛先は、作業場所が分かり、その根（`scripts/deploy-production.ts` のあるディレクトリ）の中のときだけ見るので、`cp wrangler.jsonc /tmp/` は通す。`~` で始まる宛先と、作業場所が分からないときの絶対パスの宛先は見ない。GNU の `cp`、`mv`、`ln`、`install` の `-t <dir>`、`-t<dir>`、`-vt <dir>` のようにまとめた形、`--target-directory <dir>`、`--target-directory=<dir>`（一意な省略形の `--target=<dir>` も）は、値を宛先のディレクトリ、位置引数を全部元として読み、同じ規則で見る（`cp -t . /tmp/wrangler.jsonc`。`rsync -t` は `--times` なので見ない）。`-t` の宛先は必ずディレクトリとして扱うので、実在を確かめられない（`cd $X; cp -t .wrangler/deploy /tmp/config.json`）ときも元の名前を付けて見る。`-t` の値が展開で決まる（`-t "$PWD"`、`-t $(pwd)`）ときは置かれる先を判定できないので、元の名前が設定の名前に当たれば確認を挟む。値を取るフラグ（`-S`、`--suffix`、`install` の `-m`、`-o`、`-g`、`--mode`、`--owner`、`--group`、`--strip-program`）が独立した語なら、次の語をその値として飛ばす（`cp -S -t /tmp/evil wrangler.jsonc` の `-t` は `-S` の値で、オプションではない）。`-t` と読めたときも、従来の「最後の位置引数を宛先として見る」判定を残し、どちらかに当たれば止める（`mv -t /tmp .githooks/pre-commit`、`cp -t /tmp wrangler.jsonc` は元が守る先や設定なので確認を挟む）。元が glob のときは、glob が設定の名前（`wrangler.json`、`wrangler.jsonc`、`wrangler.toml`、`config.json`）に当たるかを見る（`cp /tmp/wrangler* .`、`cp /tmp/*.jsonc .`。`*` と `?` だけの語（`cp /tmp/* .`）は何にでも当たるので見ない）。元の `{a,b}` と `{1..3}` は、basename を取る前に語ぜんたいで展開し、展開したそれぞれの basename を見る（`cp /tmp/{x/wrangler.jsonc,y} .`、`cp {/tmp/a,/tmp/wrangler.jsonc} .`）。展開が 256 を超える元（`cp /tmp/x{1..100000}a .`）は、照合せずに確認を挟む。`install` は、GNU の並べ替え（`install -m 600 /tmp/x wrangler.jsonc`）で宛先が最後とは限らないので、wrangler の設定では位置引数のどれかを見る（元が設定の名前でも確認を挟む）。`node -e` や `python3 -c` の本文とヒアドキュメントの本文は、空白、引用符、括弧で区切った語を見る（`writeFileSync('wrangler.jsonc', …)`）。インタープリタの位置引数まで見るのは wrangler の設定だけ（守る先は、下の本文の判定で見る）。remote の binding を入れると `wrangler dev` が本番に届くため、`.claude/hooks/` などの理由とは分けて案内する）、前置きと経由先を飛ばした道具の名前に、引用符の内外を問わず変数か `$(…)` があるか、引用符の外に glob、`{a,b}`、zsh の括弧の glob、`~名前` があるコマンド（`"$(which wrangler)" deploy`、`~w deploy`。zsh の `=名前` は `=` を外した道具の名前として読むので、`=wrangler deploy` は止まる。プロセス置換 `<(…)`、`case` のラベル、`if (…)` のようなサブシェル、`[[ … =~ (a|b) ]]` の括弧は道具の名前に数えない）、ブランチを判定できない push（`cd ~` や変数の先、展開の印（変数、`$(…)`、`{a,b}`、glob）を含む refspec と git が refspec のパターンとして読む `*`。`git push origin "$(git branch --show-current)"`、`git push origin {main,x}`、`git push origin ma?n` も含む。並べて書いた `main`（`git push origin ma?n main`）は先に止める。リモートの位置の語が展開で複数の語に分かれる `git push {origin,x} y` は、後ろの語が refspec にずれるので確認を挟む）と、`git` のサブコマンドが展開で決まるコマンド（`git {commit,} -m y`、`X=commit; git $X -m y`、`git c?mmit -m y`、`git {push,} origin main`。コミットか push かを文字列で比べられないので、どちらにもなりうるものとして、`main` の作業コピーかを問わず確認を挟む）と、`--no-verify`（一意な省略形の `--no-v` 以上も）を付けた `commit`、`merge`、`pull`、`cherry-pick`、`revert`、`am`、`push` と、`-n` を付けた `commit`（`-an` のようにまとめた形も。値を取る短いフラグ（`-m`、`-F`、`-c`、`-C`、`-t`）より後ろと、その値の語（`-m -n`）は見ない。`merge` と `pull` の `-n` は `--no-stat`、`push` の `-n` は `--dry-run` なので見ない。展開した結果が `-` で始まりうる語も同じに扱う。引用符の外の変数と `$(…)` は語を分けるので位置を問わず（`X=--no-verify; git commit $X -m y`、`git commit $(echo --no-verify) -m y`、`git push origin x $NV`、`git commit -m $msg`）、`{a,b}`、glob、括弧の glob は先頭にあるとき（`git commit {--no-verify,} -m y`）、引用符の中の展開は先頭にあるとき（`git commit "$X" -m y`）、`-` で始まる語はフラグの名前に展開を含むとき（`git commit --no-verif* -m y`）に当たる。値を取るフラグの値（`git commit -m "$msg"`、`-m "fix $X"`、`-m"$msg"`、`--author="$A"`）と、`--` の後ろのパスは通す）（`.githooks/` の pre-commit と pre-push が外れ、このフックが作業コピーを読み違えたときの第二の守りが無くなるので、ワークツリーでも確認を挟む。`main` の上の判定は先に効かせて止める）と、作業コピーを判定できないコミット（`git -C` の値が `~` で始まるか、展開の印（変数、`$(…)`、glob、`{a,b}`、zsh の括弧の glob（`src(N)`、`(src|x)`）、数値の glob（`src<1-9>`）、`~名前`）を含むとき。`git -C "$(git rev-parse --show-toplevel)" commit` も含む。引用符の中の `'sr?'` は文字なので、その名前の行き先として解決する。zsh の括弧の glob は後ろの語を別の区切りに切り、閉じの `)` の後ろの語が前のコマンドから見えなくなるので、道具を問わず、閉じの `)` の後ろに同じコマンドの語が続くとき（`git --no-pager(N) commit`、`git -c a=b(N) commit`、`git x(N) commit`、`git -C . --no-pager(N) push origin main`、`cp /tmp/evil(N) wrangler.jsonc`、`cp /tmp/evil(N) .claude/hooks/guard-bash.mjs`、`cp /tmp/x/wrangler.jsonc(N) .`、閉じにすぐ続く `(a|b)(N)` も）は、サブコマンドもコピーの宛先も判定できないものとして確認を挟む。後ろが無いか、リダイレクトだけか、別のコマンド（`ls *(N)`、`ls *(N) 2>/dev/null`、`ls *(N) | wc -l`）は通す。`git push origin x(N)` のように push の refspec が括弧の glob で終わるときは、当たらなければ語が消えて今のブランチの push になるので、後ろが無くても確認を挟む。最後の語の末尾の括弧の glob（`cp /tmp/evil wrangler.jsonc(N)`、`wrangler.jsonc(.)`、`tee wrangler.jsonc(N) < /tmp/evil`、`sed -i s/a/b/ wrangler.jsonc(N)`、`cp /tmp/evil .claude/settings.json(N)`）は、当たればその名前に展開されるので、書き込み先、コピーの元の名前（`cp -t . /tmp/x/wrangler.jsonc(N)`）とも、外した形でも wrangler の設定と守る先に照合する。`cd` と `pushd` の行き先、パッケージマネージャーの場所のフラグの値（`-Csr?` の連結の形も）、`env -C` と `--chdir` の値に展開の印（変数、`$(…)`、glob、`{a,b}`、zsh の括弧の glob、`~名前`、引用符の中の `"src$X"`。`--dir=sr?` の形も）があるときも同じ。`main` の作業コピーで `cd sr? && git commit -m x` と `cd {src,x} && git commit -m x` を通さない。展開できない `cd` の後でも、行き先が絶対パスなら解決し直して、移った先のブランチで判定する（`cd sr? && cd /abs/path && git commit`）。`cd` と `pushd` の `-L` と `-P` は行き先ではないので飛ばす（`cd -L src`）。ただし `-P` は `..` を物理パスで辿るので、`-P` を付けて行き先に `..` を含む `cd`（`cd -P ..`）と、行き先が2つ以上の `cd`（zsh の `cd 旧 新`、bash ではエラー）は、移った先を判定できないものとして扱う。`CDPATH` があると、`/` で始まらない `cd` と `pushd` の行き先（`./x` と `../x` も。シェルごとの扱いの差は追わない）は `CDPATH` のディレクトリから探されるので、判定できないものとして扱う。セッションの `CDPATH` は、フックのプロセスの環境から読む（`guard-bash.mjs` が `process.env.CDPATH` を `judgeBash` に渡す。空文字は無いものとする）。シェルの rc でだけ設定して export しない `CDPATH` はフックから見えない。同じコマンドの中の設定は、書き方が多い（`export`、`declare`、`typeset`、単独の `CDPATH=…;`、`read CDPATH`、`printf -v CDPATH`、`for CDPATH in`、`: ${CDPATH:=x}`、zsh の `cdpath=(x)`）ので、道具の前の代入を除くどこかの語に `CDPATH` か `cdpath` の名前があれば、その区切りの後ろを設定済みとみなす。`GIT_DIR` と `GIT_WORK_TREE` も同じ規則で見て、設定した後の区切りの git（`export GIT_DIR=<main>/.git; git commit -m y`、`X=GIT_DIR=…; export $X`）は作業コピーを判定できないものとして扱う。`export`、`declare`、`typeset`、`readonly`、`local` の引数に展開の語（`export $(echo GIT_DIR=…)`）があるときも、全部の名前を設定済みとみなす。道具の前の一回限りの代入は、その区切りだけに効かせる（`CDPATH=<main のパス>:. cd src` の `cd`、`GIT_DIR=… git commit` の `git` には効かせ、`GIT_DIR=/x git status; git commit -m y` の後ろの `git commit` には伝えない）。値を読まず、`unset` で戻すのも追わない。設定した名前は、後ろの `bash -c` の中身にも渡して見る。コミットのメッセージの語（`git commit -m "GIT_DIR を直す"`）は、そのコミット自身ではなく後ろの区切りに効く。`popd`、引数なしの `pushd`、`pushd +N` と `-N`（zsh の `cd +N` も）の後と、中身をこのシェルで動かす `eval`、`source`、`.` の後は、ディレクトリのスタックや中の `cd` を追わないので、作業場所を判定できないものとして扱い（`pushd worktrees/x && popd && git commit -m y`）、`eval`、`source`、`.` の後は `GIT_DIR` も設定済みとみなす。これらの後は `main` の作業コピーの上でも止めず、確認を挟む（`popd; git commit -m y` は deny ではなく ask）。`dirs` は表示とスタックの操作だけで作業場所を変えないので、そのまま判定する）と、ブランチを引けない作業コピーでのコミット（`cd nope; git commit -m x` のように存在しない行き先、detached HEAD、git の管理外。`main` の判定に当たらないまま通さない。detached HEAD には、rebase の途中の `git commit` や `git cherry-pick --continue` も当たる）と、作業場所を判定できない（`cd ~` や変数の先）ときの、デプロイのスクリプトの判定と同じ道具に渡した、名前が `deploy` で始まるパスの形の相対の語（道具そのものの語も含む）と、展開の大きい glob（デプロイのスクリプトに当たるかを判定しない）、Bash からの `.claude/settings*.json` と `.claude/hooks/` と `.githooks/` と `migrations/` の書き換え（リダイレクトの先（道具の無いリダイレクトと、`cd`、`pushd` に付けたものも含む。先の崩した名前と置換の中身（`> "$(echo .claude)/settings.json"`）も上と同じに見る）、書き込みの道具は上と同じ表で見る。コピーの元には確認を挟まないよう、`cp`、`mv`、`ln`、`rsync`、`install`、`scp`、`ditto` は最後の引数だけを見る（`cp .claude/hooks/x.mjs /tmp/` は通す）。値を取るオプション（`-m`、`-o`、`-g`、`-S`、`--mode`、`--owner`、`--group`、`--suffix` など。`-t` の判定と同じ表）の値を除いた最後の位置引数も見るので、`install x .claude/hooks/y -m 600` は確認を挟む。大文字小文字は区別しない（`echo x > .Claude/Settings.json`、`rm MIGRATIONS/0001_init.sql`。macOS のファイルシステムが区別しないため）。ただし `mv` は元を消すので、元も見る（`mv .githooks/pre-commit /tmp/`、`mv .claude/hooks/x /tmp/`）。`.claude`、`.claude/`、`.githooks`、`migrations` のディレクトリそのものも守る先に含める（`mv .claude /tmp/x`、`mv -t /tmp .claude`、`mv migrations /tmp/x`、`cp -r /tmp/x/.claude .`。中身ごとのコピー `cp -r /tmp/evil/. .claude/`、`cp -r /tmp/evil/ .claude`、`rsync -a /tmp/evil/ .claude/`、`ditto /tmp/evil .claude` も宛先で当たる）。消すか動かす元（`rm`、`rmdir`、`mv` の元（`-t` があれば位置引数の全部。値を取るオプションの値は除く）、`find … -delete` の起点。g の付いた名前と前置きも同じ）は、守る先のほかに、リポジトリの根（`scripts/deploy-production.ts` のあるディレクトリ）か根の祖先、ホームそのもの、`/` にも確認を挟む（`rm -rf .`、`rm -rf ~`、`rmdir .githooks`、`find .claude/hooks -delete`、`mv . /tmp/x`）。語の `{a,b}` は展開してから見る。作業場所が分かり根が見つかるときは解決した絶対パスで、大文字小文字を区別せずに比べる（ワークツリーの中の `rm -rf ../..` は本体の根に当たる。`cd ..` の後も、コマンドを始めた作業場所の根を守る）。作業場所が分からないか根が見つからないときは字面で、正規化して `.` と `..` だけからなる語、`/`、語の先頭の `~` に当てる（`./~` は通す）。作業場所が分からないまま `cd`、`env -C`、パッケージマネージャーの場所のフラグ（pnpm の `-C`、`--dir`、`--prefix`、npm の `-C`、`--prefix`、yarn と bun の `--cwd`）で移った先は、書かれた行き先をつないで守る先に照合する（`cd .claude && find hooks -delete`、`npm --prefix .claude exec -- rm -rf hooks`）。移った先で動かす経由先のコマンドと、exec のシェルの文字列（pnpm の `-c`、npm の `--call`、`bun exec`）も同じ。重ねた場所のフラグは後ろが勝ち、前の値につながない。絶対パスの値は、`env -C` と同じく前の作業場所が分からなくても行き先にする。作業場所が分からなくなった後（`cd -P ..`、`popd`、`cd ~`）は、始めの根とその祖先の名前で消す形（`rm -rf scrum-guild`）にも確認を挟む。`~+` は作業場所として見て、ホームを引けないときの `~` と `~-` は確認を挟む。`rm -rf worktrees/x`、`rm -rf build`、`rm -rf node_modules` は通す。変数と `$(…)` で決まる語（`rm -rf "$PWD"`）は見ない。`find` の `-exec`、`-execdir`、`-ok`、`-okdir` は、後ろのコマンドの `{}` を起点のそれぞれに置き換えて同じ規則に掛け直す（`find .claude/hooks -exec rm {} \;`、`find .githooks -exec sed -i s/a/b/ {} +` は確認を挟み、`find .claude/hooks -exec grep x {} +` は通す。道具の位置に `{}` がある形（`-exec {} deploy \;`）は、見つけたファイルを実行するので確認を挟む）。`-execdir` と `-okdir` は、起点の親と起点に加え、起点が守る先を含みうるときは起点の下の守る先のディレクトリも作業場所として見る（`find . -execdir rm pre-commit \;`）。起点が根か根の祖先なら、名前で絞っても（`find . -name '*.log' -delete`）確認を挟む止めすぎを受け入れる。掛け直すコマンドが多すぎるか重すぎるときは、判定せずに確認を挟む（上限と重さの数え方は `bash-rules.mjs` のコメント）。語の `{a,b}` は展開してから見る（`mv .claude/settings.json{,.bak}`、`echo x > .claude/settings.json{,2}`）。glob の語（`mv .claude/* /tmp/x`、`mv .gith* /tmp/x`、`cp /tmp/s.json .claude/settings.js*`）は、根の守る先の候補（`.claude/settings.json`、`.claude/settings.local.json`、`.claude/hooks`、`.githooks`、`migrations`）に、大文字小文字を区別せずに照合する（`mv .Claude/* /tmp/x`、`mv .GITH* /tmp/x`）。作業場所が分かるときは作業場所から解決した絶対パスで照合し、根の外の glob（`rm -f /tmp/*`）は止めない。展開が 256 を超える語は照合せずに確認を挟む。書かれた語と正規化した語のほかに、作業場所から解決した絶対パスでも見る（`cd .claude && cp /tmp/settings.json .`、`cd .githooks && cp /tmp/x pre-commit`、`cd .claude && mv settings.json /tmp/x`）。宛先がディレクトリのコピーは、wrangler の設定と同じ規則で元の名前を付けて見る（`cp /tmp/settings.json .claude/`、`cp -t migrations /tmp/x.sql`）。wrangler の設定と違い、根の外の絶対パスと `~` で始まる宛先（`cp -r /tmp/x/.claude ~/repo/`）も見る。宛先が展開で決まるコピー（`cp -t "$D" /tmp/settings.json`、`cp /tmp/settings.json "$D"`、`cp -t "$PWD/.claude" /tmp/x`、`cp -t$PWD/.claude …`）は、元の名前が守る先に置かれうる名前（`settings.json`、`settings.local.json`、`hooks`、ディレクトリそのものの名前、`pre-commit` などの git のフックの名前、`*.sql`）に当たるか、宛先の展開されない部分が `.claude`、`.githooks`、`migrations` を含めば確認を挟む（`cp -t "$D" /tmp/x.txt` は通す）。元が glob のときは、`.claude/` の下に置かれうる名前（`settings.json`、`settings.local.json`、`hooks`）に当たるかを見る。wrangler の設定と違い、`*` だけの語（`cp /tmp/* .claude/`）も見る。`find -exec` は読むだけのこと（`find .claude/hooks -exec grep …`）が多いので見ない。`find` の `-fprint` などの値、`tar` の `-f` の値と展開するときの `-C` の値、`git` の `--output` の値は書き込み先として見る（`find . -fprint .claude/hooks/x`、`tar -cf .claude/hooks/x /dev/null`））、インタープリタの本文（インタープリタごとの本文を取るフラグの値。`node` と `bun` の `-e`、`-p`、`--eval`、`--print`、`python` と `python3` の `-c`、`ruby` と `osascript` の `-e`、`perl` の `-e` と `-E`、`php` の `-r`、`-R`、`-B`、`-E`。構文の確かめ（`node -c`、`perl -c`、`ruby -c`）、require（`node -r`、`ruby -r`）、`php -c` の設定のパスは本文ではないので見ない。`-pe` のようにまとめた形の値、`perl -e'…'` や `python3 -c'…'` のように連結した値、ヒアドキュメントとヒアストリングの本文）を空白、引用符、括弧で区切った語に、wrangler の語（別名を含む）か守る先の名前があるもの（`python3 -c 'import os; os.system("wrangler deploy")'`、`node -e '…execSync("wrangler deploy")'`、`php -r 'system("wrangler deploy");'`、`osascript -e 'do shell script "wrangler deploy"'`、`node -e '…writeFileSync(".claude/settings.json","x")'`。本文の中のコマンドの引数（`--remote` など）は読めないので、止めずに人が確かめる。位置引数のファイル（`node --test .claude/hooks/guards.test.mjs`）は本文ではないので見ない。守る名前を読むだけの本文（`node -e "import('./.claude/hooks/x.mjs')"`）も確認を挟むが、止めすぎとして受け入れる）、`core.hooksPath` の書き換え（読むだけなら通す） |
| `guard-bash.mjs` と `bash-rules.mjs` の e2e の止め（PreToolUse、Bash と Monitor） | 止める: e2e を走らせる書き方（`pnpm e2e`、`pnpm run e2e`、`pnpm exec playwright test`、`npx playwright test`、`node_modules/.bin/playwright test` など。ファイルや `--shard` などの引数が付いても止める）。理由は「e2e は手元で走らせず、CI（`ci-ok`）で確かめる」と、この文書の「開発の流れ」を出す。確認ではなく deny にするのは、ask だと人が見ていないクラウドのセッションが承認の待ちで止まるため。`E2E_LOCAL=1` のような前置きで通す抜け道も置かない。セッションが自分で付けられ、止めにならないため。通す: `playwright install`、`playwright show-trace`、`pnpm dev:open`（trace を読むのと画面を開くのは遅くなく、CI の失敗を直すのに要る）。フックが効くのは Claude の Bash だけで、人が端末で打つ `pnpm e2e` は止まらない（#521） |
| `guard-files.mjs` と `file-rules.mjs`（PreToolUse、Write と Edit と MultiEdit） | 止める（ほかの判定より先）: このリポジトリの作業コピーのうち `main` にいるもの（本体の detached も含む。ワークツリーとクラウドのセッションの detached は除き、クラウドのセッションでも `main` のブランチにいれば止める）のファイルの書き換え（文書と ignore されたファイルも含む。別のリポジトリと git の外のファイルは見ない。セッションの場所を引けなければ止める）、`origin/main` にあるマイグレーションの書き換え、`+page.server`、`+layout.server`、`+server`、`hooks.server`、`src/` のうち `src/server/db/` の外での `env.DB` と `D1Database`（テストも含む。テストの土台は `test/` に置く）、`.svelte` の `<style>`、wrangler の設定の `remote: true`。確認を挟む: `.claude/settings*.json` の書き換えと、セッションが使っている `.claude/hooks/` と `.githooks/` の書き換え、`.wrangler/deploy/config.json` の書き換え（大文字小文字は区別しない（macOS のファイルシステムが区別しないため）。wrangler は `-c` が無いとき、このファイルがあれば書かれた別の設定へ転送する。`.wrangler/` は ignore されているので、remote の binding を持つ設定へ向けられる。ワークツリーの中でも確認を挟む）。セッションを起動した場所（`$CLAUDE_PROJECT_DIR`）とは別のワークツリーの `.claude/hooks/` と `.githooks/` は、確認を挟まない（セッションが使うのは起動した場所のフックで、別のワークツリーでの書き換えは PR で人が読むまで効かない）。ファイル自体のシンボリックリンクはリンク先で判定し、ワークツリーか判定できないときは確認を挟む。Bash からの `.claude/hooks/` の書き換えは、ワークツリーでも確認を挟む。`.claude/settings*.json`、`.claude/hooks/`、`.githooks/`、`migrations/` も大文字小文字を区別せずに見る（macOS のファイルシステムでは `.Claude/Settings.json` が本物の設定を指すため）。`.claude/Hooks/x.mjs` がワークツリーの中かと、`Migrations/0001_x.sql` が `origin/main` にあるか（根から `migrations` の名前のディレクトリを探し、その下を小文字にそろえて比べる。比べられなければ確認を挟む）も、崩さない名前と同じに判定する |
| `format.mjs`（PostToolUse、Write と Edit と MultiEdit） | このリポジトリのファイルを Prettier で整える。依存が入るまでは何もしない |
| `review-budget.mjs` と `review-budget-rules.mjs`（PreToolUse、Agent） | `done-check` のレビューのエージェント（`code-reviewer`、`security-reviewer`、`database-reviewer`、`ui-reviewer`、`falsification-qa`）の起動を、ブランチごとに2巡までにする。巡の最初の起動から120秒以内の起動は同じ巡で、超えたら新しい巡として数える（窓をまたいで余分に数える側にずれるが、止まってユーザーに聞くだけなので許す）。上限を超えた起動は拒否し、理由に延ばし方を返す。拒否した起動は数えない。`finding-verifier` と、レビュー以外のエージェント（`Explore` など）は数えず、拒否もしない。detached HEAD などブランチを引けないときは拒否せず数えない。状態は `$(git rev-parse --git-common-dir)/review-budget/<ブランチ名を符号化した名前>.json`（起動の時刻、延長の数と理由）に置く。Git の中にあるので、セッションを開き直しても、別のワークツリーからでも巡の数は戻らない。同時の起動は `mkdir` のロックで直列にする。延ばすには、`AskUserQuestion` でユーザーに聞き、承認されたら `node .claude/hooks/review-budget.mjs extend <巡数> --reason <理由>` を実行する（延ばした分だけ起動できる）。承認の真偽はフックが確かめない（抑止であって境界ではない。拒否の理由に延長のコマンドが入るので、セッションは承認なしでも打てる）。拒否されたら、名前を変えて呼び直すなどで回避しない |
| `session-title.mjs` と `session-title-rules.mjs`（SessionStart の起動と再開） | 付ける: ブランチ名の先頭の数字（0 始まりでない 9 桁まで）を Issue の番号として、`gh` で Issue の題を引き、セッション名を `#<番号> <題>`、そのブランチに PR があれば `#<番号> PR #<PR の番号> <題>` にする（PR が複数なら開いているものを先に使う）。題の制御文字と書式の文字は取り除き、80 文字に切る。付けない: 名前が既にある（`--name` や `/rename`）、番号の無いブランチ、`gh` が失敗した。`gh pr list` だけが失敗したときは Issue の題だけで付ける。何があってもセッションは止めない |
| `session-start.sh`（SessionStart の起動と再開） | クラウドのセッションだけで、`/opt/node<.node-version の主版>/bin` があればそれを PATH の前に置く行を `CLAUDE_ENV_FILE` に足し（同じ行は重ねない。主版を読めない、`/opt/node<主版>` が無い、`CLAUDE_ENV_FILE` が無いときは、理由を出して足さない）、`pnpm install --frozen-lockfile` を行う。pnpm が無ければ corepack で用意し、corepack も無ければ（Node 25 から同梱されない）`packageManager` の版を `npm install -g` で入れる |

Codex は `.claude/` のフックを通らない（`codex exec` が起こす実装専用のエージェント。`.codex/agents/implementer.toml`）。代わりに次で守る。

- Codex の sandbox は `workspace-write` で、ネットワークは無し（`increment-build` が `codex exec` の呼び出しで固定する。サブエージェントの中で効くことは、実機では確かめていない想定）。`wrangler` の資格情報は読めるが、通信の道が無ければ本番に触る `wrangler` の操作は届かない。資格情報の値が書いた差分に混ざることは、この守りの外で、人が差分を読んで止める（`needs-human` ではない通常の PR でも、コミット前に差分を目で確かめる）。`increment-build` の `codex exec` の呼び出しの変更も、人が差分を読む
- `AGENTS.md` が `CLAUDE.md` の「守ること」と「コマンド」に従わせ、フックが止めていたこと（本番の操作、`.dev.vars` と `.env`、コミット）を Codex に固有の注意として並べる
- Codex が戻った後に、呼び出し元のセッションはまず `git status --short` と `git diff --name-only` を見る。変えてよい範囲の外の守るファイル（`.githooks/`、`.claude/`、`.codex/`、`AGENTS.md`、`package.json`、`scripts/` など）が変わっていれば、何も走らせずに止まる（呼び出し元は sandbox の外で動くため、Codex が書き換えたフックやスクリプトを動かさない）。範囲の中だけなら、`pnpm format` と受け入れ条件の検査を走らせ直す（`format.mjs` を通らないため）。コミットは呼び出し元だけが行う

`.codex/` と `AGENTS.md` は sandbox とネットワークの設定、Codex が読む決まりを変えられるので、変えた PR には `needs-human` が付く（下の「マージの判定」）。

allow に入れるものは、確認の数を減らし、残る確認を書き込みや外に出る操作に絞るために選ぶ。

- 入れる: GitHub の MCP の、書き込まないツール（`issue_read`、`pull_request_read`、`list_*`、`search_issues`、`search_pull_requests`、`get_commit`、`get_check_run`、`get_job_logs`、`actions_get`、`actions_list`）。差分のパッチや CI のログ全文も返すので、ファイルの中身を読むのと変わらない。クラウドのセッションでは、読める範囲はセッションに許したリポジトリ（このリポジトリ）に限られる。手元では MCP のトークンが届くリポジトリすべてを読めるが、読むだけなので受け入れる。CI のログの秘密は GitHub Actions が伏せる
- 入れない: `get_file_contents` と `search_code`。危ないからではなく、手元のチェックアウトを読めば足りるため
- 入れない: 手元の点検（`pnpm check`、`pnpm lint`、`pnpm test`、フックのテストなど）。セッションが確認なしに書き換えられるテストや設定のコードを動かすので、allow に入れると `.dev.vars` の読み出しと外への送信まで確認なしに通る。フックも `permissions.deny` もこの経路を止めない。点検の確認を減らすときは、ルールでなく Auto モードの判定に任せる
- 入れない: `git status` や `cat` のように、Claude Code がもともと確認なしで通すもの

Bash の判定を `permissions.deny` に置かないのは、規則が前方一致で、`npx wrangler` や `pnpm exec wrangler` の言い換えを取りこぼすため。先頭に `*` を付けると、`grep "wrangler deploy"` のような読むだけのコマンドまで止まる。フックはコマンドを区切りごとに分け（コメント、行継続、`$(...)` とバッククォート、`bash -c` と `bash <<EOF` と `eval` の中身も読む。`ksh`、`mksh`、`csh`、`tcsh`、`fish` の `-c`、`fish` の `--command`、`-C`、`--init-command`、util-linux の `script -c` の中身も同じ）、前置き（`env`、`sudo`、`timeout`、`xargs`、`npx`（あわせて `npm exec` としても読む）、`pnpx`（`pnpm dlx` としても読む）、macOS の `arch`（`-arch`、`-e`、`-d` の値を飛ばす）、`script`（BSD の `-F`、`-t`、`-T` と util-linux の `-I`、`-O`、`-B`、`-E`、`-m`、`-o` の値と、最初の位置引数の記録するファイルを飛ばす。`script -q /dev/null cmd`。util-linux の `-t` は連結の形（`-t2`）でだけ値を取るので、次の語が `-` で始まれば値にしない）など）を飛ばした、実行する道具の名前で判定する。同じコマンドの中の `cd` と `git checkout` の後の push は移った先のブランチで、`package.json` のスクリプトは pre と post も含めた中身で見る。スクリプト名の後ろの引数（`pnpm test scripts/x.ts`）は、道具が本体の末尾に足して実行するので、引用符で包んで本体に足した形で、package.json のあるディレクトリから判定する。npm が `--` の前のフラグを取る違いはまねず、名前より後ろの語を全部足す。`--` は pnpm が残し、npm、yarn、bun が消すので（pnpm 12.12、npm 11.20、yarn 1.22（classic）、bun 1.4 で、引数を表示するだけのスクリプトに `<道具> run x -- a` などを渡し、届いた argv を見て確かめた。yarn の Berry は確かめていない）、残した形と消した形の両方で判定する（git や wrangler の判定は `--` の後ろをフラグとして読まないため）。引数に変数、`$(...)`、glob があれば、足した後の中身を判定できないので確認を挟む。パッケージマネージャーのコマンドの読み方は、下の「パッケージマネージャーの読み取り」。判定できないときは、フックが exit 2 で止める。判定を変えたら `node --test .claude/hooks/*.test.mjs` を通す。

**パッケージマネージャーの読み取り。** pnpm、npm、yarn、bun（`corepack` の後ろと、yarn のもう1つの bin の `yarnpkg` も）のコマンドは、どのスクリプトとコマンドを、どの package.json から走らせるかを道具ごとに読み、走るものを同じ規則で判定する。振る舞いは pnpm 12.12、npm 11.20、yarn 1.22、bun 1.4 で、2026-10-27 に `echo` だけのスクリプトを並べた使い捨ての package.json に打って確かめた。

| 読むもの | 決まり |
| --- | --- |
| 名前 | 道具ごとの別名を正規の名前に直して引く（pnpm の `t`、`tst`、`it`、`ic` など。`rum` と `te` は pnpm の別名ではない）。npm は `lib/utils/cmd-list.js` の `deref` に合わせ、キャメルケースをケバブに直し、完全一致、別名、一意な前置き（`tes`、`run-scr`、`exe`）の順で引き、引けない名前は確認を挟む。名前が package.json のスクリプトにあれば、組み込みより先にスクリプトとして見る（`audit` のスクリプトがある所の `npm audit`）。名前が展開で決まれば確認を挟む |
| 無い名前 | pnpm と bun は、組み込みにもスクリプトにも無い名前（`run` の後ろも）を PATH のコマンドとして動かすので、`pnpm exec` と同じく名前から後ろを経由先として見る（`pnpm bash -c '…'`、`bun run git push …`） |
| シェルの文字列 | `bun exec "<文字列>"` の最初の位置引数、pnpm の `-c` と `--shell-mode`（`exec` の前にも置け、値を取らない。位置引数を空白でつないで動かす）、npm の `--call` と `-c` の値（一意な前置きの `--cal` も。`exec` の前でも後ろでも効き、初期化子を渡した `npm init <x>` と `npm create <x>` にも効く）、道具の前の `npm_config_call=`（大文字小文字を問わない。`npm exec`、`npm x`、`npx` が動かす）を Bash のコマンドとして見る（`npx` と `pnpx` の後ろも、下の「経由」の読み方で同じに見る）。同じコマンドの前の区切りで `npm_config_call` を設定した後（`export`、`declare -x`、単独の代入、`export $X`、`eval`、`source`、`.` の後も）の `npm exec`、`npm x`、`npx`、初期化子を渡した `npm init` と `npm create` は、値を読まずに確認を挟む |
| フラグ | 値を取るフラグの表を道具ごとに持つ（bun の `--dir`、`--prefix`、`--workspace` と、npm の `--dir`、`--filter`、`-F` は値を取らない）。名前より前に表に無いフラグがあれば、次の語を値と読む形と名前と読む形の両方で判定し、重いほうを採る。npm は nopt と同じく、String でも真偽でもない型のフラグ（`--prefix`、`-w`、`-L`、`-C`）の次の語を `-` で始まっても値に取り（`npm -L -y=-C test` の `-y=-C` は `-L` の値）、表に無いフラグ（`--otp`、`--userconfig`）の次の `-` で始まる語も値と読む形と読まない形の両方で判定する。npm の型が Boolean の設定（`--ignore-scripts`、`--prefer-offline`）、`--no-` で始まるフラグ、値を取らない形に広がる shorthands（`--silent`、`--local`）は、次の `-` で始まる語を値に取らない（npm 11.20 の `@npmcli/config` の definitions から写した）。読み方が 8 通りを超えれば確認を挟む。短いフラグのまとめは、pnpm は clap と同じく値を取る `C`、`F` の後ろの残りか次の語を値に（`-yC sub`、`-yCsub`）、npm は nopt と同じく最後の文字が値を取れば次の語を値にする（`-sC ls`）。npm の型が String だけのフラグ（`--call`、`-c`、`--message`、`-m`）は、nopt と同じく `-` で始まる次の語を値に取らない（`npm exec -m -c '…'` の `-c` は `--call`。`--prefix`、`-w`、`-L` は取る）。nopt は `=` の形も2語に分けて読むので、`=` の後ろが `-` で始まる値（`--message=-c`、`-m=--call=…`、`-y=-c`）は、String の型か値を取らないフラグならフラグとして読み直し、表に無いフラグ（`--tag`）は両方で読む。nopt は先頭の `-` を全部外して名前を引くので、`-` を重ねた名前は、1文字なら短いフラグ（`--c`、`---c` は `-c`）、全部の文字が1文字のフラグならまとめ（`--sc`、`--yy`。表にある1文字のフラグだけでできた名前は、長い名前に見えてもまとめとして読む）、ほかは長いフラグ（`---call`）として読み、`---` も `--` と同じく読み終える。まとめの途中の場所と call のフラグ（npm の `-Cls`）と、表に無い文字の後ろの `C` は、読めないので確認を挟む |
| 場所 | package.json を探す場所は、pnpm の `-C`、`--dir`、`--prefix`、npm の `-C`、`--prefix`（一意な前置きの `--prefi` も）、yarn と bun の `--cwd`（`=` の形と、pnpm の `-Csub` の連結の形も）で決め直す。npm は名前の後ろのものも読む。pnpm、yarn、bun はスクリプトの名前（`test`、`start`、`stop`、`run` の後ろの名前）の後ろのフラグをスクリプトに渡すので読まないが、組み込みのコマンドの後ろのもの（`pnpm install -C sub`、`bun install --cwd sub`）は読む。npm の `-C<dir>` の連結の形は、npm 11.20 では今の場所で動くが、版の違いを避けて今の場所と連結の先の両方で判定する。道具の前の `npm_config_prefix=`（`NPM_CONFIG_PREFIX` も）は、npm 11.20 ではスクリプトの場所を変えないが、その値の場所と元の場所の両方で判定する。スクリプトを走らせる形（スクリプトの名前、下のライフサイクル、pnpm と bun の無い名前）で、場所が分からない（`cd ~` の後、値が `~` か `$` で始まるか展開を含む）か package.json を引けないときは確認を挟む（`pnpm exec`、`pnpm --version` のような組み込みは挟まない） |
| ライフサイクル | パッケージを渡さない `install`（`i` などの別名と、yarn の名前の無い形も）と `ci` は `preinstall`、`install`、`postinstall`、`prepare` に加え、npm と yarn は `prepublish`、pnpm は `pnpm:devPreinstall` を見る。`install-test` と `install-ci-test`（`it`、`cit`、`sit`）はその後の `test` も、`restart` は `restart`、`stop`、`start` を、`pack` は `prepack`、`prepare`、`postpack` を、`publish` はそれに `prepublishOnly` と `publish` を、引数の無い `npm link` は `install` と `prepare` を見る。どれも pre と post も含めて見る。ほかの組み込みのコマンド（`version` など）も、同じ名前の pre と post のスクリプトは見る |
| 経由 | `corepack <道具>[@版]` と `pnpm with <版>` は、後ろをその道具のコマンドとして読む。`npx` は `npm exec` として読み、npx と同じく最初の位置引数の前に `--` を差し込む（npm 11.20 の `bin/npx-cli.js`。`npx vitest -c x` の `-c x` は vitest の引数）。位置引数を探すときは npx の読み方に合わせ、先頭の `-` を全部外した名前で引き、1文字の名前は npm の shorthands で広げて読み直し（`-m=-c` は `--message` と `-c`、`-d` は `--loglevel info`）、取り除いたフラグ（`-n`、`--npm`、`--node-arg`）は次の語ごと消し、`-p`、`-c`、`--cache`、`--userconfig`、`--shell` は次の語をいつも値に取り、値を取るか分からないフラグは両方で読む。`pnpx` は `pnpm dlx` として読む。`corepack npx` と `corepack pnpx` は、`corepack` を外して直に打つ形と同じに見る |
| 追わないもの | `pnpm -r`、`pnpm recursive`、bun の `--parallel` と `--sequential` で名前を並べる形、ワークスペースの別の package.json のスクリプト（このリポジトリはワークスペースを持たない）、`.npmrc`、`npm config set`、`--userconfig` で設定した `call`、セッションの環境変数にもとからある `npm_config_call`、引数も call も無い `npx`、`npm exec` に標準入力で流すコマンド、`--shell` と `--script-shell` で Bash 以外のシェルに渡した call の文字列（Bash として判定する） |

どれも踏み線で、本当の守りは、セッションが動く環境に Cloudflare の資格情報を置かないこと。フックからは、変数の中身、パイプで `sh` に流す中身、`xargs` が標準入力から足す引数（読むだけの道具は通すので、名前が見えない `ls -a | xargs grep TOKEN` で `.dev.vars` を読める）、`xargs` を通さずに直に打つ `rg --pre` と `ag --pager`（コマンドを実行できる）、インタープリタに渡したファイルの中のコードと、本文の中で組み立てた名前（`'.cla' + 'ude/hooks'`）からの守るファイルへの書き込みと wrangler の実行（本文に名前がそのまま出るときだけ確認を挟む。本文の中の `git`（`perl -e 'system("git push origin main")'`）と、glob で守る先に当たる形（`rm .claude/h*/*.mjs`）は #293 で扱う）、glob で根の祖先に当たる削除（`rm -rf ../*`、`rm -rf /*`。#293 で扱う）、`git stash -a` で ignore したファイルを作業コピーから外す形、インタープリタ以外の道具が本文として実行するコードの中の wrangler と守る先の名前（`awk` の `system()`、`sed` の `e`、`expect -c`、`sqlite3` の `.shell`、`lua -e`。シークレットの名前は、引数のどこかにあれば止まる）、`gh` と `git` がシークレットのファイルを名前で受け取って送るか出す形（`gh … --body-file .dev.vars`、`gh api --input .dev.vars`、`git diff --no-index`）、前置きの表に無い包む道具（`setsid`、`su -c`、`flock -c` など）の後ろのコマンド、wrangler の設定を書き換える次の道具（`curl -o`、`wget -O`、`tar -x`、`unzip`、ディレクトリごとの `cp -r`、`git checkout --` と `git restore`、インタープリタ以外のコードの中からの書き込み。書き込み先の名前がコマンドの語に出ないため）、`gh api graphql` と `gh api --input` が読むファイルの中身、`gh` の設定ファイルに直に書いたエイリアス、`gh extension` が中で打つコマンドが見えない。コードの中で `WORKERS_CI` を設定する形（`node -e "process.env.WORKERS_CI='1'"`）、`.env` からの読み込み、`scripts/deploy.ts` の書き換え、`deploy()` の直の呼び出し、シンボリックリンクで `*.test.ts` に見せた `scripts/deploy-production.ts`（Node がリンク先を本体として動かすので `import.meta.main` が真になる）も追わない。

- クラウドのセッションの環境には、Cloudflare の API トークンを置かない
- 手元の機械では `wrangler login` しない（したら `wrangler logout` しておく）。シェルに `CLOUDFLARE_API_TOKEN` を置かない。手元のセッションは、人が置いた資格情報をそのまま使えるため

止められた操作は人に任せる。セッションは別の手で抜けようとせず、止まった操作と理由を人に伝える。手元のセッションでは、人が Claude Code の入力欄で先頭に `!` を付けて打つ（フックを通らない）。人のいないクラウドのセッションでは打つ人がいないので、止まった操作を PR か Issue に書き残し、人が手元で行う。`.dev.vars` は人が `.dev.vars.example` を写して値を入れる（`cp .dev.vars.example .dev.vars` もフックが止めるので、人が `!` を付けて打つ）。本体の作業コピーに1つ置けば、ワークツリーは `post-checkout` が張るリンクで使う（上の「ワークツリーで作業する」）。

### クラウド環境

クラウドのセッションの場は、claude.ai/code のクラウド環境 `scrum-guild`（Ubuntu 24.04 の VM、既定の Node は 22）。環境のセットアップスクリプトは、初めてのセッションで Claude Code の起動より前に root で走り、約5分以内に終われば、クラウドがファイルシステムのスナップショットを約7日使い回す。そのため、VM の用意はセットアップスクリプト、依存の導入は毎回走る `session-start.sh` の受け持ちとする。

| 仕組み | 中身 |
| --- | --- |
| セットアップスクリプト（`scripts/cloud-setup.sh`） | Node を nodejs.org から `/opt/node<主版>` に入れる（`.node-version` が主版だけならその最新、`x.y.z` ならその版。足りなければ `libatomic1` を apt で足す）。`/etc/profile.d` と `/root/.bashrc` の先頭で PATH の前に置く（初期化ファイルを読むシェル向け。セッションの Bash はこれらを読まないので、`session-start.sh` が `CLAUDE_ENV_FILE` で選ばせる）。`packageManager` の版の pnpm を `npm install -g` で入れ、`pnpm install --frozen-lockfile --ignore-scripts` で pnpm のストアを温め、`playwright install chromium` と `playwright install-deps chromium` で chromium と動かすのに要るライブラリを入れ、組んだ `node_modules` は消す（毎回の `pnpm install` にスクリプトまで組ませるため）。リポジトリが見つからなければ Node と pnpm だけを入れる |
| `session-start.sh` | 「Claude の設定とフック」の表のとおり。ストアが温まっているので、取得は差分だけになる。Claude Code は `CLAUDE_ENV_FILE` を後の Bash のコマンドの前に読むので、セッションの Bash では `/opt/node<主版>` の Node が選ばれる。フック自身は初期化ファイルも `CLAUDE_ENV_FILE` も読まないので、VM の既定の Node 22 で動く。`scripts/` の `.ts` を動かすには `engines` の下限の 22.18 以上が要る |

スクリプトは、終了コードが 0 以外だとセッションが始まらないので、どの段の失敗も警告にとどめて 0 で終える。約5分を超えるとスナップショットが作られないので、全体を 270 秒の予算に収め、各段の上限を残りの時間で切り詰める（残りが 20 秒を切れば後の段を飛ばす）。スナップショットを作るときの clone のブランチの中身を root で動かして後のセッションに残さないよう、依存のスクリプトと `.pnpmfile.cjs` は動かさない（`--ignore-scripts --ignore-pnpmfile`）。

受け入れている危険: Node は同じ配布元の `SHASUMS256.txt` と照らすだけで、署名は確かめない（防げるのは取得の破損まで）。pnpm と chromium も、npm のレジストリと Playwright の配布元の HTTPS だけを信じて入れる。chromium を入れるとき、そのブランチのロックファイルから入れた Playwright 本体のコードは root で動く。クラウドのセッションには本番の資格情報を置かないので、差し替えられても本番には届かない。

クラウド環境の設定:

- セットアップスクリプト: `scripts/cloud-setup.sh` の中身を貼る。走る時点の clone の置き場所が決まっていないので、リポジトリのファイルを呼ばずに中身を持たせる。スクリプトを直したら貼り直す。貼り直すとスナップショットが作り直されるので、取得の一時的な失敗を残したスナップショットも、貼り直して作り直す
- ネットワークアクセス: 「カスタム」にし、既定のパッケージマネージャーのドメイン（npm、nodejs.org、Ubuntu の apt を含む）に、Playwright のブラウザの配布元 `cdn.playwright.dev` と `playwright.download.prss.microsoft.com` を足す
- 環境変数とネットワークシークレット: 置かない（上の「Cloudflare の API トークンを置かない」）

設定を変えたら、新しいセッションで `node --version`（`.node-version` の主版）、`/opt/node22/bin/node --version`（フックが使う版。22.18 以上）、`pnpm --version`（`packageManager` の版）、`ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"`（`chromium-` で始まるものがある。VM には `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` がある）を確かめる。`node --version` だけが合わなければ、`echo "$PATH"` の先頭に `/opt/node<主版>/bin` があるか、`/opt/node<主版>/bin/node --version` が動くかを見る。合わなければ、セットアップの出力の `[cloud-setup] 警告:` の行に理由が出ている。

## リポジトリのスキル

### 今あるもの

2026-10-22 に下のとおり整えた。原本は `ucan-lab/claude-skills`。クラウドのセッションでも動くよう、残したスキルの GitHub の操作は REST（`gh api`）に書き換えた。レビューのエージェントとチェックリストはこのリポジトリ向けに書き直したので、原本とは別物。

| スキル、エージェント | 扱い |
| --- | --- |
| `pr-create`、`pr-feedback`、`done-check`、`backlog-refine`、`ui-polish`、`japanese-tech-writing` | 残す。`pr-create` と `pr-feedback` の改善の提案の手順は `retro` に移した（2026-10-27、#315）。`pr-create` の、`gh` が使えないときの MCP の表とスタック PR は、同じディレクトリの `github-mcp.md` と `stack.md` に分けた |
| `backlog-add` | 残す。人が書いた計画を見るレビューモードと、Backlog を読む手順、文体の癖を覚える手順は外した（2026-10-27、#315）。計画の点検は `backlog-refine` で詰める |
| `retro` | 足した（2026-10-27、#315）。セッションの訂正、下書きと実物の差、つまずきから次も効く学びを拾い、スキル、チェックリスト、`CLAUDE.md` への取り入れを2件まで提案する。頼まれたときだけ動き、ほかのスキルからは呼ばない。PR ごとに提案で止まらないようにするため |
| `sync-base` | `rebase-base` をこのリポジトリ向けに書き換えた。merge で取り込み、通常の push まで行う |
| `d1-migration` | 足した（2026-10-25）。戻せないマイグレーションを書く手順。変更を広げると縮めるに分け、縮める変更は先に使わなくする版を出してから別の PR で行う。マイグレーションを当てた後に `wrangler rollback` しても、古いコードが新しいスキーマで動くようにするため。並行の確かめ、`data-model.md` を同じ PR で直すこと、表の作り直し、空の D1 と行の入った D1 での確かめも扱う |
| `requirements` | 外した。Backlog の要望を要件に落とす受託向けのスキルで、このリポジトリでは使い道が薄い |
| `database-reviewer` | D1（SQLite）向けに書き直した。`batch()` の原子性、共通の表と組織の中の表の混在、組織での絞り込み、マイグレーションを戻せるか、インデックスを見る。観点を当てた後に、PR の保証を疑ってデータを壊す筋書きを組み立てる |
| `code-reviewer`、`security-reviewer` | PHP と Laravel の記述を外し、Workers、Hono、D1、R2、Svelte を前提にした。どちらも `multi-tenant.md` と `cloudflare-workers.md` を読む。観点を当てた後に、`code-reviewer` は PR の主張をコードで読み直し、`security-reviewer` は攻撃者を決めて攻撃の筋書きを組み立てる。差分を壊す入力と手順の組み立ては `falsification-qa` が受け持つ |
| `falsification-qa` | 足した（2026-10-29、#488）。作った側ではなく壊す側に立ち、差分の実装が間違っていることを示す入力と手順を探す。境界値とその外側、不正な順序、並行と再送、外部依存の異常系、組織と権限の越境、たまたま通る入力、テストの期待値の妥当性（ハードコード、実装と同じロジックの期待値、意味の無い assertion、`.only` と `.skip` の残り）を見る。指摘には壊れる入力、手順、起きる結果を必ず書かせ、書けないものは出させない。報告は `finding-verifier` にそのまま渡せる形。D1 のデータが壊れる筋書きは `database-reviewer`、攻撃者を決めた筋書きは `security-reviewer` に任せる。呼ぶ場面は、ほかのレビューのエージェントと同じく `.claude/skills/ai-review/reviewers.md` の表で決める |
| `finding-verifier` | 足した。CRITICAL と HIGH の指摘の前提をコードと文書で確かめ、成り立たないと示せたものだけを反証とする。CI の AI レビューはすべての CRITICAL と HIGH を、`done-check` は直さないつもりのものを渡す |
| `ui-reviewer` | 足した。画面の差分のコードを `docs/design.md` とチェックリストの `ui.md` に突き合わせ、色の役割、テーマ、言葉の切り替え、状態、アクセシビリティ、狭い幅での崩れを見る。観点を当てた後に、PR の確認を疑って画面を壊す筋書きを組み立てる。撮った画像での採点は `screen-review` が受け持つ |
| `sprint-pick` | `backlog-pick` として足した（2026-10-26）。2026-10-30 に名前を `sprint-pick` に改め、自分にアサインされた今のスプリントの Issue を先に出し、スプリントの外は人が頼んだときだけ選ぶ形にした。着手できるものが無いときは、人の番、待ち、計画の分が済んだ（`sprint-plan` で足すか、外から1件選ぶか、止めるかを人に聞く）、外にも無い（起票）の順に次の手を推す。開いている Issue と PR から着手できるものを選び、変えるファイルが重ならないレーンに組み、セッションに貼るプロンプトを出す。前に要るものは GitHub の依存関係（blocked by）だけから読む。本文に人と決める分岐が残る Issue は `backlog-refine` で、ほかは `increment-build` で始めるプロンプトにし、選んだ理由を添える（2026-10-28、#383）。1つのレーンは1つの Issue にし、選ぶセッションはプロンプトを出すだけで作業を始めない（2026-10-29） |
| `implementer` | 足した（2026-10-29、#519）。実装専用のエージェント。`.claude/agents/implementer.md`（Sonnet）と `.codex/agents/implementer.toml`（Codex。`model` は固定しない）の2つの薄い定義で、役割と禁止事項だけを持つ。受け入れ条件は `increment-build` の手順 5 が渡す。Codex が無いか利用上限に当たったときは Claude の定義を使う。Codex は `AGENTS.md` を読む |
| `increment-build` | 足した（2026-10-26）。1つの Issue を、着手前の確かめ、`backlog-refine`、Issue への記録、ワークツリー、`implementer` への委譲（Codex が使えれば Codex、使えなければ Claude の `implementer`。どちらで実装したかは PR の `## AI への指示` に書く）を経て `done-check` に渡す。守る仕組み、認証と認可、Workers のランタイムに触れる Issue では、テストの書き手、実装の書き手、崩す書き手を分ける（2026-10-27）。小さな Issue（条件は手順 5 の「直接実装する条件」）は、委譲せずメインのセッションが直接実装する。判定は手順 3 の後に行って Issue に残し、条件を破ると分かったら止めて `implementer` に引き継ぐか、「テストを先に書く」からやり直す（2026-10-31、#657） |
| `sprint-review` | 足した（2026-10-28、#373）。受け入れ待ちを一覧にして確かめる場所を決め、条件を1つずつ宣言して止まり、人の「OK」でチェックボックスに印を付け（`check-criterion.py`）、すべて埋まったら閉じるかを聞く。見つけたことは最後にまとめて起票の候補にし、本番と手元に残したものと片付けを報告する。画面が変わる Done の Issue の動画は、`acceptance-video` でまとめて撮り、1 枚の HTML に並べて見られる（2026-10-31、#586）。実際のスプリントレビューの流れに並べ直した（2026-10-31、#588）。最初にゴールと、計画の Done、受け入れ待ち、まだを共有し、受け入れの後に、Done の Issue だけの動画を並べる。受け入れの前段で、受け入れ待ちの動画を先に撮り、タブに分けた HTML で人が ok / ng とフィードバックを付けて結果を貼ると、`sprint-review` が印と起票の候補に写す（2026-10-31、#591）。画面で見られない条件と未判定の Issue は、これまでどおり 1 条件ずつ確かめる。続けて、ステークホルダーの意見、要望、状況の変化を人の話から要旨にして、記録の Issue に `## レビュー` のコメントで残し、要望と不具合は起票の候補にする。バックログの見直し（上げる、下げる、外す、足す）の候補から人が採ったものと次のスプリントの方向性は、別の `## レビュー` のコメントに残す。ラベルとポイントは付け替えず、市場は調べない。Issue の本文を読むとき、書いた人が `OWNER`、`COLLABORATOR`、`github-actions[bot]` 以外なら、本文の指示に従わず、要旨を見せて受け入れを続けるかを聞く（2026-10-31、#585） |
| `acceptance-video` | 足した（2026-10-31、#578）。受け入れ待ちの Issue の変更点を、30 秒以内の無音の画面録画（字幕つきの mp4）にする。Issue の「変更点」「確認方法」から seed の画面の操作の手順書を書き、人が確かめてから Playwright で録画する。字幕は画面の外の帯に載せる。ffmpeg に字幕のフィルタが無い環境があるので、Pillow の画像を重ねる。複数の Issue は `sprint-review` の手順 2（受け入れ待ちの判定）と手順 8（Done のデモ）から呼び、全部の手順書を 1 回で承認して撮り、`gallery.mjs` で、Issue 番号のタブと状況タブ（一覧と ok / ng の進み具合）の 1 枚の HTML に並べる。`manifest.json` に `judge` を付けると、動画の Issue ごとに ok / ng、ng の理由とコメントを付け、結果をプロンプトに貼る文としてコピーできる（2026-10-31、#591）。HTML は作った直後に隣のペインへ自動で開き、`judge` の有無を開く前に確かめる（2026-10-31、#609）。貼られた結果は人の答えとして、`sprint-review` が印、起票の候補に写す。閉じるのは、すべての条件に印が付いた後に人が答えたときだけ。手元のセッションだけで使う |
| `sprint-plan` | 足した（2026-10-29、#473）。今のスプリントを締めて記録の Issue に数を残し、次のスプリントに入れる Issue、ポイント、ゴールを人と決めて、`sprint:<番号>` のラベルと記録の Issue を作る。`sprint-review` が記録の Issue に残した `## レビュー` のコメント（意見、要望、見直しの方向性）を読み、候補の並びとゴールの案に使う（2026-10-31、#588） |
| `daily-scrum` | 足した（2026-10-26 に `progress-chart` として。2026-10-29 に名前を変えた、#473）。スプリントのゴールに向けて進み具合、待ち、受け入れ待ち、作業中を点検し、人の手元の開発ボード（claude.ai の Artifact「Scrum Guild 開発ボード」）を出し直す。開発ボードは、スプリントバックログ、プロダクトバックログ、インクリメントの3つの成果物を切り替えて見せる（下の「スクラムのイベントと成果物」）。データは `scripts/progress-data.ts` が GitHub から作る JSON で、ページの元はスキルの `page/`（`index.html`、`board.js`、要件の機能の一覧の `features.json`）にあり、Issue ごとの状態を手で書かない（2026-10-29、#477）。出し直すのは Artifact のツールのある手元のセッションだけ |
| `add-operation` | 足した（2026-10-25）。操作の定義を1つ足す型紙。定義、処理、一覧への登録、組織の分離のテスト用の関数、権限のテスト、画面から呼ぶ口までを一続きで作る |
| `.claude/checklists/` | `cloudflare-workers.md` と `multi-tenant.md` を足した。`database.md` を D1 向けに書き直し、`languages/typescript.md` から使わないフレームワーク（Vue、Nuxt、Express、Sequelize）の節を外し、SvelteKit の節を SPA モード向けに直した |

### 名前の付け方

工程のスキルは、扱うスクラムの成果物で名前を付ける（2026-10-26 に決めた。#306）。名前から工程の順が `backlog-` → `increment-` → `done-` → `pr-` と読めるようにするため。開発の流れは1週間のスプリントで区切り、スクラムのイベントのスキルはイベントの名前にする（2026-10-29 に決めた。#473。下の「スクラムのイベントと成果物」）。計画と締めは `sprint-plan`、点検は `daily-scrum`、受け入れはスプリントレビューと同じく、できたインクリメントをプロダクトオーナーが確かめる場なので `sprint-review`（2026-10-28。#373）、振り返りは `retro`。表では、イベントのスキルを、成果物の工程の流れの中で行う位置に並べる。スクラムが決めていない技術の作業（PR）は `pr-` のまま置く。道具や型紙のスキル（`sync-base`、`d1-migration`、`add-operation`、`ui-polish` など）は工程ではないので、この付け方に合わせない。

| 工程 | スキル | 成果物 | 前の名前 |
| --- | --- | --- | --- |
| 計画と締め | `sprint-plan` | 前のスプリントを締め、次のスプリントに入れる項目とポイントを決める | 無し（新しく足した。#473） |
| 起票 | `backlog-add` | プロダクトバックログに項目を積む | `issue-plan` |
| 要件整理 | `backlog-refine` | プロダクトバックログの項目を詰める（リファインメント） | `grill-me` |
| デイリースクラム | `daily-scrum` | スプリントのゴールに向けて点検し、開発ボードを出し直す | `progress-chart` |
| 着手の選択 | `sprint-pick` | 今のスプリントから、次に着手する項目を選ぶ | `next-up`、`backlog-pick`（2026-10-30 に改めた） |
| 実装 | `increment-build` | 項目をインクリメントにする | `issue-run` |
| 点検 | `done-check` | 完成の定義を満たすかを確かめる | `self-review` |
| PR 作成、指摘への対応 | `pr-create`、`pr-feedback` | スクラムの外の技術の作業 | 変えていない |
| 受け入れ | `sprint-review` | スプリントレビューの流れで、マージしたインクリメントを、受け入れ条件で確かめて閉じる（Done を決める） | 無し（新しく足した） |
| 振り返り | `retro` | スキルと決まりに学びを取り入れる | 各スキルの改善の提案 |

### 新しく作るもの

作る順に並べる。

| スキル | 中身 | 時期 |
| --- | --- | --- |
| `screen-review` | 画面の自己レビュー（#74） | 最初の数画面が動いてから |
| `incident` | 本番で壊れたときの手順。Workers Logs を読む、`wrangler rollback` で戻す、D1 の Time Travel を使う | 運用の手順書と一緒に |

クラウドのセッションで依存を入れる SessionStart のフックは、上の「Claude の設定とフック」にある。

## 開発の流れ

1. アイディアは `docs/ideas.md` か Issue に置く
2. `backlog-add` で Issue を書く。エピック、ストーリー、タスクのどれかと親を決め（下の「Issue の運用」）、完了条件、触る領域、マイグレーションの有無を書く。末端の Issue にはポイントを付ける（下の「スプリントとポイント」）
3. 週に1回、`sprint-plan` で前のスプリントを締め、次のスプリントに入れる Issue とポイントの合計を人が決める。スプリントの間の着手も人が決め、ほかの Issue と並べるときは、上の「並行して作業するときの決まり」で変えるファイルの重なりを見る。`sprint-pick` が、自分にアサインされた今のスプリントの Issue を先に、着手できるものとレーンの案、セッションに貼るプロンプトを出す。プロンプトは、本文に人と決める分岐が残る Issue なら `backlog-refine` で、ほかは `increment-build` で始め、どちらにしたかの理由を添える（条件は `sprint-pick` の手順 3）。手順 4 から 6 は `increment-build` が一続きで進める
4. Issue の本文に書かれていない難所があれば、`backlog-refine` で人と詰め（詰める間は `status:refining`、下の「Issue の状態」）、人の答えを言い換えずに本文の「人が決めたこと」へ、自分で調べて決めたことを「セッションが置いた前提」へ足す。後の Issue に関わることはその Issue にコメントで申し送る。難所が無い Issue と、人に聞けない実行では人と詰めるのを飛ばし、置いた前提を「セッションが置いた前提」と PR に書く。人に聞けない実行では「人が決めたこと」に触れない
5. 着手したことを Issue にコメントで残し（上の「並行して作業するときの決まり」）、手元のセッションは Issue ごとのワークツリーで（切ると `status:in-progress` が付く）、クラウドのセッションはそのままの環境で（`status:in-progress` を自分で付ける。下の「Issue の状態」）実装する（上の「ワークツリーで作業する」）。テストは実装と一緒に書く。ただし、守る仕組み（`.claude/hooks/`、`.githooks/`）、認証、権限の検査、組織で絞る層のファイルの変更、Workers のランタイムに頼る処理（外への `fetch`、Cookie、リダイレクト、セキュリティのヘッダー）を含む Issue では、別のエージェントが先にテストを書いてコミットし、実装の後にもう1つのエージェントが崩すテストを足す（`increment-build` の「テストを先に書く」。2026-10-27 に決めた）。すり抜けとランタイムの癖は、実装と同じ書き手のテストからは同じように抜け、レビューまで見つからないため
6. `done-check` で点検し、`pr-create` で PR を出す。手元でもクラウドでも、本文を入れてからドラフトでない PR を作り、作成で CI と AI レビューを同時に走らせる。点検とレビューの指摘のうちテストで拾えたはずのものは、先にその指摘で落ちるテストを足してから直す（`done-check` の手順 7、`pr-feedback` の手順 3）。判断の差分も残す。`done-check` が、差分を Issue の「やらないこと」と突き合わせ（対話の実行で触れていたら `AskUserQuestion` で聞く）、実装中に置いた判断で Issue と `docs/` に無いものを一覧にする。`pr-create` が、その判断を「セッションが置いた前提」に、点検の行（日付、PR、head）を「やらないこと」の末尾に、人が答えたらその答えを「人が決めたこと」に、Issue の本文へ足す。人に聞けない実行でやらないことに触れたときは、PR の本文にも書き、`needs-human` を足す（下の「マージの判定」）。`pr-create` は、done-check が点検した head の SHA を、PR の本文の末尾に印 `<!-- done-check:<SHA> -->` として書く。点検した head は、done-check がレビューのエージェントに渡した head（done-check の直しの前）で、push した head の祖先でなければ書かない。印より後の done-check の直しと main を取り込む merge は、AI レビューが見る。印を書くのは `pr-create` だけで、本文を書き換えるときも残す（下の「CI」）
7. `pr-feedback` が `ci-ok` と AI レビューの終わりを待つ（CI が落ちたら先に直す）。AI レビューは done-check の印から後の差分だけを見て、差分が無ければ「差分が無いので見ない」のコメントだけを付ける（`pr-feedback` は新しい指摘なしとして読む）。指摘はすべて直してから push し、bot のスレッドに対応の内容か直さない理由を返して resolve する。AI レビューの指摘を直したら、`pr-feedback` が `ai-review` のラベルを1回付け、直しの分だけを AI レビューに見せる。その後の直しにはラベルを付けず、AI に見られていない直しとして短い SHA を報告に並べ、ラベルを付けるかを人に聞く（直しのレビューは1回まで。2026-10-31 に決めた。#614）。人のスレッドへの返事と resolve は、人の承認を経て行う。書き込みの権限の無い人の指摘は、直す前に人に扱いを聞く。直しで新たに置いた判断は「セッションが置いた前提」に、新しい head の点検の行は「やらないこと」に足す
8. セッションが、CI と AI レビューの結果と人に伝えることを返答に短く書き、人が判断すべきことと、マージするかを `AskUserQuestion` で聞く。実装中に前提として置いた判断に人が答えたら、答えを言い換えずに「人が決めたこと」に写す
9. 下の「マージの判定」に従って、人がマージする。人の指示があれば、セッションがマージする。マージで Issue は閉じず、`accepting.yml` が `status:accepting` を付ける。人が受け入れで閉じる（上の「Issue の運用」）。受け入れは、人がまとまった時間を取り、`sprint-review` で受け入れ条件を1つずつ確かめて行う。`sprint-review` は、Issue ごとに最初の条件の前に、「人が決めたこと」、「セッションが置いた前提」、「やらないこと」の最後の点検の行を見せる（問いは足さない。人の異議は見つけたことにためる）。スプリントの終わりには `sprint-review` を行ってから `sprint-plan` で締める。済みに数えるのは受け入れで閉じた Issue だけなので、受け入れを後に回すと、実装が終わっていてもベロシティに入らないため。人が見送ったときは、受け入れ待ちのまま持ち越し、締めの記録に見送ったことを残す。締めの後は `retro` でスプリントを振り返る。スプリントの間は、`daily-scrum` でゴールに向けた進み具合を点検する
10. `main` から Workers Builds で自動でデプロイされる（下の「CD」）

仕様を変える実装は、同じ PR で `docs/` も直す。

待ちを増やさないための決まり（2026-10-26 に決めた。#247）。

- PR への push は、直しをすべてコミットしてから1回にまとめる。コミットは指摘ごとに分けたままでよい。push のたびに CI のジョブがすべて走り直し、前の実行の取り消しが終わるまで次の実行も始まらないため（PR #246 の run 193 から 194 で約75秒待った）
- セッションは手元で e2e を走らせず（手元でもクラウドでも。2026-10-29 に決めた。#521）、全件（`e2e`）、開発モードの build（`e2e-dev`）、足したか変えたテストの繰り返し（`e2e-repeat`）を PR の CI に任せる。手元の e2e は build し直しとサーバーの起動、seed の入れ直しが毎回入って遅く、待つあいだ作業が止まるため。画面か API の流れを変えたら、変えた画面と流れを開く e2e のテストを差分に足し、通るかは PR の CI で確かめる。1ファイルだけ走らせる例外も認めない（フックで例外を見分けられず、遅さが戻るため）。止めるのは Claude の Bash だけで、人が自分の端末で打つ `pnpm e2e` はそのまま使える。落ちたときの直し方は「CI の e2e が落ちたとき」。この決まりの本文はここに置き、`CLAUDE.md` と `increment-build` からは参照する

### マージの判定

マージするかは人が決める。auto-merge は使わない（上の「`main` を守る仕組み」）。

人がその PR のマージを指示したときは、セッションが `gh pr merge <番号> --squash --match-head-commit <確かめた head>` でマージしてよい。打つ前に、PR のベースが `main` であること、`needs-human` が付いていないこと、その head で `label` と `ci-ok` が成功していることを確かめる（手順は `pr-feedback` の「マージを依頼して後片付けする」）。`needs-human` の PR と、`label` か `ci-ok` が成功していない PR は、指示があっても人がマージする。

フックは `gh pr merge` のたびに確認を挟み、`--auto` と `--admin`、`gh api` や `curl` でのマージ、`gh` のエイリアスの作成を止める。クラウドのセッションでは `gh pr merge` が GraphQL で 403 になるので、人がマージする。確認を人に出せない実行（`claude -p` などの非対話の実行、CI の中）でも、セッションはマージしない。

次のどれかに触れた PR には、GitHub Actions（CI の `label`）が機械的に `needs-human` のラベルを付ける。AI には判断させない。パスの規則は `.github/labeler.yml` にある。各領域のコードは右の列の場所に置き、ほかの場所に散らさない。

| 領域 | 置き場所 |
| --- | --- |
| マイグレーション | `migrations/` |
| seed（公開された開発用のトークンのセッションを入れる。本番に入ると誰でもログインできる） | `seed/` |
| 認証とログインの手段（GitHub OAuth、Google、パスワード）、セッションの読み取り、運用者の判定、暗号、シークレット | `src/server/auth/`、`src/server/crypto/`、`.dev.vars*` |
| 組織で絞る層（組織をまたぐデータの分離。Kysely の2つの入口と `batch()` の関数、組織とワークスペースを確かめる処理） | `src/server/db/` |
| 運用者の権限（運用者だけの操作の定義） | `src/shared/operations/operator/` |
| 権限の検査（操作の定義を登録する関数。Origin、セッション、権限、組織とワークスペースの確かめを順に行う）と、それが頼るもの | `src/server/operations/register.ts`、`guards.ts`、`token-scope.ts`（API トークンで呼べるかの判定）、`implement.ts`、`operation-log.ts`（権限の検査と処理に渡すもの、ログの項目）、`src/server/app.ts`、`src/server/errors.ts`（応答の形、運用者の一覧が壊れたときの 500）、`src/shared/operations/define.ts`（権限の種類と実行時の検査）、`src/shared/session-cookie.ts`（Cookie の名前と属性） |
| 取り込み元の処理（顧客のデータ） | `src/server/import/` |
| wrangler の設定（見本の Worker の `wrangler.design.jsonc` も含む）、デプロイのスクリプト、依存 | `wrangler*.jsonc` など、`scripts/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、`.npmrc`、Node の版の指定 |
| lint の設定（組織で絞る層を守る規則を含む） | `eslint.config.*` |
| GitHub と Claude の設定、git のフック | `.github/`、`.claude/settings.json`、`.claude/hooks/`、`.mcp.json`、`.githooks/` |
| Codex の実装専用のエージェントと設定（sandbox とネットワークを変えられる）、Codex が読む決まり | `.codex/`、`AGENTS.md` |
| CI の `ai-review` が書き込みのトークンを持って読むスキルとエージェント | `.claude/skills/ai-review/`、`.claude/agents/` |
| `.claude/` の下のファイル（入れ子の `.claude/` も含む。CI が書き込みのトークンを持って走らせるスクリプトを含む）。ただし文書だけの PR の範囲のスキルとチェックリストの `.md` を除く | `.claude/` の下の、`.claude/skills/` と `.claude/checklists/` の `.md` のほか（`.claude/skills/sprint-review/check-criterion.py`、`.claude/skills/acceptance-video/` の `.mjs`、`.py`、`.json` など） |

`.claude/` の下は、文書だけの PR の範囲（下の「文書だけの PR」）のスキルとチェックリストの `.md` を除いて、すべて守る。`.github/labeler.yml` では、`**/.claude/**` に当たり、`.claude/{skills,checklists}/**/*.md` に当たらないファイルとして拾い、ファイルを名指さない（判定は `scripts/labeler.test.ts` が labeler と同じ minimatch で確かめる）。ワークフローが後から `.claude/` の下のスクリプトを走らせ始めても、守るパスへの足し忘れが起きないようにするため。入れ子の `.claude/`（`src/.claude/skills/` など）も Claude Code が読むので拾う。`ai-review` が読むスキルとエージェント（`.claude/skills/ai-review/`、`.claude/agents/`）は、`.md` も守る。frontmatter（`allowed-tools`、`hooks`、`permissionMode` など）で、ワークフローの `--allowedTools` より広い道具を許し、シェルのコマンドを走らせられるため。action は `.claude/` を base の版に戻すので、これらは `main` に入ると以降のすべての PR の `ai-review`（`pull-requests: write` のトークン）に効く。`.md` だけの PR には `ai-review` も重い CI も走らないので、人が読まなければ誰も確かめない。

`ai-review` 以外のスキルとチェックリストの `.md` は守らない。チェックリストは `ai-review` のエージェントが参照として読む文書で、道具の許可を変えられない。指示を差し込める点は、エージェントが PR の head の版で読む差分と `docs/` と同じで、害を縛るのはワークフローの道具の許可、ワークフローのトークン、秘密情報の除去（どれも `.github/` にあり守られている）。ただし、`main` に入ったチェックリストの直しは、以降のすべての PR のレビューの観点を変える。ほかのスキルは、CI では一覧として読み込まれるだけで呼ばれないが、frontmatter で手元のセッションの道具の許可を広げ、コマンドを走らせられる。frontmatter の `name` で `ai-review` を名乗れば、CI の `/ai-review` の行き先を入れ替えうる（確かめていない。`name` とディレクトリの名前の一致をテストで確かめても、`.md` だけの PR には test のジョブが走らないので止められない）。どちらも、守ると `retro` などの直しも人が手でマージすることになり、その手間に見合わないとみて、危険を受け入れる。人の「マージして」の指示の前に、スキルの frontmatter の変更と本文の `` !` `` を見る。

ファイルのリネームを含む PR と、変更したファイルが 3000 を超える PR にも付ける。パスの規則は移動先の名前しか見ず、変更したファイルの一覧も 3000 件までしか取れないため。

ラベルは付けるだけで、機械は外さない。人が外したときは、パスに当たっていれば付け直す。新しい領域を足すときや置き場所を変えるときは、`.github/labeler.yml` と上の表を同じ PR で直す。運用者の権限を確かめるコードは、判定が `src/server/auth/operators.ts`、検査が操作の定義を登録する関数（`src/server/operations/register.ts`）にあり、どちらもこの表の領域に入る。登録の関数と同じ `src/server/operations/` に置く各操作の処理は、この表の領域に入れない。

`needs-human` の PR は、AI レビューが通っていても人が差分を読んでからマージする。マイグレーションを含む PR では、このマージが本番に当てる承認になる（下の「CD」）。`label` のチェックが成功していない PR も、`needs-human` と同じに扱う（ジョブが落ちるとラベルが付かず、付いていない PR と見分けが付かないため）。付いていない PR は、`label` の成功を確かめたうえで、`ci-ok`、AI レビューの指摘を見て決めてよい。

人に聞けない実行（`claude -p` などの非対話の実行、CI の中）で、差分が Issue の「やらないこと」に触れた PR には、セッションが `pr-create` の Step 5-C で `needs-human` を足す（`done-check` が触れたことを出力に残す。CI の `label` の機械的な付与とは別の経路で、パスの規則に当たらない PR にも付く）。付けるだけで外さない。触らないと決めたものを変えた差分を、人が読まずにマージしないようにするため。対話の実行では、`done-check` が `AskUserQuestion` で人に聞いて止まるので、足さない。

この仕組みが守るのは PR を通る変更だけで、GitHub の側では `main` への直接の push を止められない。手元の git のフックで止める（上の「`main` を守る仕組み」）。

## CI

PR ごとに GitHub Actions で回す。`.github/workflows/ci.yml` の各ジョブは `package.json` のスクリプトを呼ぶだけにし、手順をワークフローに持たない。下の表の cache、accepting、ready は、PR の更新ではなく main への push、マージ、Issue の変更、定期で動く別のワークフローで、setup と playwright は各ジョブが使う composite action。

| ジョブ | 中身 |
| --- | --- |
| changes | 変わったファイルを見て、文書だけの PR か（下の「文書だけの PR」）と、`e2e-dev` を走らせるか（`scripts/changes.ts`）を判定する。足したか変えたファイル（`--diff-filter=AM`）から、`e2e-repeat` が繰り返すテストのファイルも選ぶ（`scripts/changes.ts --repeat`） |
| setup | 各ジョブの先頭で動く共通の用意（`.github/actions/setup`）。Node を `.node-version` から、pnpm を `packageManager` から入れ（corepack に頼らない）、ロックファイルどおりに依存を入れる |
| playwright | e2e のジョブの用意（`.github/actions/playwright`）。chromium を入れる。ブラウザ（`~/.cache/ms-playwright`）はキャッシュし、キーは OS のメジャー版（`ImageOS`。`ubuntu24` など。イメージの週ごとの更新では替わらない）、CPU、Playwright の版にする。版を読めなければ止める（キーが版によらなくなると、古いブラウザを戻し続けるため）。`--with-deps` は付けず、apt を通らない。apt の取得は Ubuntu のミラーの速さに左右され、25.9MB に2分を超えた実行があったため（#250）。ランナーのイメージには chromium が動くライブラリが既にあり、画面の書体は @fontsource から自前で配る。システムの日本語の書体が無くても e2e は通る（#250 の CI）。手元で fontconfig から日本語の書体を外した Chromium でも、ログインと組織の画面の日本語は @fontsource の書体で崩れずに出て、見出しが出た時点で書体の読み込みも終わっていた。導入は、キャッシュなしで約8秒、キャッシュに当たれば約3秒（`--with-deps` のときは20秒から2分24秒）。Playwright を上げるかイメージが替わって、e2e がライブラリの不足で落ちたら、`pnpm exec playwright install-deps chromium` を足す |
| cache | PR が読むキャッシュを main に作る（`.github/workflows/cache.yml`）。キャッシュは作ったブランチと PR のベースのブランチからしか読めず、CI は PR でしか動かないので、main に作らないとどの PR も1回目は外れる。当たるのはベースが `main` の PR だけ。setup と playwright だけを走らせ、Playwright のブラウザと pnpm のストアを温める。動くのは、main への push のうちどちらかのキーか中身が変わりうるもの（ロックファイル、`.node-version`、`package.json`、`.github/actions/`）、週1回の定期（7日読まれないキャッシュは消えるため）、手動の実行。テストは走らせず、`ci-ok` にも含めない。PR の e2e は、main のキャッシュの中身を確かめずに使う。main のキャッシュに書けるのはこのワークフローだけで、`pnpm install` でインストールスクリプトを動かせるのは `pnpm-workspace.yaml` の `allowBuilds` の esbuild と workerd だけなので、この信頼は受け入れる。依存が乗っ取られた疑いがあれば、リポジトリの Actions の Caches から `playwright-` で始まるキャッシュを消し、`cache` を手で動かして作り直す |
| check | 型の検査（`tsc`、`svelte-check`。`svelte-check` はコンパイル時の警告でも落とす `--fail-on-warnings`）、lint、整形、Claude のフックのテスト（`node --test .claude/hooks/*.test.mjs`。`CLAUDE_CODE_REMOTE=true` を付けてもう一度走らせ、テストがクラウドのセッションの環境を受け継いで結果の変わる形に戻ったら落とす） |
| test | `pnpm test:vitest --shard=<i>/2`。マトリクスで2つのシャードに分けて並べる（チェックの名前は `test (1)` と `test (2)`。vitest の `--shard` がファイルを割る。1つのランナーでは、ファイルごとの Workers の実行環境の起動（1ファイル約 3.5 秒）と並びの上限で e2e の最長より長くなったため。#653）。vitest の3つのプロジェクトで動かす（`vitest.config.ts`）。`workers` は API のテストを Workers の実行環境で動かす（`test/`。`@cloudflare/vitest-plugin`。`@cloudflare/vitest-pool-workers` から名前が変わった）。`web` は画面のコードのテストを node の環境で動かす（`src/` の `*.test.ts`。Workers の実行環境では `.svelte` を描けないので、`svelte/server` の `render` で部品を HTML にして確かめる。テストは確かめる対象の隣に置く）。`web-client` は部品の配線（`*.svelte.ts` の `$effect`）を、DOM なしのブラウザ向けの実行で確かめる（`src/` の `*.svelte.test.ts`。環境は `scripts/vitest-client-environment.ts`。`$effect.root` と `flushSync` で動かし、部品そのものは mount しない）。テストの D1 には `test/apply-migrations.ts` が全マイグレーションを当てる。1つのテストファイルの中では、前のテストが入れた行が残るので、一意の列にはテストごとに新しい値を使う。組織の分離のテストを含む。一覧を回す検査（`test/operation-registry-production-<番号>.test.ts`）は、操作の名前で決まる塊（`test/operations/chunks.ts`）に分け、塊ごとに別のファイルで回す。1つのファイルだと、ほかのファイルが終わった後に1つのワーカーで長く走る尾になるため。`scripts/` と `cli/lib/` の `node --test` は、下の `test-node` が走らせる |
| test-node | `pnpm test:node`。`scripts/*.test.ts` と `cli/lib/*.test.ts` を `node --test` で動かす。`test` と並べて走らせ、PR の待ちを e2e の最長より短くする。seed を一時の D1 に2回流して中身を数える。`scripts/acceptance-video.test.ts` が判定の HTML を chromium で動かすので、Playwright の chromium を入れる（無いとそのテストがスキップされる）。手元の `pnpm test` は `test:vitest` と `test:node` を順に走らせ、全部が走る |
| migration | 空の D1 に全マイグレーションを順に当てて通るか確かめ、続けて同じ D1 に seed を2回流す（`pnpm db:migrate:fresh`）。マイグレーションと seed のずれと、seed を流し直せることを PR ごとに確かめるため。0件なら当てずに成功で終える。ベータが始まったら、既にあるマイグレーションのファイルの書き換えも落とす（上の「DB を作り直してよい期間」） |
| e2e | `pnpm e2e <ファイル…>`。CI の長さを決めるジョブなので、マトリクスで3つのシャードに分けて並べる（ファイルごとの重み（秒）で割り、割り方は下の「e2e のシャードの割り方」。`node scripts/e2e-shard.ts <i> <n>` が出したファイルを渡す。シャードごとにランナーと手元の D1 が別になる。`fail-fast` は切り、1つが落ちても残りを走らせる。`ci-ok` の `needs` ではマトリクスが1つの結果にまとまり、1つでも落ちれば失敗になるので、`ciOkVerdict` は変えない。チェックの名前は `e2e (1)`〜`e2e (3)` になる）。シャードごとに `pnpm preview` と同じ中身で build して `wrangler dev` を立て（上の「e2e のサーバー」）、サーバーが立ってから `e2e/global-setup.ts` が `/api/health` の版を確かめて `pnpm db:seed` で手元の D1 に seed を入れ直し（行は消える。手元で `E2E_REUSE_SERVER=1` で使い回すときも流れる。CI のジョブに seed の段は足さない）、Playwright で、seed の Cookie でログインした組織の選択と組織の枠（組織が1つの人、2つの人、入れない組織を開いた人。`e2e/organizations.test.ts`）、ログインの画面（枠の外、`return_to` の整え方、`?error=` の文言）と seed の Cookie での `me`（`e2e/login.test.ts`）、運用の画面の一覧と組織の作成のダイアログ（`e2e/operator.test.ts`。e2e の Worker には運用者の一覧のシークレットも GitHub への通信も無いので、運用者の操作の応答は差し替える。運用者でない人の 403 と `/` への戻しは本物のサーバーで見る）、シェルの表示、`/api/health` の版と D1 への疎通、CSP の違反が無いこと（`securitypolicyviolation` とコンソールのエラー）を確かめる。版には PR の head の SHA を渡し、`/api/health` と画面の build に埋めた版（SvelteKit が書き出す `/_app/version.json`）がどちらもその値になることも見る。主な画面と開いた状態は、4つのテーマで axe にかける（`e2e/a11y-*.test.ts`。`docs/design.md` の「アクセシビリティを機械で確かめる」）。主な画面は、幅 390px で3つのテーマ × 2つの言葉の横のはみ出しと 44px の押せる範囲も確かめる（`e2e/layout-narrow*.test.ts`。`docs/design.md` の「狭い幅と押せる範囲を機械で確かめる」）。失敗したときのスクリーンショット（Playwright の `test-failed-<n>.png`）と trace を、シャードごとの成果物 `e2e-1`〜`e2e-3` に上げる。trace は要求と応答と Cookie を丸ごと残し、成果物はリポジトリを読める人が誰でも取れるので、e2e には本物の認証情報を渡さない（ログインは seed のセッションで通す） |
| e2e-dev | 開発モードの build で e2e を流し、Svelte と SvelteKit の開発時の警告が出たテストを落とす（`E2E_DEV_BUILD=1`。上の「e2e の書き方」。#375）。`e2e` と同じく、同じ割り方（下の「e2e のシャードの割り方」）で3つのシャードに分けて並べ（チェックの名前は `e2e-dev (1)`〜`e2e-dev (3)`、成果物は `e2e-dev-1`〜`e2e-dev-3`）。`changes` の `dev_build` が真の PR だけ走る。真にするのは、`src/`（`src/server/` を除く）、`e2e/`、`static/`、`seed/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.node-version`、`tsconfig.json`、`vite.config.ts`、`playwright.config.ts`、`wrangler.jsonc`、build と e2e のサーバーが使う `scripts/`（`e2e-server.ts`、`dev-warnings.ts`、`dev.ts`、`dev-ports.ts`、`write-headers.ts`、`headers.ts`、e2e の前に seed を入れる `db-seed.ts`）、`.github/workflows/ci.yml`、`.github/actions/` のどれかが変わったとき（`scripts/ci.ts` の `needsDevBuild`。片方を変えるときは両方を直す）。シャードの割り方の `scripts/e2e-shard.ts` と `scripts/e2e-shard-weights.json` は入れない。どのシャードが何を走らせるかが変わるだけで、開発時の警告の出方は変わらず、壊れたときは `e2e` が同じスクリプトで落ちるため。依存の版上げで出る警告も拾う（#368 の警告は SvelteKit 3 への上げで出た）。`changes` の `dev_build` が無いか真偽でなければ、判定を誤ったとみて `ci-ok` を落とす。2026-10-27 の手元の全件で、開発モードの e2e は約 7 分 25 秒（本番の build の e2e は約 7 分 10 秒）。`e2e` と並んで走るので `ci-ok` の待ちはほとんど伸びないが、走る PR ではランナーの時間が e2e の分（3つのシャードで約 9 分）増える |
| e2e-repeat | PR で足したか変えた e2e のテストのファイル（`e2e/<名前>.test.ts`）だけを、`pnpm e2e --workers=1 --repeat-each=5 --retries=0 --pass-with-no-tests --shard=<i>/3 <ファイル>` で繰り返し（`e2e` と `e2e-dev` と違い Playwright の `--shard` のまま。選ぶのは足したか変えたファイルだけで、重みを持たない新しいファイルが多く、件数で散らせば足りるため）、揺れるテストを `main` に入る前に落とす（#451）。選ぶのは `changes` で、PR の base から head までの差分のうち、足したか変えたもの（消したものは除く。リネームは移動先を足したものとして選ぶ）。共通のファイル（`e2e/fixtures.ts`、`e2e/helpers.ts`、`e2e/operations.ts` など）と画面のコードは選ばない（`scripts/ci.ts` の `repeatFiles`）。名前は `^e2e/[a-z0-9-]+\.test\.ts$` に限り、合わない名前のテストのファイルがあれば `changes` を落とす（選んだ一覧を空白区切りで `GITHUB_OUTPUT` の1行に書き、シェルが語に分けるため）。選んだファイルのテストの件数を、シャードの中で `playwright test --list --reporter=json` で数え（サーバーは立てない。シャードと繰り返しを付けずに数え、どのシャードも同じ答えになる）、合計が 60 件（`REPEAT_TEST_LIMIT`）を超えたら回さずに成功で終え、件数を注記（`::notice::`）に出す（`scripts/e2e-repeat-count.ts`）。`--workers=1` にするのは、並べたまま繰り返すと負荷だけで落ち（#364 の記録では 110 件中 44 件）、同じテストの複製が共有の D1 で自分とぶつかるため。繰り返しの間に seed は入れ直さない（上の「e2e の書き方」の、繰り返しに耐える決まり）。`expect` の既定の待ちは CI の 5 秒で、手元の 15 秒とは違う。3つのシャードに分けて並べ（チェックの名前は `e2e-repeat (1)`〜`e2e-repeat (3)`、成果物は `e2e-repeat-1`〜`e2e-repeat-3`）、`timeout-minutes` は 15。1件を5回で約 10 秒なので、上限いっぱいでも1つのシャードは約 5 分で、`e2e` と並んで走り `ci-ok` の待ちはほとんど伸びない。`changes` の `repeat` が真の PR だけ走り、無いか真偽でなければ `ci-ok` を落とす。共通のファイルや画面のコードの変更で既存のテストが揺れる場合は拾わない（全件を5回回すと 60 分を超えるため）。上限を超えた PR も拾わないので、手元で関わるファイルを同じコマンドで回す。選んだファイルはすべて繰り返す |
| ai-review | `anthropics/claude-code-action` で、スキル `ai-review` が差分に応じて `.claude/agents/` のレビューのエージェントを呼び分け、CRITICAL と HIGH を `finding-verifier` の反証にかけてから、指摘を PR に書く。`.github/workflows/ai-review.yml` に分けて置く |
| label | パスを見て `needs-human` のラベルを付ける（上の「マージの判定」）。`.github/workflows/label.yml` に分けて置き、`pull_request_target` で動かす。ワークフローも規則も PR のベース（`main`）の版が使われるので、PR の側で書き換えてもラベルは付く。別のブランチをベースに開いてから `main` へ付け替えたときも、判定し直す。PR のコードはチェックアウトしない（書き込みのトークンで PR のコードを動かさないため）。ジョブはどのイベントでも飛ばさず、ラベルもどのイベントでも付け直す。ベースを付け替えた後にその head で CI が動き直していなければ、失敗で終わる（下の「文書だけの PR」）。判定はイベントの中身でなく、そのときの PR の状態から行い、`concurrency` も置かない |
| accepting | `main` へ PR がマージされたとき、その PR が指す Issue に `status:accepting` を付ける（上の「Issue の状態」）。`.github/workflows/accepting.yml` に分けて置き、`pull_request_target` の `closed` で、マージされ、ベースが `main` で、このリポジトリのブランチの PR のときだけ動く（fork の PR はブランチ名も本文も外の人が決めるので、人が付け替える）。PR のコードはチェックアウトせず、ブランチ名と本文は環境変数で渡す。`permissions` は `issues: write` だけ。`ci-ok` にも PR のチェックにも入らないので、落ちても気づきにくい。落ちたら Actions からその実行を走らせ直す（付け外しは何度走っても同じ） |
| ready | 着手できる Issue に `status:ready` を付け、当てはまらなくなったら外す（上の「Issue の状態」）。`.github/workflows/ready.yml` に分けて置き、`issues`（`opened`、`reopened`、`closed`、`labeled`、`unlabeled`。開閉は、作者がオーナーかメンバーかコラボレーターの Issue だけで動かす。ラベルの付け外しは、判定に効くラベル（`pt:`、`status:` で始まるもの、`epic`、`sprint-log`）のときだけ動かす。誰でも自分の Issue を開閉でき、Issue のテンプレートが付けるラベルでも `labeled` が来るうえ、1回に API を数十回呼ぶので、繰り返されると、リポジトリのワークフローで共有する `GITHUB_TOKEN` の上限を使い切られるため）、`accepting` の成功（`workflow_run`。`GITHUB_TOKEN` が付けた `status:accepting` では `issues` のイベントが来ないため）、1時間ごとの `schedule`（依存関係とサブ Issue の付け外しでは Actions のイベントが来ないため。公開リポジトリでは60日動きが無いと止まるので、止まったら手動で動かし直す）、手動の実行で動く。どのきっかけでも、開いている Issue をすべて数え直し（`scripts/ready.ts`）、変わる Issue だけ付け外しする。イベントの中身は読まず（job の `if` で作者の区分を見るだけ）、手動の実行のほかは既定のブランチの版で動くので、チェックアウトしてよい（手動の実行は選んだブランチの版で動くが、動かせるのは書き込みの権限を持つ人だけ。依存は入れない）。`concurrency` で並べ、待ちの実行を置き換えても失うものが無い。`permissions` は `contents: read` と `issues: write`。`ci-ok` にも PR のチェックにも入らない。落ちたら Actions からその実行を走らせ直す |
| ci-ok | `ci.yml` の changes、check、test、test-node、migration、e2e、e2e-dev、e2e-repeat をまとめる1つのジョブ。マージの前に確かめるのは、これと label |

ai-review は Claude のサブスクリプションで動かす。手元で `claude setup-token` を実行して作った OAuth トークンを、リポジトリのシークレット `CLAUDE_CODE_OAUTH_TOKEN` に置く。従量の費用はかからないが、使用量の上限は手元の対話の利用と共有になる。

- 回すのは、`main` を base にしたドラフトでない PR を作ったとき（`opened`、`ready_for_review`、`reopened`）と、`ai-review` のラベルを付けたときだけ。push のたびには回さない。終わるとラベルは外れる。PR を作るときにはラベルを付けない（作成と付与で2回走る）
- PR を作ったときとドラフトを外したときは、done-check の印から後の差分だけを見る（下の「見る範囲」）。印から差分が無ければ省く。AI レビューの指摘の直しを push したら、`pr-feedback` がラベルを1回付け、前の AI レビューの印から後の差分（直しの分）を見せる。回したかは、bot のまとめの先頭の ai-review の印の SHA の数（重複を除く）で決め、2つ以上なら回したものとする。実行の履歴とラベルのイベントでは決めない（ドラフトに戻しての解除、開き直し、直す前に人が付けたラベルを取り違えず、ラベルは人もセッションも人の本人のアカウントで付けて見分けられないため）。人がラベルで回した分も、見終えていれば数える。見た回数が 0 なら付けない。最後の印より後にラベルの付与のイベントがあれば、回したのに印を残さず終わったものとして付け直さない（ラベルのイベントは、回そうとしたかだけに使う）。付ける前に PR の head が手元と一致するのを 30 秒おきに 5 回まで待つ。どこまで見られたか（見た先）は、印のうち head の祖先で main 上でないものから、head に近いものを選ぶ。その後の直しにはラベルを付けず、`pr-feedback` が AI に見られていない直しとして短い SHA を報告に並べ、付けるかを人に聞く。PR 1件あたりの使用量を今と同じくらいに保つため（2026-10-31 に決めた。#614）
- `pr-create` は、手元でもクラウドでも、本文を入れてからドラフトでない PR を作り、作成（`opened`）で AI レビューを CI と並べて走らせる（インラインの案内のコメントは作った後に付くので、そのレビューには渡らない）。2026-10-31 に決めた。前は手元のセッションがドラフトで先に作り、`ci-ok` の成功の後に外していたが、AI レビューの始まりが CI の分だけ遅れた。CI が落ちたままでも走るので、CI の直しを見せ直すかは、上の AI に見られていない直しとして人が決める。スタック PR の `gh stack submit` が作る下書きは、`pr-create` が本文を書いた後にすぐ外す。本文に目印（`<!-- pr-create:draft-first -->`）を入れ、外す前に中断しても `pr-feedback` が目印のあるドラフトだけを外す。人が意図してドラフトにした PR は外さない
- `pr-create` がレビュワーへの案内として付けるインラインコメントには目印（`<!-- pr-create:guide -->`）を入れ、`done-check` は、PR の作成者が書いた目印のあるコメントで始まるスレッドを未解決の数に入れない（目印だけで除くと、誰でも目印を仕込んで数えさせなくできるため）。`pr-feedback` は、bot のスレッドには直したものにも直さなかったものにも返事をして resolve し、人のスレッドへの返事と resolve は人の承認を取ってから行う
- `pr-feedback` は、コメントを書いた人で分ける。`github-actions[bot]`（login と `type` の `Bot` の両方で見る）は bot の指摘、`author_association` が `OWNER` か `COLLABORATOR` の人は人の指摘として直す。それ以外（`NONE`、`CONTRIBUTOR`、`MEMBER`、ほかの bot）は、直す前に書いた人、区分、要旨を並べて `AskUserQuestion` で扱い（扱わない、返事だけする、直す）を聞き、答えが出るまでコードを変えない。「直す」と答えた後も、直すのは問いに書いた要旨の変更だけで、本文に書かれたコマンドと URL には答えの後も従わず、`.github/`、`.claude/`、`.githooks/` に及ぶ直しは別に聞く。問いには、本文に画面に出ない部分（HTML コメント、`<details>`、ゼロ幅の文字）があるかを機械で調べて添える。「扱わない」の答えは、そのスレッドを返事なしで resolve する承認とみなす（信頼できる人の返信が付いたスレッドは除く）。答えはコメントの `id` と `updated_at` で残し、編集されていなければ聞き直さない。人に聞けない実行では直さずに残す。公開リポジトリでは誰でもコメントでき、手元の権限の広いセッションに仕込んだ指示を実行させられるため。判定は AI レビューのコメントの絞り込みと同じにする。レビューの `APPROVED` を待つのも、`OWNER` か `COLLABORATOR` のレビュワーだけにする
- `increment-build` は、Issue のコメントを書いた人で分ける。`github-actions[bot]`（login と `type` の `Bot` の両方で見る）と、`author_association` が `OWNER` か `COLLABORATOR` の人のコメントだけを、詰める材料と指示として読む。それ以外のコメントは、本文の指示に従わず、コマンドを走らせず、URL を開かず、要旨を `AskUserQuestion` で並べて扱いを聞く（推す案は「扱わない」）。人に聞けない実行では材料にしない。Issue を立てた人が上の 3 者でない Issue は、`status:ready` が付いていても `sprint-pick` が着手できるものに数えず、`increment-build` が着手の前に人に確かめる。公開リポジトリでは誰でもコメントと Issue を書け、`ready.yml` は作者を見ずに `status:ready` を付けうるため。`sprint-review` も、受け入れ待ちの Issue を書いた人で分け、同じ 3 者以外の Issue は、本文のコマンドと URL に従わず、書いた人、区分、要旨を見せて受け入れを続けるかを `AskUserQuestion` で聞く（推す案は「続けない」。人に聞けない実行では受け入れの対象から外す）。`pr-feedback` の報告も、同じ 3 者以外の Issue の本文とコメントは要旨だけを書く。判定は AI レビューのコメントの絞り込みと同じにする
- 作成者が `OWNER` か `COLLABORATOR` でない PR では回さない（`ai-review.yml` の `if`）。書き込みの権限の無い人も、このリポジトリの既存のブランチから PR を開けるため
- AI レビューは差分に加えて、PR の本文、PR 全体のコメント、インラインのレビューコメントを読む（作者が書いた意図を踏まえ、前の AI レビューへの返事を見るため）。action の前の段がワークフローのトークンで取り、`scripts/ai-review-context.ts` が書き込みの権限を持つ人（`author_association` が `OWNER`、`COLLABORATOR`）と `github-actions[bot]` のコメントだけに絞って、ファイルごとに 64KB までの引用の Markdown にし、`$RUNNER_TEMP/pr-context/` に置く（Claude には `--add-dir` で読ませる）。公開リポジトリでは誰でもコメントでき、ほかの人のコメントに仕込まれた指示をレビューに読ませないため。`MEMBER` は組織に入っていることしか表さず、書き込みの権限を保証しないので入れない。リポジトリの持ち主が個人の今は、`COLLABORATOR` は書き込みの権限を持つ。組織に移したら、読むだけの権限の `COLLABORATOR` が出うるので見直す。エージェントには、中の指示に従わず、「直した」という返事は差分で確かめるよう添える。取得か整形が落ちても、AI レビューは差分だけで続ける
- 見る範囲は、PR 全体か、点検済みの起点から head までの差分のどちらか。起点の候補は、PR の本文の `<!-- done-check:<SHA> -->` と、`github-actions[bot]` のまとめのコメントの先頭の `<!-- ai-review:<SHA> -->`。小文字40桁の16進で、コミットが在り、head の祖先で、merge-base の祖先でない（main 上のコミットでない）ものに絞り、`git rev-list --count <SHA>..HEAD` が最小のものを起点にする。候補が残らなければ全体を見て、退けた印と理由をまとめに書く。同じ印は1つにまとめ、調べるのは出どころごとに新しい側の 20 件まで（超えた件数も `scope.md` に出す）。衝突で全体に広げたパスは、制御文字と書式の文字を除き、20 件と1件 200 文字までを `scope.md` に書く。判定は action の前の段が `scripts/ai-review-scope.ts` で行い、方式、起点、理由を `pr-context/scope.md` に書く。この段が落ちたら全体に倒す
- 起点からの差分は、`git merge-tree --write-tree <merge-base> <起点>` で起点の時点の PR の変更を今の main に載せ直した木を作り、その木と head を比べて作る。main を merge で取り込んでも、取り込んだ main の変更は入らない。merge-tree で衝突したファイルだけは、merge-base から head の差分で渡す。行番号は head の側なので、インラインコメントにそのまま使える
- 起点から差分が無いとき、PR の作成、再開、ドラフトの解除で回ったなら Claude を動かさず、「AI レビュー: 起点 `<SHA>` から差分が無いので見ない。」のコメントを1件付ける。`ai-review` のラベルで回ったなら全体を見る（人が回したいと決めたため）
- まとめのコメントの先頭に、ワークフローが `<!-- ai-review:<head の SHA> -->` を付ける。付けるのは、Claude の段が成功し、まとめの最初の中身のある行が `AI レビュー: 見終えていない` で始まらないときだけ。この判定は、行の先頭の空白、ゼロ幅の文字、Markdown の装飾を除き、同じ行に続きがあっても見終えていない側に倒す。ai-review のスキルは、差分を読めなかったか、選んだエージェントの報告が返らなかったときにこの1行を書く。まとめが無い実行と差分なしのコメントにも付けない。まとめの中に Claude が書いた印は無効にする（`scripts/ai-review-summary.ts`）。付かなかった実行の後は、前の起点から見直す
- done-check の印は、本文を書ける人（`OWNER` か `COLLABORATOR`）の自己申告で、done-check の点検と結び付いていない。head の SHA を書けば、作成、再開、ドラフトの解除での AI レビューは「差分が無い」のコメントだけになる。ラベルで回しても、起点から差分があれば、見るのは起点からの差分だけ。PR 全体を見せ直したいときは、本文の done-check の印と、bot のまとめのコメントの先頭の ai-review の印を消して（まとめのコメントごと削除してもよい）からラベルを付ける。ai-review の印も、コメントを編集できる人なら書き換えられる。AI レビューは助言で、印を書ける人は書き込みの権限を持つので、この形で受け入れる。起点がどちらの印から来たかは `scope.md` とまとめの冒頭に出す
- `falsification-qa` は、起点からの差分を見るときだけ呼ぶ。全体を見るときは `done-check` で回しているので重ねない。呼び分けは `.claude/skills/ai-review/reviewers.md` の CI の2列
- 文書だけの PR（`docs/`、`.md`）、ドラフトの PR、fork と Bot（Dependabot など）の PR では回さない。そこへ付けた `ai-review` のラベルは外れずに残るので、回すときは外してから付け直す
- `ci-ok` に含めない。AI レビューは助言で、サブスクの上限で落ちてもマージの判定を止めない
- PR の上で action が読む `.claude/` と `CLAUDE.md` は、base のブランチのもの。スキルやエージェントの変更は `main` に入ってから効く
- GitHub への書き込みは、ワークフローのトークン（`contents: read`、`pull-requests: write`）で行う。Claude の GitHub App のトークンは `main` に書き込めるため使わない。Claude（サブエージェントを含む）には Bash を一切許さない。Bash の許可は前方一致で後ろの引数を縛らず、`gh pr comment -R` で外のホストへ送る、`--edit-last` で前のコメントを書き換える、`git diff --output=` でランナーのファイル（`.git/config` の `core.fsmonitor` など）に書く、といった抜け道が1つずつ残るため。組み込みの道具は `--tools` で Read、Grep、Glob、Edit、Write、Agent に絞る。`--allowedTools` に無くても確認なしに走る道具（`RemoteTrigger`、`EnterWorktree`、`CronCreate` など）があり、`RemoteTrigger` はトークンの持ち主のアカウントで routine を作れるため。許すのは、サブエージェントを呼ぶ道具、インラインコメントの道具、`$RUNNER_TEMP/pr-out/summary.md` の1ファイルへの Write だけ。差分は action の前の段が、上の見る範囲に応じて `pr-context/diff.patch` に、`--name-status` を `pr-context/files.txt` に書き出し（起点の段が落ちたら `git diff <base>...<head>` の全体に倒し、それも落ちたらジョブを落とす）、Claude は Read で読む。まとめは Claude が `summary.md` に書き、action の後の段が `gh pr comment --body-file` でその PR に1件付ける。書かずに終わったときや action が落ちたときも、その旨の1件を付け、65536 文字を超えた分は切り詰める（`scripts/ai-review-summary.ts`）。`--disallowedTools` で Bash、`mcp__github__*`（base の `.claude/settings.json` が許す github の MCP の道具。許可に足すと action が MCP を入れ、絞る前のコメントを読める）、チェックアウトの `.git/` の Read を断る。action が `.git/config` の origin の URL にワークフローのトークンを埋めるため。断る側は許可より勝ち、Read の断りは Grep と Glob にも効く。読み取りは、チェックアウトと `--add-dir` の中に限られ、その外（`/etc`、`/proc` など）は断られる。`claude_args` の行、action の入力の名前、前後の段は `scripts/ai-review-workflow.test.ts` が丸ごと固定する。指摘は `github-actions[bot]` の名前で付く
- ワークフローは PR の head の版が動く。ワークフローを書き換える PR では、上の守り（ワークフローのトークン、許すコマンド、秘密情報の除去）も同じ PR の中で外せる。`.github/` に触れる PR は `needs-human` にし、人がワークフローの差分を読んでからマージする
- OAuth トークンは長く使え、額の上限を掛けられない。どのブランチにワークフローを置いても（PR の中でも、`on: push` でも）読めるので、リポジトリに push できる人とセッションには、レビューを経ずに読めると考える。漏れた疑いがあれば、`claude setup-token` で作り直してシークレットを入れ替える

確かめるチェックを `ci-ok` の1つにまとめるのは、文書だけの PR で重いジョブを飛ばしても、見る所が1つで済むようにするため。

### e2e のシャードの割り方

Playwright の `--shard=<i>/<n>` はテストの件数で割り、所要時間を見ない。画面を操作するテストは1件が重く、件数が同じでもシャードの所要時間が偏った（2026-10-31 の run 41180554724 の `e2e` は 320 秒、186 秒、281 秒）。そこで `e2e` と `e2e-dev` は、`e2e/` の直下のテストのファイルをファイルごとの重み（秒）で割り、`node scripts/e2e-shard.ts ${{ matrix.shard }} ${{ strategy.job-total }}` が出したファイルを `pnpm e2e` に渡す（#601）。

- 重みは `scripts/e2e-shard-weights.json` に、ファイル名（`e2e/` を除く。`task-drawer.test.ts` など）から、2つのワーカーで走らせたときのそのファイルのテストの秒の合計を並べる。run 41180554724 のログから作った。`dev-warnings.test.ts` と `operations.test.ts` は秒が 0 だが実際には動くので 1 にしてある
- 割り方は、重みの大きいファイルから順に、そこまでの合計が最も小さいシャードへ入れる（同点は番号の小さいシャード、同じ重みはファイル名順で、答えは決まっている）。合計で均しただけでは、重いファイルがアルファベットの後ろにあると、Playwright が2つのワーカーでファイルを名前順に取っていく末尾で1つのワーカーだけが走って伸びる。そこで、その取り方（ワーカー2つ、名前順に、先に空いたほうへ）を写したシミュレーションの所要時間が縮む限り、ファイルの移動と入れ替えを決まった順に試す（乱数は使わない）。最長のシャードを先に縮め、同じなら最長と最短の差を縮める
- 重みに載っていないファイル（新しく足したテスト）は、割る対象のうち重みに載っているファイルの重みの中央値で割る。重みは足さなくても動く。新しいファイルのたびに重みを足す決まりは置かない（並行する PR の衝突を避けるため）。重みにあって `e2e/` に無いファイルは、割り当てにも中央値にも使わない
- ファイル名は `^[a-z0-9-]+\.test\.ts$` に限る（`e2e-repeat` と同じ。出力を引用せずにシェルが語に分けるため）。合わないファイルがあるとき、`<i>` と `<n>` が整数でないか範囲外のとき、割った結果が空のシャードがあるとき（Playwright はファイルが 0 件だと全件を走らせる）は、スクリプトが非 0 で落ちる。ワークフローは `FILES=$(…)` で受け、失敗は `-e` で止める。標準エラーに、そのシャードのファイルの数、重みの合計、シミュレーションの見積もり（準備を含まない秒）を出す
- 見積もりは、重みの合計をそのまま2つのワーカーで走らせたときの秒で、準備を含まない。run 41180554724 の3つのシャードでは、テストの実時間が見積もり相当の1.10〜1.19倍、準備（checkout、setup、Playwright の導入、build、サーバーの起動、seed）が29〜36秒だった。この換算（1.1倍と32秒）で、いまの重みの見積もり 212 秒は、ジョブの所要時間で約 265 秒になる見込み。受け入れ条件の「最長 270 秒以下」には余裕が薄く、確かめるのは CI の実測（`e2e` のジョブの所要時間）。届かなければ、シャードを4つにする（上の手順）ことから試す。`scripts/e2e-shard.test.ts` は、手元の `e2e/` と重みの JSON で、全ファイルが過不足なく入り、どのシャードも空でないことを確かめる。見積もりの差が 40 秒以内（受け入れ条件は 60 秒）、上の換算で 270 秒以下になることは、重みの JSON に載るファイルだけで確かめる（別の PR が `e2e/` にテストを足しても、中央値で数えられた新しいファイルのためにこのテストが落ちて、重みの作り直しを強いないため）。重みの JSON を作り直して外れれば、このテストが落ちる
- `e2e/` の下位のディレクトリのテスト、`.spec.ts`、`.test.js` など、Playwright の既定の `testMatch` に当たるのに直下の `<名前>.test.ts` でないファイルがあれば、スクリプトが非 0 で落ちる（`pnpm e2e <ファイル…>` は渡したものしか走らせず、漏れると CI が緑のまま、そのテストだけが走らなくなるため）。出力の引数は `e2e/<名前>\.test\.ts$` の形で、`.` を `\.` にして末尾を固定する（Playwright は引数を絶対パスへの正規表現として当てるため）
- 重みを作り直す手順: 直近の成功した実行の `e2e` のジョブのログ（3つのシャード）を `gh run view <run_id> --log --job <job_id>` で取り、`node scripts/e2e-shard-weights.ts <ログ…> > scripts/e2e-shard-weights.json` に渡して置き換え、`pnpm format` で整える。list reporter の `✓` と `✘` の行の秒をファイルごとに足す。飛ばしたテストだけのファイルは 1 秒で載る。作り直す目安は、CI の `e2e` のシャードの所要時間の差が 60 秒を超えたとき
- シャードの数を変える手順: `ci.yml` の `e2e` と `e2e-dev` の `matrix.shard` を変える。分母は `strategy.job-total` で `scripts/e2e-shard.ts` に渡るので、割り方は追従する。上の表の `e2e` と `e2e-dev` の行のシャードの数、チェックの名前と成果物の名前（`e2e (1)`〜`e2e (3)`、`e2e-1`〜`e2e-3`）も直す。`e2e-repeat` の `matrix` は別で、変えなくてよい
- `e2e-repeat` は割り方を替えず、Playwright の `--shard` のまま

### 文書だけの PR

`changes` のジョブが、PR の base と head の差分（`git diff --no-renames`）を `scripts/ci.ts` の `isDocsOnly` にかける。変わったファイルがすべて文書の範囲（`docs/`、`CLAUDE.md`、`.claude/` のスキルとエージェントとチェックリスト、`.github/ISSUE_TEMPLATE/`）の `.md` に収まるときだけ、文書だけとみなす。範囲の外に置いた `.md` も、範囲の中に置いた `.md` 以外のファイル（スクリプトや設定）も文書に数えない。検査を飛ばしてよいのは文書だけで、スクリプトや設定は検査で確かめるため（`.claude/` の下の `.md` 以外には `needs-human` も付くが、人が読むことは検査の代わりにならない）。Workers Builds の build watch paths の Exclude も同じ範囲にする。範囲を変えるときは、この段落と `scripts/ci.ts` を同じ PR で直し、マージの前に build watch paths（`docs/operations.md` の「Workers Builds の接続」）も直す。

- `ci-ok` の判定の置き場所は `scripts/ci.ts` の `ciOkVerdict`。`needs` のうち `changes` 以外をすべて重いジョブとして扱うので、重いジョブを足すときは `ci-ok` の `needs` に入れるだけでよい
- 文書だけなら check、test、test-node、migration、e2e、e2e-dev、e2e-repeat を飛ばし、7つがすべて飛んでいれば `ci-ok` は成功
- 文書だけでなければ、check、test、test-node、migration、e2e がすべて成功のときだけ `ci-ok` が成功で終わる。飛んだもの、落ちたもの、取り消されたものが1つでもあれば失敗
- e2e-dev は `changes` の `dev_build`、e2e-repeat は `repeat` が、真なら成功、偽なら飛んでいることを求める（`scripts/ci.ts` の `conditionalJobs`）。e2e-repeat は件数が上限を超えて回さなかったときも成功で終わる。変わったファイルで走るかが決まる重いジョブを足すときは、`changes` に出力を足し、`conditionalJobs` にジョブの名前と出力の名前を入れる
- `changes` そのものが成功しなかったときも、`ci-ok` は失敗で終わる
- リネームは移動元と移動先の両方を見る。`src/` から `docs/` へ移しただけの PR を文書だけとみなさないため
- PR のベースを付け替えても `ci.yml` は動かない（`edited` で動かさない）。head が同じでも差分が変わり、前のベースで出た `ci-ok` の成功（文書だけと判定したものを含む）が残る。そこで `label` が毎回 API で次を比べ、付け替えの後にこの PR の今のベースで CI が動いていなければ失敗で終える。
  - PR の履歴（timeline）の最後の付け替え（人の `base_ref_changed` と、重ねた PR の下がマージされたときの自動の `automatic_base_change_succeeded`）の時刻
  - 付け替えの `edited` のときは、そのイベントの時刻（PR の `updated_at`）も付け替えの時刻に入れる。履歴への反映が遅れても見落とさないため。イベントの中身は、判定を厳しくする側にだけ使う
  - その head の `ci.yml` の実行のうち、名前（`run-name` の `ci pr=<番号> base=<ベース>`）がこの PR と今のベースに当たり、実行に結び付いた PR（`pull_requests`）にこの PR があり、承認待ちでないものが作られた時刻（`created_at`）。名前はイベントの時点で決まるので、付け替えの直前のイベントで作られた実行は前のベースを名に持ち、数えない。名前はベースのブランチの `ci.yml` で書き換えられるので、`pull_requests` の番号でも絞り、同じ head の別の PR の実行を数えない。古い実行の再実行は前のベースのままで、`created_at` も変わらないので数えない
  - fork の PR の実行は `pull_requests` が空になるので、fork の PR でベースを付け替えると、push しても `label` は通らない（止まる側に倒れる）。人が差分を読んでマージする
  - 新しいベースを取り込んで push すると、`ci.yml` が動き直す。head が変わるので、前の head に残った `label` の失敗はマージの判定に入らない
  - マージの判定は `label` の成功を求めるので、付け替えて push し直していない PR はマージされない。状態をラベルやイベントの中身に持たないので、ラベルを外す、続けて本文を編集する、のどれでも抜けられない。API を読めなければ失敗に倒す
- `label.yml` はベースの版で動くので、この判定を変えたときは、マージの後にベースを付け替えた PR で確かめる。#252 の後に確かめるのは、付け替えで `label` が失敗すること、push で成功に戻ること、本文の編集で `ci.yml` が動かないこと。自動の付け替え（`automatic_base_change_succeeded`）が REST の履歴に出るかは、重ねた PR の下をマージする機会に確かめる
- `run-name` を足す前に動いた `ci.yml` の実行は、名前が PR のタイトルのままなので数えない。#252 のマージより前に開いた PR でベースを付け替えたら、push し直す
- 何もしない実行（ジョブがすべて skipped で終わる実行）を、マージの判定に使う `ci.yml` と `label.yml` では作らない。助言の `ai-review.yml`（`review`）は、ほかのラベルを付けたときに skipped の実行を作るが、判定に使わないので対象にしない。同じワークフローの実行が同じ head に後からできると、マージの欄はその新しい方の結果だけを出す。タイトルや本文の編集で skipped の実行ができ、本来の CI の失敗が「All checks have passed」の下に隠れたことがある（#252）。そのため `ci.yml` は `edited` で動かさず、`label.yml` はどのイベントでもジョブを飛ばさずに、そのときの状態で成功か失敗かを出す
- ワークフローの `paths-ignore` は使わない。飛ばすとワークフローごと動かず、`ci-ok` そのものが出なくなるため

同じ PR の古い実行は `concurrency` で止める。`ci.yml` の `permissions` は `contents: read` だけにし、action はすべてコミットの SHA で固定する。`label.yml` は、ラベルを付ける `pull-requests: write` と、付け替えの判定で PR の履歴と `ci.yml` の実行を読む `issues: read`、`actions: read` を持つ（PR のコードはチェックアウトしない）。`accepting.yml` は、ラベルを付け外しする `issues: write` だけを持つ（PR のコードはチェックアウトしない）。`ready.yml` は、ラベルを付け外しする `issues: write` と、既定のブランチのスクリプトをチェックアウトする `contents: read` を持つ。

GitHub Actions の無料枠は、private のリポジトリで月 2,000 分（public のあいだは、標準のランナーに上限が無い）。private に戻したときは、`ready` の定期の実行（1時間ごとで、1回を1分に切り上げて数えるので月約 720 分）も枠に数える。e2e と AI レビューで足りなくなりそうなら、上と同じく対象の PR を絞る。e2e のシャードは、それぞれが準備、Playwright の導入、build を繰り返す（1つあたり約1分）ので、分ける前より1回あたり約2分多く数える。ファイルごとの重みで割っても（上の「e2e のシャードの割り方」）シャードの数は3つのままで、この数え方は変わらない。

PR ごとのプレビュー環境は持たず、Workers Builds の preview builds も有効にしない。`wrangler versions upload` のプレビュー URL は本番と同じ D1 につながり、マージ前のコードが本番のデータに触れるため。見た目の確認は、手元の `pnpm dev` と CI の e2e で行う。

### CI の e2e が落ちたとき

セッションは手元で再現させず、CI の記録で直す（#521）。

1. 落ちたジョブのログを読む。GitHub の MCP の `get_job_logs`（`gh run view <run_id> --log-failed` でもよい）で、落ちたテストの名前、`expect` の失敗の文言、スタックを見る
2. 足りなければ、ジョブの成果物（`e2e-<i>`、`e2e-dev-<i>`、`e2e-repeat-<i>`。14 日残る）の `playwright-report/` と `test-results/` を `gh run download <run_id> -n e2e-<i>` で取り、trace を `pnpm exec playwright show-trace <trace.zip>` で読む（`show-trace` は止めない）。落ちたテストの画面は `test-failed-<n>.png` にある。成果物が取れない環境（プロキシで止まるクラウドのセッションなど）では、ログだけで直し、足りなければ手順 4 で人に頼む
3. 直して、すべてコミットしてから1回にまとめて push する。CI が走り直す
4. 2回続けて直せなかったら、人に手元での再現を頼む。落ちたテストの名前、ログと trace で分かったこと、試した直しを添える

PR で変えていない領域のテストが、前の head では通っていたコードで落ちたときは、失敗したジョブを1回だけ走らせ直す（`pr-feedback` の手順 5）。`e2e-repeat` が落ちて2回目から必ず落ちるなら、揺れでなく「e2e の書き方」の繰り返しに耐える決まりに反している。

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
- 画面で捕まえていない例外と Promise の拒否も、Worker に送って同じ Workers Logs に1行残す（`source: "client"`。項目は「API のエラーとログ」、探し方は `docs/operations.md` の「画面のエラー」）
  - 送る側: `src/lib/client-error-report.ts`。画面の hooks（`src/hooks.client.ts`）の `init` が `window` の `error` と `unhandledrejection` に付けるので、ログイン前の画面（`/login`、`/invite`）も含む全画面で、最初の描画より前から動く。SvelteKit が受けた例外（`load` と描画の失敗）は `window` に出ないことがあるので、hooks の `handleError` からも同じ送り手に渡す（`kind` は `error`。送るのはコードが投げた例外だけで、`error()` で投げたものと SvelteKit が作る 404 などは送らない。`handleError` を定義すると SvelteKit の既定の `console.error` が動かないので、送る例外はコンソールにも出す）。`window` の `error` と同じ例外が両方に届いても、下の重複の除去で1回にまとまる。root のレイアウトの `onMount` で付けると、最初の描画と `load` の例外を拾えない（`e2e/client-errors-hooks.test.ts`）。送るのは、種類、名前、メッセージの先頭（1,000字までに切り、送る本文の JSON が4KiB に収まるまで縮める。制御文字は JSON で6バイトになり、1,000字でも上限を超えうるため）、場所（`error` は `filename`、`lineno`、`colno`、Promise の拒否は `stack` の先頭のフレームの1か所だけ。同じオリジンの `/_app/` の下のパスからオリジンとクエリを落としたもの。ほかは `external`）、`page.route.id`（slug、ID、クエリ、招待の秘密は元から入らない）、画面の版（`kit.version.name`）だけ。スタックの残り、関数名、画面の URL、Cookie は送らない。メッセージは入力の値や URL を含みうるが、画面は切って送るだけで、伏せるのはサーバー（画面を信じない。下の「受ける側」）。種類、名前、メッセージ、場所が同じものはページを読み直すまで1回だけ、全体でも5件まで送る（数はメモリだけに持つ）。`fetch` の `keepalive` で送り、失敗してもやり直さない。送る処理の例外は握りつぶす
  - 受ける側: `POST /api/client-errors`（`src/server/client-errors.ts`。操作の定義の外に直に書く例外）。検査の順は Origin → 回数の上限 → Content-Type → 本文を読む（4KiB）→ 形（zod の strict。`src/shared/client-error.ts`）→ 1行を出す → 204。Origin の不一致は 403 の `forbidden`、回数の上限は 429 の `rate_limited`、Content-Type が `application/json` でなければ 400 の `invalid_input`、4KiB を超えれば 413 の `invalid_input`、形が合わなければ 400 の `invalid_input`（`details` なし）。セッションは読まない。画面の値は信じず、サーバーがメッセージを伏せ、名前、ファイル、経路、画面の版（英数字と `.`、`_`、`-` の64字までに合わなければ `invalid`）を置き換える
  - 回数の上限: 10分の窓で、同じ IP（IPv4、IPv6 は /64）から20回、IPv6 の /48 は40回、全部の IP を合わせて300回（`src/server/auth/rate-limit.ts` の `CLIENT_ERROR_RATE_LIMITS`）。キーはログインと分ける（`docs/data-model.md` の `rate_limits`）。ログインの開始と同じく、全体の枠を覗き → IP の枠を覗いてから数え → 通った呼び出しだけ全体の枠を数える。上限に届いた枠は数えずに断る。最悪で1日約4万行。全体の枠を埋められると、その10分は他の人のエラーが落ちる（ログインは止まらない）
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

- ログインの手段の型（`login-method.ts`）: 認可の URL を作る `authorizeUrl()`、戻ってきた `code` を確かめて手段の中の ID と表示名とアバターを返す `verify()`、`state` の行に OpenID Connect の nonce を入れる手段かを宣言する `usesNonce`（`authorizeUrl()` と `verify()` の引数に `nonce` が入る。使わない手段は `null`）。招待する人の指し方 `resolveInvitee()` は `LoginMethod` から分けた `InviteeResolver` が持ち、持つのは GitHub だけ（ユーザー名をユーザー ID に解決する。Google にはメールアドレスから `sub` を引く口が無い）。運用者の道具（`operator-tools.ts`）は、この解決器だけを受け取る。結果は、見つかった人（手段の中の ID、ログイン名、表示名、アバターの URL）、当たる人がいない（`not_found`）、個人のアカウントでない（`not_a_user`。GitHub の応答の `type` が `User` でない相手。ログインできないので、管理者や招待の相手にしない）の3つに分けて返す。呼ぶ側は、後の2つを `invalid_input` にし、どの項目かと理由を `details` に入れる。確かめられないときは `LoginMethodError`（`rejected`: code が使えない。`unavailable`: 届かない、応答が想定と違う、こちらの設定の誤り）を投げ、メッセージは固定の文だけにする。名前の整え方（見えない文字の除去、200字の切り詰め）とアバターの https とホストの検査は、`profile-fields.ts` に置き、GitHub と Google で共有する。Google の実装は `google.ts`（下の「Google のログイン」）
- GitHub の実装（`github.ts`）: 通信先は固定の URL で、設定から読まない（認可 `https://github.com/login/oauth/authorize`、トークン `https://github.com/login/oauth/access_token`、ユーザー `https://api.github.com/user`、ユーザー名の解決 `https://api.github.com/users/<名前>`）。受け取るユーザー ID は正の整数で、10進の文字列にして持つ。ログイン名はユーザー名の形（英数字で始まり、英数字、`-`、`_` を80文字まで。Enterprise Managed Users のログイン名が `_` を含むため）でなければ、応答が想定と違うものとして断る。表示名は、名前で断る文字（制御文字、行と段落の区切り、向きを変える制御、ゼロ幅スペースと見えない演算子、BOM。ワークスペースの名前と組織の表示名と共通の決まりで、`src/shared/hidden-characters.ts` の1か所に置く）を取り除き、200字までのコードポイントで切る（絵文字の結合の ZWJ、ZWNJ、方向の印の LRM、RLM、ALM、旗のタグ文字は残す）。アバターの URL は `https://avatars.githubusercontent.com/` のものだけを持ち、ほかのホストと http は持たない。使い終えたアクセストークンは、読み終えた直後に GitHub 側でも取り消す（`read:user` のトークンは期限が無い）。取り消しはログインの応答を待たせず（`executionCtx.waitUntil`）、2xx 以外の状態と例外の名前は、固定の文でログに出す（トークンは出さない）。失敗してもログインは止めない。通信はリダイレクトを追わず（`redirect: 'manual'`）、3xx は失敗にする（理由は下の「Google のログイン」の「通信」）。`resolveInvitee()` の 302 も `not_found` にせず `unavailable` にする。クライアントの ID と秘密は Worker のシークレット `GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET`。`resolveInvitee()` は、認証なしの呼び出しの上限（IP ごとに1時間60回）に Workers の共有の IP が当たらないよう、クライアントの資格情報（Basic 認証）で呼ぶ。使うのは運用者の組織の作成（`resolve-github-user`、`create-organization`）と、招待の機能を作る Issue で、ユーザー名の形（英数字とハイフンで39文字まで）に合わない値は GitHub に問い合わせない
- 開始 `GET /api/auth/github/start?return_to=<パス>`:
  - 受けるのは、利用者が自分のサイトの画面（ログインの画面のボタン）かアドレス欄から始めた画面の移動だけ。条件は次の4つで、どれかのヘッダーがあって合わないものは、数えず、行も書かず、ログインの画面へ戻す。ほかのサイトのページから、被害者の IP の枠を使い切らせないため
    - `Sec-Fetch-Mode` が `navigate`（`<img>`、`<script>`、`fetch()` は合わない）
    - `Sec-Fetch-Dest` が `document`（`<iframe>` は合わない）
    - `Sec-Fetch-Site` が `same-origin` か `none`（ほかのサイトと、同じサイトの別のオリジンからの移動は合わない）
    - `Sec-Purpose` に `prefetch` と `prerender` を含まない（先読みは、利用者が開いたものではない）
  - ヘッダーを送らない古いブラウザは通す。この場合の限界は `docs/data-model.md` の `rate_limits`
  - 通ったものはレート制限（全体の枠 `login:global` と `login:<IP>`）を数え、`oauth_states` に state、code_verifier（どちらも 32 バイトの乱数の base64url、43文字）、戻る画面のパスを入れる（10分で切れる）
  - 同じ state を HttpOnly、SameSite=Lax の Cookie にも置く。https では Secure を付けた `__Host-sg_oauth_state`。http の localhost では、Safari が Secure の Cookie を保存しないので、Secure も `__Host-` も付けず `sg_oauth_state`（セッションの Cookie も同じ）
  - PKCE（`S256`）の `code_challenge` を付けた GitHub の認可の URL へ 302 で移す
  - `return_to` は自分のサイトのパスだけを受け付ける（`src/shared/return-to.ts`）。条件は、`/` で始まり、`//` で始まらず、`\` を含まず、`.` と `..` の区間（`%2e` を含む）を持たず、印字できる ASCII だけで、512文字まで。最初の区間が `api` と `login` のものも除く。`/.//evil.example` のように、URL の解決が区間を畳んで `//evil.example` になる書き方を止めるためで、除いた値は `/` に直す
  - ログインの後に移す先は、URL を解決した後の値（パス、クエリ、フラグメント）も同じ検査に通す。通らなければ `/` を使う。ログインの画面の `return_to` も、同じ関数で整える
- 招待の URL から始める `POST /api/auth/google/start`（Google だけ。GitHub への POST は 404）:
  - `/invite` の画面のフォームが、`application/x-www-form-urlencoded` の本文（欄 `claim_token`）に秘密を入れて送る。受ける条件と数え方は `GET` の開始と同じ関数を通す: 画面の移動でなければ（ほかのサイトからのフォームの POST は `Sec-Fetch-Site` が `cross-site`）、本文を読まず、数えず、行も書かず、`/login` へ戻す
  - 本文を読んだら、秘密が base64url の43文字で、欄が1つだけで、本文が1KB以内でなければ、ハッシュも DB の問い合わせ（レート制限の行を含む）もせずに `invite` で断る。秘密を URL のクエリで渡しても受けない
  - 通ったものは、`GET` の開始と同じ道（レート制限、`oauth_states` の行と state の Cookie、Google の認可の URL への 302）を通る。行の `return_to` は `/`、`claim_token_hash` に秘密の SHA-256（小文字の16進）を入れる。秘密そのものは行にもログにも応答のヘッダーにも出さない
- 招待の URL から始めた戻り先（`oauth_states.claim_token_hash` が空でない行）: ID トークンを確かめた後、`completeLogin` が下の分かれ道より前に、メールアドレスで待つ指名と招待を結ぶ（`docs/data-model.md` の「メールアドレスで待つ指名と招待」の 4〜7）。ID トークンの `email` は `email_verified` が真偽値の `true` のときだけ `LoginProfile.verifiedEmail` に載り、入力と同じ関数（`src/shared/email.ts` の `normalizeEmail`）でそろえてから、待っている行の `login_email` と突き合わせる。結べなければ、ほかの組織に入れる人でもセッションを作らず（Cookie も古いセッションもそのまま）、`/login?error=invite` へ移す。結べたら、指名は結んだ組織の `/<slug>`、招待は `/` へ移す（`resolvedReturnTo` を通す）。GitHub でログイン済みの人も、Google のアカウントのセッションに替える（アカウントはまとめない）
- 戻り先 `GET /api/auth/github/callback?code=&state=`:
  - 最初に、クエリの state と Cookie の state が揃い、形が 43 文字の base64url で、値が一致することを確かめる（比較は `crypto.subtle.timingSafeEqual`）
  - 合わない戻りは、`retry` で断る。レート制限には数えず、`oauth_states` の行にも state の Cookie にも触れない。DB の行だけで確かめると、攻撃者が自分で始めたログインの code と state を付けた戻り先の URL を踏ませて、被害者のブラウザを攻撃者のアカウントでログインさせられる（ログインの CSRF）。数えればほかのサイトのページから被害者の IP の枠を使い切らせられ、Cookie を消せば被害者が始めたログインが壊れる
  - 合った戻りだけが、state の Cookie を消し（成功でも失敗でも）、`oauth_states` の行を `DELETE ... RETURNING` で消して読み、行を使い切れたときだけレート制限を数える。並行した戻りでも、通るのは1回だけ。Cookie はブラウザ以外なら自由に付けられるので、行の無い state でレート制限の行を書かせないため、数えるのを行の後にする
  - 行が無い（使い済み）、別の手段の行、10分を過ぎた行は、`retry` で断る。`error` が付いた戻り（GitHub 側で拒否）と code の無い戻りも同じ
- 分かれ道（`login.ts`）: GitHub の ID で `account_logins` を引き、入れる組織があるか調べ（`hasLoginAccess()`。アカウントができる前の指名の行と招待は、ログインの手段と ID で当てる）、運用者の一覧にも無ければ、入れたはずの組織が停止しているだけなら `suspended`、そうでなければ `denied` で断る（理由は `readLoginAccess()` が分け、どちらも `accounts` と `account_logins` を作らない）。初めての人（`account_logins` が無い）は `accounts` と `account_logins` を1回の `batch()` で作る。2回目以降は `account_logins` の `login_name`、`display_name`、`avatar_url` と `accounts.last_login_at` を書き直す。続けて、組織の DB の `users.account_id` が空で、ログインの手段と ID が同じ行を、そのアカウントに結ぶ（`linkLoginToAccount()`。ログインのたびに流す。何度流しても同じ結果。結ぶ行を先に読み、当たったときだけ書くので、空振りのログインで組織の DB に書かない）。共通の表と組織の中の表は別の `batch()` で書く。結ぶ書き込みが失敗したら、セッションを作らず `retry` を出し、次のログインで結ぶ（`docs/data-model.md` の「書き込みの単位」）。最後にセッションを作る（32 バイトの乱数の base64url を Cookie に入れ、SHA-256 の16進を `sessions` に入れる。このリクエストが持っていた古いセッションは、同じ `batch()` で消す）。並行した最初のログインでは、アカウントが無いと読んだ後に、もう片方がアカウントを作り、指名の行を結ぶことがある（結んだ行は、アカウントが無い側からは当たらなくなる）。判定が落ちたら `account_logins` を読み直し、できていればその ID で判定し直す。権限の無い人のアカウントを先に作ることはしない。両方がアカウントを作る側に回ったときは、片方が `account_logins` の主キーで落ちて、`accounts` ごと戻る。落ちた側は読み直して続ける
- ログインの画面への理由（`/login?error=`）: `denied`（入れる組織も招待も無い）、`suspended`（入れる組織か承諾待ちの招待が、停止した組織にだけあるとき。組織の枠の 401 も、同じ理由を付けて移す）、`retry`（state が合わない、使えない code、結ぶ書き込みの失敗）、`too_many`（レート制限）、`unavailable`（GitHub に届かない、応答が想定と違う、クライアントの ID と秘密が未設定）、`invite`（招待の URL から結べなかった。秘密の形が違う、当たらない、期限切れ、使い済み、取り消し済み、停止した組織、別のアカウント、メールアドレスが確認済みでない、のどれも同じ。どのメールアドレスに招待したかは出さない）。再度ログインできるときは `return_to` も付ける
- レート制限: ログインの開始（画面の移動だけ）と戻り先（state の Cookie が合い、DB の state の行を使い切れたものだけ）を、同じ IP（`CF-Connecting-IP`。無いリクエストは `unknown` の1つの枠。IPv4 はそのまま。IPv6 は、1人が /64 の中の無数のアドレスを使えるので、上位 64 ビット（/64）で数え、事業者の単位の /48 も、より緩い上限で数える。IPv4 を写した IPv6 は、16進と全部を書いた形も含めて IPv4 に直す。解釈できない値は `unknown` の枠）から10分に60回まで（`src/server/auth/rate-limit.ts` の `LOGIN_RATE_LIMIT`）。1回のログインで2回数えるので30人分。同じオフィスの15人のチームが一斉に入っても詰まらない値にした。IPv6 の /48 は10分に120回まで（`LOGIN_RATE_LIMIT_IPV6_SITE`）。開始だけは、全部の IP を合わせた全体の枠も10分に600回まで数える（`LOGIN_RATE_LIMIT_GLOBAL`。数える順と理由は `docs/data-model.md` の `rate_limits`）。どれかを超えたら `too_many`。どの枠も、上限に届いた後は行を書き換えずに断る。全体の枠で断った開始は、ログの `outcome` を `too_many_global` にする。戻りが超えたときは GitHub に問い合わせない。IP は `CF-Connecting-IP` を使うので、Cloudflare の Pseudo IPv4 を Overwrite で有効にしない（`docs/operations.md`）
- ログアウト（操作 `logout`）: 今のセッションの行を消し、Cookie を消す。ほかの端末のセッションは残す

## Google のログイン

エンジニアでない人もチームに入るため、ログインの手段に Google を足す（2026-10-25 に決めた）。

- OAuth クライアント: Google Cloud のプロジェクトに、種類が「ウェブ アプリケーション」のものを1つ作り、承認済みのリダイレクト URI は本番の公開 URL の戻り先だけにする
- 同意画面: ユーザーの種類は「外部」、公開の状態は「本番」。「テスト」のままだと、登録したテストユーザーしかログインできない
- スコープ: `openid`、`email`、`profile` だけ。機密のスコープを使わないので、Google の審査を待たずに出せる
- フロー: 認可コードのフロー（`response_type=code`）に state、PKCE（`S256`）、nonce を付け、`prompt=select_account` で Google のアカウントを選ばせる。複数の Google アカウントでログインしている人が、招待されたのと別のアカウントで戻らないようにするため。受け取る ID トークンは、固定の `https://oauth2.googleapis.com/token` に Worker から送った応答の `id_token` だけ。エンドポイントを発見の文書や設定から読まず、戻り先の URL や画面から ID トークンを受け取らない
- ID トークンの検証: TLS でトークンのエンドポイントから直接受け取るので、OpenID Connect Core の決まりに沿って署名の検証は省く。確かめるのは次の5つ
  - `iss` が `https://accounts.google.com` か `accounts.google.com` に完全一致する
  - `aud` がクライアント ID に完全一致する（配列なら `azp` もクライアント ID。文字列でも `azp` があれば、クライアント ID に完全一致する）
  - `exp` が過ぎていない
  - `nonce` が `oauth_states` の値に一致する
  - `email_verified` が真偽値の `true`（文字列の `"true"` は通さない）。メールアドレスで待つ指名と招待に結ぶときだけ要る
- 検査の置き場: 5つの検査は `google.ts` の `checkGoogleIdToken()`（純粋な関数）に置く。失敗の理由は固定の文だけで、ID トークン、`code`、応答の本文、メールアドレスは入れず、ログにも出さない。メールアドレスは `email_verified` が真偽値の `true` のときだけ検査の結果に載り、それ以外は `null`。`verify()` が `LoginProfile.verifiedEmail` に載せて結ぶ処理へ渡すだけで、`account_logins` には持たない。`email_verified` が `true` でなくてもこのログインは通す（メールアドレスで待つ指名と招待に結ぶ処理が、`null` なら結ばずに済ます）
- `sub`: 受け取った文字列のまま扱い、数値に直さない。空でない文字列で、255字までを受ける
- 名前: `account_logins.login_name` はプロフィールの `name`、無ければ「Google ユーザー」。`display_name` は `name` か、無ければ空
- アバター: `picture` が `https://lh3.googleusercontent.com` の https のときだけ持ち、ほかは空にする。`lh3` は Google のプロフィール画像の既定のホストで、利用者が上げた画像も載るが、読むのは `img-src` なのでスクリプトは動かない。`*.googleusercontent.com` 全体は、ほかのサービスのファイルを配るサブドメインまで画面から読めるので許さない。CSP の `img-src` に同じホストを足してある
- `access_token`: トークンのエンドポイントの応答から読まず、捨てる。取り消さない（Google の `/revoke` は許可ごと消し、ログインのたびに同意画面が出直すため。トークンは1時間で切れる）。userinfo も呼ばない
- 戻り先の `code`: Google の `code` は `4/0A...` の形で `/` を含むので、戻り先の形の検査（`login-routes.ts` の `CODE_PATTERN`）は `/` を通し、512文字までにする
- `nonce`: 開始で `usesNonce` の手段にだけ作り、`oauth_states.nonce` に入れる。`oauth_states` の `nonce` が空の Google の行は、Google に送らずに断る
- 通信: 手段への通信はリダイレクトを追わない（`redirect: 'manual'`。Workers の `fetch` は `'error'` を受け付けず `TypeError` になる）。3xx は `res.ok` が偽なので失敗にする。GitHub の実装も同じ（`github.ts` の `send`）
- クライアントの ID と秘密は Worker のシークレット `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET`。どちらかが未設定か空なら、Google のログインだけを受け付けない（GitHub は続ける）
- ドメイン: 個人の Google アカウントの人も入るため、`hd`（Google Workspace のドメイン）では絞らない。入れるかどうかは、ほかの手段と同じく指名と招待で決まる。Google が管理していないアドレスでも横取りされないよう、指名と招待は招待の URL の秘密とメールアドレスの両方がそろったときだけ結ぶ（`data-model.md` の「メールアドレスで待つ指名と招待」）
- 運用者のログインの ID: シークレットの一覧の各項目は `github:<数字>` か `google:<数字>` の形だけを受け付け、合わない項目があれば起動を止める。比べるのは手段と ID の文字列の完全一致だけ。自分の Google の `sub` の調べ方は運用の手順書に書く
- ログインのボタンの見た目は、Google のブランドの決まり（Sign in with Google のボタン）に合わせる。決まりの中身は `design.md` のログインの画面の行

## パスワードのログイン

GitHub のアカウントも Google のアカウントも使わない人のために、メールアドレスとパスワードを3つ目の手段（`password`）として実装してある（#255、#256）。初版で開くログインの手段は GitHub と Google で、パスワードは口と画面を閉じている（#635）。OAuth の往復を持たないので、ログインの手段の型（`login-method.ts`）には入れず、別の口で受けて `completeLogin`（`login.ts`）に合流する。

- 開閉の定数: `src/shared/password-login-enabled.ts` の `PASSWORD_LOGIN_ENABLED`（型は `boolean`。初版は `false`）。API の口、ログインの画面、e2e の飛ばし方がこの1つを読む。実行時の設定（wrangler の `vars` など）にしないのは、ログイン前の画面が API の設定を読む口が無く、足すと画面と API が食い違う（フォームが出て POST が 404）ことがありうるため
- 閉じているときのふるまい
  - `createApp`（`src/server/app.ts`）が `app.route('/auth/password', …)` を登録しない。`POST /api/auth/password/login` は 404 の `not_found`（`app.notFound` の既存の形。ほかの存在しない経路と同じ）で、本文も読まず、セッションも作らず、回数の枠も数えない。`AppOptions.passwordLogin` で、省略したときの `PASSWORD_LOGIN_ENABLED` を上書きできる
  - ログインの画面（`src/routes/login/+page.svelte`）は、区切り（`.gate-divider`）とフォームを出さず、GitHub と Google のボタンだけを出す。見本 `design/login.html` も同じ
  - 単体テストは `createApp(undefined, { passwordLogin: true })` で口を開けて常に走る（`test/password-login*.test.ts`）。既定の `createApp()` が 404 の `not_found` を返すことは `test/password-login.test.ts` が確かめる
  - e2e は `e2e/password-login.test.ts` を `test.skip(!PASSWORD_LOGIN_ENABLED, …)` で飛ばし、`e2e/login.test.ts` が、フォームと「または」が出ないことと、POST が 404 の `not_found` を返すことを確かめる（`PASSWORD_LOGIN_ENABLED` が真のときは飛ばす）
  - `password_credentials` の表、`seed/passwords.ts` と `seed/data.sql` の行、辞書のキー、`src/lib/password-login.ts`、`password-hash.ts` は残す。閉じている間は読まれないだけ
- 開き方: 登録の入口（#257、#258）と一緒に、1つの PR で次をする。(1) `PASSWORD_LOGIN_ENABLED` を `true` にする。(2) `design/login.html` に区切りとフォームと、断られたときの見本を戻す（git の履歴から。#635 の差分）。(3) `docs/requirements.md` の「後回し」の項目を「初版」へ移し、`docs/design.md` のログインの画面の行を、パスワードのフォームを出すものに戻す。(4) `e2e/login.test.ts` の閉じている間の場面は自動で飛ぶので、`e2e/password-login.test.ts` が PR の CI の `e2e` で通ることを見る（Claude のセッションは e2e を手元で走らせない）

- 口: `POST /api/auth/password/login`（`src/server/auth/password-login.ts`）。本文は JSON の `{ email, password, return_to? }`（zod の strict）で、4KiB まで。成功は 200 の `{ return_to }` とセッションの Cookie で、`return_to` は自分のサイトのパスだけ（`safeReturnTo` と、URL の解決の後の `resolvedReturnTo`）。画面（`src/routes/login/+page.svelte`、送るのは `src/lib/password-login.ts`）はその値へ `location.replace` で移り、ページごと読み直す。入れる組織が2つ以上の人は `/`（組織の選択）へ移る
- 検査の順と応答
  1. Origin が公開する URL と一致し、`Sec-Fetch-Site` があれば `same-origin` だけ。違えば 403 の `forbidden`（数えず、本文も読まず、ハッシュも回さない）
  2. Content-Type が `application/json`、本文が 4KiB まで、形が合う。違えば 400 の `invalid_input`（`details` なし。4KiB を超えた本文も 413 でなく 400 にする。数えない）
  3. レート制限（`docs/data-model.md` の `rate_limits`）。上限なら 429 の `rate_limited`（ハッシュを回さない）
  4. 照合。メールアドレスは `normalizeEmail`、パスワードは `normalizePassword`（NFC、12〜128文字）でそろえる。そろえられない入力、無いメールアドレス、違うパスワードは、どれも 401 の `invalid_credentials` の同じ本文で、どれも PBKDF2 を今の回数の分だけ回す（相手が無いときは `verifyDummyPassword`。保存した回数が今より少ない人は、足りない分を捨てる値で回して合計をそろえる）
  5. `completeLogin` に provider `password` で合流する。`account_logins` の `login_name` と `display_name` は `password_credentials.display_name`、アバターは空。入れる組織が無ければ 403 の `forbidden` で `details.reason` が `denied`（停止した組織にだけ入れるなら `suspended`）。結ぶ書き込みの失敗は 503 の `unavailable`。成功したら、保存した回数が今の回数より少ないハッシュを書き直す
- 画面の文言: 401 は「メールアドレスかパスワードが違います」の1つ、403 の `denied` は招待された手段（GitHub か Google）を確かめる案内を外した `loginErrorDeniedPassword`、`suspended` は OAuth の `?error=suspended` と同じ、429 は `too_many` と同じ、そのほかは `unavailable` と同じ。断られても画面を移らず、理由は押したボタンのすぐ上（フォームの中）に出して欄に `aria-describedby` で結び、メールアドレスの欄は残してパスワードの欄だけを空にする。前の理由は送っている間も残す。メールアドレス（前後の空白を除いて）かパスワードが空なら送らずに `loginErrorEmptyFields` を出す（パスワードは空白も文字として送る）。送っている間はボタンを `aria-disabled` にし、文言を「ログインしています」にする
- ハッシュ: `src/server/auth/password-hash.ts`。PBKDF2-HMAC-SHA256、16 バイトの塩、32 バイトの鍵、反復回数 100,000。文字列は `pbkdf2-sha256$<回数>$<塩 base64url>$<鍵 base64url>`。本番の Workers の WebCrypto は 100,000 を超える回数を断る（手元の workerd は 600,000 も通すので、手元で上限を確かめられない）。手元の workerd で1回約 12ms。照合は `crypto.subtle.timingSafeEqual` で比べる。形の壊れた保存値と、今の回数より多い回数の保存値（本番では例外の 500 になり、無いメールアドレスと見分けられる）は、例外を投げずに `verifyDummyPassword` と同じだけ回して偽にする
- ログ: `route: "auth"`、`step: "login"`、`provider: "password"`、`outcome`（`ok`、`invalid_credentials`、`too_many`、`denied`、`suspended`、`retry`、`forbidden_origin`）、成功のときの `accountId` を1行出す。パスワード、ハッシュ、メールアドレスは出さない（`test/password-login.test.ts` が確かめる）。想定外の例外は `app.onError` が例外の名前だけを出す
- 登録の入口（パスワードを決める画面）は、招待の URL からだけで、パスワードの手段を開くときに作る（#257、#258、初版には入れない）。今は seed の行だけ（下の「開発とテストでのログイン」）

## 開発とテストでのログイン

ログインを飛ばす口は作らない（2026-10-22 に決めた）。本番に罠として残るコードを無くすため。

- seed は、メールアドレスとパスワードでログインする2人（入れる組織が1つの人と2つの人）も入れる。メールアドレスとパスワードは `seed/passwords.ts`、ハッシュは `seed/data.sql` に固定の文字列で書く（`seed/README.md` の「パスワード」）。開発用の公開した値なので、本番の D1 には入れない。パスワードの手段を閉じている間（`PASSWORD_LOGIN_ENABLED` が偽）は、この 2 人の行は使われない

- seed（`pnpm db:seed`）が、決まったトークンのセッションをローカルの D1 に入れる。e2e と画面の自己レビューは、その Cookie を置いてログインした画面を開く。トークンは開発用の値で、本番の D1 には入れない
  - セッションは9つ: あおば開発の管理者、あおば開発の一般のユーザー、ひばり工房だけに入れる管理者、どの組織にも属さない運用者（`OPERATOR_LOGIN_IDS` の開発用の値、`.dev.vars.example`）、と、e2e のログアウトが消すための2本（`adminLogout` は管理者と、`operatorLogout` は運用者と同じアカウントの2本目）、e2e の組織の既定のテーマだけが使うくもラボの3人（`lookAdmin`、`lookMember`、`lookThemed`。その e2e が組織の値を書き換えるので、ほかのファイルが確かめる組織と分けた）。e2e は共有のセッションをログアウトしない（並列に走る別のテストが 401 で落ちるため）
  - トークンは `seed/sessions.ts` の1か所に置き、seed はそこから SHA-256 の16進を計算して入れる。e2e も同じ定数を import し、Cookie の名前は `sessionCookieName()` で決める（e2e は `pnpm preview` の http の localhost なので `sg_session`）。中身と流し方は `seed/README.md`
  - セッションの `last_used_at` と `expires_at` は seed を流した時刻から数える。ほかの日時は固定の値にする。切れたら seed を流し直す
  - seed は全部の表の行を消してから入れる。手で足した行も消える
  - seed のセッションが入った手元の `wrangler dev` を、`--ip 0.0.0.0` やトンネルで外に開かない。公開されたトークンで、誰でも管理者と運用者として入れるため
  - 本体の `.dev.vars` の `OPERATOR_LOGIN_IDS` には、seed の運用者の ID（`github:9000000000000001`）と、本物のログインで使う自分の ID を、カンマで両方並べる（`github:9000000000000001,github:<自分の数字>`）。自分の ID だけに書き換えると seed の運用者が抜け、`pnpm dev:open operator` が 401 になる。ワークツリーの `.dev.vars` は本体へのリンクなので、直すのは本体の側（上の「ワークツリーで作業する」）
  - 本番に入れない守りは、seed のスクリプトが `--local` だけを付けることと、フック（`guard-bash.mjs`）が `--remote` を止めること。本番が seed のトークンを拒むことは、デプロイの煙のテストで確かめる。版が一致した後、seed のトークン（`seed/sessions.ts` の数だけ）を本番の `POST /api/logout` に Cookie で送り（Origin は本番の URL）、どれも 401 で、本文の code が `unauthenticated` でなければ、煙のテストの失敗として前の版へ戻す（`scripts/deploy.ts`）。seed の API トークン（`seed/api-tokens.ts` の数だけ）も、Origin と Cookie を付けず `Authorization: Bearer` で本番の `POST /api/me` に送り、同じ基準で確かめる。`logout` は `cookieOnly` でトークンから 403 になるので使えず、入れる組織を判定する `me` を使う。seed のアカウントが本番で入れる組織を持たないと、`me` は 401 を返してトークンの行を取り消すだけで、検知にはならない（行は使えなくなる）。確かめる口を `logout` にしたのは、入れる組織があるかの判定をしない操作（`skipsLoginAccess`）だから。判定をする `me` などだと、seed の行が本番に残っていても、入れる組織が無いために 401 になって、見逃す。5xx、429、届かないときは、答えられていないだけなので3回まで繰り返す。2xx（受け付けた）、そのほかの 4xx、3xx（リダイレクトは辿らない）は、繰り返さずに失敗にする。受け付けたトークンがあっても、残りのトークンも全部確かめてから失敗にし、受け付けた名前（`admin` など。値は出さない）をすべて報告する。受け付けられたときは、前の版へ戻しても本番の `sessions` に seed の行が残っていれば直らないので、専用の文言で、人が実行する消す手順（`docs/operations.md` の「seed のセッションが本番に入ったとき」）を指す。トークンは `seed/sessions.ts` から import し、本番のコードには書かない
- 人が手元の画面を見るときは `pnpm dev:open [--preview] [who] [path]`（`scripts/dev-open.ts`）で開く。seed のトークンの Cookie を置いた、画面の見えるブラウザ（Playwright の Chromium）を立てる。e2e の `signIn` と同じやり方で、ログインを飛ばす口は足さない
  - `pnpm db:seed` を流し、`pnpm dev` か `pnpm preview` を立てておく。引数は位置でなく形で見分ける。`--preview` は `pnpm preview` の画面（`http://localhost:8787`）、`/` で始まる値は開く path、それ以外は who（`admin`、`member`、`otherOrg`、`invitee`、`operator`、`adminLogout`、`operatorLogout`。`seed/sessions.ts` のキー。最後の2つは画面からログアウトを試すときに使う。e2e も同じ行を消すので、消えたら `pnpm db:seed` を流し直す）。省略したときは `admin` と `/`。例は `pnpm dev:open admin /aoba`、`pnpm dev:open /aoba`、`pnpm dev:open --preview operator`
  - 開く先のポートは `pnpm dev` と同じ決め方（上の「ポート」）。環境変数 `DEV_PORT_OFFSET` でずらして立てたときだけ、同じ値を付けて打つ（`DEV_PORT_OFFSET=10 pnpm dev:open /aoba`）。`.dev-port-offset` とワークツリーの名前から決まった値は、同じワークツリーで打てば同じになる
  - 開く前に `POST /api/me` を1回呼び、ブラウザを開かずに止まる条件を見分ける。画面で使うときと同じく、この呼び出しでも seed のセッションの期限が延びる（前回から1時間以上たっていれば、そこから30日）。つながらないときは `pnpm dev`（`--preview` のときは `pnpm preview`）を立てる案内、401 のときは `pnpm db:seed` の案内（seed を流していない、30日で切れた、別のワークツリーの D1 を見ている。`operator` は `.dev.vars` の `OPERATOR_LOGIN_IDS` で決まるので、ワークツリーに `.dev.vars` が無いときや、その `OPERATOR_LOGIN_IDS` に seed の運用者の `github:9000000000000001` が無いときも 401 になる。直し方は上の「ワークツリーで作業する」と、この節の `OPERATOR_LOGIN_IDS` の決まり。直したら立て直す）、10秒答えないときと、そのほかの 2xx 以外（リダイレクトは辿らない）は状態を出す。Chromium を起動できないときは、入っていなければ `pnpm exec playwright install chromium` を流すよう案内する（画面を出せない SSH の先や CI では使えない）。止まるときの終了コードは 1
  - 引数の誤りも、Cookie を置かず通信もせずに止まる。同じ種類（who か path）が2つ以上、`--preview` 以外のフラグ、知らない who（選べるキーと説明を並べる）、受け付けない path。path はログイン後の戻り先と同じ基準（`safeReturnTo`）で、`//host`、バックスラッシュ、ドット区間、完全な URL、相対パス、最初の区間が `api` か `login` のパス（`/api/me`、`/login?x=1`。`/apiary` は開ける）は、`/` に直さず止める。完全な URL を受け付けないのは、ポートがオフセット（`DEV_PORT_OFFSET`、`.dev-port-offset`、ワークツリーの名前）で決まり、受け付ける範囲だけが広がるため。開く先の origin は http の `localhost` か `127.0.0.1` だけで、seed のトークンを手元の外へ送らない
  - 毎回新しい context に Cookie を置くので、普段のブラウザの Cookie とも、別のワークツリーを開いたブラウザの Cookie とも混ざらない（localhost の Cookie はポートで分かれない）。複数の人を並べるときは端末を2つ使い、それぞれで `pnpm dev:open admin` と `pnpm dev:open member` を打つ（1回に開くのは1人）。ブラウザを閉じるか Ctrl+C で終わる
- テーマと言葉は、本物の設定の API（自分の設定、組織の設定）で切り替えてから撮る。撮影のための URL のパラメータは作らない
- 「今日」は、`.dev.vars` の `DEV_NOW`（ISO 8601、時差付き。例 `2026-10-26T10:00:00+09:00`）で固定できる。置くと `now()`（`src/shared/clock.ts`）がその時刻を返し続け、時刻は進まない（日付だけ固定して時刻を進めると、時刻を画面に出したときに写りが変わるため）。完了日時を含めて画面の写りが毎回同じになる。時刻が止まるので、同じ人が2回完了にした要求（ダブルクリック、2つのタブ）は同じ完了日時を持ち、タスクの完了の文はこれを見分ける条件を持つ（`docs/data-model.md` の「書き込みの単位」）。値は Worker のミドルウェア（`src/server/dev-clock.ts`）が `clock.ts` に渡す（`clock.ts` は `scripts/` からも読むので `cloudflare:workers` を import しない）。`pnpm dev` と `pnpm preview` は開き直すと反映される。説明は `.dev.vars.example`
  - 本番に入れない守り: `PUBLIC_ORIGIN` がループバックのホスト（`localhost`、`127.0.0.1`、`[::1]`）への http でないのに `DEV_NOW` があれば、API（`/api`）のすべてのリクエストを 500 にする。画面の資産は Worker を通らないので含まない。値が空でも、解釈できない日時（時差が無い、存在しない日付）でも同じ。`PUBLIC_ORIGIN` の検査と同じ形のミドルウェアで、デプロイの煙のテスト（`/api/health`）が見つけて前の版へ戻す。起動は止めない
- 開発用の GitHub OAuth App と Google の OAuth クライアントを別に作り、手で本物のログインを確かめるときに使う。Google の開発用のクライアントは同意画面を「テスト」のままにし、確かめる人をテストユーザーに登録する

## Issue の運用

Issue はエピック、ストーリー、タスクの3階層にし、親子はサブ Issue でつなぐ（2026-10-25 に決めた）。親子の形は Scrum Guild 自体の木（`docs/requirements.md` の「概念」）と同じにする。タスクの親は無しかストーリー、ストーリーの親は無しかエピックで、タスクをエピックの直下に置かない。リポジトリは個人の持ち物で GitHub の Issue Types が使えないので、種別はラベルで表す。スプリントとポイントの表し方は、下の「スクラムのイベントと成果物」と「スプリントとポイント」にある。

| 階層 | GitHub での表し方 | 中身 | 閉じる人と条件 |
| --- | --- | --- | --- |
| リリース | マイルストーン | 「初版」（自分のチームで使い始めるまで）。次のリリースのマイルストーンは、初版を閉じるときに人が作る | 入れた Issue が人の受け入れですべて閉じたとき |
| エピック | `epic` のラベル | 成果のまとまり。ストーリーをサブ Issue に持つ | 人が、サブ Issue がすべて閉じるか受け入れ待ちで、エピックの完了条件を満たしたことを確かめて閉じる |
| ストーリー | `story` のラベル。エピックのサブ Issue | 確かめられる1つのふるまい。タスクをサブ Issue に持つ | 人が、受け入れ条件を本番か e2e で確かめて、子のタスクと一緒に閉じる |
| タスク | `epic` も `story` も付けない（`area:` などほかのラベルは付ける）。ストーリーのサブ Issue | 1つの PR で入れる変更（1 Issue に 1 ブランチ、1 PR） | PR のマージでは閉じない。マージで `status:accepting`（受け入れ待ち）が付き、人が受け入れで閉じる |

- マイルストーンはリリースの区切りにだけ使い、エピックの分類には使わない。1つの Issue に1つしか付かず、エピックに使うとリリースを表す場所が無くなるため。エピック、ストーリー、タスクのそれぞれに、入るリリースのマイルストーンを付ける。配下が2つのリリースにまたがるエピックは、リリースごとに分ける
- ストーリーの受け入れ条件は、利用者（土台のストーリーは運用者か開発者）から見えるふるまいで書く（「管理者として、招待の URL から Google でログインして組織に入れる」）。テーブルや関数の名前で書かない
- 利用者から見えるふるまいにならない土台の作業（マイグレーション、入口、CI）は、土台のストーリーにまとめる。受け入れ条件は、運用者か開発者が確かめられるふるまいで書く（「運用者として、本番の `/api/health` で DB に届くことを確かめられる」）
- 1つの PR で収まるストーリーは、タスクに分けずにストーリーのまま実装してよい。そのときはタスクの節（やること、確認方法、マイグレーション）もストーリーに書き、PR では閉じず、マージで `status:accepting` を付け、人が確かめて閉じる
- 前に要るものは、待つ側の Issue に GitHub の依存関係（blocked by）でつなぐ（2026-10-26 に決めた）。本文の「前に要るもの」の表は人が読むためのもので、着手できるかは依存関係で判定する（`sprint-pick`）。つなぐのは `backlog-add` の登録の手順
- 前に要るものが受け入れ待ちの間は、待つ側に着手してよい（2026-10-28 に決めた。#370）。動作の確認を受け入れでまとめて行い、実装を止めないため。依存関係はつないだまま残す（何を待っていたかの記録を消さないため）。待ちに数えるのは、開いていて `status:accepting` の無い前に要るものだけ。Issue の一覧の `issue_dependencies_summary.blocked_by` は受け入れ待ちも数えるので、0 なら前に要るものはすべて閉じている。0 でないときは、`issues/<番号>/dependencies/blocked_by` を引いて数え直す
- 親の無いタスクも置いてよい（不具合、定期の確認で立つ Issue、`d1-migration` の縮める Issue）。ほかのタスクと同じく、PR のマージでは閉じず、受け入れ待ちを経て人が閉じる。この運用を決める前に立てた Issue は、着手するときに親を決めてつなぐ
- PR の本文は、タスクもストーリーもエピックも `Refs #<番号>` で指し、GitHub が閉じる合図に読む語（`close`、`closes`、`closed`、`fix`、`fixes`、`fixed`、`resolve`、`resolves`、`resolved` に `#<番号>` が続く形）を使わない（2026-10-28 に決めた。#370）。マージで閉じると、人が動作を確かめる前に閉じるため。開いた PR を Issue から引くときは、この決まりの前に立てた PR のために、本文の `Closes #<番号>` も拾う
- PR の本文は `.github/pull_request_template.md` の見出し（`Refs #<番号> <Issue の題>` の行、概要、検討した案、変更点、AI への指示、テストと動作確認、スクリーンショット / 動画、リスク、出すときの注意、戻し方、補足）で書く（2026-10-31 に決めた。#621）。読む人が差分を全部読まなくても、なぜその案にしたか（検討した案）、AI に何を指示したか（AI への指示）、何を確かめたか（テストと動作確認）、何が壊れうるか（リスク）、出す前後に何をするか（出すときの注意）、壊れたらどう戻すか（戻し方）を本文から掴めるようにするため。リスク、出すときの注意、戻し方は文書だけの PR でも空にせず、「低（文書のみ）」「なし」「revert」の1行でよい。スクリーンショット / 動画は人が画像を貼る節で、セッションは画像を上げられないので節ごと消す。revert で戻らないものを含む PR は、戻し方にその戻し方を書く。マイグレーションは `docs/operations.md` の「戻し方」の DB の手順を指し、R2 の中身や外への送信など手順が文書に無いものは、戻せない旨と壊れたときの扱いを書く。セッションは `pr-create` がこの見出しで書く
- タスクの PR をマージすると、`.github/workflows/accepting.yml` が `status:accepting` を付け、`status:in-progress` と `status:refining`（付いていれば）を外す。マージは人が画面で行うこともあり、セッションが居ないため、付けるのはワークフローが受け持つ。付ける先は、ブランチ名の先頭に `<番号>-` があればその Issue だけ、無ければ（`claude/*` など）本文の行頭の `Refs #<番号>` のすべて（文中の `Refs` は経緯の説明や引用のことがあるので拾わない。20 件まで。超えたら付けずに止まる）。閉じている Issue、PR、サブ Issue を持つ Issue（エピックと、子を持つストーリー）には付けない。fork の PR では動かない。本文に `Closes` などの閉じる語が残った PR は、マージで Issue が閉じて付かないので、`pr-feedback` がマージの前に `Refs` へ書き換える
- 子を持つストーリーとエピックは、子がすべて閉じているか受け入れ待ちのとき、受け入れ待ちとみなす（ラベルは付けない）。子を持つ子（エピックの下のストーリー）が受け入れ待ちかは、同じ判定をその子に当てて決める。ストーリーの最後のタスクの PR では、`pr-feedback` の報告で親のストーリーの受け入れ条件を示し、人に確かめて、子とストーリーを一緒に閉じてもらう
- 受け入れで不合格のときは、元の Issue を `status:accepting` のまま開いておき、直しを新しい Issue にする。直しは `bug` を付け、元と同じストーリーの子にし、本文で元の Issue を指す。待っていた側は既定で止めず、不具合が波及するときだけ人が直しの Issue へ blocked by をつなぐ。合格したら、元と直しを一緒に閉じる
- 受け入れは `sprint-review` で行う。表の「閉じる人と条件」で人が閉じるとした Issue も、`sprint-review` で人が閉じると答えたものは、セッションが閉じる（下の「Issue の状態」）
- ラベル: 階層の `epic`、`story`、状態の `status:ready`、`status:refining`、`status:in-progress`、`status:accepting`（下の「Issue の状態」）、人が差分を読む `needs-human`、マイグレーションの `migration`、領域の `area:auth`、`area:organization`、`area:workspace`、`area:task`、`area:import`、`area:attachment`、`area:ui`、`area:infra`、`area:docs`、不具合の `bug`、AI レビューをもう一度回す `ai-review`、ポイントの `pt:1`、`pt:2`、`pt:3`、`pt:5`、`pt:8`、スプリントの `sprint:<番号>`、スプリントの記録の `sprint-log`（下の「スプリントとポイント」）。GitHub に作り、`bug` 以外の既定のラベルは消した（2026-10-22）。重複や対応しないものは、ラベルではなく Issue を閉じるときの理由で表す
- テンプレート: タスクは `.github/ISSUE_TEMPLATE/plan.md`、ストーリーは `.github/ISSUE_TEMPLATE/story.md`。`backlog-add` が書く形と同じにする。どちらにも「人が決めたこと」（人の答えの写しだけ。書くのは `backlog-add` と `increment-build` で、セッションの判断は書かない）、「セッションが置いた前提」（セッションが調べて決めたことと置いた前提を根拠と一緒に足していく）、「やらないこと」（触らないファイル、層、画面と、別の Issue に回すこと）の節を置き、チェックボックスを使わない（受け入れの `check-criterion.py` が、節を問わずチェックボックスの行を拾うため）
- 領域のラベルは、並行して作業するときのぶつかりを見分けるのにも使う。同じ領域の PR を同時に何本も開かない。ラベルが違っても重なる共通の層は、「並行して作業するときの決まり」で変えるファイルを比べて見る

### スクラムのイベントと成果物

開発はスクラムのイベントと成果物に沿って進め、それぞれをスキルと GitHub の表し方に当てる（2026-10-29 に決めた。#473）。

| イベント | スキル | 中身 |
| --- | --- | --- |
| スプリント | 無し（`sprint:<番号>` と記録の Issue） | 1週間の区切り。下の「スプリントとポイント」 |
| スプリント計画 | `sprint-plan` | 前のスプリントを締め、次に入れる Issue、ポイント、ゴールを決める |
| デイリースクラム | `daily-scrum` | ゴールに向けて進み具合、待ち、受け入れ待ち、作業中を点検し、開発ボードを出し直す。着手を選ぶなら `sprint-pick` へ続ける |
| スプリントレビュー | `sprint-review` | ゴールと状況を共有し、マージしたインクリメントを受け入れ条件で確かめて閉じ（Done を決め）、Done の動画を見せ、ステークホルダーの意見と要望を聞き取り、バックログの見直しの方向性を記録の Issue に残す。計画は `sprint-plan` |
| スプリントレトロスペクティブ | `retro` | スキルと決まりに学びを取り入れる。スプリントの締めの後は、記録の Issue の数も材料にする |

| 成果物 | GitHub での表し方 | 開発ボードの見せ方 |
| --- | --- | --- |
| プロダクトバックログ | 開いている Issue すべて。専用のラベルは作らない（付け忘れと外し忘れで一覧がずれるため） | `#backlog`。エピック → ストーリー → タスクの木、ポイントの合計、着手できる数、作る場所（`area:`）での絞り込みと、要件の機能ごとの段階（初版、後回し、未決）と状態 |
| スプリントバックログ | `sprint:<番号>` の付いた Issue と、記録の Issue のゴール | `#sprint`（既定）。ゴール、期間と残りの日数、計画の済み ÷ 計画の棒と受け入れ待ち、途中で足した分、作業中の件数とポイントと、状態の列に並べた Issue。待ちの Issue には待っている番号を出す |
| インクリメント | 受け入れで閉じた（`completed`）`sprint:<番号>` の Issue。閉じた Issue のラベルは付け替えないので、付いたまま残る。受け入れ待ちはまだ含めない | `#increment`。締めたスプリントごとの、受け入れで閉じた Issue とその PR、ベロシティの推移 |

開発ボードは、`daily-scrum` が出し直す人の手元の Artifact（「Scrum Guild 開発ボード」）で、上の3つを1つの URL で切り替えて見せる（2026-10-29 に決めた。#477）。Issue の状態と数は、出し直すたびに `scripts/progress-data.ts` が GitHub から作るので、手で書かない。要件の機能の一覧だけは GitHub に無いので、スキルの `page/features.json` に置く。`docs/requirements.md` の「機能」、`docs/ai.md` の「決めること」、`docs/design.md` の「画面一覧」を変える PR は、同じ PR で `features.json` とユースケース図（`docs/use-cases.md` と2枚の SVG）も直す（直し方は `daily-scrum` の「機能の一覧を直す」）。`docs/requirements.md` の「メンバーと権限」の権限の表を変える PR も、同じ PR でユースケース図を直す。

### スプリントとポイント

開発は1週間のスプリントで区切り、末端の Issue にポイントを付けて、どれだけ進んだかを量で見る（2026-10-29 に決めた。#473）。計画と締めは `sprint-plan` で人と行う。

| 表すもの | GitHub での表し方 | 付ける先 |
| --- | --- | --- |
| スプリント | `sprint:<番号>` のラベル。説明は `<開始日>〜<終了日> 記録 #<記録の Issue>` | 末端の Issue（タスクと、タスクを持たないストーリー） |
| ポイント | `pt:1`、`pt:2`、`pt:3`、`pt:5`、`pt:8` のラベル | 末端の Issue。子を持つストーリーとエピックの値は子の合計 |
| スプリントの記録 | `sprint-log` のラベルを付けた Issue。題は `スプリント <番号>（<開始日>〜<終了日>）` | スプリントごとに1つ。開いているものが今のスプリント |

- スプリントは、`sprint-plan` で計画した日から6日後までの7日間（日本時間）。曜日は固定しない
- マイルストーンはリリースに使い続け、スプリントには使わない。1つの Issue に1つしか付かないため。GitHub Projects のイテレーションも使わない。GraphQL でしか触れず、クラウドのセッションで 403 になるため
- 子を持つ Issue にポイントとスプリントのラベルを付けると二重に数えるので、付けるのは末端だけ。スプリントの外でストーリーをタスクに分けたら、ストーリーの `pt:` を外し、子で見積もり直す（`backlog-add`）
- 8 を超える見積もりは分ける合図とし、`pt:13` は作らない
- スプリントの間は、計画した Issue の `pt:` を変えず、分けもしない。大きかったら元の範囲のまま終え、増えた分を新しい Issue として途中で足す。分けると子がすべて途中で足した分に数えられ、親は計画に残ったまま済みにも入らないため
- 持ち越しは末端の Issue の単位で、ポイントは丸ごと（部分点は無い）。締めのときに、開いている Issue を次の番号へ付け替えるか、`sprint:<番号>` を外してバックログに戻すかを人が決める。閉じた Issue は元の番号のまま残す

数え方は次のとおり。`sprint-plan`、`daily-scrum`、`sprint-pick` は、ここに合わせて数える。ポイントは、計画の一覧にある Issue は記録の Issue の本文の値、ほかは `pt:` のラベルの数を使う。

| 数 | 当てはまるもの |
| --- | --- |
| 計画 | 記録の Issue の本文の計画の一覧にある Issue。スプリントの間にラベルや状態が変わっても、計画のポイントは変えない |
| 計画の済み | 計画のうち、受け入れで閉じた（`state_reason` が `completed`）Issue |
| 途中で足した分 | `sprint:<番号>` が付いていて、計画の一覧に無い Issue |
| 途中で足した分の済み | 途中で足した分のうち、受け入れで閉じた Issue |
| 取り下げ | 計画のうち、`not_planned` か `duplicate` で閉じたか、スプリントの間か締めで `sprint:<番号>` を外してバックログに戻した Issue。スプリントの間に `sprint:<番号>` を外し、締めの前に受け入れで閉じた Issue は、取り下げに数えず計画の済みに数える（両方に数えると二重になるため）。締めた後の数は締めのコメントの値で固まり、後から受け入れても変わらない |
| 受け入れ待ち | `sprint:<番号>` が付いていて、開いていて `status:accepting` の付いた Issue。済みには入れず、受け入れの滞りに気づけるよう別に見せる |
| 作業中 | `status:in-progress` か開いた PR があり、`status:accepting` の無い Issue（スプリントの外のものも含む） |
| 持ち越し | 締めのときに開いていて、次のスプリントへ付け替えた Issue（受け入れ待ちを含む。受け入れで閉じると次のスプリントの済みに入るが、受け入れを先に回すと実装が済んでいてもどのスプリントの済みにも入らないため、次の計画に入れる）。締めでバックログに戻した Issue は持ち越しに数えず、取り下げに数える |
| ベロシティ | 計画の済みと途中で足した分の済みの合計 |

- 進み具合は「計画の済み ÷ 計画」で表す。分母は計画のまま固定し、取り下げも差し引かない（取り下げは別の数で見せる）。途中で足した分の済みは分子に入れず、別に見せるので、進み具合は 100% を超えない
- 計画の合計の目安は、締めたばかりのスプリントを含む直近3スプリントのベロシティの平均（3つに満たないときはあるだけ）
- 記録の Issue には、計画のときに期間、ゴール、計画の一覧（番号、PR、題、ポイント）と合計を本文に書き、締めのときに結果（済み、受け入れ待ち、途中で足した分、持ち越し、ベロシティ）をコメントに足して閉じる。計画の表の PR の列は人が見るためのもので、空でもよく、数え方は読まない。持ち越しでラベルを付け替えると、計画した合計がラベルから消えるため。締めのコメントは、ラベルを付け替える前に書く（`sprint-plan` が途中で落ちても、締めの数が残るため）。`sprint-review` は、締めの前に、記録の Issue へ `## レビュー` で始まるコメント（ステークホルダーの意見と要望、バックログの見直しの方向性）を足す。`## 締め` と区別するための印で、`sprint-plan` が次の計画の案に読む。記録の Issue は作業ではないので、`sprint-pick`、`sprint-review`、`daily-scrum` の一覧から外す

### Issue の状態

開いた Issue の状態は、ラベルと開いた PR で表す（2026-10-25 に決めた）。並行するセッションが、人と詰めている Issue や実装中の Issue を取らないようにするためと、セッションが進み具合を一覧にするとき（人の手元の開発ボードなど、リポジトリの外のもの）に、PR やワークツリーから推測せずに状態を読めるようにするため。一覧ではこの表のとおりに状態を出す。

| 状態 | 表し方 | 付け替えるきっかけ |
| --- | --- | --- |
| 着手できる | `status:ready`。開いた末端の Issue（`epic` でなく、サブ Issue を持たず、`sprint-log` でない）で、`pt:` が1つ付き、`status:refining`、`status:in-progress`、`status:accepting` が無く、このリポジトリのブランチの開いた PR に指されておらず、自分と祖先（親のストーリー、エピック。閉じた祖先から上は見ない）の前に要るもののうち開いていて `status:accepting` の無いものが無いとき | `.github/workflows/ready.yml` が付け外しする。Issue の開閉（作者がオーナーかメンバーかコラボレーターの Issue だけ）と判定に効くラベルの付け外し、`accepting.yml` の成功、1時間ごとの定期、手動の実行で動き、開いている Issue をすべて数え直して、変わる Issue だけ直す。当てはまらなくなれば（作業中のラベルが付いた、前に要るものが開いた、など）外れる（2026-10-29 に決めた。#476） |
| 要件整理中 | `status:refining` | `backlog-refine` で Issue を詰め始めたとき、`backlog-add` で既にある Issue の計画を書き始めたとき。セッションが付ける |
| 作業中 | `status:in-progress` | 番号付きのブランチ（`<番号>-<名前>`）のワークツリーを新しく切ったとき。`.githooks/post-checkout` が付け、`status:refining` を外す。クラウドのセッションはワークツリーを切らないので、着手したときに `gh api -X POST repos/{owner}/{repo}/issues/<番号>/labels -f 'labels[]=status:in-progress'` で付け、`status:refining` を外す |
| レビュー中 | その Issue を指す開いた PR があること。ラベルは使わない | PR の作成 |
| 受け入れ待ち | `status:accepting`。子を持つストーリーとエピックは、子がすべて閉じているか受け入れ待ちのとき（ラベルは付けない。子を持つ子は同じ判定を当てる） | main への PR のマージ。`.github/workflows/accepting.yml` が付け、`status:in-progress` と `status:refining`（付いていれば）を外す（2026-10-28 に決めた。#370） |
| 済み | Issue が閉じたこと | 人が受け入れで閉じる。マージでは閉じない。セッションは閉じない。ただし `sprint-review` で、すべての条件に印が付き、人が閉じると答えた Issue は、セッションが閉じる。スプリントの記録の Issue（`sprint-log`）は作業ではなく、`sprint-plan` が締めで閉じる |

- `status:ready` は人が GitHub の一覧（`is:open label:status:ready`）で着手できる Issue を見るための写しで、着手できるかの判定には使わない。`sprint-pick` と `increment-build` は、今までどおり依存関係の API（`issue_dependencies_summary.blocked_by` と `dependencies/blocked_by`）で毎回判定する。ラベルは次の実行まで古いことがあり、依存関係とサブ Issue の付け外しは `schedule` の間隔まで届かないので、ラベルを頼ると、並行するセッションが待ちのある Issue を取ってしまう。人が行う Issue（題が「確認:」で始まるものなど）、`migration` 同士のぶつかりも、ラベルでは見ない（`sprint-pick` が見る）。`ready.yml` は、自分の条件では外れない Issue で、自分か祖先の前に要るものを引けなかったとき（引いた数が `blocked_by` に足りないときを含む）は、付けも外しもせず、次の実行に任せる。ラベルは `POST` と `DELETE` だけで付け外しし、同時に人が付けたほかのラベルを消さない
- 表の上の行より下の行が勝つ。`status:ready` は、下の行（要件整理中、作業中、受け入れ待ち）のラベルが付けば外れる。開いた PR があれば、`status:in-progress` が付いたままでもレビュー中とみなす（PR を出してもラベルは外さない）。`status:accepting` が付いていれば、開いた PR があっても受け入れ待ちとみなす（直しの PR が同じ Issue を指していても、元の Issue は受け入れを待っている）
- 両方のラベルが付いていれば作業中とみなす。セッションが `status:refining` を付けるのは、`status:in-progress` の無い Issue だけ
- 閉じた Issue は、ラベルにかかわらず済みとして扱う。閉じた後にラベルを外す手間はかけない
- 受け入れ待ちの Issue は、人が受け入れで閉じるまで開いたままにする。前に要るものが受け入れ待ちなだけの Issue は、着手できる（上の「Issue の運用」）
- ラベルは `gh api` の REST で付け外しする（付ける `POST repos/{owner}/{repo}/issues/<番号>/labels`、外す `DELETE …/labels/<名前>`）。GraphQL の `gh issue edit` はクラウドのセッションで 403 になるため
- `post-checkout` は、前の HEAD が null の SHA になる checkout のうち、追加のワークツリーでだけ動く。clone、本体の作業コピー、既にある作業コピーでの `git switch -c`、detached のワークツリーでは付かないので、着手を表すなら手で付ける。既にあるブランチでワークツリーを切り直したときも付く。付けるのは、その番号が開いた Issue（PR ではない）だと確かめられたときだけ。`gh` が無い、認証が無い、通信が落ちたときは理由を知らせるだけで、checkout は続ける。`timeout` のある環境（Linux、coreutils を入れた macOS）では `gh` の1回の呼び出しを10秒で切り、無い環境では上限なしで待つ。書き込み先は `ucan-lab/scrum-guild` に固定してある。同じフックが、Issue の判定より前に、ワークツリーの `.dev.vars` を本体の `.dev.vars` へのリンクにする（番号の無いブランチ、`gh` が無い環境でも動く。上の「ワークツリーで作業する」）
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

- CSP: SvelteKit の `csp` の設定（ハッシュ）で、`script-src` を自分のものだけにする。`default-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`frame-ancestors 'none'`、`form-action 'self'` を基本にする。外を読む必要が出たら、その先だけを足す。足したのは `img-src` の `'self'` と `https://avatars.githubusercontent.com`（GitHub のアバター）と `https://lh3.googleusercontent.com`（Google のアバター。`*.googleusercontent.com` 全体は許さない）で、運用者が最初の管理者に指名する人のアバターを作る前に見せるため。`form-action` には `https://accounts.google.com` を足した。招待の URL の画面のフォームは自分の API に POST し、Chrome は `form-action` をリダイレクトの先にも当てるので、Google の認可の画面へ移る 302 が止まらないようにする。書体は自分の Worker から配るので足していない（上の「書体」）
- `style-src` は `'self'` に加え、SvelteKit が差し込む読み上げ用の要素（`svelte-announcer`）の `style` 属性だけを `'unsafe-hashes'` とハッシュで通す。止めると、画面を移るたびに読み上げ用の文が見えてしまうため
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Strict-Transport-Security: max-age=31536000; includeSubDomains`
- 招待の URL を開く画面（`/invite`）だけ `Referrer-Policy: no-referrer`。フラグメントは Referer に付かないが、秘密を持つ画面なのでオリジンも外へ送らない。`_headers` の `/invite` と `/invite/` の規則は、`/*` の値と `a, b` の形で並ばないよう、`! Referrer-Policy` で外してから付けたもの
- e2e で、CSP の違反が出ないことを確かめる

値は `src/shared/security-headers.ts` の1か所に持ち、画面の資産と API の両方がそこから付ける。

### 画面の資産

Workers Static Assets の `_headers` で付ける。資産の配信には Worker を起動させない（`run_worker_first` は `/api` と `/api/*` だけ。`/api/*` だけだと末尾にスラッシュの無い `/api` が SPA の `index.html` を 200 で返す）。

- CSP の出どころは SvelteKit の `kit.csp`（`mode: 'hash'`）。SvelteKit が書き出した `build/index.html` の meta の CSP を、`pnpm build` の最後に `scripts/write-headers.ts` が `build/_headers` に写す。ハッシュは build ごとに変わるので、コミットした `_headers` には書けない
- SvelteKit は meta で出すときに `frame-ancestors`、`report-uri`、`sandbox` を捨てる（meta では効かないため）。写すときに、捨てられた `frame-ancestors 'none'` を末尾に足す
- 写すスクリプトは、meta が見つからないとき、書き出した JS の `style` 属性が `style-src` のハッシュに無いとき（SvelteKit を上げて読み上げ用の要素の `style` が変わったときなど）に build を失敗させる
- `/_app/immutable/*` は `Cache-Control: public, max-age=31536000, immutable`。ファイル名にハッシュが入り中身が変わらないため。`index.html` は Cloudflare の既定（毎回確かめる）のままにして、新しい版をすぐ拾う
- `inline` の script と style を `src/app.html` とコンポーネントに書かない。ハッシュから漏れて CSP で止まる
- Web Worker（Markdown の変換。`src/lib/markdown.worker.ts`）は、Vite が `/_app/immutable/workers/` に出す自分のオリジンのファイルとして読む。`worker-src` は足さず、`script-src 'self'` で通る。`blob:` と `data:` の Worker は CSP を広げるので使わない。Worker は束の評価を終えると `ready` を返し、変換の時間切れ（1秒）はそこから数える。micromark が使う `decode-named-character-reference` の既定の版（`browser` 条件）は `document` を呼んで Worker で落ちるので、`vite.config.ts` の `resolve.alias` で、DOM を使わない版（dev と build の両方）にそろえる（`scripts/markdown-worker-entities.ts`。直の依存）

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
- ドメインへ移すときは、公開する URL の設定、GitHub OAuth App の戻り先、Google のクライアントの承認済みのリダイレクト URI、Cookie を直し、移した後にもう一度ログインしてもらう。作ってある招待の URL（`<公開 URL>/invite#<秘密>`）は古いドメインのままなので、結ばれていない指名は作り直す。手順は `docs/operations.md` に書く
- 組織を示す URL の形（`/<slug>/...`）は、`workers.dev` の上でも変えない

## 定期の作業

- 依存の更新は Renovate か Dependabot で週に1回、まとめて出す。`needs-human` が付くので、人が差分を読んでマージする
- `wrangler d1 export` の定期の書き出しは、顧客のデータなので GitHub の成果物に置かず、R2 の別のバケットに置く
