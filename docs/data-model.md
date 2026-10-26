# Scrum Guild データモデル

状態: 確定。要件定義（`requirements.md`）を D1（SQLite）のテーブルに落としたもの。最初のマイグレーション（`migrations/0001_create_initial_tables.sql`）で、共通の6表と、一本道に要る組織の中の16表を作った。残りの表は、使う機能の Issue でマイグレーションを足して作る

## 決まりごと

- 名前はスクラムの言葉で、テーブルは複数形のスネークケース、列はスネークケース。
- 主キーは UUIDv7 の文字列（`TEXT`）で、列名は `id`。行を作る Worker が採番する。単一の行しか持たない表と、他の表の組を主キーにする表は除く。主キーの列には `NOT NULL` も書く。SQLite の通常の表では、`PRIMARY KEY` だけでは NULL を拒まないため。
- 日時は UTC の ISO 8601（`2026-10-20T01:23:45.678Z`）を `TEXT` で持ち、列名は `_at` で終える。
- 日付は `YYYY-MM-DD` を `TEXT` で持ち、列名は `_on` か `_date` で終える。検査は `CHECK (x IS date(x))`。`=` で比べない。`date()` は形の崩れた値に NULL を返し、`=` の比較が NULL になると CHECK は通ってしまうため。`IS` なら空の列は通り、形の崩れた値は当たる。
- 月は `YYYY-MM` を `TEXT` で持ち、列名は `_month` で終える。検査は `CHECK (x || '-01' IS date(x || '-01'))`。
- 真偽は `INTEGER` の 0 と 1 で持ち、列名は `is_` で始める。検査は `CHECK (x IN (0, 1))`。
- 列挙は `TEXT` に `CHECK (x IN (...))` を付ける。値は英語の小文字とスネークケース。取り込み元に固有の値（取り込み元の種類、取り込む範囲の種類）は CHECK に書かず、取り込み元の型の一覧でアプリが検証する。SQLite では CHECK を後から変えられず、取り込み元を足すたびに表を作り直すことになるため。
- JSON は `TEXT` に `CHECK (json_valid(x))` を付け、列名は `_json` で終える。
- 本文とコメントは `CHECK (length(x) <= 100000)` で10万字に抑える。
- 論理削除は `deleted_at` で持つ。一覧の索引は `deleted_at IS NULL` の部分索引にする。
- SQL は D1 で通る SQLite の方言で書く（部分索引、`json_valid`、`date()`、CHECK を使う）。
- 外部キーは張る。D1 は検査が有効。`ON DELETE` は付けず、物理削除はアプリが順に行う。
- `users.id` を指す外部キーの列には、外部キーの検査に使える索引を持つ。その列を先頭に置く索引で、部分索引なら条件は `x IS NOT NULL` だけにする（空にできる列はこの形にする）。待っていた `users` の行を消すとき（「メールアドレスで待つ指名と招待」の統合）、索引が無いと SQLite が子の表を全件読んで検査するため。引き換えに、子の表を書くたびに索引も書き、D1 の書いた行数が増える。空にできる列を部分索引にするのは、空の行の分を書かずに済ませるため。主キーやほかの索引の先頭の列なら足さない。`left_at IS NULL` のようなほかの条件の部分索引は、検査に使えないので数えない。各表の索引では「外部キーの検査」と書く。表を足すときも同じにし、`test/schema.test.ts` が `users` の行を消す文の実行計画で確かめる。
- 作成日時と更新日時は `created_at`、`updated_at` で、更新はアプリが書く。
- 手で並べ替える並びは、分数の並び（fractional indexing）の文字列 `position` で持つ。間に入れても他の行を書き換えない。新しく入ったものは末尾の値を取る。同時に作ると同じ値になりうるので、読むときは `position, id` の順で並べる（同じ値の行は `id` の順で、同じミリ秒の中では作った順とは限らない）。並べ替えは、移す先の中で直前の行とその次の行（移す行を除き、完了した行も含む）の間の値を取る。直前の行と次の行が同じ値なら、間に入る値が無いので、直前の行と同じ値で `id` が後ろの行（同じ値の続き）を、移す行と一緒に、直前の行の値と次の違う値の間で振り直す（同じ `batch()` で書く。決まりは `tasks` の「並べ替えと親の移動」）。値は `fractional-indexing` のパッケージで作る（ワークスペースを作るときの最初の列も同じ）。
- 集計（積載量、経験値の合計、ポイントの合計、ベロシティ）は保存せず、読むたびに計算する。
- 1つの D1 に複数の組織を入れる。組織の中の行は、リクエストの組織から辿って引く。ID だけで行を引かず、必ず `organization_id` か、組織を確かめた `workspace_id` で絞る。他の組織の行が見えないことはテストで確かめる。
- 表を共通の表と組織の中の表に分け、後から組織ごとにデータベースを分けられるようにしておく。決まりは「データベースの分け方」。

## 全体の構成

| まとまり | テーブル |
| --- | --- |
| アカウント | `accounts`、`sessions`、`oauth_states`、`rate_limits` |
| 組織 | `organizations`、`users`、`organization_holidays` |
| ユーザーの稼働 | `user_capacity_settings`、`user_monthly_overrides`、`user_time_off` |
| ワークスペース | `workspaces`、`workspace_point_rates`、`workspace_holidays`、`memberships`、`invitations`、`allocations` |
| ワークスペースの定義 | `board_columns`、`detail_fields`、`categories`、`repositories` |
| 接続 | `connections`、`connection_scopes`、`connection_status_mappings` |
| 計画と作業 | `epics`、`epic_party_members`、`stories`、`tasks`、`task_sources`、`task_source_payloads`、`task_field_values`、`comments`、`attachments`、`sprints`、`sprint_entries` |
| 記録 | `completions`、`thanks`、`xp_grants`、`notifications`、`change_logs` |

親子の向きの要点。

- アカウントは人ごとに1行で、組織をまたぐ。ログインの手段（初版は GitHub と Google）とは `account_logins` で結び、特定の手段に依存させない。ログインとセッションはアカウントに付く。
- 人は、ログインの手段（`login_provider`）と手段の中の不変の ID（`login_subject`）の組で見分ける。GitHub では `github` とユーザー ID、Google では `google` と `sub`。アカウントができる前の管理者の指名と招待も、この組で持つ。
- Google の人への指名と招待は、`sub` が分からないうちはメールアドレス（`login_email`）と招待の URL の秘密のハッシュ（`claim_token_hash`）で持ち、`login_subject` を空にしておく。本人が招待の URL から Google でログインしたときに、その行へ `sub` を埋める（下の「メールアドレスで待つ指名と招待」）。
- ユーザーは組織ごとの人で、アカウントと組織の組に1行。組織の中の表はすべてユーザーを指し、アカウントは指さない。
- 組織の直下のもの（`users`、`workspaces`、`organization_holidays`、`change_logs`）は `organization_id` を持つ。
- ワークスペースの中のものは、すべて `workspace_id` を持つ。権限の検査と絞り込みを1つの列で行うため、親から辿れるものにも持たせる。`organization_id` は持たせず、`workspaces.organization_id` で組織を確かめる。
- タスクの親はストーリーだけ（`tasks.story_id`）、ストーリーの親はエピックだけ（`stories.epic_id`）。
- 取り込んだタスクは `tasks` の1行に `task_sources` の1行が付く。手で作ったタスクには付かない。

## データベースの分け方

初めは全組織を1つの D1 に入れる。容量か負荷が足りなくなったら、決まった数の D1 に組織を振り分ける。そのときにコードを書き直さずに済むよう、今から次の決まりを守る。

### 共通の表と組織の中の表

| 区分 | テーブル | 置き場所 |
| --- | --- | --- |
| 共通 | `accounts`、`account_logins`、`sessions`、`oauth_states`、`rate_limits`、`organizations` | 共通の DB に1つだけ |
| 組織の中 | それ以外のすべて | 組織が置かれた DB |

添付ファイルの中身は D1 ではなく R2 に置く。R2 のキーの先頭は組織の ID なので、D1 を分けても R2 は分けずに済む。

- 共通の表から組織の中の表へは外部キーを張らない。
- 組織の中の表から共通の表へ張る外部キーは、`users.account_id` と、`users`、`workspaces`、`organization_holidays`、`change_logs` の `organization_id` だけにする。分けるときはこれらを外し、アプリの検査に替える。
- 共通の表と組織の中の表を1つの SQL で結合しない。`users` にログイン名とアバターを添えるときも、`accounts` と `account_logins` を別に引いてアプリで合わせる。

### 読み書きの入口

- 組織の中の表は、リクエストの組織から DB を選ぶ1つの関数を通して読み書きする。今はどの組織でも同じ DB を返す。
- 共通の表は、共通の DB を返す別の関数を通して読み書きする。
- 1回の `batch()` に、共通の表と組織の中の表を混ぜない。今これに当たる操作は「書き込みの単位」の組織の作成、組織の設定の変更、メンバーの離脱で、どれも2回に分けて書く。
- 組織をまたいで読む処理は、1つの関数にまとめる。当たるのは、ログインできるか（入れる組織と届いた招待があるか）、ログインの直後の組織の選択、届いた招待の一覧、初めてのログインで `users.account_id` を埋めること、招待の URL の秘密のハッシュから待っている指名と招待を引くこと、運用者の一覧の管理者の状態を数えること。今は組織の中の表を持つ DB が1つで、`allOrganizationDatabases()`（`db/select-database.ts`）が返す DB ごとに、組織の中の表（`users`、`memberships`、`invitations`）を引き、共通の表（`organizations`）を別の問い合わせで引いて、アプリで合わせる。`users` と `invitations` は、アカウントに結んだログインの手段と ID の組ごとに、`users_login` と `invitations_login_pending` の索引で引く（全件を読まない）。分けたときは、この関数だけを、DB の一覧を全部返す形に直すか、共通の DB にログインの ID（`login_provider` と `login_subject`）と組織の組の索引、招待の URL の秘密のハッシュと組織の組の索引を持つ形に直す。どちらにするかは分けるときに決める。
- 組織をまたいで読む関数（`listAccountOrganizations`）の前提。アカウントは必ず1つ以上のログインを持つ（0件なら、一覧は何も引かずに空を返す）。`users` の行のログイン（`login_provider`、`login_subject`）は、結んだアカウントのログインのどれかである。一覧はログインの手段と ID で `users` を引いてから `account_id` で絞るのに対し、`enterOrganization` は `account_id` で引くので、この前提が崩れると、一覧と入れる組織がずれる。ログインの付け替えや統合を入れるときは、この関数を直す。結ぶ書き込み（ログインのたびの、`account_id` が空の行の埋め直し）は、この前提を崩さない。
- 組織の選択（`listAccountOrganizations`）が返す届いた招待は、1組織1件で、組織の名前と slug だけを持つ（`{ organization_name, slug }`）。slug は、承諾と辞退の操作（#187 で作る。今は無い）をその組織の slug の下で呼ぶのに使う。ワークスペースや招待した人など、組織の中の値は入れない。
- ログインできるかの判定は、`listAccountOrganizations` と同じ読み取り（`readAccountOrganizations`）を通す。入れる組織か届いた招待が、停止していない組織に1つでもあれば通す。2つの場面で使う。
  - セッションの判定（組織の外の操作と、組織に入れなかったとき）: 組織の選択と同じ結果を、1回のリクエストの中で使い回す。アカウントに結ばれる前の行（`account_id` が空で、ログインの手段と ID が一致する、指名で待っていた行）は数えない。結ばれる前の行だけを持つ人のセッションを、どこにも入れないまま残さないため。その人は 401 でセッションが消え、もう一度ログインすると結ばれて入れる。組織を離れる、無効にするなどの書き込みの後に、相手のセッションを消すかの判定（組織の道具の `endSessionsIfLoginLost`。`docs/development.md` の「操作の定義」）も、同じ基準を使う。
  - ログインのとき（`hasLoginAccess`）: 結ばれる前の行も数える。ログインのたびに `users.account_id` を結ぶので、これから入れる行だから。初めてのログインではアカウントが無くても引ける。
- `linkLoginToAccount` は、組織で絞らずに `users.account_id` と `updated_at` を書く、この読み書きの入口だけの例外（組織の中の操作の処理は、組織の ID で絞らないと書けない）。呼ぶのは、ログインのたびの結び直しと、運用者の組織の作成の書いた後の結び直し（運用者の道具の `linkLogin` 経由）。絞るのは、ログインの手段と ID が一致することと、`account_id` が空であること。読む文と書く文は、どちらも `users_login` の索引に乗る。1つのアカウントに複数のログインの手段を結ぶとき（#57）は、同じ組織に同じアカウントの行が2つできて、`users_organization_account`（`organization_id` と `account_id` の一意）に当たりうる。#57 で、この前提と判定と、結ぶ UPDATE を見直す。

### 分けるとき

- wrangler の設定に、決まった数の D1（`DB_0`、`DB_1` など）を並べる。D1 の接続は設定に固定で書くもので、組織を作るたびには増やせないため。
- `organizations` に置き場所の列を足し、組織の DB を選ぶ関数はその列を見る。
- マイグレーションは、共通の DB と、組織を置くすべての DB に当てる。組織の中の表の定義はどの DB でも同じにする。
- 組織を移すときは、その組織の行を書き出して移し先へ入れ、`organizations` の置き場所を書き換える。手順は運用の手順書に書く。
- 組織ごとに Durable Objects の SQLite を持つ形は選ばない。API が Durable Objects を経由する形になり、マイグレーションの当て方も変わって、作りが大きく変わるため。

### 分ける目安

- 応答を保存する組織では、量の大半は取り込み元の応答（`task_source_payloads`）で、1件 5〜10KB とみると、上限いっぱい（タスク5万件）の組織で 0.5GB 前後になる。保存しない組織はこの分がなく、ずっと小さい。1つの D1 の上限は 10GB。
- 容量が上限の半分を超えたら、分ける準備を始める。
- D1 は1つのデータベースへの問い合わせを順に処理するため、容量より先に負荷が効くことがある。分けるのは、画面の API が 500ms の目安を超える状態が続き、索引や問い合わせを直しても戻らないとき。

## アカウント

### accounts

人ごとの1行。組織をまたぐ。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| last_login_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 初めてログインできたときに、`account_logins` の行と同じバッチで作る。入れる組織が1つもない人の行は作らない。ただし運用者（下の一覧に載った人）は、入れる組織が無くても作る。運用者の画面に組織の外から入るため。
- 運用者かどうかは、この表ではなくシークレットのログインの ID（`github:12345`、`google:<sub>` の形）の一覧で決める。

### account_logins

アカウントとログインの手段の結び付き。初版は1つのアカウントに1行だけ（GitHub か Google）で、結ぶ操作を足したら1つのアカウントに複数の行を結べる。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| login_provider | TEXT | PK | ログインの手段（初版は `github` と `google`）。値はログインの手段の型の一覧でアプリが検証する |
| login_subject | TEXT | PK | 手段の中の不変の ID。GitHub ではユーザー ID を10進の文字列で、Google では ID トークンの `sub` を受け取った文字列のまま持つ。数値に直さない（Google の `sub` は JavaScript の数値で正確に表せない桁数がある） |
| account_id | TEXT | NOT NULL、FK accounts | |
| login_name | TEXT | NOT NULL | ログインのたびに書き直す表示用の名前。GitHub ではログイン名、Google ではプロフィールの名前（`name`。無ければ「Google ユーザー」）。Google のメールアドレスは持たない |
| display_name | TEXT | | 手段の側の名前。組織で初めてユーザーを作るときの表示名の既定 |
| avatar_url | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `(account_id)`。

### sessions

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| token_hash | TEXT | PK、`CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')` | Cookie に入れたランダムな ID（32 バイトの乱数の base64url、43文字）の SHA-256 を小文字の16進（64文字）にしたもの。ハッシュする前の値を入れる取り違えを DB で止める。`claim_token_hash` の列（`oauth_states`、`users`、`invitations`）も同じ CHECK を持つ |
| account_id | TEXT | NOT NULL、FK accounts | |
| created_at | TEXT | NOT NULL | |
| last_used_at | TEXT | NOT NULL | 使うたびに書き直す |
| expires_at | TEXT | NOT NULL | `last_used_at` の30日後 |

- 索引: `(account_id)`。ログアウトは今のセッションの行だけを消す。ログインできる条件を失ったとき（入れる組織が1つもなくなったとき。運用者は組織が無くてもログインできるので除く）は、その人の行をすべて消す。確かめるのは、組織の外の操作（定義に `skipsLoginAccess` を付けた `logout` を除く）と、組織の中の操作で組織に入れなかったとき。`logout` は入れる組織を失った人にも使わせる。結ばれる前の指名の行は数えない（「読み書きの入口」）。停止した組織にしか入れない人は、停止の間にセッションが消え、組織が再開した後も、もう一度ログインが要る。消すのは確かめた時刻までに作られた行だけで、確かめた後に作られたセッションは残す。
- 組織に入れるかは、リクエストのたびにその組織の `users`、`memberships`、`invitations` で確かめる。1つの組織で無効にされても、セッションは消さない。
- 書き込みを減らすため、`last_used_at` は前回から1時間以上たったときだけ書き直す。
- `expires_at <= 定期処理の基準の時刻` の行を、毎分の定期処理で消す（「期限切れの行の掃除」）。

### oauth_states

ログインの手段の OAuth の state と PKCE の code_verifier、OpenID Connect の nonce。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| state | TEXT | PK | |
| login_provider | TEXT | NOT NULL | 戻ってきたときにどの手段で確かめるか |
| code_verifier | TEXT | NOT NULL | |
| nonce | TEXT | | OpenID Connect の手段（Google）で、ID トークンの `nonce` と比べる値。GitHub では空。Google で空の行は、アプリが拒む |
| claim_token_hash | TEXT | | 招待の URL から始めたログインで、その URL の秘密の SHA-256。戻ってきたときに、待っている指名か招待を引く |
| return_to | TEXT | `CHECK (return_to GLOB '/*' AND return_to NOT GLOB '//*' AND return_to NOT GLOB '/\*' AND return_to NOT GLOB '*[^ -~]*')` | ログイン後に戻る画面のパス。自分のサイトのパスだけで、`//` や `/\` で始まる別のサイトへの移動は DB でも拒む。印字できる ASCII に限る（ブラウザは URL のタブと改行を取り除くので、`/<タブ>/evil.example` が `//evil.example` になる）。DB の CHECK が拒むのは、この大まかな形だけ。長さ（512文字まで）、`.` と `..` の区間、パスの `\`、`api` と `login` で始まる値などの細かい検査は、アプリ（`src/shared/return-to.ts`）が持ち、合わない値は `/` に直す。長さを絞るのは、未ログインの人が書かせられる1行を小さく保つため |
| expires_at | TEXT | NOT NULL | 作ってから10分 |

- `state` は HttpOnly の Cookie にも同じ値で置く。戻り先では、クエリの `state` と Cookie の値が合うことを確かめてから、この表の行を `DELETE ... RETURNING` で消して読む。Cookie が無い、合わない戻りは、行にも Cookie にも触れず、レート制限にも数えずに断る（ログインの CSRF を止める）。照合に通った戻りは、行と Cookie を使い切る。枠を数えるのは、行を使い切れた戻りだけ（ブラウザ以外の相手は Cookie を自由に付けられるので、行の無い `state` で枠の行を書かせない）。
- 使ったら消す（1つの `state` は1回しか通らない）。使われずに切れた行は、`expires_at <= 定期処理の基準の時刻` の行を、毎分の定期処理で消す（「期限切れの行の掃除」）。

### rate_limits

ログイン、手動の同期、招待（GitHub に問い合わせる `invitee-resolve` と `invitation-create`）のレート制限。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| key | TEXT | PK | `login:<IP>`（ログインの開始と戻り先。`CF-Connecting-IP`。IPv6 は上位 64 ビットに丸めた `login:2001:db8:1:2::/64` と、上位 48 ビットの `login48:2001:db8:1::/48` の2つ。IPv4 を写した IPv6 は IPv4 に直す。解釈できない値と IP の無いリクエストは `login:unknown`）、`login:global`（ログインの開始の全体の枠）、`operation:<操作の名前>:<アカウントの ID>`（操作の定義の `rateLimit`） |
| window_start_at | TEXT | NOT NULL | 窓の最初の呼び出しの日時 |
| count | INTEGER | NOT NULL | 窓の中の呼び出しの数。操作の定義の枠は、上限を超えた呼び出しも数える。ログインの枠は、覗いた時点で上限に届いていれば数えない（覗いた後に並行した呼び出しは、上限を少し超えて数えることがある） |

- 1文の upsert（`INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`）で数える。`window_start_at` から窓の長さがたっていれば、`window_start_at` を今に、`count` を 1 に戻す。返った `count` が上限以下なら通す。
- ログインの枠は、数える前に行を読むだけで覗き、上限に届いた枠が1つでもあれば、どの行も書かずに断る。未ログインの人が、叩く速さに比例して行を書き換えさせられないようにするため。窓は固定で、断った呼び出しは `window_start_at` を動かさないので、上限の後を数えなくても断る効き目は同じ。覗いた後に並行して来た呼び出しはそれぞれ数えてから断るので、`count` が上限を超えるのは、そのとき飛んでいた呼び出しの分だけ。
- ログインは同じ IP から10分に60回まで（1回のログインで開始と戻り先の2回を数える）。IPv6 は、この /64 の枠に加えて、/48 の枠を10分に120回まで数え、どちらかを超えたら断る。/48 の枠を先に数え、超えていたら /64 の枠は数えない（/64 を変えて叩かれても、行を増やさない）。/48 の枠は、下の全体の枠より十分小さくし、1つの /48（家庭の /56 を含む1回線）だけで全体の枠を使い切れないようにする。値は `src/server/auth/rate-limit.ts` の定数。
- ログインの開始は、IP の枠に加えて、全部の IP を合わせた全体の枠 `login:global` を10分に600回まで数える。IP を多く持つ人が、IP の数に比例して `oauth_states` の行を書かせられないようにするため。
  - 順は、全体の枠を覗き、上限に届いていれば何も書かずに断る → IP の枠を覗いてから数える → 通った呼び出しだけ全体の枠を数える。全体の枠を先に数えると、断った呼び出しも数えるので、1つの IP から叩き続けるだけで全体の枠を使い切れる。この順なら、1つの IP が使える全体の枠は IP の枠の上限まで（IPv4 は60回、IPv6 の /48 は120回。窓の始まりは枠ごとに違うので、窓の境目をまたぐとその約2倍）。
  - 全体の枠が上限の間の開始は、`rate_limits` にも `oauth_states` にも書かない。
  - 覗いた後に並行した呼び出しがすり抜けても、最後に全体の枠を数えるので、通る開始（`oauth_states` を書く数）は上限を超えない。すり抜けた呼び出しが IP の行を書くことは止めず、受け入れる（全体の枠が埋まる瞬間に飛んでいた呼び出しの分だけ）。
  - 居座る `oauth_states` は、窓の境目をまたいでも約1,200行まで。叩かれ続けたときの書き込みは、索引と掃除の削除を含めて開始1回で約10〜15行、月に約2,500万〜4,000万行で、Workers Paid の込みの5,000万行に収まる。
  - 戻り先は全体の枠で数えない。戻り先が数えるのは `state` の行を使い切れたものだけで、行は開始が書いたものしか無いので、開始の全体の枠で間接的に絞られる。GitHub から戻った人を、全体の枠で断らないため。
  - 断ったときの画面は IP の枠と同じ `too_many`。ログの `outcome` は `too_many_global` で、IP の枠の `too_many` と見分ける。
- 数えるのは、利用者が始めた画面の移動の開始と、`state` の行を使い切れた戻りだけ。開始は、`Sec-Fetch-Mode` が `navigate`、`Sec-Fetch-Dest` が `document`、`Sec-Fetch-Site` が `same-origin` か `none` で、`Sec-Purpose` に prefetch と prerender を含まないもの。どのヘッダーも、送らない古いブラウザは通す。ほかのサイトが `<img>`、`fetch()`、`<iframe>`、リンクの移動、先読みで読ませても、被害者の枠は減らず、`oauth_states` の行もできない。
- 残る限界: `Sec-Fetch` を送らない古いブラウザには、`<img>` で読ませる攻撃が通る。同じ IP を共有する人（同じオフィス）が、意図して枠を使い切ることは止められない。IP を多く持つ人は、IPv4 なら約10個（窓の境目をまたげば約5個）、IPv6 なら約5個（窓の境目をまたげば約3個）の /48 で全体の枠を使い切り、新しいログインを止められる。止まるのは新しいログインだけで、ログイン済みの人はセッションの期限まで使い続ける。覗いて断った呼び出しにも、Workers のリクエストと D1 の読み出しの料金はかかる。行の無い `state` を Cookie と合わせて送る戻り先も、枠では止まらず `oauth_states` の `DELETE` まで届く（消す行が無いので書き込みは0行）。リクエストの量そのものを止めるのは、ドメインを取った後の WAF の役目。
- 手動の同期の「接続ごとに5分に1回」は、この表ではなく `connections.last_manual_sync_at` で判定する。
- `window_start_at <= 定期処理の基準の時刻 - 最長の窓` の行を、毎分の定期処理で消す（「期限切れの行の掃除」）。最長の窓は、ログインの枠（`src/server/auth/rate-limit.ts`）と操作の定義の `rateLimit` の窓のうち最も長いもの。短い窓の枠を過ぎていても、最長の窓の内にある行は残す。最長の窓に入らない窓の枠は、`consumeRateLimit` が例外にする。

### 期限切れの行の掃除

`sessions`、`oauth_states`、`rate_limits` の期限を過ぎた行は、毎分（`* * * * *`）の定期処理（`src/server/scheduled/`）が消す。

- 基準の時刻は3表で共通で、`controller.scheduledTime`。
- 消す文は表ごとに1文で、1文につき1万行まで。D1 は `DELETE ... LIMIT` を受けないので、`WHERE <主キー> IN (SELECT <主キー> FROM <表> WHERE <期限の条件> LIMIT 10000)` の形にする。表ごとに別の `batch()` で送る。
- 消した件数が1万行に届いた表は、同じ文をもう一度送る。1回の定期処理で1つの表に送る文は20回まで、かつ定期処理の開始から20秒まで。どちらか先に尽きたら止め、残りは次の回に消す。普段は1文で終わる。
- 1つの表が失敗したら、その表はそこで止め、残りの表は続け、全部を終えてから定期処理は例外で終わる。
- 期限の列に索引は無い。消す行が少ない回は表を全部読む。表が数十万行で常にとどまるようになったら、索引を見直す。

## 組織

### organizations

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| slug | TEXT | NOT NULL、UNIQUE、`CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40)` | URL の先頭に入れる名前。後から変えない |
| name | TEXT | NOT NULL | 組織の表示名 |
| vocabulary | TEXT | NOT NULL、`game` か `scrum`、既定 `game` | ワークスペースの外の言葉づかい |
| theme | TEXT | NOT NULL、`simple`、`simple_light`、`simple_dark`、`medieval`、`modern` のどれか、既定 `simple` | 組織の既定のテーマ。`simple` は OS の明暗に合わせる |
| suspended_at | TEXT | | 停止した日時。入っていれば誰も入れず、定期処理も止める |
| purge_on | TEXT | | 解約で停止したときの、データを消す予定日（停止から30日後）。一時的な停止では空 |
| member_limit | INTEGER | NOT NULL、既定 15、`CHECK (member_limit > 0)` | 人数の上限。運用者が決める |
| attachment_quota_bytes | INTEGER | NOT NULL、既定 32212254720 | 添付ファイルの合計の上限（既定 30GB）。運用者が決める |
| attachment_quota_warned_at | TEXT | | 合計が上限の80%を超えたと管理者に通知した日時。合計が80%を下回るか、上限を上げたら空に戻す |
| stores_source_payload | INTEGER | NOT NULL、既定 0 | 取り込み元の応答（`task_source_payloads`）を保存するか。管理者が組織の設定で選ぶ |
| created_by_operator | TEXT | NOT NULL | 作った運用者のログインの ID（`github:12345`、`google:<sub>` の形） |
| created_at、updated_at | TEXT | NOT NULL | |

- 運用者の画面で作る。作るときに最初の管理者の `users` を同じバッチで入れる（アカウントがまだなければ、`account_id` が空の `users` の行で待つ。下の `users` を参照）。
- アプリが使う名前（`api`、`login`、`operator` など）を slug にできないことは、アプリが検査する。予約した名前の一覧は `src/shared/organization-slug.ts` に持ち、画面の最上段のルートを足したら合わせて足す（`scripts/organization-slug.test.ts` が照合する）。
- 続けて書く `users` と `change_logs` の入口は、組織の作成の関数（`src/server/db/create-organization.ts`）が作る。入口を作れるのは `organizations` に挿入した組織の ID だけで、任意の組織の ID から入口を作る関数は `db/` の外へ出さない。同時に作られて `slug` の UNIQUE に当たったときは、`slug` の行が今あるかを読み直し、重なりとして 409 を返す。
- 人数は保存せず、招待のたびに数える。対象は、無効にしていない管理者と、いずれかのワークスペースに今所属しているか承諾待ちの招待を持つ人（まだアカウントのない人への招待を含む）で、同じ人は1人とする。招待のうち、閉じたワークスペースへの招待と、同じ組織で無効にされた人（同じ `(login_provider, login_subject)`）への招待は数えない。人数が `member_limit` 以上なら、まだ数えられていない人の招待を断る。すでに数えられている人（同じ `(login_provider, login_subject)` の、無効でない管理者、いずれかのワークスペースに今所属している人、数えられる承諾待ちの招待を持つ人）は、上限でも招待できる。数えるのは GitHub に問い合わせた後で、数えてから書くまでの間に同時に招待されたときはそのまま認める（超えるのは同時に送った招待の数まで）。
- 解約した組織は、`purge_on` を過ぎたら運用の手順でこの組織の行をすべて消し、R2 の `<organization_id>/` で始まるファイルも消す。再開したら `suspended_at` と `purge_on` を空に戻す。

### users

組織ごとの人。アカウントと組織の組に1行。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| organization_id | TEXT | NOT NULL、FK organizations | |
| account_id | TEXT | FK accounts | アカウントができる前（管理者の指名で待つ間）は空 |
| login_provider | TEXT | NOT NULL | 突き合わせに使うログインの手段。`account_logins` と同じ値 |
| login_subject | TEXT | | 突き合わせに使う手段の中の不変の ID。`account_logins` と同じ値。Google の指名で `sub` が分かる前は空 |
| login_email | TEXT | | `sub` が分かる前に突き合わせるメールアドレス（そろえ方は下の「メールアドレスで待つ指名と招待」）。Google の指名で使い、`sub` を埋めたら空にする |
| claim_token_hash | TEXT | UNIQUE | 招待の URL の秘密の SHA-256。`sub` を埋めたら空にする |
| claim_expires_at | TEXT | | 招待の URL の期限（作ってから14日）。`sub` を埋めたら空にする |
| name | TEXT | NOT NULL | この組織での表示名。初回は手段の側の名前かログイン名。Google の指名で待つ間はメールアドレスで、`sub` を埋めるときに Google のプロフィールの名前に書き直す |
| is_admin | INTEGER | NOT NULL、既定 0 | 管理者（ギルドマスター） |
| work_start_on | TEXT | | 稼働開始日。空なら区切らない |
| work_end_on | TEXT | | 稼働終了日。空なら区切らない |
| disabled_at | TEXT | | 無効にした日時。入っていればこの組織に入れない |
| last_seen_at | TEXT | | この組織に最後に入った日時。1時間に1回まで書く |
| theme | TEXT | `organizations.theme` と同じ値か NULL | 自分で選んだテーマ。NULL なら組織の既定に従う |
| created_at、updated_at | TEXT | NOT NULL | |

- 表の制約: `CHECK ((login_subject IS NULL) = (login_email IS NOT NULL))`、`CHECK ((login_email IS NULL) = (claim_token_hash IS NULL) AND (login_email IS NULL) = (claim_expires_at IS NULL))`、`CHECK (login_email IS NULL OR (login_provider = 'google' AND login_email = lower(trim(login_email))))`。
- 一意: `(organization_id, login_provider, login_subject)`。`login_subject` が空の行どうしは、SQLite では NULL が重ならないので当たらない。待っている指名は、運用者が指名し直すと消すので、メールアドレスの一意は持たない。
- 一意: `(organization_id, account_id) WHERE account_id IS NOT NULL`。アカウントと組織の組に1行。1つのアカウントに複数のログインの手段を結んだ後も、同じ人が1つの組織に2行持たないようにする。
- 索引: `(login_provider, login_subject)`。ログインのときに入れる組織を引く。
- 表示するログイン名とアバターは `account_logins` から引く。
- 運用者が組織を作るときは、最初の管理者をログインの ID に解決し（GitHub はユーザー名からユーザー ID へ。Google は解決せず、`login_email` と招待の URL の秘密で待つ）、`is_admin = 1` の行を入れる。GitHub の `name` は解決したユーザー名。GitHub のユーザー名が指すのは個人のアカウントだけで、組織のアカウント（応答の `type` が `Organization`）は断る。`account_id` は、指名のときに共通の DB の `account_logins` を（ログインの手段と ID で）引き、当たればその書き込みで埋める。既にアカウントのある人（別の組織で使っている人）が、ログインし直さずに新しい組織へ入れるため。当たらなければ空で待ち、その人が初めてログインしたときに埋める（`linkLoginToAccount`）。`account_logins` は共通の表なので、読むのは共通の入口から、`users` の書き込みとは別の文で行う。引いて当たらなかった人が、`users` を書くまでの間に初めてログインを終えたときは、`users` を書いた後に `account_logins` を引き直し、当たれば `linkLoginToAccount` で結ぶ（`account_id` が空の行だけに当たるので、何度流しても同じ結果）。指名の `change_logs` に結んだ `account_id` を残すのは、指名の書き込みと同時に結んだとき（`account_logins` に当たったとき）だけ。書いた後の結び直しは、`users.account_id` だけを書く。結び直しが失敗しても組織の作成は成功として返し、`organizations` と `users` は残る。ログには組織の ID と例外の名前だけを出し、次のログインで結ばれる。管理者の指名し直しも同じで、そのときは同じ組織の `login_subject` が空の行を同じバッチで消す。
- 運用者の組織の一覧は、組織ごとの管理者の状態を持つ。`none` は無効でない管理者（`is_admin = 1`）の行が無い組織、`pending` はその行があるが、どれも `account_id` が空の組織（指名した人がまだログインしていない）、`expired` は `pending` のうち、空の行がどれも Google の指名で待つ行で、招待の URL の期限が過ぎている組織、`active` はそれ以外。`login_subject` が空の行（Google の指名で待つ行）は、管理者の数や最後の管理者の検査には数えないが、ここでは `account_id` が空の管理者の行として `pending` に数える。運用者の画面が「ログイン待ち」と出すため。組織をまたいで読む関数に置き、一覧の組織の ID を `organization_id IN (...)` で渡して、1回の問い合わせで数える（束縛の上限で区切る）。人の名前や ID は返さない。
- `login_subject` が空の行（Google の指名で待つ行）は、管理者の数にも最後の管理者の検査にも数えない。
- 最後の管理者を解除できないことはアプリが検査する。
- 招待された人は、承諾した時点でその組織の行を作る（すでにあれば使う）。招待の時点では `invitations` にログインの ID（Google では `sub` が分かるまでメールアドレス）だけを持つ。

### organization_holidays

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| organization_id | TEXT | PK、FK organizations | |
| holiday_on | TEXT | PK | |
| name | TEXT | | 「元日」など |
| created_by | TEXT | NOT NULL、FK users | |
| created_at | TEXT | NOT NULL | |

- 索引: `(created_by)`。外部キーの検査。

一括の登録は `INSERT ... ON CONFLICT DO NOTHING` で行う。

## ユーザーの稼働

### user_capacity_settings

1日の時間、許容幅、稼働する曜日の履歴。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| user_id | TEXT | PK、FK users | |
| effective_month | TEXT | PK | 適用開始月 |
| daily_hours | REAL | NOT NULL、0〜24 | 1日の時間 |
| tolerance_percent | REAL | NOT NULL、0〜100 | 許容幅（基準に対する割合） |
| working_weekdays | INTEGER | NOT NULL、1〜127 | 稼働する曜日。日曜を 1、月曜を 2 … 土曜を 64 とするビットの和 |
| created_at | TEXT | NOT NULL | |

- 行がなければ、8時間、12.5%、月〜金（62）を使う。1つだけ変えたときも、すべてを入れた行を作る。
- ある月の値は、`effective_month <= その月` のうち最も新しい行。

### user_monthly_overrides

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| user_id | TEXT | PK、FK users | |
| month | TEXT | PK | |
| hours | REAL | NOT NULL、0 以上 | その月のユーザーの基準の上書き |
| created_at、updated_at | TEXT | NOT NULL | |

### user_time_off

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| user_id | TEXT | PK、FK users | |
| off_on | TEXT | PK | |
| kind | TEXT | NOT NULL、`full` か `half` | 終日か半日 |
| created_at | TEXT | NOT NULL | |

理由の列は持たない。

## ワークスペース

### workspaces

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| organization_id | TEXT | NOT NULL、FK organizations | |
| name | TEXT | NOT NULL | |
| timezone | TEXT | NOT NULL | IANA のタイムゾーン名。作った人のブラウザの値を既定にする。時差の表記（`+09:00` など）は受けず、`Intl.DateTimeFormat` で作れる名前を `resolvedOptions().timeZone` にそろえて保存する（`asia/tokyo` は `Asia/Tokyo`）。正式名の一覧とは突き合わせない。ブラウザが旧名（`Asia/Calcutta` など）を返すことがあるため |
| week_start | INTEGER | NOT NULL、0〜6、既定 1 | 週の始まり。0 が日曜 |
| vocabulary | TEXT | NOT NULL、`game` か `scrum`、既定 `game` | 言葉づかい |
| definition_of_done_md | TEXT | | 完成の定義。空なら出さない |
| closed_at | TEXT | | 閉じた日時。入っていれば読み取り専用 |
| created_by | TEXT | NOT NULL、FK users | |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `(organization_id)`。組織のワークスペースの一覧に使う。
- 索引: `(created_by)`。外部キーの検査。
- 閉じることと開き直すことを、画面では「終了する」「再開する」と呼ぶ（`docs/design.md` の組織の管理の画面）。この文書と API の操作の名前（`workspace-close`、`workspace-reopen`）は、閉じると開き直すのままにする。
- 閉じても、そのワークスペースの接続（`connections`）の行は書き換えない。接続の同期（#67 で作る）は、`closed_at` の入ったワークスペースを飛ばす。開き直せば、次の同期から元に戻る。
- 名前は前後の空白を除いて、1〜50 字（コードポイントで数える。絵文字も1字）。制御文字（`Cc`）、ゼロ幅のスペース（U+200B）、行と段落の区切り（U+2028、U+2029）、向きを変える制御（U+202A〜U+202E、U+2066〜U+2069）、語結合子などの見えない演算子（U+2060〜U+2064）、BOM（U+FEFF）は受けない。この決まりは `src/shared/hidden-characters.ts` の1か所に置き、組織の表示名と GitHub の表示名（取り除く）も同じ文字を扱う。ZWJ（U+200D）でつないだ絵文字、旗のタグ文字、ZWNJ（U+200C）を使うペルシア語やインド系の文字、方向の印（LRM、RLM、ALM）の名前は通す。空白、書式の文字（`Cf`）、U+3164、U+2800、U+115F、U+1160、U+FFA0 を除いて何も残らない名前は、空の名前と同じ扱いにする。重複は許す（一意の制約を持たず、閉じたものと同じ名前もありうるため）。
- ワークスペースの一覧（`workspace-list`）と最初のリーダーの候補（`workspace-leader-candidates`）は、件数に上限を付けない。想定はワークスペースが組織あたり数十、候補も同じく数十から数百で、1回の応答に収まる。上限で切ると、管理者から見えないワークスペースや、指せない人ができるため。想定を超える組織が出たら、そのときに絞り込みやページ分けを足す。
- ワークスペースの一覧の人数（`workspace-list` の `member_count` と `leader_count`）は、メンバーの一覧（`member-list`）が返す人と同じ条件で数える（次の項目）。
- メンバーの一覧（`member-list`）も件数に上限を付けない。1つのワークスペースの所属と承諾待ちの招待は数十人の想定で、1回の応答に収まる。返す人は、今所属し（`memberships.left_at` が空）、無効でなく（`users.disabled_at` が空）、`users.login_subject` のある人。並びはリーダーが先、続いて参加日、名前、ID。承諾待ちの招待（`status = 'pending'`。期限の過ぎた Google の招待も含め、切れたかを `expired` で返す）は、リーダーと管理者（所属していない管理者を含む）にだけ返し、一般のメンバーには `null` を返す。招待した日と期限の日は、`invitations.created_at` と `claim_expires_at` をワークスペースのタイムゾーンの日付にした値。組織の人数（`organizations` の「人数」）と上限（`member_limit`）も、招待と同じくリーダーと管理者にだけ `seats` で返し、一般のメンバーには `null` を返す。

### workspace_point_rates

ポイントの換算比率の履歴。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| workspace_id | TEXT | PK、FK workspaces | |
| effective_month | TEXT | PK | |
| hours_per_point | REAL | NOT NULL、0 より大きい | 1ポイントの時間 |
| created_at | TEXT | NOT NULL | |

ワークスペースを作るときに、作った月で 4 の行を入れる。

### workspace_holidays

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| workspace_id | TEXT | PK、FK workspaces | |
| holiday_on | TEXT | PK | |
| name | TEXT | | |
| created_by | TEXT | NOT NULL、FK users | |
| created_at | TEXT | NOT NULL | |

- 索引: `(created_by)`。外部キーの検査。

### memberships

所属の期間の履歴。抜けて戻ったら新しい行を作る。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| user_id | TEXT | NOT NULL、FK users | |
| role | TEXT | NOT NULL、`leader` か `member` | 今のロール。変えた記録は `change_logs` に残す |
| joined_on | TEXT | NOT NULL | 参加日（ワークスペースのタイムゾーン） |
| left_on | TEXT | | 離脱日。空なら所属している |
| joined_at | TEXT | NOT NULL | |
| left_at | TEXT | | |

- 一意: `(workspace_id, user_id) WHERE left_at IS NULL`。今の所属は1人1行。
- `CHECK ((left_on IS NULL) = (left_at IS NULL))`、`CHECK (left_on >= joined_on)`。離脱の日付と日時はそろって入り、離脱日は参加日より前にならない。今の所属の一意は `left_at` で、積載量の期間は `left_on` で見るので、片方だけ入った行は2つの判定を食い違わせる。
- 索引: `(user_id, left_at)`。外部キーの検査と、ログインできるか、自分の今日に出すワークスペースはどれか（今の所属）を引く。
- 積載量では、日がいずれかの行の `joined_on`〜`left_on` に入るかで、所属していた期間を数える。
- 管理者が所属していないワークスペースを操作するときは、行を作らない。担当や討伐隊の候補は、この表の今の所属から選ぶ。

### invitations

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| login_provider | TEXT | NOT NULL | 招待した人のログインの手段 |
| login_subject | TEXT | | 招待のときに解決した、手段の中の不変の ID。Google では `sub` が分かるまで空 |
| login_email | TEXT | | `sub` が分かる前に突き合わせるメールアドレス（そろえ方は下の「メールアドレスで待つ指名と招待」）。Google の招待で使い、`sub` を埋めたら空にする |
| claim_token_hash | TEXT | UNIQUE | 招待の URL の秘密の SHA-256。`sub` を埋めたら空にする |
| claim_expires_at | TEXT | | 招待の URL の期限（作ってから14日）。`sub` を埋めたら空にする |
| login_name | TEXT | NOT NULL | 招待のときの名前（表示用）。GitHub ではユーザー名、Google ではメールアドレス。メンバーの画面の承諾待ちの招待（`member-list`）に、リーダーと管理者にだけ出す。Google の招待ではメールアドレスもそのまま出る |
| role | TEXT | NOT NULL、`leader` か `member` | |
| invited_by | TEXT | NOT NULL、FK users | |
| status | TEXT | NOT NULL、`pending`、`accepted`、`declined`、`revoked` | |
| responded_at | TEXT | | 承諾、辞退、取り消しの日時 |
| created_at | TEXT | NOT NULL | |

- 表の制約: `users` と同じ3つの CHECK（`login_subject` と `login_email` のどちらか一方、`login_email` と `claim_token_hash` と `claim_expires_at` はそろって入るか空、`login_email` は `google` の行だけで、そろえた形）。
- 一意: `(workspace_id, login_provider, login_subject) WHERE status = 'pending'`、`(workspace_id, login_provider, login_email) WHERE status = 'pending' AND login_subject IS NULL`。
- 索引: `(login_provider, login_subject) WHERE status = 'pending'`。ログインの可否と招待の一覧に使う。
- 索引: `(invited_by)`。外部キーの検査。
- メンバーの画面の承諾待ちの招待（`member-list`）は、`status = 'pending'` の行を、期限の過ぎたものも含めて `created_at`、`id` の順に、リーダーと管理者（所属していない管理者を含む）にだけ返す。一般のメンバーには返さない。
- 今の所属がある人は招待できないことを、アプリが検査する。Google の招待では、メールアドレスを `sub` に結べないため、所属の検査は `sub` を埋めるときに行う（下の「メールアドレスで待つ指名と招待」）。
- Google で招待し直すときは、同じワークスペースの同じ `login_email` の承諾待ちの招待を同じバッチで `revoked` にする。

### メールアドレスで待つ指名と招待

Google の人は、ログインするまで `sub` が分からない。そのため、`users`（管理者の指名）と `invitations`（招待）を `login_subject` を空にした行で作り、招待の URL から本人がログインしたときに `sub` を埋める。

招待の URL を作るとき。

- 秘密は 32 バイトの乱数を base64url（43文字）にし、URL のフラグメント（`/invite#<秘密>`）にだけ入れる。フラグメントはサーバーに届かず、Referer にも付かないので、ログに残らない。DB には SHA-256 の `claim_token_hash`（`sessions.token_hash` と同じく小文字の16進）だけを持つ。
- 招待と指名を作る API は、秘密を応答の本文にだけ入れ、`Cache-Control: no-store` を付ける。ヘッダーと `change_logs` には入れない。URL は作った直後の画面にだけ出す。
- メールアドレスは、前後の空白を除き、ASCII の英大文字だけを小文字に直してから `login_email` に入れる。ASCII の外の文字を含むものは受け付けない。ドットや `+` 以降は読み替えない。招待と指名の入力と、ID トークンの `email` の両方に、同じ1つの関数を通す。
- `claim_expires_at` は作ってから14日にする。

本人が招待の URL を開いたとき。

1. 画面は `location.hash` から秘密を読み、すぐ `history.replaceState` で URL を `/invite` に置き換える。`/invite` の画面のヘッダーは `Referrer-Policy: no-referrer`。
2. 画面に「Google でログイン」のボタンを出し（組織の名前は、秘密を API に送る前なので出さない）、押してからログインを始める。リンクを先読みする仕組み（メールの安全確認、チャットのプレビュー）でログインが始まらないようにするのが狙い。ボタンは、隠し欄に秘密を入れたフォームを `POST /api/auth/google/start` に送る（`form.submit()`）。すでにログインしていても、Google のログインを通す。秘密の形が合わない URL（無い、短い、長い）は、ボタンを出さずに使えない旨を出す。
3. ログインを始める API は、秘密を POST の本文（`application/x-www-form-urlencoded` の `claim_token` 欄）でだけ受ける。URL のクエリでは受けない。ほかのサイトからのフォームの POST（`Sec-Fetch-Site: cross-site`）は、本文を読まず、数えず、行も書かず、ログインの画面へ戻す。決まった形（base64url の43文字）でなければ、ハッシュも DB の問い合わせもせずに断り、`/login?error=invite` へ移す。サーバーがハッシュにして `oauth_states.claim_token_hash` に入れ、戻り先は `/` にする。この API と戻り先も、ログインのレート制限（`login:<IP>`）で数える。
4. 戻ってきたら ID トークンを確かめ（`development.md` の「Google のログイン」）、`email_verified` が真偽値の `true` のときだけ先に進む。
5. 組織をまたいで読む関数で、`claim_token_hash` が一致し、`login_subject` が空で、`claim_expires_at` が過ぎていない行を引く（`invitations` は `status = 'pending'` も）。`login_email` がトークンの `email` をそろえた値と一致しないとき、組織が停止しているときは、当たらなかったものとする。指名で、同じ組織の同じ `sub` の行が待っている行より後に無効にされていたとき（`disabled_at` が待っている行の `created_at` より後）も同じ。当たらなければ、理由を分けずに「この招待の URL は使えません」と出す。どのメールアドレスに招待したかは出さない。結べなかったログインは、ほかの組織に入れる人でも、セッションを作らず、アカウントも作らず、`/login?error=invite` へ移す。この結ぶ処理は、入れる組織があるかの判定（`hasLoginAccess`）より前に流す。組織の停止の確認は、書く前に1回読むだけである。共通の表（`organizations`）と組織の中の表を1回の `batch()` に混ぜない決まりのため、読んでから書くまでに停止されると結ばれうる。結ばれても、その後の判定（`hasLoginAccess`）が停止した組織を数えないので、その組織には入れない。
6. 当たった行の組織で、次の文を1回の `batch()` に並べて書く。読んでから書くまでに、指名し直し、取り消し、期限切れ、同じ URL の二重の戻りが起こりうるので、どの文にも「待っている行がまだ有効」という同じ条件を付ける: `EXISTS (SELECT 1 FROM <表> WHERE id = :pending_id AND login_subject IS NULL AND claim_token_hash = :hash AND claim_expires_at > :now)`（`users` は `AND disabled_at IS NULL`、`invitations` は `AND status = 'pending'` も）。`:now` は、待つ行を読み終えて `batch()` を組む直前の時刻にする。読んだ時刻のままだと、読んだ後で期限を越えた行が結べてしまう。これで一意の制約に当たらず、もう一度流しても同じ結果になる。
   - 指名（`users`）: 同じ組織に同じ `sub` の行があれば、その行を `is_admin = 1` にし、`disabled_at` を空にする。続けて待っていた行を消す。無ければ、待っていた行に `sub` を埋め、`login_email`、`claim_token_hash`、`claim_expires_at` を空にし、`name` を Google のプロフィールの名前に書き直す（`AND NOT EXISTS (同じ組織の同じ sub の行)`）。
   - 招待（`invitations`）: 同じワークスペースに同じ `sub` の承諾待ちの別の招待がある（`id <> :pending_id`）か、その人がもうそのワークスペースに所属していれば、待っていた招待を `revoked` にする（書く列は `status` と `responded_at`）。取り消した招待は、`login_email`、`claim_token_hash`、`claim_expires_at` を持ったまま残す。`login_subject` が空なら `login_email` が入っているという CHECK（`(login_subject IS NULL) = (login_email IS NOT NULL)`）のため、空にできない。無ければ、`sub` を埋め、`login_email`、`claim_token_hash`、`claim_expires_at` を空にする（`AND NOT EXISTS (…)`）。招待では、同じ組織で無効にされた人にも `sub` は埋まる。入れるかどうかは、ログインの判定（`hasLoginAccess`）が無効にされた人を除いて決める。
   - どちらも、結んだことを `change_logs` に残す（`entity_type` は `user` か `invitation`、`action` は `update`、`actor_user_id` は結んだ本人、`operator` は空）。指名した運用者は、指名したときの `change_logs` で分かる。`changes_json` には `login_email`、`claim_token_hash`、`claim_expires_at` を入れず、待っていた行の名前は「Google の招待（ログイン待ち）」と残す。
   - 文の並びは、`change_logs` の記録を先に、統合と取り消しを次に、`sub` を埋める文を最後にする。記録を変える文の後ろに置くと、先の文が待っている行を変えた後は「待っている行がまだ有効」の条件が外れて、記録が入らないため。記録の条件は、実際に行を変える文と同じにする。
   - どの文も行を変えなかったら（`meta.changes` がすべて 0）、当たらなかったときと同じ文言を返す。
7. そのあとは、GitHub と同じく `sub` で入れる組織を引き、アカウントを作り、`users.account_id` を埋める。`sub` を埋めるのをアカウントを作るより先にするのは、入れる組織が1つもない人のアカウントを作らないため。GitHub でログイン済みの人が招待の URL から Google でログインしたときも、セッションを Google のアカウントのものに替える（GitHub のアカウントとはまとめない）。結んだ後の行き先は、指名なら結んだ組織の `/<slug>`、招待なら届いた招待が出る `/`。
8. 6 の途中で失敗しても、行は待ったままで、期限までは同じ招待の URL を開き直せば結べる。結んだ後の 7 で失敗したときは、`sub` を埋めた後で秘密を使い切っているので、招待の URL は使えない。ログインの画面（`/login`）から Google でログインすれば、`sub` で当たって入れる。

`login_subject` が空の `users` の行は、運用者の画面の「指名済み、ログイン待ち」のほかには、ユーザーの一覧にも担当の候補にも出さない。待つ間の `name` がメールアドレスのため。

結んだ後の見分けは `sub` だけで、Google の側でメールアドレスが変わっても、結んだ行はそのまま当たる。

期限を過ぎて結ばれていない招待は、人数に数えず、招待の一覧に「期限切れ」と出す。期限を過ぎた指名は、運用者の画面に「期限切れ」と出し、運用者が指名し直す。運用者の組織の一覧の管理者の状態は、結ばれた管理者がおらず、結ばれていない管理者の行がどれも期限の過ぎた待つ行なら `expired`、期限内の待つ行か結ばれていない GitHub の指名が1つでもあれば `pending` とする。

人数（`organizations` の「人数」）の数え方: `sub` の行は `(login_provider, login_subject)`、待つ行は `(login_provider, login_email)` で1人。すでに所属している人をメールアドレスで招待すると、結ぶまでの間だけ2人に数える（結んだときに取り消す）。

### allocations

メンバーの月ごとの配分の履歴。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| workspace_id | TEXT | PK、FK workspaces | |
| user_id | TEXT | PK、FK users | |
| effective_month | TEXT | PK | |
| percent | INTEGER | NOT NULL、0〜100、`percent % 5 = 0` | |
| set_by | TEXT | NOT NULL、FK users | |
| created_at | TEXT | NOT NULL | |

- 行がなければ配分は未設定。その月に所属しているワークスペースが1つだけなら 100% とみなす。この判定は保存せず読むときに行う。
- 索引: `(user_id, effective_month)`。本人の配分の合計に使う。`user_id` の外部キーの検査にも使う。
- 索引: `(set_by)`。外部キーの検査。

## ワークスペースの定義

### board_columns

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| name | TEXT | | リーダーが付けた名前。完了の列は空で、言葉づかいに合わせた名前を辞書から出す |
| is_done | INTEGER | NOT NULL、既定 0 | 完了の列 |
| position | TEXT | NOT NULL | |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 一意: `(workspace_id) WHERE is_done = 1`。完了の列はワークスペースに1つ。
- 索引: `(workspace_id, position) WHERE deleted_at IS NULL`。`detail_fields`、`categories`、`repositories` も同じ索引で一覧を引く。
- `CHECK (is_done = 1 OR name IS NOT NULL)`。
- 完了の列を末尾に置くことは、読むときに `ORDER BY is_done, position` で守る。完了の列の `position` は使わない。
- 削除は論理削除にする。変更の履歴と完了の記録が列を指すため。最後に残った完了以外の列と完了の列を削除できないことは、アプリが検査する。

### detail_fields

タスクの詳細の決まった欄の定義。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| name | TEXT | NOT NULL | |
| position | TEXT | NOT NULL | |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

ワークスペースを作るときに、言葉づかいに合わせて「受け入れ基準」か「達成条件」の1行を入れる。

### categories

区分の定義。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| name | TEXT | NOT NULL | |
| is_billed_monthly | INTEGER | NOT NULL、既定 0 | 月ごとに計上する |
| position | TEXT | NOT NULL | |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 削除は論理削除にする。完了の記録と変更の履歴が指したまま残り、集計では元の名前で出す。
- 削除したら、その区分を振っていたエピック、ストーリー、タスクの `category_id` を空にして区分なしに戻す。削除と同じバッチで書く。

### repositories

タスクに振るリポジトリの定義。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| name | TEXT | NOT NULL | リーダーが付けた名前 |
| provider | TEXT | | 結んだ入る先の取り込み元の種類。`task_sources.provider` と同じ値 |
| source_container_id | TEXT | | 結んだ入る先の ID。`task_sources.source_container_id` と同じ値 |
| source_container_name | TEXT | | 結んだときの入る先の表示名 |
| position | TEXT | NOT NULL | |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- `CHECK ((provider IS NULL) = (source_container_id IS NULL) AND (provider IS NULL) = (source_container_name IS NULL))`。入る先は結ばないか、3つの列をそろえて結ぶ。
- 一意: `(workspace_id, provider, source_container_id) WHERE deleted_at IS NULL AND provider IS NOT NULL`。同じ入る先を2つのリポジトリに結ばない。
- 入る先は取り込み元の種類を問わず結べる。どの入る先を結ぶかは、リーダーが接続の取り込む範囲の一覧から選ぶ。
- 削除は論理削除にする。変更の履歴が指したまま残る。削除したら、振っていたタスクの `repository_id` を空にする。削除と同じバッチで書く。

## 接続

### connections

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| owner_user_id | TEXT | NOT NULL、FK users | 登録したメンバー |
| provider | TEXT | NOT NULL | 取り込み元の種類（初版は `backlog` と `github`）。値は取り込み元の型の一覧でアプリが検証する |
| name | TEXT | NOT NULL | 本人が付けた表示名 |
| status | TEXT | NOT NULL、`active`、`error`、`stopped` | |
| stopped_reason | TEXT | `auth_failed`、`owner`、`leader`、`member_left`、`workspace_closed`、`user_disabled` | 停止の理由。`status = 'stopped'` のときだけ入る |
| scope_mode | TEXT | NOT NULL、`include` か `exclude`、既定 `include` | 対象を挙げるか、除外を挙げるか |
| ignore_source_due | INTEGER | NOT NULL、既定 0 | 取り込み元の期限を無視する |
| settings_json | TEXT | NOT NULL、既定 `'{}'` | 取り込み元に固有の設定。Backlog のスペースのドメインとユーザー ID など。型が検証する |
| credential_ciphertext | TEXT | | 暗号化した認証情報。退会で消す |
| credential_key_version | INTEGER | | 暗号化に使った鍵の版 |
| credential_last4 | TEXT | | 画面に出す末尾4文字 |
| sync_state_json | TEXT | NOT NULL、既定 `'{}'` | 前回成功した時点と、上限で止めたときの続きの位置 |
| reconcile_state_json | TEXT | NOT NULL、既定 `'{}'` | 1日1回の照合の続きの位置 |
| last_success_at | TEXT | | |
| last_reconciled_at | TEXT | | |
| last_error_message | TEXT | | |
| last_error_at | TEXT | | |
| consecutive_failures | INTEGER | NOT NULL、既定 0 | |
| last_manual_sync_at | TEXT | | 手動の同期の受付を5分に1回に抑える |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `(workspace_id) WHERE deleted_at IS NULL`、`(owner_user_id)`。`owner_user_id` は外部キーの検査にも使うので、部分索引にしない。
- 定期処理は `status IN ('active', 'error') AND deleted_at IS NULL` を `last_success_at` の古い順に処理する。
- 削除は論理削除にする。取り込んだタスクが `task_sources.connection_id` で指すため。削除したら認証情報の列を消す。
- `credential_*` と `sync_state_json` は API で返さない。返すのは `credential_last4` まで。
- 鍵の入れ替えは `credential_key_version` が古い行を選んで書き直す。

### connection_scopes

取り込む範囲。`scope_mode` が `include` なら対象、`exclude` なら除外の一覧になる。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| connection_id | TEXT | PK、FK connections | |
| scope_kind | TEXT | PK | 範囲の種類（初版は `backlog_project`、`github_owner`、`github_repo`）。取り込み元の型が定義し、アプリが検証する |
| source_id | TEXT | PK | 取り込み元の ID |
| source_name | TEXT | NOT NULL | 選んだときの表示名 |

`include` で行がなければ取り込まない。登録した直後はこの状態。

### connection_status_mappings

取り込み元の状態から列への対応。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| connection_id | TEXT | PK、FK connections | |
| source_status | TEXT | PK | 取り込み元の状態名 |
| column_id | TEXT | NOT NULL、FK board_columns | 完了の列は選べない（アプリが検査） |

列を削除したら、その列を指す行を消す。

## 計画と作業

### epics

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| title | TEXT | NOT NULL | |
| body_md | TEXT | | レイドの説明。経験値は付かない |
| category_id | TEXT | FK categories | 配下のストーリーとタスクが引き継ぐ |
| due_on | TEXT | | |
| link_url | TEXT | `CHECK (link_url LIKE 'http://%' OR link_url LIKE 'https://%')` | http と https だけ。`stories` と `tasks` の `link_url` も同じ CHECK を持つ |
| reward_tier | TEXT | NOT NULL、`small`、`medium`、`large` | クリア報酬の段階。値はコードの定数 |
| requester_user_id | TEXT | NOT NULL、FK users | 依頼主。リーダーが替えられる |
| created_by | TEXT | NOT NULL、FK users | 作った人。削除の権限に使う |
| completed_at | TEXT | | クリアした日時 |
| completed_by | TEXT | FK users | |
| canceled_at | TEXT | | 中止した日時 |
| canceled_by | TEXT | FK users | |
| position | TEXT | NOT NULL | バックログの最上段での並び |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- `CHECK (completed_at IS NULL OR canceled_at IS NULL)`。
- 索引: `(workspace_id, position) WHERE deleted_at IS NULL`。
- 索引（外部キーの検査）: `(requester_user_id)`、`(created_by)`、`(completed_by) WHERE completed_by IS NOT NULL`、`(canceled_by) WHERE canceled_by IS NOT NULL`。

### epic_party_members

討伐隊。抜けたら行を消し、記録は `change_logs` に残す。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| epic_id | TEXT | PK、FK epics | |
| user_id | TEXT | PK、FK users | |
| joined_via | TEXT | NOT NULL、`self`、`assigned`、`task_assignee` | 受注、割り振り、配下のタスクの担当 |
| added_by | TEXT | NOT NULL、FK users | |
| joined_at | TEXT | NOT NULL | |

- 索引: `(user_id)`。`user_id` の外部キーの検査にも使う。
- 索引: `(added_by)`。外部キーの検査。
- クリア報酬は、クリアした時点のこの表の行に払う。

### stories

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| epic_id | TEXT | FK epics | 親。空なら親なし |
| title | TEXT | NOT NULL | |
| acceptance_criteria_md | TEXT | | 受け入れ基準 |
| body_md | TEXT | | |
| category_id | TEXT | FK categories | 親なしのときだけ入る（アプリが検査） |
| due_on | TEXT | | |
| link_url | TEXT | | |
| created_by | TEXT | NOT NULL、FK users | |
| completed_at | TEXT | | |
| completed_by | TEXT | FK users | |
| position | TEXT | NOT NULL | 親の中（親なしなら最上段）での並び |
| deleted_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `(workspace_id, epic_id, position) WHERE deleted_at IS NULL`。
- 索引（外部キーの検査）: `(created_by)`、`(completed_by) WHERE completed_by IS NOT NULL`。
- 親を変えたら、新しい親の末尾の `position` を振る。
- 並べ替えと親の移動（`story-move`）は、`tasks` の「並べ替えと親の移動」と同じ決まりで、親は `epic_id`（null は親なし）、直前の行は `after_story_id`。違うのは次のとおり。移す先のエピックが無ければ（別の組織を含む）404、親を変えるときに完了しているか中止していれば（`epics.completed_at` か `canceled_at` が空でない）409（`conflict`、理由は `parent_completed`）。同じエピックの中の並べ替えは、エピックが完了か中止していてもできる。完了したストーリーも動かせる。エピックの下へ移したら `category_id` を空にし、空にした区分は `tasks` と同じく履歴の `category` に残す。親が変わったときの履歴は `{"epic": [前, 後]}`（値は `{id, title}` か null）。
- `title` は `tasks.title` と同じ決まり（前後の空白を除いて 1〜200 字）。`acceptance_criteria_md` と `body_md` はそれぞれ 1 万字まで（コードポイントで数え、改行とタブ以外の制御文字と見えない文字は断る）。改行は `\n` にそろえ、前後の空行と末尾の空白だけを落とし、先頭の行の字下げは残す。空は `NULL`。列の CHECK（10 万字）は、決まりを超えた書き込みを止める保険。`link_url` は http と https の URL だけで 2048 字まで。ユーザー名とパスワードを含む URL は断り、保存する値は解釈した URL（`new URL(...).href`）にそろえる。`due_on` は暦に存在する日付で、空は `NULL`。
- 作る操作（`story-create`）は、親なし（`epic_id` は空）で、`position` は親のないストーリーの末尾、`created_by` は呼んだ人。変える操作（`story-update`）は、送られた欄のうち今の値と違うものだけを、読んだ値のままなら、という条件つきで書き（書き方は「書き込みの単位」の「ストーリーの変更」）、変えた欄だけを `change_logs` に `{"列名": [前, 後]}` で残す。変える欄が無ければ何も書かない。ダイアログを開くときの読み取り（`story-get`）は、1件の全部の欄を返す（`backlog-tree` には載せない）。無い（別の組織、別のワークスペース、削除済みを含む）ときは 404 で、閉じたワークスペースでも読める。

### tasks

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| is_imported | INTEGER | NOT NULL | 取り込んだタスク。作ったあとは変えない |
| tray | TEXT | NOT NULL、`inbox`、`backlog`、`archive` | 置き場所。手で作ったタスクは常に `backlog` |
| title | TEXT | NOT NULL | 取り込んだタスクは同期で書き直す |
| body_md | TEXT | | |
| link_url | TEXT | | 手で作ったタスクだけ |
| story_id | TEXT | FK stories | 親。空なら親なし |
| category_id | TEXT | FK categories | 親なしのときだけ入る（アプリが検査） |
| repository_id | TEXT | FK repositories | 0〜1つ。親から引き継がない |
| sprint_id | TEXT | FK sprints | 今入っているスプリント。履歴は `sprint_entries` |
| column_id | TEXT | FK board_columns | スプリントの中の列 |
| assignee_user_id | TEXT | FK users | 担当。0〜1人 |
| points | INTEGER | `NULL` か 0、1、2、3、5、8、13 | 空は未見積もり |
| due_on | TEXT | | Scrum Guild で振った期日 |
| today_on | TEXT | | 「今日やる」の印を付けた日付 |
| completed_at | TEXT | | |
| completed_by | TEXT | FK users | |
| position | TEXT | NOT NULL | バックログでの並び（親の中、親なしなら最上段） |
| column_position | TEXT | | 列の中での並び |
| created_by | TEXT | FK users | 起票した人。取り込んだタスクは空 |
| created_at、updated_at | TEXT | NOT NULL | |
| deleted_at | TEXT | | |

- `CHECK (is_imported = 1 OR tray = 'backlog')`、`CHECK (is_imported = 0 OR link_url IS NULL)`、`CHECK (is_imported = 1 OR created_by IS NOT NULL)`。
- `CHECK (tray = 'backlog' OR (sprint_id IS NULL AND column_id IS NULL AND story_id IS NULL))`。受信箱とアーカイブのタスクは、スプリント、列、親を持たない。
- `CHECK ((sprint_id IS NULL) = (column_id IS NULL))`。スプリントに入っていれば列を持つ。
- 索引:
  - `(workspace_id, tray, position) WHERE deleted_at IS NULL`: 受信箱、アーカイブ、バックログの一覧
  - `(story_id, position) WHERE deleted_at IS NULL`: ストーリーの配下
  - `(sprint_id, column_id, column_position) WHERE deleted_at IS NULL`: スプリントの列
  - `(assignee_user_id, deleted_at, completed_at) WHERE assignee_user_id IS NOT NULL`: 外部キーの検査と、自分の今日、積載量（担当の未完了のタスク）
  - `(completed_by) WHERE completed_by IS NOT NULL`、`(created_by) WHERE created_by IS NOT NULL`: 外部キーの検査
- 手で作るタスクの `title` は、前後の空白を除いて 1〜200 字。字数の数え方と断る文字は `workspaces.name` と同じ。
- 引き出しで直す欄（`task-update`）の決まりは、ストーリーと同じ。`body_md` は 1 万字まで（`stories.body_md` と同じ正規化。空は `NULL`）、`link_url` は http と https の URL だけで 2048 字まで（解釈した URL にそろえる）、`due_on` は暦に存在する日付。取り込んだタスクはリンクを持たず（上の CHECK）、タイトルは同期で書き直すので、どちらも直せない。完了したタスクのポイントは直せない（「書き込みの単位」の「タスクの変更」）。1件の読み取り（`task-detail`）は、これらの欄と、担当（`assignee`。ID、名前と、今そのワークスペースに所属していないか（`left`。抜けた、無効にされた、所属が無い）。名前は組織で絞った `users` から、所属はそのワークスペースの `left_at IS NULL` の `memberships` から読む）、取り込んだタスクか、完了した日時、呼んだ人が削除できるかに加えて、期日の印を決める今日（`today`。ワークスペースのタイムゾーン）と週の始まり（`week_start`）を返す（`backlog-tree` と同じ決め方。ワークスペースの行は組織とワークスペースで絞って読む）。本文は長いので、バックログの木には載せない。
- 担当は `task-assign` で替える（`task-update` では替えない）。担当にできるのは、そのワークスペースに今所属している、無効でなく `login_subject` のある人（`task-create` と同じ条件。候補を出すメンバーの一覧（`member-list`）と同じ人で、Google で待っている行は担当にしない）で、外す（`NULL`）のはいつでもできる。完了したタスクの担当は替えない（完了の経験値と `completions` が完了した時点の担当を使うため。直すのは完了の記録の修正）。取り込んだタスクの担当は替えられる。書き方は「書き込みの単位」の「タスクの担当の変更」。
- 「今日やる」は、`today_on` が今日（ワークスペースのタイムゾーン）なら今日の印、それより前で未完了なら前日からの持ち越しとして示す。担当が替わったら消す（`task-assign` が担当を書く同じ文で `NULL` にする。同じ担当を送ったときは消さない）。
- 区分は、親のエピック、親のストーリー、タスク自身の順に、最初に入っているものを使う。読むときに結合して出し、タスクには写さない。完了の記録（`completions.category_id`）には、完了した時点の値を写す。
- `repository_id` は、取り込むときに `repositories` の `(workspace_id, provider, source_container_id)` が `task_sources` と一致する行があれば入れる。同期では書き換えない。
- 表示する期日は `due_on`、なければ `task_sources.source_due_on`（接続の `ignore_source_due` が 0 のとき）。
- バックログの木（`backlog-tree`。親のないストーリーと、その配下の未完了のタスク、親のない未完了のタスク）は、件数に上限を付けない。想定は1ワークスペースで数百件までで、1回の応答に収まり、完了したものは行を返さず件数だけ返すので、返す行は使い続けても増えない（読む行は完了した分も増える。ストーリーの配下は `tasks_story` の索引で引き、ストーリーごとの合計は完了した分も数える）。上限で切ると、優先順位の後ろにあるタスクが見えなくなるため。5万件の規模での重さと、索引や上限、分けて読む形は、#165 で測って決める。ストーリーの配下を引く文は、`FROM stories CROSS JOIN tasks`（結ぶ条件は `WHERE`）で順序を固定する。INNER JOIN だと SQLite が `tasks_workspace_tray` を先に走査する計画を選ぶため。配下の未完了のタスクは、`ORDER BY` を付けると `tasks_story` を使わない計画になるので、読んだ後に `position`、`id` の順に並べる。
- `backlog-tree` が返すもの。最上段は「親のないストーリー」と「親のない未完了のタスク」の2段で、それぞれ `position`（同じ値なら `id`）の順に並べる。ストーリーには `id`、`title`、`due_on`、`link_url`、`completed_at`（長い `acceptance_criteria_md` と `body_md` は載せない）、配下の未完了のタスク、配下の完了したタスクの件数、配下のポイントの合計（`points_done` は完了したタスク、`points_all` は削除していないタスク全部。未見積もりは 0）を付ける。タスクの行には `id`、`title`、`points`、`due_on`、担当を付ける。親のない完了したタスクは件数だけ返す。ワークスペースのタイムゾーンでの今日の日付（`today`）と週の始まり（`week_start`）も返し、期日の印（過ぎた、今日、今週、それ以外）はこの2つと `src/shared/due.ts` で決める。組織とワークスペースで絞り、ストーリー側もワークスペースで絞る。
- タスクの親は、同じワークスペースの削除していないストーリー。作るとき（`task-create` の `story_id`）に無ければ 404、完了していれば（`stories.completed_at` が空でない）409（`conflict`）で、`position` はそのストーリーの配下の末尾。
- 並べ替えと親の移動（`task-move`）。入力は動かすタスク、移す先の親（`story_id`。null は親なし）、直前の行（`after_task_id`。null は先頭、ID はその行の直後、省くと末尾）。画面の「親を移す」は直前の行を送らず、移す先の末尾に置く。
  - 移す先の並びは、親の配下（親なしなら親のないタスク）の削除していないバックログのタスクを、完了したものも含めて `position, id` の順に並べ、移すタスクを除いたもの。直前の行とその次の行の間の値（`generateKeyBetween`）を振る。先頭なら最初の行の前、末尾なら最後の行の後。
  - 直前の行と次の行が同じ値（同時に作った行）なら、直前の行と同じ値で `id` が後ろの行の続きを、移す行と一緒に、直前の行の値と次の違う値（無ければ上限なし）の間で振り直す（`generateNKeysBetween`。最初の値が移す行、残りが続きの `id` の順）。親の行を全件は読まず、同じ値の続き（`position = 直前の値 AND id > 直前の id`。41 行まで）と、直前の値より大きい最初の1行だけを読む。続きが 40 行を超えたら、振り直さずに 409（`conflict`、理由は `ties`）で断る（1回の `batch()` を際限なく大きくしない。同じ値は同時に作った行にしかできないので、ふつうは数行）。振り直しの文は、移す行の更新が通った（その `id` の行が新しい `position`、親、`updated_at` を持つ）ことと、その行の `position` が読んだ値のままであることを条件にし、移す行の更新と同じ `batch()` で書く。振り直した行の `updated_at` も書く。
  - 断るもの。動かすタスクか移す先の親が無い（別の組織、同じ組織の別のワークスペースを含む）ときは 404。動かすタスクが受信箱かアーカイブにあるときも 404。直前の行が移す先に無い（別の親、削除済み、受信箱とアーカイブ、別のワークスペース、別の組織）ときも 404。直前の行が動かすタスク自身なら 400（`invalid_input`）。完了したタスクを動かすのは 409（`conflict`、理由は `task_completed`）。完了したストーリーの下へ親を移すのは 409（`conflict`、理由は `parent_completed`）。同じ親の中の並べ替えは、親のストーリーが完了していてもできる。閉じたワークスペースは 409（`workspace_closed`）。
  - 409 の `conflict` は、理由を `details.reason` に載せる（`parent_completed`、`task_completed`、`changed`、`ties`。`src/shared/operations/task/task-move.ts` の `moveConflictReasons`）。画面は理由で知らせる文を選ぶ。
  - 書く文は条件つきの `UPDATE`（読んだときの親のまま、閉じていないワークスペース、移す先の親が今もあり、親が変わるならその親が完了していない、直前の行が今も読んだ値の位置にある）で、変わった行が 0 なら読み直して理由を決める（閉じていれば `workspace_closed`、タスクか親か直前の行が無ければ 404、タスクが完了していれば `task_completed`、移す先の親が完了していれば `parent_completed`、どれでもなければ別の要求が先に親を移したか直前の行を動かしたので `changed`）。`updated_at` は並べ替えだけでも書く。
  - 親が変わったときだけ `change_logs`（`action` は `update`、`changes_json` は `{"story": [前, 後]}`、値は `{id, title}` か null）を、移す行の更新が通ったときだけ書く。並べ替えだけなら履歴を残さない。ストーリーの下へ移したら `category_id` を空にする（区分は親なしのときだけ入る）。空にした区分は、同じ履歴に `{"category": [{id, name}, null]}` で残し（`name` は読んだ時点の名前。改名と競合すると前の名前が残るが、`id` で引ける）、親が変わるときの書く文は区分が読んだ値（空も含む）のままであることも条件にする。応答は `task_id` と `story_id` で、`position` は返さない。
- タイトルの検索は `title LIKE` と `task_sources.source_key LIKE` で行う。5万件の規模なら、ワークスペースの索引で絞れば足りる見込み。遅ければ FTS5 を足す。

### task_sources

取り込んだタスクの取り込み元への参照と、取り込み元が持つ属性。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| task_id | TEXT | PK、FK tasks | |
| workspace_id | TEXT | NOT NULL、FK workspaces | 一意のキーのために持つ |
| connection_id | TEXT | NOT NULL、FK connections | 最初に取り込んだ接続 |
| provider | TEXT | NOT NULL | 取り込み元の種類。`connections.provider` と同じ値で、一意のキーに使う |
| source_kind | TEXT | NOT NULL、`issue`、`pull_request`、`review_request` | 種別。取り込み元を問わず共通 |
| source_id | TEXT | NOT NULL | 取り込み元の不変の ID |
| reviewer_source_id | TEXT | NOT NULL、既定 `''` | レビュー依頼のレビュアーの取り込み元での ID。他の種別は空文字 |
| source_key | TEXT | NOT NULL | 課題キーや `owner/repo#12` など、取り込み元での表示用のキー。移動で変わるので検索と表示にだけ使う |
| source_url | TEXT | NOT NULL | |
| source_container_id | TEXT | NOT NULL | Backlog のプロジェクトや GitHub のリポジトリなど、取り込み元で項目が入る先の ID。絞り込みに使う |
| source_container_name | TEXT | NOT NULL | |
| source_status | TEXT | NOT NULL | 取り込み元での状態名 |
| source_due_on | TEXT | | 取り込み元の期限 |
| source_updated_at | TEXT | NOT NULL | 差分の判定に使う |
| is_source_done | INTEGER | NOT NULL、既定 0 | 「取り込み元で完了」の印 |
| missing_since_at | TEXT | | 「取り込み元で見つからない」の印。入っていれば印あり |
| last_seen_at | TEXT | NOT NULL | 最後に取り込み元で確認できた日時 |
| created_at、updated_at | TEXT | NOT NULL | |

- 一意: `(workspace_id, provider, source_kind, source_id, reviewer_source_id)`。同じワークスペースで同じ項目を1件にまとめ、レビュー依頼だけはレビュアーごとに分ける。
- 索引: `(connection_id)`、`(workspace_id, source_container_id)`。
- 接続が削除されても行は残す。続けて同期する接続がなくなるだけ。

### task_source_payloads

取り込み元の応答そのもの。一覧で読まない大きな列を `task_sources` から分ける。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| task_id | TEXT | PK、FK tasks | |
| payload_json | TEXT | NOT NULL | 本文とラベルを含む応答。大きすぎる分は切り詰める |
| is_truncated | INTEGER | NOT NULL、既定 0 | |
| updated_at | TEXT | NOT NULL | |

切り詰めは D1 の行の上限（2MB）より十分小さい 512KB を目安にする。

- 行を書くのは、組織の `organizations.stores_source_payload` が 1 のときだけ。0 の組織では同期で応答を読んでも、この表に書かない。
- 0 に切り替えたら、その組織の行を次の定期処理で組織の中の DB から消す。`organizations` は共通の表なので、切り替えと同じ `batch()` では消さない。
- 1 に切り替えても取り直さない。次に同期で更新された項目から行ができる。

### task_field_values

タスクの決まった欄の中身。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| task_id | TEXT | PK、FK tasks | |
| field_id | TEXT | PK、FK detail_fields | |
| value_md | TEXT | NOT NULL | 空にしたら行を消す |
| updated_by | TEXT | NOT NULL、FK users | |
| updated_at | TEXT | NOT NULL | |

- 索引: `(updated_by)`。外部キーの検査。
- 未記入の判定は、削除していない欄のうち行のない欄があるか。
- 「詳細を書いた」の受け取り手は、すべて埋まっているタスクで `updated_at` が最も新しい行の `updated_by`。

### comments

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| task_id | TEXT | NOT NULL、FK tasks | |
| author_user_id | TEXT | NOT NULL、FK users | |
| body_md | TEXT | NOT NULL | 削除したら空文字にする |
| edited_at | TEXT | | 入っていれば「編集済み」 |
| deleted_at | TEXT | | 入っていれば「削除されました」 |
| deleted_by | TEXT | FK users | |
| created_at | TEXT | NOT NULL | |

- 索引: `(task_id, created_at)`。
- 索引（外部キーの検査）: `(author_user_id)`、`(deleted_by) WHERE deleted_by IS NOT NULL`。

### attachments

添付ファイルの情報。ファイルの中身は R2 に置く。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| task_id | TEXT | FK tasks | |
| story_id | TEXT | FK stories | |
| epic_id | TEXT | FK epics | |
| comment_id | TEXT | FK comments | |
| object_key | TEXT | NOT NULL、UNIQUE | R2 のキー。`<organization_id>/<workspace_id>/<id>` |
| file_name | TEXT | NOT NULL | 上げたときのファイル名。255字まで |
| content_type | TEXT | NOT NULL | 中身の先頭のバイトで確かめた種類。分からなければ `application/octet-stream` |
| size_bytes | INTEGER | NOT NULL、`CHECK (size_bytes BETWEEN 1 AND 52428800)` | |
| uploaded_by | TEXT | NOT NULL、FK users | 消す権限に使う |
| attached_at | TEXT | | 付く先が決まった日時。空なら書いている途中で上げたもの |
| created_at | TEXT | NOT NULL | |

- 付く先は4つの列のうち多くても1つ: `CHECK ((task_id IS NOT NULL) + (story_id IS NOT NULL) + (epic_id IS NOT NULL) + (comment_id IS NOT NULL) <= 1)`。付く先が決まったら `attached_at` を入れる: `CHECK ((attached_at IS NULL) = (task_id IS NULL AND story_id IS NULL AND epic_id IS NULL AND comment_id IS NULL))`。
- 起票の画面やコメントの欄では、保存する前に上げるため、付く先のない行を先に作る。保存したときに、本文やコメントが参照する行へ付く先を入れる。付く先のないまま1日たった行とファイルは定期処理で消す。
- 消すときは行を物理削除する。論理削除にしないのは、戻す手段がなく、残すと容量の上限に数え続けるため。消したことは付く先の `change_logs` に残す。
- 組織の合計は、組織のワークスペースの `size_bytes` の合計を上げるたびに計算する。集計は保存しない。同時に上げたときに少し超えることは許す。上げたことで80%を超え、`organizations.attachment_quota_warned_at` が空なら、管理者全員に通知し、その日時を入れる。
- 画面と Markdown からは `/api/<slug>/attachments/<id>` で参照する。返すときは権限を確かめ、`X-Content-Type-Options: nosniff` と `Cache-Control: private` を付ける。画像として出す4種類（PNG、JPEG、GIF、WebP）と動画として再生する2種類（MP4、WebM）以外は `Content-Disposition: attachment` で返す。動画は Range リクエストに応える。
- 索引: `(task_id)`、`(story_id)`、`(epic_id)`、`(comment_id)` をそれぞれ NOT NULL の部分索引で、`(workspace_id)`、`(created_at) WHERE attached_at IS NULL`、`(uploaded_by)`（外部キーの検査）。

### sprints

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| name | TEXT | | 空なら期間を名前として出す |
| goal | TEXT | | スプリントゴール |
| start_on | TEXT | NOT NULL | |
| end_on | TEXT | NOT NULL | 最終日 |
| status | TEXT | NOT NULL、`planned`、`active`、`closed` | |
| extended_days | INTEGER | NOT NULL、既定 0 | 延長した日数の合計。1以上ならベロシティから除く |
| is_goal_achieved | INTEGER | | 終了のときの記録。ゴールがなければ空 |
| started_at | TEXT | | |
| started_by | TEXT | FK users | |
| closed_at | TEXT | | |
| closed_by | TEXT | FK users | |
| deleted_at | TEXT | | 始まっていないものだけ |
| created_at、updated_at | TEXT | NOT NULL | |

- `CHECK (julianday(end_on) - julianday(start_on) BETWEEN 0 AND 27)`。長さは1〜28日。
- 一意: `(workspace_id) WHERE status = 'active' AND deleted_at IS NULL`。進行中は1つ。
- 索引: `(workspace_id, start_on) WHERE deleted_at IS NULL`。
- 索引（外部キーの検査）: `(started_by) WHERE started_by IS NOT NULL`、`(closed_by) WHERE closed_by IS NOT NULL`。
- 期間を重ねないことはアプリが検査する。延長で後ろのスプリントをずらすときは、1回のバッチで全部を書き直す。

### sprint_entries

タスクとスプリントの所属の履歴。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| sprint_id | TEXT | NOT NULL、FK sprints | |
| task_id | TEXT | NOT NULL、FK tasks | |
| added_at | TEXT | NOT NULL | |
| added_by | TEXT | NOT NULL、FK users | |
| ended_at | TEXT | | 出た日時。終了したスプリントで完了のまま残るものは、終了の日時 |
| outcome | TEXT | `completed`、`carried_over`、`removed` | 完了、持ち越し、外した。入っている間は空 |

- 一意: `(task_id) WHERE ended_at IS NULL`。1つのタスクが入っている行は1つ。
- 索引: `(sprint_id)`、`(task_id)`、`(added_by)`（外部キーの検査）。
- 積載量では `outcome = 'carried_over'` の行を数えない。持ち越したタスクは最後に入ったスプリントでだけ数える。
- スプリントを削除したら、入っていた行を `removed` で閉じ、タスクの `sprint_id` と `column_id` を空にする。

## 記録

### completions

タスクの完了の記録。振り返りと請求に使う。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| task_id | TEXT | NOT NULL、FK tasks | |
| completed_at | TEXT | NOT NULL | リーダーが直せる |
| completed_by | TEXT | NOT NULL、FK users | |
| points | INTEGER | | 完了した時点。リーダーが直せる |
| assignee_user_id | TEXT | FK users | 完了した時点の担当 |
| sprint_id | TEXT | FK sprints | スプリントの外で完了したら空 |
| category_id | TEXT | FK categories | 完了した時点の区分（引き継いだもの） |
| billing_month | TEXT | | 計上月。月ごとに計上する区分のときだけ入る。リーダーが直せる |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `(workspace_id, completed_at)`、`(workspace_id, billing_month)`、`(sprint_id)`、`(task_id)`。
- 索引（外部キーの検査）: `(completed_by)`、`(assignee_user_id) WHERE assignee_user_id IS NOT NULL`。
- 未完了に戻したら行を消す。ただし、レビュー依頼が再依頼されて未完了に戻るときは消さない。このため1つのタスクに複数の行がありうる。

### thanks

感謝。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| task_id | TEXT | NOT NULL、FK tasks | |
| sender_user_id | TEXT | NOT NULL、FK users | |
| recipient_user_id | TEXT | NOT NULL、FK users | |
| created_at | TEXT | NOT NULL | |

- `CHECK (sender_user_id <> recipient_user_id)`。
- 一意: `(task_id, recipient_user_id)`。同じタスクで同じ相手に1回。
- 索引: `(recipient_user_id)`（外部キーの検査にも使う）、`(sender_user_id)`（外部キーの検査）。
- 取り消しは行を消す。完了したタスクの感謝は取り消せない（アプリが検査）。

### xp_grants

経験値の付与の明細。行は足すだけで、打ち消しも負の値の行で足す。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| user_id | TEXT | NOT NULL、FK users | 受け取った人 |
| action | TEXT | NOT NULL、`task_created`、`task_detailed`、`task_completed`、`review`、`help`、`story_completed`、`epic_reward` | |
| task_id | TEXT | FK tasks | |
| story_id | TEXT | FK stories | |
| epic_id | TEXT | FK epics | |
| completion_id | TEXT | | 起票、詳細、完了、レビューでは元の完了の記録。記録は消えうるので外部キーにしない |
| thank_id | TEXT | | 手助けでは元の感謝。同上 |
| helper_sender_user_id | TEXT | FK users | 手助けでは感謝を送った人。回数の上限の判定に使う |
| amount | INTEGER | NOT NULL | 正なら付与、負なら打ち消し |
| reverses_grant_id | TEXT | FK xp_grants | 打ち消しの行が指す元の行 |
| dedupe_key | TEXT | NOT NULL | 重複を防ぐキー（下記） |
| confirmed_at | TEXT | NOT NULL | 確定日時 |

- 一意: `(dedupe_key)`。
- `dedupe_key` の作り方。打ち消したあとに付け直せるよう、付与の「回」をキーに含める。
  - 起票: `task_created:<completion_id>`
  - 詳細: `task_detailed:<completion_id>`
  - 完了: `task_completed:<completion_id>`
  - レビュー: `review:<completion_id>`（依頼の回ごとに完了の記録が分かれる）
  - 手助け: `help:<thank_id>:<completion_id>`
  - ストーリーの完了: `story_completed:<story_id>:<user_id>:<completed_at>`
  - クリア報酬: `epic_reward:<epic_id>:<user_id>:<completed_at>`
  - 打ち消し: `reversal:<元の id>`
- 「同じタスクの同じ行動で有効な付与は1回だけ」は、上のキーと、付与の前に「打ち消されていない同じ行動の付与がないか」をアプリが見ることで守る。
- 起票、詳細、完了は、タスクを完了にしたときに同じバッチで付け、未完了に戻したときに同じバッチで打ち消す。
- 感謝の回数の上限は、`action = 'help'` の行を `helper_sender_user_id` と受け取った人で絞り、`confirmed_at` がワークスペースのタイムゾーンで同じ週に入るものを数えて判定する。
- 索引: `(user_id, workspace_id)`、`(workspace_id, user_id)`、`(task_id)`、`(story_id)`、`(epic_id)`、`(reverses_grant_id)`。`(workspace_id, user_id)` はチーム全体の合計とメンバーごとの合計に使う。`(user_id, workspace_id)` は `user_id` の外部キーの検査にも使う。
- 索引: `(helper_sender_user_id) WHERE helper_sender_user_id IS NOT NULL`。外部キーの検査。
- レベル、合計、チーム全体の合計は `SUM(amount)` で出す。

### notifications

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| user_id | TEXT | NOT NULL、FK users | 受け取る人 |
| workspace_id | TEXT | FK workspaces | |
| kind | TEXT | NOT NULL | `source_done`、`source_reopened`、`source_missing`、`connection_failed`、`credential_expiring`、`comment`、`assigned`、`party_assigned`、`reward_changed`、`thanked`、`attachment_quota_warning` |
| task_id | TEXT | FK tasks | |
| epic_id | TEXT | FK epics | |
| connection_id | TEXT | FK connections | |
| actor_user_id | TEXT | FK users | 知らせのもとになった操作をした人 |
| payload_json | TEXT | NOT NULL、既定 `'{}'` | 文面に差し込む値 |
| read_at | TEXT | | |
| created_at | TEXT | NOT NULL | |

- 索引: `(user_id, created_at)`、`(user_id) WHERE read_at IS NULL`。`(user_id, created_at)` は `user_id` の外部キーの検査にも使う。
- 索引: `(actor_user_id) WHERE actor_user_id IS NOT NULL`。外部キーの検査。
- 既読にしてから90日たった通知は定期処理で消す。未読は消さない。

### change_logs

変更の履歴。タスク、ストーリー、エピックの属性の変更と、権限、配分、接続、完了の記録の修正、削除を1つの表に残す。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| organization_id | TEXT | NOT NULL、FK organizations | |
| workspace_id | TEXT | FK workspaces | 組織の変更（組織の作成、管理者の指名、ユーザーの無効化、組織の休日）では空 |
| actor_user_id | TEXT | FK users | 空なら同期などの定期処理か運用者の操作 |
| operator | TEXT | | 運用者の操作（管理者の指名し直しなど）のときの運用者のログインの ID（`github:12345`、`google:<sub>` の形） |
| entity_type | TEXT | NOT NULL | `task`、`story`、`epic`、`sprint`、`membership`、`invitation`、`allocation`、`connection`、`completion`、`user`、`workspace`、`organization` など |
| entity_id | TEXT | NOT NULL | |
| action | TEXT | NOT NULL | `create`、`update`、`delete`、`complete`、`reopen`、`archive`、`close` など |
| changes_json | TEXT | NOT NULL、既定 `'{}'` | `{"列名": [前, 後]}`。人や列は ID と、そのときの表示名を並べて残す |
| created_at | TEXT | NOT NULL | |

- 索引: `(entity_type, entity_id, created_at)`、`(organization_id, created_at)`、`(workspace_id, created_at)`。
- 索引: `(actor_user_id) WHERE actor_user_id IS NOT NULL`。外部キーの検査。
- タスク、ストーリー、エピックの履歴はメンバー全員が、それ以外はリーダーと管理者が見られる。見られる範囲は `entity_type` で決める。
- 同期による取り込み元の属性の書き換えは残さない。量が多く、取り込み元で見られるため。
- 期間で消さず、残し続ける。容量が気になったら、手順書のエクスポート（`wrangler d1 export`）で退避する。

## 書き込みの単位

D1 は対話的なトランザクションを持たない。まとめて書く操作は D1 の `batch()` で1回に送る。`batch()` の中の文は1つのトランザクションとして全部が通るか全部が戻る。主な操作と、1回のバッチで書くもの。

| 操作 | 書くもの |
| --- | --- |
| タスクの完了 | `tasks`、`completions`、`sprint_entries`（スプリントの外なら書かない）、`xp_grants`（完了、起票、詳細、手助け）、`change_logs`、`notifications` |
| タスクの作成 | `tasks`、`change_logs`。`tasks` の文は `INSERT ... SELECT ... WHERE EXISTS`（閉じていないワークスペース。担当を指すときは、そのワークスペースに今所属している、無効でなく `login_subject` のある人。親を指すときは、同じワークスペースの削除していない、完了していないストーリー）にし、`change_logs`（担当と親も残す）は作った行があるときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、親が完了していれば 409（`conflict`）、そうでなければ 404 |
| タスクの変更 | `tasks`、`change_logs`。ストーリーの変更と同じ書き方: 先に読んだ今の値と違う欄だけを `UPDATE` の `SET` に入れ（送られない欄は触らない）、条件は `id`、`workspace_id`、`deleted_at IS NULL`、閉じていないワークスペースと、書く欄ごとの `<列> IS :読んだ値`。`change_logs`（`entity_type = 'task'`、`action = 'update'`、変わった列だけの `{"列": [前, 後]}`）は、直前の `UPDATE` が行を変えたときだけ入れる（`INSERT ... SELECT ... WHERE changes() > 0`。下の「直前の文に結ぶ」）。欄は `title`、`points`、`due_on`、`link_url`、`body_md` で、担当（下の「タスクの担当の変更」）、区分、リポジトリは変えない。断る変更は読んだ時点で 409（`conflict`）にする: 完了したタスク（`completed_at IS NOT NULL`）のポイント（経験値とスプリントの集計が `completions.points` を使うため。同じ値を送るだけなら断らない）と、取り込んだタスク（`is_imported = 1`）のタイトルとリンク。ポイントを書く文は `completed_at IS NULL` も条件にし、読んでから書くまでに完了にされたら止める（次の周の読み直しで 409）。何も入らなければ、閉じていれば 409（`workspace_closed`）、タスクが無ければ 404、どちらでもなければ（別の要求が先に同じ欄を変えた）読み直して差を作り直し、やり直す（3 回まで。超えたら 409 の `conflict`）。変える欄が無い要求は何も書かず、閉じたワークスペースは 409 にする |
| タスクの担当の変更 | `tasks`（`assignee_user_id`、`today_on`、`updated_at`）、`change_logs`。`task-assign` が、読んだ担当と違う担当（か `NULL`）を送られたときだけ書く。`tasks` の文は `assignee_user_id` を書き、同じ文で `today_on` を `NULL` にする。条件は `id`、`workspace_id`、`deleted_at IS NULL`、`completed_at IS NULL`、`assignee_user_id IS :読んだ担当`、`today_on IS :読んだ値`、閉じていないワークスペースと、新しい担当を指すときは、その人がそのワークスペースに今所属していて、無効でなく `login_subject` があること（`EXISTS`）。`change_logs`（`entity_type = 'task'`、`action = 'update'`、`{"assignee": [前, 後]}`。前と後は `{"id", "name"}`（そのときの名前）か `null`。`today_on` が入っていたら `"today_on": [前の日付, null]` も）は、直前の `UPDATE` が行を変えたときだけ入れる。読んだ時点で、タスクが無ければ 404、同じ担当なら何も書かない（閉じたワークスペースは 409 の `workspace_closed`）、完了していれば 409（`conflict`）、新しい担当が今所属していなければ 404。何も入らなければ、閉じていれば 409（`workspace_closed`）、タスクが無いか新しい担当が所属を外れていれば 404、どちらでもなければ（別の要求が先に担当か今日やるの印を変えた、完了にした）読み直してやり直す（3 回まで。超えたら 409 の `conflict`） |
| タスクの削除 | `tasks`（`deleted_at` と `updated_at`）、`change_logs`（`action = 'delete'`、`{"deleted_at": [null, <日時>]}`）。論理削除なので、`completions`、`xp_grants`（経験値）は残す。バックログの木のストーリーごとの合計（削除していないタスクだけ）からは外れる。削除できるのは、手で作ったタスクの作った人（`tasks.created_by`）とリーダー（管理者を含む）で、権限が無ければ 403（`forbidden`）。取り込んだタスクは、権限があっても 409（`conflict`）で削除できず（アーカイブで外す。`docs/requirements.md` の「削除」）、`task-detail` の `can_delete` も偽にする。タスクが無ければ（別の組織、別のワークスペース、削除済みを含む）権限より先に 404。`tasks` の文の条件は `id`、`workspace_id`、`deleted_at IS NULL`、閉じていないワークスペースで、`change_logs` は直前の `UPDATE` が行を変えたときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 404（別の要求が先に削除した） |
| ストーリーの作成 | `stories`、`change_logs`。`stories` の文は `INSERT ... SELECT ... WHERE EXISTS`（閉じていないワークスペース）にし、`change_logs` は作った行があるときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 404 |
| ストーリーの変更 | `stories`、`change_logs`。先に読んだ今の値と違う欄だけを `UPDATE` の `SET` に入れる（送られない欄は触らない）。条件は `id`、`workspace_id`、`deleted_at IS NULL`、閉じていないワークスペースと、書く欄ごとの `<列> IS :読んだ値`（読んでから書くまでに別の要求が同じ欄を変えていたら、更新は通らない。履歴の「前」がずれるのと、同じ値の指定の取りこぼしを防ぐ）。`change_logs` は、この更新の `updated_at` と書いた値が入った行があるときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、ストーリーが無ければ 404、どちらでもなければ（別の要求が先に同じ欄を変えた）読み直して差を作り直し、やり直す（3 回まで。超えたら 409 の `conflict`）。読み直して書くものが無くなれば、何も書かずに今の値を返す。変える欄が無い要求も、閉じたワークスペースは 409 にする |
| タスクの移動 | `tasks`（移す行と、同じ値の続きの振り直し）、`change_logs`（親が変わったときだけ）。移す行の文は条件つきの `UPDATE`（読んだときの親のまま、閉じていないワークスペース、移す先の親が今もある、直前の行が読んだ値の位置にある）。振り直し（40 行まで）と `change_logs` は、移す行の更新が通ったことを条件にする。何も変わらなければ、閉じていれば 409（`workspace_closed`）、無ければ 404、そうでなければ理由つきの 409（`conflict`）。決まりは `tasks` の「並べ替えと親の移動」 |
| ストーリーの移動 | `stories`（移す行と、同じ値の続きの振り直し）、`change_logs`（親が変わったときだけ）。形はタスクの移動と同じで、親はエピック |
| 完了を戻す | `tasks`、`completions` の削除、`xp_grants`（打ち消し）、`change_logs` |
| スプリントの終了 | `sprints`、`sprint_entries`、持ち越すタスクの `tasks` と新しい `sprint_entries`、`change_logs` |
| エピックのクリア | `epics`、`xp_grants`（クリア報酬）、`change_logs` |
| メンバーの離脱 | `memberships`、担当を外す `tasks`、`epic_party_members`、`connections`、`change_logs`。ログインできなくなったときは、続けて共通の DB の `sessions` を消す |
| 取り込み（1件） | `tasks`（結ばれたリポジトリがあれば `repository_id` も）、`task_sources`、`task_source_payloads` |
| 組織の作成 | 共通の DB の `organizations`、続けて組織の DB の最初の管理者の `users` と `change_logs` の2行（組織の作成と管理者の指名） |
| 組織の設定の変更 | 共通の DB の `organizations`（`vocabulary`、`theme`、`updated_at`）を、それだけの `batch()` で書き、続けて組織の DB の `change_logs` を別の `batch()` で書く。`organizations` の文の条件は `id` と、書く欄ごとの `<列> IS :読んだ値`。変わった行が無ければ（別の要求が先に変えた）409 の `conflict` で、`change_logs` は書かない |
| ワークスペースの作成 | `workspaces`、`workspace_point_rates`（作った月、4）、`board_columns`（4行。完了の列は末尾）、`detail_fields`（1行）、最初のリーダーの `memberships`、`change_logs`（ワークスペースと所属の2行）。どの文も `INSERT ... SELECT ... WHERE EXISTS`（最初のリーダーが同じ組織にいて、無効でなく、`login_subject` があり、管理者か、いずれかのワークスペースに今所属している。かつ、作る人が同じ組織の、無効でない管理者）にし、全部入るか何も入らないかにする。何も入らなければ 404 |
| ワークスペースを閉じる | `change_logs`（`entity_type` は `workspace`、`action` は `close`、`changes_json` は `{"closed_at": [null, 閉じた日時]}`）、`workspaces`（`closed_at`、`updated_at`）。この順に書き、どちらの文も同じ条件（ワークスペースが組織のもので `closed_at IS NULL`、かつ呼んだ人が同じ組織の無効でない管理者）を持つ。1回の `batch()` は文を順に流すので、履歴が入るのは `workspaces` が書き換わるときだけ。何も入らなければ、読み直して閉じていれば 409（`workspace_closed`）、そうでなければ 404 |
| ワークスペースを開き直す | 閉じるのと同じ形で、`action` は `reopen`、`changes_json` は `{"closed_at": [前の日時, null]}`、`workspaces` の条件は `closed_at = 前の日時`（読んだ値）。何も入らなければ、読み直して `closed_at` が読んだ値と違えば 409（`conflict`）、同じなら 404。開いているワークスペースには、書く前に 409（`conflict`） |
| 招待（GitHub） | `invitations`、`change_logs`（`entity_type = 'invitation'`、`action = 'create'`、`{"login_provider": [null, …], "login_subject": [null, …], "login_name": [null, …], "role": [null, …]}`）。書く前に、ユーザー名を解決し直して画面が確かめた ID と違えば 409（`invitee_changed`）、そのワークスペースに今所属している無効でない人なら 409（`already_member`）、同じワークスペースに同じ `(login_provider, login_subject)` の承諾待ちの招待があれば 409（`already_invited`）、人数（`organizations` の「人数」）が `member_limit` 以上で、招待する人がまだ数えられていなければ 409（`member_limit_reached`）。無効にされた人への招待は断らない。`invitations` の文は `INSERT ... SELECT ... WHERE`（閉じていないワークスペース、所属していない、承諾待ちの招待が無い）にし、`change_logs` は直前の文が行を入れたときだけ入れる（下の「直前の文に結ぶ」）。何も入らなければ、読み直して閉じていれば 409（`workspace_closed`）、所属か招待があればその 409、どちらでもなければ 404。人数は書く文の条件に入れない（同時に招待して超えたときは、そのまま認める。超えるのは同時に送った招待の数まで） |
| 招待の取り消し | `invitations`（`status = 'revoked'`、`responded_at`）、`change_logs`（`action = 'update'`、`{"status": ["pending", "revoked"]}`）。招待はワークスペースで絞って読み、無ければ（別のワークスペース、別の組織を含む）404、承諾待ちでなければ 409（`conflict`）。`invitations` の文の条件は `id`、`workspace_id`、`status = 'pending'`、閉じていないワークスペースで、`change_logs` は直前の文が行を変えたときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 409（`conflict`） |
| Google の招待の URL から結ぶ | 組織の DB の `users` か `invitations`、`change_logs`（「メールアドレスで待つ指名と招待」の 6）、続けて共通の DB の `accounts` と `account_logins` |
| 初めてのログイン | 共通の DB の `accounts` と `account_logins`、続けて組織の DB の `users.account_id`（指名で待っていた行に結ぶ）、続けて共通の DB の `sessions`。2回目以降は `account_logins` と `accounts.last_login_at` の書き直し、`users.account_id` を結び直す書き込み、`sessions` の順 |
| 添付ファイルを上げる | R2 にファイルを書き、続けて `attachments` |
| 添付ファイルを消す | `attachments` の削除と `change_logs`、続けて R2 のファイルの削除 |
| コメントの削除 | `comments`、そのコメントの `attachments` の削除、`change_logs`、続けて R2 のファイルの削除 |

先に読んだ値で判定してから書く操作（最後の管理者、完了の可否など）は、書く文の `WHERE` に同じ条件を入れ、影響した行の数で競合を見つける。

直前の文に結ぶ: 履歴の `INSERT ... SELECT` は、直前の `UPDATE` が行を変えたことを `WHERE changes() > 0` で条件にする（`src/server/db/previous-statement.ts` の `previousStatementChanged`）。D1 の `batch()` は全部の文を1つの接続の1つのトランザクションで順に流すので、`changes()` は直前の文の件数になる（テストで確かめている）。履歴の行や時刻の一致で「自分の更新か」を見分けると、止めた時計（`DEV_NOW`）や同じ値を書く要求では、負けた要求も一致して履歴を二重に書く。この条件は直前の文だけを見るので、変える文の直後に置く。タスクの変更と削除、招待と取り消しが使う。

タスクの完了（`task-complete`）の文と条件。ポイント、担当、区分、作った人は先に読まず、`INSERT ... SELECT` で `tasks` の行から取る。読むのは、計上月を決めるワークスペースのタイムゾーンと、変更の履歴に残す完了にした人の名前だけ。`batch()` は件数 0 の文があっても後ろの文を書くので、後ろの文は先の文が通ったことを自分の条件に持つ。この版の完了は、スプリントに入っていないバックログのタスク（親のないタスクと、ストーリーの下のタスク）を対象にし、1 の条件（`tray = 'backlog' AND sprint_id IS NULL`）で守る。対象でないタスク（受信箱やアーカイブのタスク、スプリントに入っているタスク）は、何も書かず 404 にする。`sprint_entries` を足すときに、スプリントに入っているタスクへ対象を広げる。

1. `tasks`: `completed_at`、`completed_by`、`updated_at` を書く。条件は `id = :task AND workspace_id = :ws AND tray = 'backlog' AND sprint_id IS NULL AND completed_at IS NULL AND deleted_at IS NULL AND EXISTS (閉じていないワークスペース)`。最後の条件は、読んでから書くまでの間にワークスペースが閉じた競合を止める。変わった行が0なら、`batch()` の後に、同じ前提（`tray`、`sprint_id`）でタスクを読み直して分ける。ワークスペースが閉じていれば 409（`workspace_closed`）、タスクの行が無い（別の組織のタスクと、前提に当たらないタスクを含む）なら 404、あれば完了済みの 409（`conflict`）
2. `completions`: `tasks LEFT JOIN stories LEFT JOIN epics`（どちらも同じワークスペースのものだけ）に、段ごとに同じワークスペースの `categories` を `LEFT JOIN` したもの（エピックの区分 `ec`、ストーリーの区分 `sc`、タスクの区分 `tc`）から入れる。`category_id` は `COALESCE(ec.id, sc.id, tc.id)`。別のワークスペースの区分が結ばれた段は結ばれないので飛ばし、次の段へ下りる（全部だめなら空）。条件は `tasks.completed_at = :at AND tasks.completed_by = :me AND NOT EXISTS (同じタスクで同じ完了日時の completions)`。開発用の時計（`DEV_NOW`）で止めた時刻では、同じ人が2回完了にした要求の完了日時と完了にした人が同じになる。1 の値との一致だけでは自分の更新か先の要求の更新かを見分けられないので、先に入った記録があれば何も入らないようにする。レビュー依頼の再依頼で1つのタスクに完了の記録が複数ありうるため、`task_id` の一意制約では守らない。`billing_month` は、`category_id` に入れた段の区分が `is_billed_monthly = 1` のときだけ `:at` の月（ワークスペースのタイムゾーン）、ほかは空
3. `xp_grants`: 起票（`task_created`。受け取るのは `created_by`、`created_by IS NOT NULL` が条件）と完了（`task_completed`。受け取るのは `COALESCE(assignee_user_id, :me)`）。どちらも `tasks.points >= 1`、受け取る人がそのワークスペースに今所属している（`EXISTS (SELECT 1 FROM memberships WHERE workspace_id = :ws AND user_id = <受け取る人> AND left_at IS NULL)`）こと、`EXISTS (SELECT 1 FROM completions WHERE id = :自分の completion_id)` が条件。所属していない管理者や所属を外れた担当は、経験値の対象にならない（`docs/requirements.md`）ので、担当のいないタスクを所属していない管理者が完了にすると、完了の経験値は誰にも付かない。`dedupe_key` は `task_created:<completion_id>`、`task_completed:<completion_id>`
4. `change_logs`: 3 と同じ `EXISTS` が条件

自分の `completion_id` の記録が入ったことを後ろの文の条件にするので、遅れた要求は `completions`、`xp_grants`、`change_logs` を1行も書かない。

共通の DB と組織の DB に分けて書く操作は、途中で失敗したときの扱いを決めておく。

- 組織の作成で `users` が入らなかったときは、管理者のいない組織が残る。運用者の一覧では管理者の状態が `none` になり、画面は「管理者がいない」と出す。管理者の指名し直しで入れる。`change_logs` は `users` と同じ `batch()` で書くので、残らない。
- 組織の設定の変更で `change_logs` が入らなかったときは、`organizations` の変更だけが残り、その変更の履歴は残らない。応答と画面での扱いは、設定の操作（#192）で決める。
- Google の招待の URL から結んだあと、アカウントが作れなかったときは、`sub` を埋めた行だけが残る。次に Google でログインすれば `sub` で当たり、アカウントの作成に進む。
- ログインで `users.account_id` を結べなかったときは、`accounts` と `account_logins` だけが残る。セッションは作らず、「もう一度ログインしてください」を出す。ログインのたびに、そのログインの ID（手段と手段の中の ID）で `account_id` が空の `users` を結び直す（結んだ行は当たらなくなるので、何度流しても同じ結果）ので、次のログインで結ばれる。組織に入れるかの判定は `users.account_id` で行うので、結ばれるまでその組織には入れない。
- 同じ人の最初のログインが並行したときは、片方の `batch()` が `account_logins` の主キーで落ちて、`accounts` ごと戻る。落ちた側は、もう片方が作った行を読み直して続ける。
- 添付ファイルを上げるときに `attachments` が入らなかったら、書いた R2 のファイルを消す。添付ファイルを消すときに R2 のファイルが消えなかったら、どの行も指さないファイルが残る。容量の上限には数えず、組織を消すときにまとめて消える。
- メンバーの離脱で `sessions` が消えなかったときも、組織に入れるかはリクエストのたびに確かめるので、離脱した組織には入れない。ログインできる条件を失った人のセッションは、次にその人がリクエストしたときに消す。

## 要件からの補い

要件定義に書いていないが、テーブルにするために決めたこと。

- 稼働する曜日も、1日の時間と同じく適用開始月付きの履歴で持つ。変えても過去の月の積載量は動かない。
- ストーリーとエピックの完了は、行の `completed_at` と `completed_by` だけで持ち、`completions` には入れない。請求と振り返りはタスクの完了の記録で足りるため。
- エピックは Markdown の本文を1つ持つ。経験値は付かない。
- 感謝の取り消しと、討伐隊から抜けることは行の削除で表し、記録は `change_logs` に残す。
- 招待は承諾したときにユーザーの行を作る。
- 既読の通知は90日で消す。変更の履歴は消さない。
- 区分を削除したら、振っていたものは区分なしに戻す。完了の記録は削除した区分を指したまま残す。

