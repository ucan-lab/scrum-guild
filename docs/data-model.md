# Scrum Guild データモデル

状態: 確定。要件定義（`requirements.md`）を D1（SQLite）のテーブルに落としたもの。最初のマイグレーション（`migrations/0001_create_initial_tables.sql`）で、共通の6表と、一本道に要る組織の中の16表を作った。`organization_holidays` は `migrations/0004_add_organization_holidays.sql` で、`comments` は `migrations/0006_add_comments.sql` で、`sprint_entries` と `completions.previous_column_id` は `migrations/0008_add_sprint_entries.sql` で、`epic_party_members` と `thanks` は `migrations/0009_add_epic_party_members_and_thanks.sql` で、共通の表の `password_credentials` は `migrations/0010_add_password_credentials.sql` で足した（共通の表は7表になった）。残りの表は、使う機能の Issue でマイグレーションを足して作る

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
- 手で並べ替える並びは、分数の並び（fractional indexing）の文字列 `position` で持つ。間に入れても他の行を書き換えない。新しく入ったものは末尾の値を取る。同時に作ると同じ値になりうるので、読むときは `position, id` の順で並べる（同じ値の行は `id` の順で、同じミリ秒の中では作った順とは限らない）。並べ替えは、移す先の中で直前の行とその次の行（移す行を除き、完了した行も含む）の間の値を取る。直前の行と次の行が同じ値なら、間に入る値が無いので、直前の行と同じ値で `id` が後ろの行（同じ値の続き）を、移す行と一緒に、直前の行の値と次の違う値の間で振り直す（同じ `batch()` で書く。決まりは `tasks` の「並べ替えと親の移動」）。値は `fractional-indexing` のパッケージで作る（ワークスペースを作るときの最初の列も同じ）。例外は、エピックとストーリーの削除で配下をまとめて移す末尾の値で、子の数によらず1つの文で振るため SQL の中で作る（移す先の最後の値（`ORDER BY position DESC LIMIT 1`。無ければ `a0`）の後ろに、元の並びの順番を桁をそろえた10進数で足し、`V` で閉じる。最後の値が接頭辞なので、どの値も既存の行より後ろで、順番の桁がそろうので文字列の比較でも元の並びのまま。小数の部分が `0` で終わらないので `fractional-indexing` の鍵としてそのまま使える。式は `src/server/db/tail-position.ts` の `tailPosition` の1か所に置く。続けて削除すると、末尾の値はそのたびに順番の桁と `V` の分だけ伸びる（次に末尾へ足す行は `generateKeyBetween` で短い値に戻る）。「書き込みの単位」の「エピックとストーリーの削除」）。
- 集計（積載量、経験値の合計、ポイントの合計、ベロシティ）は保存せず、読むたびに計算する。
- 1つの D1 に複数の組織を入れる。組織の中の行は、リクエストの組織から辿って引く。ID だけで行を引かず、必ず `organization_id` か、組織を確かめた `workspace_id` で絞る。他の組織の行が見えないことはテストで確かめる。
- 表を共通の表と組織の中の表に分け、後から組織ごとにデータベースを分けられるようにしておく。決まりは「データベースの分け方」。

## 全体の構成

| まとまり | テーブル |
| --- | --- |
| アカウント | `accounts`、`account_logins`、`password_credentials`、`sessions`、`oauth_states`、`rate_limits` |
| 組織 | `organizations`、`users`、`organization_holidays` |
| ユーザーの稼働 | `user_capacity_settings`、`user_monthly_overrides`、`user_time_off` |
| ワークスペース | `workspaces`、`workspace_point_rates`、`workspace_holidays`、`memberships`、`invitations`、`allocations` |
| ワークスペースの定義 | `board_columns`、`detail_fields`、`categories`、`repositories` |
| 接続 | `connections`、`connection_scopes`、`connection_status_mappings` |
| 計画と作業 | `epics`、`epic_party_members`、`stories`、`tasks`、`task_sources`、`task_source_payloads`、`task_field_values`、`comments`、`attachments`、`sprints`、`sprint_entries` |
| 記録 | `completions`、`thanks`、`xp_grants`、`notifications`、`change_logs` |

親子の向きの要点。

- アカウントは人ごとに1行で、組織をまたぐ。ログインの手段（初版は GitHub、Google、メールアドレスとパスワード）とは `account_logins` で結び、特定の手段に依存させない。ログインとセッションはアカウントに付く。
- 人は、ログインの手段（`login_provider`）と手段の中の不変の ID（`login_subject`）の組で見分ける。GitHub では `github` とユーザー ID、Google では `google` と `sub`、パスワードでは `password` と発行した UUID（`password_credentials.login_subject`）。アカウントができる前の管理者の指名と招待も、この組で持つ。
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
| 共通 | `accounts`、`account_logins`、`password_credentials`、`sessions`、`oauth_states`、`rate_limits`、`organizations` | 共通の DB に1つだけ |
| 組織の中 | それ以外のすべて | 組織が置かれた DB |

添付ファイルの中身は D1 ではなく R2 に置く。R2 のキーの先頭は組織の ID なので、D1 を分けても R2 は分けずに済む。

- 共通の表から組織の中の表へは外部キーを張らない。
- 組織の中の表から共通の表へ張る外部キーは、`users.account_id` と、`users`、`workspaces`、`organization_holidays`、`change_logs` の `organization_id` だけにする。分けるときはこれらを外し、アプリの検査に替える。
- 共通の表と組織の中の表を1つの SQL で結合しない。`users` にログイン名とアバターを添えるときも、`accounts` と `account_logins` を別に引いてアプリで合わせる。例外は、運用者が手で流す、解約した組織のデータを消す SQL だけ（`organizations` の節）。

### 読み書きの入口

- 組織の中の表は、リクエストの組織から DB を選ぶ1つの関数を通して読み書きする。今はどの組織でも同じ DB を返す。
- 共通の表は、共通の DB を返す別の関数を通して読み書きする。
- 1回の `batch()` に、共通の表と組織の中の表を混ぜない。今これに当たる操作は「書き込みの単位」の組織の作成、組織の設定の変更、組織の停止と再開、人数と添付ファイルの上限の変更、メンバーの離脱、ユーザーの無効化で、どれも2回に分けて書く。運用者の管理者の指名し直しは、共通の表を読むだけで、書くのは組織の中の表の1回の `batch()`。
- 組織をまたいで読む処理は、1つの関数にまとめる。当たるのは、ログインできるか（入れる組織と届いた招待があるか）、ログインの直後の組織の選択、届いた招待の一覧、初めてのログインで `users.account_id` を埋めること、招待の URL の秘密のハッシュから待っている指名と招待を引くこと、運用者の一覧の管理者の状態と組織ごとの集計（人数、ワークスペースとタスクの数、最後に使われた日時）を数えること。今は組織の中の表を持つ DB が1つで、`allOrganizationDatabases()`（`db/select-database.ts`）が返す DB ごとに、組織の中の表（`users`、`memberships`、`invitations`）を引き、共通の表（`organizations`）を別の問い合わせで引いて、アプリで合わせる。`users` と `invitations` は、アカウントに結んだログインの手段と ID の組ごとに、`users_login` と `invitations_login_pending` の索引で引く（全件を読まない）。分けたときは、この関数だけを、DB の一覧を全部返す形に直すか、共通の DB にログインの ID（`login_provider` と `login_subject`）と組織の組の索引、招待の URL の秘密のハッシュと組織の組の索引を持つ形に直す。どちらにするかは分けるときに決める。
- 組織をまたいで読む関数（`listAccountOrganizations`）の前提。アカウントは必ず1つ以上のログインを持つ（0件なら、一覧は何も引かずに空を返す）。`users` の行のログイン（`login_provider`、`login_subject`）は、結んだアカウントのログインのどれかである。一覧はログインの手段と ID で `users` を引いてから `account_id` で絞るのに対し、`enterOrganization` は `account_id` で引くので、この前提が崩れると、一覧と入れる組織がずれる。ログインの付け替えや統合を入れるときは、この関数を直す。結ぶ書き込み（ログインのたびの、`account_id` が空の行の埋め直し）は、この前提を崩さない。
- 組織の選択（`listAccountOrganizations`）が返す届いた招待は、1組織1件で、組織の名前と slug だけを持つ（`{ organization_name, slug }`）。slug は、その組織の招待の画面（`/<slug>/invitations`）へ移り、届いた招待の一覧、承諾、辞退の操作（`invitation-list`、`invitation-accept`、`invitation-decline`。`invitations` の節）をその組織の slug の下で呼ぶのに使う。ワークスペースや招待した人など、組織の中の値は入れない。
- ログインできるかの判定は、`listAccountOrganizations` と同じ読み取り（`readAccountOrganizations`）を通す。入れる組織か届いた招待が、停止していない組織に1つでもあれば通す。2つの場面で使う。
  - セッションの判定（組織の外の操作と、組織に入れなかったとき）: 組織の選択と同じ結果を、1回のリクエストの中で使い回す。アカウントに結ばれる前の行（`account_id` が空で、ログインの手段と ID が一致する、指名で待っていた行）は数えない。結ばれる前の行だけを持つ人のセッションを、どこにも入れないまま残さないため。その人は 401 でセッションが消え、もう一度ログインすると結ばれて入れる。組織を離れる、無効にするなどの書き込みの後に、相手のセッションを消すかの判定（組織の道具の `endSessionsIfLoginLost`。`docs/development.md` の「操作の定義」）も、同じ基準を使う。
  - ログインのとき（`hasLoginAccess`）: 結ばれる前の行も数える。ログインのたびに `users.account_id` を結ぶので、これから入れる行だから。初めてのログインではアカウントが無くても引ける。
- `linkLoginToAccount` は、組織で絞らずに `users.account_id` と `updated_at` を書く、この読み書きの入口だけの例外（組織の中の操作の処理は、組織の ID で絞らないと書けない）。呼ぶのは、ログインのたびの結び直しと、運用者の組織の作成と管理者の指名し直しの書いた後の結び直し（運用者の道具の `linkLogin` 経由）。絞るのは、ログインの手段と ID が一致することと、`account_id` が空であること。読む文と書く文は、どちらも `users_login` の索引に乗る。1つのアカウントに複数のログインの手段を結ぶとき（#57）は、同じ組織に同じアカウントの行が2つできて、`users_organization_account`（`organization_id` と `account_id` の一意）に当たりうる。#57 で、この前提と判定と、結ぶ UPDATE を見直す。

### 入ってから書くまでの停止

組織が停止しているかは、組織に入るとき（`enterOrganization`、`src/server/db/enter-organization.ts`）に共通の表の `organizations.suspended_at` を1回読んで確かめる。組織の中の表に書く操作（タスクやストーリーの書き込み、ワークスペースの作成、組織の休日の登録など）は、書く文の条件に `suspended_at` を入れられない。共通の表と組織の中の表を1つの SQL で結合せず、1回の `batch()` にも混ぜないため（「共通の表と組織の中の表」「読み書きの入口」）。

そのため、入った後に運用者が組織を停止すると、その要求は停止した組織の DB にも行（操作によっては `change_logs` も）を書く。この窓は受け入れ、塞がない。

- 窓は要求の単位で、停止より前に入った要求の中だけにある。停止の直前に入った要求が並行していれば、どれも書き終えうる。停止の後に入る要求は書かずに止まる（403 の `organization_suspended`、入れない人は 404、停止した組織にしか入れない人はセッションを消して 401）ので、続けては書けず、読めるものも増えない。
- 書く直前に `suspended_at` を読み直す形は取らない。読み直してから書くまでの間にも停止されうるので、窓は縮むだけで無くならないため。
- 共通の表の `organizations` を書く操作（組織の設定の変更）は、書く文の条件に `suspended_at IS NULL` を入れて止める。書く表と停止の列が同じ表にあるので、条件にできる（「書き込みの単位」の組織の設定の変更）。
- 招待の URL から結ぶ処理は組織に入るときの確かめを通らないが、結ぶ前に停止を1回読むだけなので、読んでから結ぶまでに同じ窓を持つ。結ばれても、その組織には入れない（「メールアドレスで待つ指名と招待」の 5）。

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

アカウントとログインの手段の結び付き。初版は1つのアカウントに1行だけ（GitHub か Google かパスワード）で、結ぶ操作を足したら1つのアカウントに複数の行を結べる。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| login_provider | TEXT | PK | ログインの手段（初版は `github`、`google`、`password`）。値はログインの手段の型の一覧でアプリが検証する |
| login_subject | TEXT | PK | 手段の中の不変の ID。GitHub ではユーザー ID を10進の文字列で、Google では ID トークンの `sub` を受け取った文字列のまま、パスワードでは `password_credentials.login_subject`（発行した UUID）を持つ。数値に直さない（Google の `sub` は JavaScript の数値で正確に表せない桁数がある） |
| account_id | TEXT | NOT NULL、FK accounts | |
| login_name | TEXT | NOT NULL | ログインのたびに書き直す表示用の名前。GitHub ではログイン名、Google ではプロフィールの名前（`name`。無ければ「Google ユーザー」）、パスワードでは `password_credentials.display_name`。Google とパスワードのメールアドレスは持たない |
| display_name | TEXT | | 手段の側の名前。組織で初めてユーザーを作るときの表示名の既定 |
| avatar_url | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `(account_id)`。

### password_credentials

メールアドレスとパスワードでログインする人の資格情報（手段 `password`。`migrations/0010_add_password_credentials.sql`）。共通の表。`accounts` と `account_logins` の行は、ほかの手段と同じく、初めてログインできたときに作る（入れる組織が無い人のアカウントは作らない）。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| login_subject | TEXT | PK | 手段 `password` の中の ID。発行した UUID で、`account_logins` と `users`、`invitations` の `(password, login_subject)` に当たる。メールアドレスは ID にしない（後から変えられるようにするため） |
| email | TEXT | NOT NULL、UNIQUE、`CHECK (email = lower(trim(email)) AND email GLOB '?*@?*')` | ログインに使うメールアドレス。そろえた形（`src/shared/email.ts`。「メールアドレスで待つ指名と招待」と同じそろえ方）で持ち、共通の DB で一意にする。ログにも応答にも出さない |
| password_hash | TEXT | NOT NULL、`CHECK (password_hash GLOB 'pbkdf2-sha256$[1-9]*$?*$?*')` | `pbkdf2-sha256$<反復回数>$<塩の base64url>$<鍵の base64url>`（PBKDF2-HMAC-SHA256、16 バイトの塩、32 バイトの鍵。`src/server/auth/password-hash.ts`）。形を CHECK で縛り、平文のパスワードを入れる取り違えを DB で止める |
| display_name | TEXT | NOT NULL、`CHECK (length(display_name) BETWEEN 1 AND 100)` | 手段の側の名前（Google のプロフィールの名前にあたる）。ログインのたびに `account_logins.login_name` と `display_name` に写す |
| password_changed_at | TEXT | NOT NULL | パスワードを決めた（変えた）日時。ハッシュの回数を上げて書き直したときは変えない |
| created_at、updated_at | TEXT | NOT NULL | |

- 索引: `email` の UNIQUE の索引が、ログインのときにメールアドレスで引くのを兼ねる。
- パスワードは NFC にそろえ、コードポイントで12〜128文字（`src/shared/password.ts`）。対になっていないサロゲートを含む入力は断る（UTF-8 にすると U+FFFD に置き換わり、別の文字列が同じパスワードとして通るため）。合わない入力は照合せずに、違うパスワードと同じ応答にする。
- 反復回数は 100,000（本番の Workers の WebCrypto が受ける上限）。保存した回数が今の回数より少ない行は、ログインの成功時に今の回数で書き直す（`password_hash` と `updated_at`。読んだ値と同じ行だけに当てるので、並行したログインやパスワードの変更を上書きしない）。
- 照合は保存した回数で1回回し、鍵を `crypto.subtle.timingSafeEqual` で比べる。無いメールアドレスと形の合わない入力でも、決まったダミーの値で今の回数を1回回し、所要時間でメールアドレスの有無を見分けさせない。
- 行を作る（パスワードを決める）入口は、招待の URL からだけで、#257 以降で作る。今は seed の行だけ。
- 解約した組織のデータを消す SQL は、この表を消さない（`organizations` の節）。

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

ログイン（OAuth の手段とパスワード）、画面のエラーの送信（`POST /api/client-errors`）、手動の同期、招待（GitHub に問い合わせる `invitee-resolve` と `invitation-create`。`invitation-create` は GitHub に問い合わせない Google の招待も同じ枠で数える）、完成の定義の変更（`workspace-dod-update`。10 万字の本文を書く）、コメントの作成と編集（`comment-create`、`comment-update`。10 万字の本文を何件でも足せる。どれも 10 分に 30 回）のレート制限。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| key | TEXT | PK | `login:<IP>`（ログインの開始と戻り先。`CF-Connecting-IP`。IPv6 は上位 64 ビットに丸めた `login:2001:db8:1:2::/64` と、上位 48 ビットの `login48:2001:db8:1::/48` の2つ。IPv4 を写した IPv6 は IPv4 に直す。解釈できない値と IP の無いリクエストは `login:unknown`）、`login:global`（ログインの開始の全体の枠）、`client-error:<IP>`（画面のエラーの送信。IP の丸め方はログインと同じで、IPv6 は `client-error:<…>::/64` と `client-error48:<…>::/48`、解釈できない値は `client-error:unknown`）、`client-error:global`（画面のエラーの送信の全体の枠）、`operation:<操作の名前>:<アカウントの ID>`（操作の定義の `rateLimit`）、`password:<IP>`（パスワードのログイン。IP の丸め方はログインと同じで、IPv6 は `password:<…>::/64` と `password48:<…>::/48`、解釈できない値は `password:unknown`）、`password-email:<そろえたメールアドレスの SHA-256 の16進>`（パスワードのログインの、メールアドレスごとの枠。メールアドレスそのものは持たない） |
| window_start_at | TEXT | NOT NULL | 窓の最初の呼び出しの日時 |
| count | INTEGER | NOT NULL | 窓の中の呼び出しの数。操作の定義の枠は、上限を超えた呼び出しも数える。ログインと画面のエラーの送信の枠は、覗いた時点で上限に届いていれば数えない（覗いた後に並行した呼び出しは、上限を少し超えて数えることがある） |

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
- 画面のエラーの送信（`POST /api/client-errors`。ログイン前も受ける）は、ログインの開始と同じ順と覗き方で、キーを分けて数える。10分に、同じ IP（IPv6 は /64）から20回、IPv6 の /48 は40回、全体の枠 `client-error:global` は300回まで。どれも Workers Logs に1行を出す数の上限で、全体の枠で1日の行を最悪で約4万行に抑える。全体の枠を埋められると、その10分は他の人の画面のエラーが残らない（ログインの枠とは別なので、ログインは止まらない）。
- 数えるのは、利用者が始めた画面の移動の開始と、`state` の行を使い切れた戻りだけ。開始は、`Sec-Fetch-Mode` が `navigate`、`Sec-Fetch-Dest` が `document`、`Sec-Fetch-Site` が `same-origin` か `none` で、`Sec-Purpose` に prefetch と prerender を含まないもの。どのヘッダーも、送らない古いブラウザは通す。ほかのサイトが `<img>`、`fetch()`、`<iframe>`、リンクの移動、先読みで読ませても、被害者の枠は減らず、`oauth_states` の行もできない。
- 残る限界: `Sec-Fetch` を送らない古いブラウザには、`<img>` で読ませる攻撃が通る。同じ IP を共有する人（同じオフィス）が、意図して枠を使い切ることは止められない。IP を多く持つ人は、IPv4 なら約10個（窓の境目をまたげば約5個）、IPv6 なら約5個（窓の境目をまたげば約3個）の /48 で全体の枠を使い切り、新しいログインを止められる。止まるのは新しいログインだけで、ログイン済みの人はセッションの期限まで使い続ける。覗いて断った呼び出しにも、Workers のリクエストと D1 の読み出しの料金はかかる。行の無い `state` を Cookie と合わせて送る戻り先も、枠では止まらず `oauth_states` の `DELETE` まで届く（消す行が無いので書き込みは0行）。リクエストの量そのものを止めるのは、ドメインを取った後の WAF の役目。
- パスワードのログイン（`POST /api/auth/password/login`）は、OAuth のログインと別のキーで数える。10分に、同じ IP（IPv6 は /64）から30回、IPv6 の /48 は60回、同じメールアドレス（そろえた形の SHA-256）に向けて10回まで。順はログインの IP の枠と同じく、全部の枠を覗いて上限に届いた枠があれば何も書かずに断り、通ったら /48、/64（か IPv4）、メールアドレスの順に数える。照合の前に、成功も含めて数え、メールアドレスの登録の有無に依らず数える。そろえられないメールアドレスは IP の枠だけを数える。全体の枠は置かない（未ログインの人が書かせられる行は IP の枠で抑えられ、1回の照合の CPU は約 12ms）。アカウントは締め出さず、窓が過ぎれば通る。値は `src/server/auth/rate-limit.ts` の `PASSWORD_LOGIN_RATE_LIMITS`。
- 手動の同期の「接続ごとに5分に1回」は、この表ではなく `connections.last_manual_sync_at` で判定する。
- `window_start_at <= 定期処理の基準の時刻 - 最長の窓` の行を、毎分の定期処理で消す（「期限切れの行の掃除」）。最長の窓は、ログイン（パスワードを含む）と画面のエラーの送信の枠（`src/server/auth/rate-limit.ts`）と操作の定義の `rateLimit` の窓のうち最も長いもの。短い窓の枠を過ぎていても、最長の窓の内にある行は残す。最長の窓に入らない窓の枠は、`consumeRateLimit` が例外にする。

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
| vocabulary | TEXT | NOT NULL、`game` か `scrum`、既定 `game` | ワークスペースの外の言葉づかい。組織を作る文（`insertOrganization`）が `scrum` を入れる（列の既定は、マイグレーションを足すだけにするため `game` のまま）。管理者が組織の管理の画面（`organization-settings-update`）で変え、変えると `updated_at` と `change_logs` が動く（「書き込みの単位」の組織の設定の変更） |
| theme | TEXT | NOT NULL、`simple`、`simple_light`、`simple_dark`、`medieval`、`modern` のどれか、既定 `simple` | 組織の既定のテーマ。`simple` は OS の明暗に合わせる。管理者が組織の管理の画面（`organization-settings-update`）で変え、変えると `updated_at` と `change_logs` が動く |
| suspended_at | TEXT | | 停止した日時。入っていれば誰も入れず、定期処理も止める |
| purge_on | TEXT | | 解約で停止したときの、データを消す予定日（解約で停止した日か、停止中に解約へ切り替えた日の30日後）。一時的な停止では空 |
| member_limit | INTEGER | NOT NULL、既定 15、`CHECK (member_limit > 0)` | 人数の上限。運用者が決める（`organization-quota-update`。「書き込みの単位」の人数と添付ファイルの上限の変更） |
| attachment_quota_bytes | INTEGER | NOT NULL、既定 32212254720 | 添付ファイルの合計の上限（既定 30GB）。運用者が決める（同じ操作） |
| attachment_quota_warned_at | TEXT | | 合計が上限の80%を超えたと管理者に通知した日時。合計が80%を下回るか、上限を上げたら空に戻す |
| stores_source_payload | INTEGER | NOT NULL、既定 0 | 取り込み元の応答（`task_source_payloads`）を保存するか。管理者が組織の設定で選ぶ |
| created_by_operator | TEXT | NOT NULL | 作った運用者のログインの ID（`github:12345`、`google:<sub>` の形） |
| created_at、updated_at | TEXT | NOT NULL | |

- 運用者の画面で作る。作るときに最初の管理者の `users` を同じバッチで入れる（アカウントがまだなければ、`account_id` が空の `users` の行で待つ。下の `users` を参照）。
- アプリが使う名前（`api`、`login`、`operator` など）を slug にできないことは、アプリが検査する。予約した名前の一覧は `src/shared/organization-slug.ts` に持ち、画面の最上段のルートを足したら合わせて足す（`scripts/organization-slug.test.ts` が照合する）。
- 続けて書く `users` と `change_logs` の入口は、組織の作成の関数（`src/server/db/create-organization.ts`）が作る。入口を作れるのは `organizations` に挿入した組織の ID だけで、任意の組織の ID から入口を作る関数は `db/` の外へ出さない。既にある組織の中の表に運用者が書くものは、組織の中の入口を渡さず、決まった書き込みだけをする関数にする。停止、再開、停止の理由の切り替えの `change_logs` は、履歴を1行足すだけの関数 `appendOperatorChangeLog`（`src/server/db/operator-change-log.ts`）、管理者の指名し直しの `users` と `change_logs` は、指名し直すだけの関数 `reassignOrganizationAdmin`（`src/server/db/operator-reassign-admin.ts`。書き方は「書き込みの単位」の管理者の指名し直し）。組織を確かめた結果はこれらの関数の中で作って外へ出さず、停止中の組織にも書ける。組織の ID は、呼び出し側が共通の表の `organizations` から読んだ値を渡し、行が無い ID は `change_logs.organization_id` の外部キーが断る。これらの関数を import できるのは運用者の道具（`operator-tools.ts` の `appendChangeLog` と `reassignAdmin`。`operator` の列に運用者のログインの ID を入れる）だけで、ESLint の入口を守る規則（`eslint.config.db-entry.js`）が止める。同時に作られて `slug` の UNIQUE に当たったときは、`slug` の行が今あるかを読み直し、重なりとして 409 を返す。
- 人数は保存せず、招待のたびと、メンバーの画面と運用者の組織の一覧を開くたびに数える。対象は、無効にしていない管理者と、いずれかのワークスペースに今所属しているか承諾待ちの招待を持つ人（まだアカウントのない人への招待を含む）で、同じ人は1人とする。招待のうち、閉じたワークスペースへの招待と、同じ組織で無効にされた人（同じ `(login_provider, login_subject)`）への招待は数えない。人数が `member_limit` 以上なら、まだ数えられていない人の招待と、管理者への指名（`user-admin-update`。「書き込みの単位」の管理者の指名と解除）を断る。運用者の管理者の指名し直しは、組織の作成の最初の管理者と同じく上限を見ない。すでに数えられている人（同じ `(login_provider, login_subject)` の、無効でない管理者、いずれかのワークスペースに今所属している人、数えられる承諾待ちの招待を持つ人）は、上限でも招待できる。数えるのは GitHub に問い合わせた後で、数えてから書くまでの間に同時に招待されたときはそのまま認める（超えるのは同時に送った招待の数まで）。
- 人数を数える関数は `src/server/db/seats.ts` の1つ（`seatHoldersIn`）に置く。組織の ID の束を受け、組織ごとの数える人（1人の見分け方 `personKey` の集合）を返す。どの文も `organization_id IN (...)` で組織に絞り、組織の ID は束縛の上限で区切る。招待の上限の検査と member-list の `seats` は、確かめた組織の入口だけを受ける `seatHoldersOf` から1つの組織で呼び、運用者の組織の一覧（`users` の節の、運用者の組織の一覧の集計の箇条書き）は組織をまたぐ入口ごとに組織の ID の束で呼ぶ。数え方は同じなので、同じ組織なら同じ数になる。
- 解約した組織は、`purge_on` を過ぎたら運用の手順でこの組織の行をすべて消し、R2 の `<organization_id>/` で始まるファイルも消す。再開したら `suspended_at` と `purge_on` を空に戻す。`purge_on` は、解約で停止した日時の UTC の日付の30日後（`YYYY-MM-DD`）。停止中に解約へ切り替えたときは、切り替えた日時の UTC の日付の30日後。`purge_on` が今日（UTC の日付）より前の組織は、再開も一時的な停止への切り替えもできない（409 の `purge_due`。消す SQL のガードと同じ境目で、予定日の当日まではできる。「書き込みの単位」の組織の停止と再開）。運用者の組織の一覧は、この組織に `purge_due` を真で返す。
- 消す手順は `docs/operations.md` の「解約した組織のデータを消す」。消す SQL は `scripts/purge-organization.ts` が1行に1文で書き出し（組み立ては `scripts/purge-organization-sql.ts`）、運用者が1文ずつ流して、組織の中のすべての表と最後に `organizations` の行を、外部キーの子から順に消す。どの文も、その組織が解約で停止していて `purge_on` を過ぎている（`purge_on < date('now')`、UTC の日付）ことを条件にするので、一時的な停止と予定日の当日までの組織では何も消えない。共通の表のうち `accounts`、`account_logins`、`password_credentials`、`sessions`、`oauth_states`、`rate_limits` は消さない（アカウントをどうするかは #407。セッションは、入れる組織を失った人の次のリクエストか期限切れで消える）。この SQL は条件の確かめに共通の表の `organizations` を組織の中の表の文から引く（「データベースの分け方」の例外で、DB が1つの今だけ使える）。組織ごとに DB を分けるときは、確かめを共通の DB で先に行う形に直す。

### users

組織ごとの人。アカウントと組織の組に1行。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| organization_id | TEXT | NOT NULL、FK organizations | |
| account_id | TEXT | FK accounts | アカウントができる前（管理者の指名で待つ間）は空 |
| login_provider | TEXT | NOT NULL | 突き合わせに使うログインの手段。`account_logins` と同じ値 |
| login_subject | TEXT | | 突き合わせに使う手段の中の不変の ID。`account_logins` と同じ値。Google の指名で `sub` が分かる前は空 |
| login_email | TEXT | | `sub` が分かる前に突き合わせるメールアドレス（そろえ方は下の「メールアドレスで待つ指名と招待」）。メールアドレスで待つ手段（`google` と `password`）の指名で使い、`sub` を埋めたら空にする。今作るのは `google` の行だけで、`password` の待つ行は #257 以降で作る |
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

- 表の制約: `CHECK ((login_subject IS NULL) = (login_email IS NOT NULL))`、`CHECK ((login_email IS NULL) = (claim_token_hash IS NULL) AND (login_email IS NULL) = (claim_expires_at IS NULL))`、`CHECK (login_email IS NULL OR (login_provider IN ('google', 'password') AND login_email = lower(trim(login_email))))`。
- 一意: `(organization_id, login_provider, login_subject)`。`login_subject` が空の行どうしは、SQLite では NULL が重ならないので当たらない。待っている指名は、運用者が指名し直すと消すので、メールアドレスの一意は持たない。
- 一意: `(organization_id, account_id) WHERE account_id IS NOT NULL`。アカウントと組織の組に1行。1つのアカウントに複数のログインの手段を結んだ後も、同じ人が1つの組織に2行持たないようにする。
- 索引: `(login_provider, login_subject)`。ログインのときに入れる組織を引く。
- 表示するログイン名とアバターは `account_logins` から引く。
- 運用者が組織を作るときは、最初の管理者をログインの ID に解決し（GitHub はユーザー名からユーザー ID へ。Google は解決せず、`login_email` と招待の URL の秘密で待つ）、`is_admin = 1` の行を入れる。GitHub の `name` は解決したユーザー名。GitHub のユーザー名が指すのは個人のアカウントだけで、組織のアカウント（応答の `type` が `Organization`）は断る。`account_id` は、指名のときに共通の DB の `account_logins` を（ログインの手段と ID で）引き、当たればその書き込みで埋める。既にアカウントのある人（別の組織で使っている人）が、ログインし直さずに新しい組織へ入れるため。当たらなければ空で待ち、その人が初めてログインしたときに埋める（`linkLoginToAccount`）。`account_logins` は共通の表なので、読むのは共通の入口から、`users` の書き込みとは別の文で行う。引いて当たらなかった人が、`users` を書くまでの間に初めてログインを終えたときは、`users` を書いた後に `account_logins` を引き直し、当たれば `linkLoginToAccount` で結ぶ（`account_id` が空の行だけに当たるので、何度流しても同じ結果）。指名の `change_logs` に結んだ `account_id` を残すのは、指名の書き込みと同時に結んだとき（`account_logins` に当たったとき）だけ。書いた後の結び直しは、`users.account_id` だけを書く。結び直しが失敗しても組織の作成は成功として返し、`organizations` と `users` は残る。ログには組織の ID と例外の名前だけを出し、次のログインで結ばれる。
- 運用者による管理者の指名し直し（`organization-admin-reassign`、#217）も、指し方、`account_id` の埋め方、書いた後の結び直しは組織の作成と同じ。どの組織にも（管理者の状態が `active` の組織にも、停止中の組織にも）指名できる。人数の上限は見ない。同じバッチで、その組織の `account_id` が空の行（GitHub でまだログインしていない指名と、Google で待つ行。期限切れも含む）を前の指名として消す。`account_id` が空の行は運用者の指名でしか入らない（招待の承諾はアカウントのある人が書く）。消した Google の待つ行の招待の URL は、待つ行が無くなるので使えなくなる。前の管理者（アカウントに結ばれた行）の印は外さない（外すのは組織の管理者の操作）。指名する人自身の行は消さない。指名する人が同じ組織に既にいるときは、新しい行を入れずにその行を管理者にする（`is_admin = 1`、`disabled_at` を空。無効にされていれば戻す）。既にいる行は、GitHub では同じ `(github, ID)` の行と、既にアカウントのある人ならそのアカウントに結ばれた行（別の手段でこの組織に入っている同じ人）で、アカウントに結ばれた行を先に選ぶ。既にいる行がまだアカウントに結ばれておらず、指名する人が既にアカウントを持つ（組織の作成の書いた後の結び直しが失敗したときなど）ときは、その行の `account_id` を埋め、ログインし直さずに入れるようにする。既に有効な管理者で、結ぶアカウントも無ければ `users` は書かない。前の指名は、読んだ行でなく書く時点のその組織の `account_id` が空の行に当てて消す（並行した2回の指名し直しで、先の指名が残らないため）。ワークスペースの所属（`memberships`）を持つ前の指名は消さず残す（組織の管理者が、まだログインしていない指名の行をワークスペースの最初のリーダーに選べ、`memberships.user_id` がその行を指すため）。代わりに管理者の印を外し（`is_admin = 0`）、管理者の解除の記録（`user` の `update`、`{"is_admin": [1, 0]}`）を運用者の操作として残す。印を外さないと、取り消したつもりの人が後でログインすると管理者として入れてしまうため。取り消しの記録（`delete`）は作らず、消した数にも数えない。GitHub で解決した人が操作する運用者自身（運用者のアカウントに結んだ GitHub のログインのどれか。結んだログインが引けなければ運用者のログインの ID）なら、GitHub に問い合わせた後、書く前に 400（`invalid_input`、`nominee_is_operator`）で断り、前の指名も消さない。Google のメールアドレスは運用者のログインと突き合わせられないので止めない。この判定は誤操作を防ぐためのもので、運用者が意図して入る道（自分の Google のメールアドレス、結んでいない別の GitHub のアカウント）は残る（`docs/requirements.md` の「組織と運用者」、`docs/operations.md` の「管理者の指名し直し」）。組織の作成の最初の管理者は運用者自身でもよい。Google はメールアドレスから `sub` を引けないので、いつも新しい待つ行を入れ、結ぶときに同じ `sub` の行へまとめる処理（「メールアドレスで待つ指名と招待」の 6）に任せる。
- 運用者の組織の一覧は、組織ごとの管理者の状態を持つ。`none` は無効でない管理者（`is_admin = 1`）の行が無い組織、`pending` はその行があるが、どれも `account_id` が空の組織（指名した人がまだログインしていない）、`expired` は `pending` のうち、空の行がどれも Google の指名で待つ行で、招待の URL の期限が過ぎている組織、`active` はそれ以外。`login_subject` が空の行（Google の指名で待つ行）は、管理者の数や最後の管理者の検査には数えないが、ここでは `account_id` が空の管理者の行として `pending` に数える。運用者の画面が「ログイン待ち」と出すため。組織をまたいで読む関数に置き、一覧の組織の ID を `organization_id IN (...)` で渡して、1回の問い合わせで数える（束縛の上限で区切る）。人の名前や ID は返さない。
- 運用者の組織の一覧は、組織ごとの集計も持つ（`list-organizations` の `seats`、`workspace_count`、`task_count`、`attachment_quota_bytes`、`last_used_at`）。数と日時だけで、人の名前、ID、ログインの ID、メールアドレス、ワークスペースやタスクの名前は返さない。
  - 人数（`seats.used`）: `organizations` の「人数」と同じ関数（`src/server/db/seats.ts`）で数える。上限（`seats.limit`）は `member_limit`。画面は `used >= limit` で「上限に達した」の印を出す
  - ワークスペースの数（`workspace_count`）: 閉じていない（`closed_at` が空）ワークスペース
  - タスクの数（`task_count`）: 削除していない（`deleted_at` が空）タスク。受信箱、アーカイブ、閉じたワークスペースの分も含める。`workspaces` と結んで `workspaces.organization_id` で絞り、組織ごとに `GROUP BY` する
  - 最後に使われた日時（`last_used_at`）: その組織の `users.last_seen_at` の最大。無効にした人も含める。だれも使っていなければ `null`
  - 添付ファイルの上限（`attachment_quota_bytes`）: `organizations` の列のまま返す。使った量の合計は出さない（#68 で足す）
  - 読み方: 共通の表（`organizations`）を共通の入口で読んだ後、組織の中の表を組織をまたぐ入口ごとに、組織の ID の束（`organization_id IN (...)`、束縛の上限で区切る）で読む。共通の表と組織の中の表を1つの文や1回の `batch()` に混ぜない。区切りごとに、人数の2文と、ワークスペースの数、タスクの数、最後に使われた日時の3文を、それぞれ1回の `batch()` で読む。DB を複数にしたときは、人数は DB ごとの集合を合わせ、数は足し、日時は新しい方を取る。初版の組織の数（数十まで）では、一覧を件数で区切らず、全部の組織を1回で数える。人数の文は組織ごとの所属と承諾待ちの招待をすべて読み、タスクの数は削除していないタスクを索引（`tasks_workspace_tray`）の上で全部数えるので、読む量は組織の数とタスクの数に比例する。見直す目安: 組織の数が数十を超えたとき、または運用の画面の一覧の応答が遅くなった（D1 の読んだ行の数が増えた）とき。そのときは、一覧を件数で区切って区切りの組織だけを数えるか、集計を保存して定期処理で書き直す形に変える
  - DB を分けるとき: 組織をまたいで数える `organizationUsageIn`（`db/cross-organization.ts`）と、人数を数える `seatHoldersIn`（`db/seats.ts`）は、入口の一覧（`allOrganizationDatabases()` の DB ごと）を受けて回る。DB を分けるときは、この2つと管理者の状態（`adminStatusesIn`）を、組織の ID をその組織の DB の入口だけに渡す形に直す（今は全部の DB に全部の組織の ID を渡し、行の無い DB は何も返さない）
- `login_subject` が空の行（Google の指名で待つ行）は、管理者の数にも最後の管理者の検査にも数えない。
- 最後の管理者を解除できないことはアプリが検査する。解除と無効化の文の条件に「同じ組織に、ほかに無効でなく `login_subject` のある管理者がいる」を `EXISTS` で入れる（「書き込みの単位」の管理者の指名と解除、ユーザーの無効化）。文には、呼んだ人が今も無効でない管理者である `EXISTS` も入れる。D1 は書き込みを1つずつ流すので、同時の解除で管理者が0人にならない。2人が同時にお互いを解除したときは、後の文を呼んだ人の `EXISTS` が止め（先の文で呼んだ人が解除されている）、2人が同時にそれぞれ自分を解除したときは、後の文をほかの管理者の `EXISTS` が止める（先の文で、ほかにいた管理者が解除されている）。どちらも、読み直して相手がまだ管理者でほかにいなければ 409（`last_admin`）を返す。
- 組織の管理の画面のユーザーの一覧（`user-list`、管理者だけ、読み取り）は、同じ組織の `login_subject` のある行を、有効な人（`disabled_at` が空）を先に、無効の人を後ろに、それぞれ `name`、`id` の順に、件数で区切らずに全部返す。件数はその組織の `users` の行数で、抜けた人と無効の人の行も消さずに残るので `member_limit` では抑えられない（想定は数十〜数百）。それでも区切らないのは、読むのが索引（`users_organization_login` の先頭の `organization_id`）の上の1組織の行だけで、画面が全員を1つの表で見て指名と無効化を選ぶため。見直す目安は、組織の行が千を超えたとき。各行は ID、名前、アバター（共通の表なので組織の道具の `avatarsOf` で別に引く）、管理者か、`disabled_at`、閉じていないワークスペースの今の所属の数、`last_seen_at`。
- 無効にする（`disabled_at` を入れる）と、その人は組織に入れない。同じ `batch()` で、管理者なら `is_admin` を 0 にし（有効に戻した時点で、招待なしに管理者として入れないため）、その人のログイン（`login_provider`、`login_subject`）への承諾待ちの招待を組織のすべてのワークスペースで取り消し（有効に戻した後に、招待し直さずに承諾できないため）、閉じたものも含めたすべてのワークスペースの所属を終えて担当を外す（開き直したときに、無効だった人が所属と担当に残らないため）。有効に戻すと `disabled_at` を空にし、所属も管理者の指名も戻らない。同じ `batch()` で、その人のログインへの承諾待ちの招待のうち、無効にした日時より前に作ったものを取り消す（Google のメールアドレスで待つ招待は無効化のときには当たらず、無効の間に本人が招待の URL から結ぶとその人のログインになるため。無効の間に作った招待は、管理者が招待し直したものなので残す）。限界: 結ばれないまま残った Google のメールアドレスの招待は、`users` にメールアドレスが残らないので、その人への招待と見分けられず取り消せない。有効に戻した後に本人がその URL から結べば、招待し直さずに承諾できる。入るには招待し直すか、管理者に指名し直す（所属を残すと、一覧と担当の候補と人数で、無効の人を除く条件があちこちに要るため）。自分は無効にできない。
- 招待された人は、承諾した時点でその組織の行を作る（すでにあれば使う）。招待の時点では `invitations` にログインの ID（Google では `sub` が分かるまでメールアドレス）だけを持つ。

### organization_holidays

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| organization_id | TEXT | PK、FK organizations | |
| holiday_on | TEXT | PK、`CHECK (holiday_on IS date(holiday_on) AND holiday_on BETWEEN '2000-01-01' AND '2099-12-31')` | 2000〜2099 年の日付だけ |
| name | TEXT | `CHECK (name IS NULL OR length(name) BETWEEN 1 AND 40)` | 「元日」など。無くてよい（空は NULL で、空の文字列は持たない） |
| created_by | TEXT | NOT NULL、FK users | |
| created_at | TEXT | NOT NULL | |

- 作ったのは `migrations/0004_add_organization_holidays.sql`（#194）。積載量（#66）が、全員の稼働しない日として読む。
- 索引: `(created_by)`。外部キーの検査。組織ごとの一覧は主キーの先頭の `organization_id` で引く。
- 操作はどれも管理者だけ（`organization-holiday-list`、`organization-holiday-add`、`organization-holiday-delete`）。どの文も `organization_id` を確かめた組織で絞る。一覧は日付の古い順に全件を返す。
- 日付は 2000〜2099 年だけ。貼り付けた一覧の年の打ち間違い（1926、2206 など）を、暦にある日付のまま入れないため。画面の解析は理由 `out_of_range` で示し、API は 400 で断り、DB の CHECK も当たる。`YYYY-MM-DD` の形どうしなら文字の順が日付の順なので、`BETWEEN` で比べる。
- 名前は前後の空白を除いて 40 字まで（コードポイントで数える）。見えない文字（制御文字、ゼロ幅のスペースなど）を含む名前は断る。決まりは `src/shared/text-rules.ts` の `shortTextProblem` と同じで、空だけは通して NULL にする。画面の貼り付けの解析（`src/shared/holiday.ts`）と API の検証が同じ判定を使う。
- 一括の登録は `INSERT ... ON CONFLICT DO NOTHING ... RETURNING holiday_on` で行う。登録済みの日付は飛ばし、名前も書き換えない。入った件数は `RETURNING` の行で数え、送った件数との差を登録済みとして返す。1回に送れるのは 100 件まで。D1 の1文の束縛は 100 個までなので、5列の行を 20 件ずつの文に分け、全部を1回の `batch()` で送る（途中で落ちれば何も入らない）。同じ送信の中で同じ日付が重なれば 400 で断る。
- 削除は組織と日付で1行を消す。消えた行が無ければ 404 の `not_found`。確かめのダイアログは挟まない（入れ直せるため）。
- 休日の登録と削除は `change_logs` に書かない。組織の変更の履歴（#193）が扱うのは、権限、組織の設定、運用者の操作で、休日は積載量の入力にすぎないため。

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
| vocabulary | TEXT | NOT NULL、`game` か `scrum`、既定 `game` | 言葉づかい。作成の入力で必須なので、列の既定は使われない |
| definition_of_done_md | TEXT | 10 万字まで | 完成の定義（Markdown）。空なら `NULL` で、出さない。書くのは `workspace-dod-update`（下の「書き込みの単位」の「完成の定義の変更」）、読むのは `workspace` の操作 |
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
- メンバーの一覧（`member-list`）も件数に上限を付けない。1つのワークスペースの所属と承諾待ちの招待は数十人の想定で、1回の応答に収まる。返す人は、今所属し（`memberships.left_at` が空）、無効でなく（`users.disabled_at` が空）、`users.login_subject` のある人。並びはリーダーが先、続いて参加日、名前、ID。各人に、ログインの手段の側のアバターの画像の URL（`account_logins.avatar_url`）を `avatar_url` で添える。共通の表なので、組織の道具（`avatarsOf`）を全員の ID で1回呼んで引き（道具の中の問い合わせは `users` と `account_logins` に分かれる）、アカウントに結ばれる前の人とアバターの無い人は `null`。アバターは一般のメンバーにも返す（同じワークスペースの人の顔が見えるようにするため。GitHub のアバターの URL は数字のユーザー ID を含むので、そこから GitHub のアカウントが分かるが、GitHub の側で公開されている情報として受け入れる。2026-10-26 に決めた）。担当の候補を読むタスクの引き出しと起票のダイアログも同じ操作を呼び、使わないアバターの問い合わせも走るが、数十人の想定なので操作を分けない。承諾待ちの招待（`status = 'pending'`。期限の過ぎた Google の招待も含め、切れたかを `expired` で返す）は、リーダーと管理者（所属していない管理者を含む）にだけ返し、一般のメンバーには `null` を返す。招待した日と期限の日は、`invitations.created_at` と `claim_expires_at` をワークスペースのタイムゾーンの日付にした値。組織の人数（`organizations` の「人数」）と上限（`member_limit`）も、招待と同じくリーダーと管理者にだけ `seats` で返し、一般のメンバーには `null` を返す。

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
| login_email | TEXT | | `sub` が分かる前に突き合わせるメールアドレス（そろえ方は下の「メールアドレスで待つ指名と招待」）。メールアドレスで待つ手段（`google` と `password`）の招待で使い、`sub` を埋めたら空にする。今作るのは `google` の行だけで、`password` の待つ行は #257 以降で作る |
| claim_token_hash | TEXT | UNIQUE | 招待の URL の秘密の SHA-256。`sub` を埋めたら空にする |
| claim_expires_at | TEXT | | 招待の URL の期限（作ってから14日）。`sub` を埋めたら空にする |
| login_name | TEXT | NOT NULL | 招待のときの名前（表示用）。GitHub ではユーザー名、Google ではメールアドレス。メンバーの画面の承諾待ちの招待（`member-list`）に、リーダーと管理者にだけ出す。Google の招待ではメールアドレスもそのまま出る |
| role | TEXT | NOT NULL、`leader` か `member` | |
| invited_by | TEXT | NOT NULL、FK users | |
| status | TEXT | NOT NULL、`pending`、`accepted`、`declined`、`revoked` | |
| responded_at | TEXT | | 承諾、辞退、取り消しの日時 |
| created_at | TEXT | NOT NULL | |

- 表の制約: `users` と同じ3つの CHECK（`login_subject` と `login_email` のどちらか一方、`login_email` と `claim_token_hash` と `claim_expires_at` はそろって入るか空、`login_email` は `google` と `password` の行だけで、そろえた形）。
- 一意: `(workspace_id, login_provider, login_subject) WHERE status = 'pending'`、`(workspace_id, login_provider, login_email) WHERE status = 'pending' AND login_subject IS NULL`。
- 索引: `(login_provider, login_subject) WHERE status = 'pending'`。ログインの可否と招待の一覧に使う。
- 索引: `(invited_by)`。外部キーの検査。
- メンバーの画面の承諾待ちの招待（`member-list`）は、`status = 'pending'` の行を、期限の過ぎたものも含めて `created_at`、`id` の順に、リーダーと管理者（所属していない管理者を含む）にだけ返す。一般のメンバーには返さない。
- 今の所属がある人は招待できないことを、アプリが検査する。Google の招待では、メールアドレスを `sub` に結べないため、所属の検査は `sub` を埋めるときに行う（下の「メールアドレスで待つ指名と招待」）。
- Google の招待（`invitation-create` の `provider: google`）は、リーダーと管理者がメールアドレスで作る。そろえたメールアドレスを `login_email` と `login_name` に入れ、`login_subject` を空にし、招待の URL の秘密のハッシュと期限（14日）を持つ。秘密は応答の本文（`invite` の `url` と `expires_at`）にだけ入れる。所属と承諾待ちの検査はしない（`sub` が分からないため）。書くものと条件は「書き込みの単位」の招待（Google）。
- Google で招待し直すときは、同じワークスペースの同じ `login_email` の承諾待ちの招待（`login_subject` が空のもの。期限切れも含む）を同じバッチで `revoked` にし、取り消しの記録を残す。古い招待の URL は、招待が承諾待ちでなくなるので結べない。`sub` を埋めた後の招待は、メールアドレスを持たないので取り消さない（同じ `sub` の承諾待ちが2つになれば、結ぶときに待っていた招待を取り消す。「メールアドレスで待つ指名と招待」の 6）。
- 届いた招待の一覧（`invitation-list`、権限 `invitee`、読み取り）は、招待された人が組織の slug の下で読む。返すのは、この組織のワークスペースへの `status = 'pending'` の招待のうち、`(login_provider, login_subject)` が呼んだ人のアカウントに結んだログインのどれかに当たるもの。ログインは共通の表（`account_logins`）なので、組織の道具の `myLogins()` で別の問い合わせとして引き、招待の文には値として渡す。招待は `workspaces` を結合して `workspaces.organization_id` で絞る。Google の招待で `login_subject` が空のもの（招待の URL から結ぶ前）は当たらない。閉じたワークスペースへの招待も出し、`closed` で示す（承諾できず、辞退はできる）。各招待の ID、ワークスペースの ID と名前、ロール、招待した人の今の名前（組織で絞った `users`）、招待した日（`created_at` をワークスペースのタイムゾーンの日付にした値）を、`created_at`、`id` の順に返す。件数の上限は付けない。承諾待ちの招待はワークスペースとログインごとに1件（上の一意）なので、1人に返る件数は組織のワークスペースの数（数十の想定）とログインの数で抑えられる。組織の名前、言葉づかい、既定のテーマも添える（招待だけの人は `organization` の操作を読めないので、画面がこれで言葉とテーマを当てる）。
- 承諾（`invitation-accept`）と辞退（`invitation-decline`）は、どちらも権限 `invitee` で、入力は招待の ID だけ。書くものと条件は「書き込みの単位」の招待の承諾と招待の辞退。前に抜けた人が承諾すると、同じ `users` の行に新しい所属の行を足す。

### メールアドレスで待つ指名と招待

メールアドレスで指す手段（`login_email` を持てる `google` と `password`）では、指名と招待のときに手段の中の ID が分からない。Google の人は、ログインするまで `sub` が分からない。パスワードの人は、招待の URL からパスワードを決めるまで資格情報（`password_credentials`）が無い。以下は今の Google の流れで、手段 `password` の待つ行（招待の URL からパスワードを決めて `login_subject` を埋める流れ）は #257 以降で作り、ここに書き足す。そのため、`users`（管理者の指名）と `invitations`（招待）を `login_subject` を空にした行で作り、招待の URL から本人がログインしたときに `sub` を埋める。

招待の URL を作るとき。

- 秘密は 32 バイトの乱数を base64url（43文字）にし、URL のフラグメント（`/invite#<秘密>`）にだけ入れる。フラグメントはサーバーに届かず、Referer にも付かないので、ログに残らない。DB には SHA-256 の `claim_token_hash`（`sessions.token_hash` と同じく小文字の16進）だけを持つ。
- 招待と指名を作る API は、秘密を応答の本文にだけ入れ、`Cache-Control: no-store` を付ける。ヘッダーと `change_logs` には入れない。URL は作った直後の画面にだけ出す。
- メールアドレスは、前後の空白を除き、ASCII の英大文字だけを小文字に直してから `login_email` に入れる。ASCII の外の文字を含むものは受け付けない。ドットや `+` 以降は読み替えない。招待と指名の入力と、ID トークンの `email` の両方に、同じ1つの関数を通す。
- `claim_expires_at` は作ってから14日にする。

本人が招待の URL を開いたとき。

1. 画面は `location.hash` から秘密を読み、すぐ SvelteKit の `goto` の `replace` で URL を `/invite` に置き換える（履歴の項目を増やさない）。`goto` は非同期なので、移動を終えるまでの短い間は URL に秘密が残る。浅いルーティング（`shallow`）は元の URL を履歴の項目の state に残すので使わない。ボタンは URL から秘密が消えてから出し、消えなければ使えない旨を出す。読んだ秘密は、読み込み中の表示で画面が作り直されても使えるよう、文書の間だけ画面の module の変数に持ち、ほかの画面へ移るときとページを離れるときに消す。`/invite` の画面のヘッダーは `Referrer-Policy: no-referrer`。
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
- 操作は `column-list`（`member`、読み取り）、`column-create`、`column-update`（`name`）、`column-move`、`column-delete` で、後ろの4つは `leader`（管理者を含む）の書き込み（`src/shared/operations/column/`、処理は `src/server/operations/column.ts`）。一覧は削除していない列を `ORDER BY is_done, position, id` で返し（完了の列は最後で `name` は空。閉じたワークスペースでも読める）、各列に `task_count`（削除すると移り先へ移る、進行中と先のスプリントの未完了のタスクの数。完了の列は 0）を添える。画面（スプリントの画面の列の並びと設定）は完了の列の名前を、言葉づかいに合わせて辞書から出す。
  - `name` は前後の空白を除いて 1〜30 字（`workspaces.name` と同じ字数の数え方と断る文字。上限は `src/shared/column.ts` の `COLUMN_NAME_MAX_LENGTH`）。同じワークスペースの削除していない完了以外の列と同じ名前は 409（`conflict`、理由は `duplicate_name`。前後の空白を除いた後の完全一致で比べ、大文字と小文字、全角と半角は別の名前とみなす）。削除していない完了以外の列が 12 件（`COLUMNS_PER_WORKSPACE`）あれば足すのは 409（`conflict`、理由は `limit`）。理由の一覧は `src/shared/operations/column/column.ts` の `columnConflictReasons`（`duplicate_name`、`limit`、`last_column`、`done_column`、`target_required`、`target_invalid`、`changed`）。どちらも書く文の条件（足すのは `INSERT ... SELECT ... WHERE NOT EXISTS (同じ名前) AND (数) < 12`、名前の変更は同じ名前が無いことと読んだ名前のままであることを条件にした `UPDATE`）で守り、同時に足しても重複を作らず上限を超えない。足す位置は完了以外の列の末尾。
  - 完了の列は、足す、名前を直す、並べ替える、並べ替えの直前に指す対象に入らない。読む文も書く文も `is_done = 0` で絞るので、完了の列を指すと、無い列（別の組織、別のワークスペース、削除済みを含む）と同じ 404 になる。並べ替え（`column-move`）は `categories` の並べ替えと同じ決まり（`after_column_id`。`null` は先頭、省くと末尾、自分自身は 400 の `invalid_input`、同じ値の振り直しも同じ）で、完了の列は並びに入らない。並べ替えは `change_logs` に残さない。
  - 変更の履歴は `entity_type = 'workspace'`、`entity_id` はワークスペースの ID、`action = 'update'`（組織の変更の履歴の画面が出す `create`、`close`、`reopen` にしない）で、列の追加は `{"column": [null, {id, name}]}`、名前の変更は `{"column": [{id, name: 前}, {id, name: 後}]}`、削除は `{"column": [{id, name}, null]}`（タスクを移したときは `"target_column": [null, {id, name}]` も）。同じ `batch()` の中で、変えた文が行を書いたときだけ入れる（`previousStatementChanged`）。
  - 削除（`column-delete`）の入力は `column_id` と省ける `target_column_id`。完了の列は 409（`done_column`）、完了以外で最後の1つは 409（`last_column`）、移すタスクがあるのに `target_column_id` が無ければ 409（`target_required`）、移し先が削除する列自身か完了の列なら 409（`target_invalid`）、削除する列と移し先が無ければ（別の組織、別のワークスペース、削除済みを含む）404。移すのは、進行中と先のスプリント（削除していない `planned` と `active`）の、削除していない未完了のタスクで、移し先の列のそのスプリントでの末尾へ、元の列の中の順（`column_position`、`id`）を保って置く。終了したスプリントのカードは変えず、削除した列を指したまま残る（終了したスプリントの中身は変えない。終了したスプリントのカードを読む画面と操作は今無い。読むようになったら、削除した列も名前を出す）。移したタスクごとに `change_logs`（`entity_type = 'task'`、`action = 'update'`、`{"column": [{id, name}, {id, name}]}`。`task-column-move` と同じ形）を書く。書き方は「書き込みの単位」の「列の削除」。
  - 取り込み元の状態から列への対応（`connection_status_mappings`）は表がまだ無いので、列の削除は触らない。表を使い始める #67 で、列の削除が対応を外してその状態を先頭の列に置く文を、同じ `batch()` に足す。

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
- 操作は `category-create`、`category-update`（`name`、`is_billed_monthly`）、`category-move`、`category-delete` で、どれも `leader`（管理者を含む）の書き込み。一覧は `category-repository-list`（`member`、読み取り。区分とリポジトリを `position, id` の順に返す。閉じたワークスペースでも読める）で読む。リポジトリの操作（`repository-create`、`repository-update`、`repository-move`、`repository-delete`）も同じ決まりで、欄は `name` だけ。入る先との結び付け（`provider`、`source_container_id`）は #67 で足す。
  - `name` は `workspaces.name` と同じ決まり（前後の空白を除いて 1〜50 字）。同じワークスペースの削除していない同じ名前は 409（`conflict`、理由は `duplicate_name`。前後の空白を除いた後の完全一致で比べ、大文字と小文字、全角と半角は別の名前とみなす）、削除していない行が 50 件あれば足すのは 409（`conflict`、理由は `limit`）。理由の一覧は `src/shared/operations/definition/definition.ts` の `definitionConflictReasons`。どちらも書く文の条件（足すのは `INSERT ... SELECT ... WHERE NOT EXISTS (同じ名前) AND (数) < 50`、名前の変更は同じ名前が無いことと読んだ名前のままであることを条件にした `UPDATE`）で守り、同時に足しても重複を作らない。足す位置は末尾。
  - 変更は `story-update` と同じく、送った欄のうち今の値と違うものだけを、読んだ値のままなら、という条件つきで書く。`is_billed_monthly` を切り替えても、すでにある完了の記録の `billing_month` は変えない。
  - 並べ替え（`category-move`、`repository-move`）は、`tasks` の「並べ替えと親の移動」と同じ決まり（`after_category_id`、`after_repository_id`。null は先頭、省くと末尾。同じ値の振り直しも同じ）で、親は無い。並べ替えは `change_logs` に残さない。
  - 削除は論理削除で、振っていた行（区分はエピック、ストーリー、タスクの削除していない行、リポジトリはタスクの削除していない行）の `category_id`、`repository_id` を空にし、空にした行ごとに `change_logs`（`entity_type` はその行の種類、`action = 'update'`、`{"category": [{id, name}, null]}` か `{"repository": [{id, name}, null]}`）を、削除と同じ `batch()`（1つのトランザクション）で書く。並べる文は、定義の削除、表ごとに1文の履歴（`INSERT INTO change_logs ... SELECT ... FROM <表> WHERE workspace_id = ? AND <列> = ? AND deleted_at IS NULL` に、自分の削除が通った定義の行（`deleted_at` が自分の時刻）を結んだもの。区分の名前は定義の行から取り、`json_object` で組む）、表ごとに1文の戻す `UPDATE`（同じ条件）で、履歴を戻す文より前に置く。振っていた行の数によらず文の数は決まっている。履歴の `id` は行ごとに SQL の中で UUIDv7 の形に作る（先頭の48ビットは `created_at` と同じアプリの時刻、残りは `randomblob`。`src/server/db/uuid-sql.ts`）。削除した後は、振る書き込みが削除していない行だけを条件にするので、新しく振られない。完了の記録（`completions.category_id` と `billing_month`）は変えない。
  - 作成、変更、削除は `change_logs`（`entity_type` は `category`、`repository`。作成は `create`、変更は `update` で変えた列だけ、削除は `delete` で `{"deleted_at": [null, 日時]}`）に残す。閉じたワークスペースへの書き込みは 409（`workspace_closed`）。無い行（削除済み、別のワークスペース、別の組織を含む）は 404。
- エピック、ストーリー、タスクに振るとき（作成と変更）は、同じワークスペースの削除していない区分とリポジトリだけを、読む文と書く文の条件（`EXISTS`）の両方で受け、無ければ 404。区分は親のないもの（エピック、親のないストーリーとタスク）にだけ振れ、親のあるものへ送ると 409（`conflict`、理由は `has_parent`。`categoryConflictReasons`）。

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
- 操作の決まりは `categories` と同じ。

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
- 作る操作（`epic-create`）は、`requester_user_id` と `created_by` を呼んだ人、`reward_tier` を `medium` にし、`position` はエピックの末尾（完了と中止したものも含めた末尾）に振る。依頼主とクリア報酬の段階を変える操作、クリア、中止は、エピックの画面の続きの Issue（#65 の子）で足す。討伐隊の受注、抜ける、割り振りは `epic_party_members` の項。削除（`epic-delete`）は下の「エピックとストーリーの削除」。欄の決まりは `stories` と同じで、`title` は前後の空白を除いて 1〜200 字、`body_md` は 1 万字まで（`stories.body_md` と同じ正規化。空は `NULL`）、`due_on` と `link_url` も同じ。変える操作（`epic-update`）は `story-update` と同じ書き方で、`title`、`body_md`、`due_on`、`link_url`、`category_id` のうち送られて今の値と違う欄だけを、読んだ値のままなら、という条件つきで書く（「書き込みの単位」の「エピックの変更」）。履歴は `entity_type = 'epic'` で、作ったときは `create`、変えたときは `update`（`{"列名": [前, 後]}`）。作る操作と変える操作は区分（`category_id`）も受ける（`categories` の「エピック、ストーリー、タスクに振るとき」）。区分の履歴は `{"category": [前, 後]}`（値は `{id, name}` か null）。ダイアログを開くときの読み取り（`epic-get`）は、1件のタイトル、本文、期日、リンク、区分の ID と、呼んだ人が削除できるか（`can_delete`。作った人かリーダー（管理者を含む））、まとめて削除できるか（`can_delete_children`。下の「削除」の `delete` の判定）、配下の件数（`children`。削除していないストーリーと、その下の削除していないタスク。完了したものも含む）を返し（本文は `backlog-tree` に載せない）、無い（別の組織、別のワークスペース、削除済みを含む）ときは 404 で、閉じたワークスペースでも読める。
- エピックの画面の読み取り（`epic-detail`）。`member` の読み取りで、入力は `workspace_id`、`epic_id`。1回の `batch()` で、エピック、討伐隊、配下のストーリー、討伐隊の経験値の合計、ワークスペースの設定を読む。読む表はどれも組織の中の表で、`epics`、`stories`、`tasks` はワークスペースで絞り、`epic_party_members` は `workspace_id` を持たないので、ワークスペースで絞ったエピックを結んで引く。無い（別の組織、別のワークスペース、削除済みを含む）ときは 404 で、閉じたワークスペースでも読める。返すもの:
  - エピックの欄（`id`、`title`、`body_md`、`due_on`、`link_url`、区分（同じワークスペースの削除していない区分の ID と名前。無ければ `null`）、`completed_at`、`canceled_at`）。
  - 依頼主（`id`、`name`、`left`）。名前は組織で絞った `users` から読み、離脱済みでも出す。`left` は、そのワークスペースに今の所属（`memberships.left_at` が空の行）が無いこと（`task-detail` の担当の `left` と同じ判定）。
  - クリア報酬の段階（`reward_tier`）と額（`reward_xp`）。段階の並びと額は `src/shared/experience.ts` の `epicRewardTiers` と `XP_EPIC_REWARD`（小 100、中 300、大 600）。払うのはクリア（#65 の続き）で、この操作は額を出すだけ。
  - 討伐隊（`party`）。`epic_party_members` の行を `joined_at`、`user_id` の順に、各人の `id`、`name`、`left`（依頼主と同じ判定）、`joined_via`、`level` で返す。抜けた人の行も、行を消すまでは含む。`level` は組織の中の本人の経験値の合計（`xp_grants.amount` の和。閉じたワークスペースと抜けたワークスペースの分も含む）から `levelOf` で出し、合計は返さない。合計は討伐隊の人で絞って1つの文（`GROUP BY user_id`）で読む（今の所属では絞らない）。
  - 配下のストーリー（`stories`）。削除していないものを `position`、`id` の順に、`id`、`title`、`completed_at`、`points_done`、`points_all` で返す。ポイントは `backlog-tree` と同じ数え方で、削除していないバックログのタスク（`tray = 'backlog'`）の `points`（未見積もりは 0）の合計。`points_done` は完了したタスクだけ。
  - `today` と `week_start`（ワークスペースのタイムゾーンの今日と週の始まり。期日の印を決める）。
  - `can_manage`: 呼んだ人が依頼主か、リーダー（管理者を含む）か。割り振り、依頼主とクリア報酬の変更、クリア、中止の口を出す側の値で、読み取りの権限には使わない。
  - `can_join`: 呼んだ人が討伐隊に入れる人か（そのワークスペースに今所属し、無効でなく `login_subject` のある人。受注の書く文と同じ `activeMemberName`。所属していない管理者は偽）。`joined`: 呼んだ人の行が、このエピックの討伐隊にあるか（入り方を問わない）。どちらも受注と抜けるの口を出す側の値。`can_join` の読み取りは同じ `batch()` に1文足す。
- 並べ替え（`epic-move`）。`member` の書き込みで、入力は `workspace_id`、`epic_id`、直前に置くエピック `after_epic_id`（null は先頭、省くと末尾）。並べる範囲は、ワークスペースの削除していないエピックの全部（完了と中止したものも含む。どちらも動かせ、その前後にも置ける）。エピックは親を持たないので、`position` だけを書き、`change_logs` は残さない。位置の作り方と同じ値の行の振り直しは `tasks` の「並べ替えと親の移動」と同じ（`src/server/operations/move-position.ts`）。移すエピックか直前のエピックが無い（削除済み、別のワークスペース、別の組織を含む）ときは 404、直前のエピックが移すエピック自身なら 400（`invalid_input`）、閉じたワークスペースは 409（`workspace_closed`）。書く文は、直前のエピックが読んだ値の位置にあることを条件にし、読んでから書くまでに並びが変わっていれば 409（`conflict`、理由は `changed`）。同じ値の行が上限を超えれば 409（`conflict`、理由は `ties`）。
- 削除（`epic-delete`）と、ストーリーの削除（`story-delete`）。どちらも `member` の書き込みで、入力は `workspace_id`、`epic_id` か `story_id`、配下の扱い `children`（`keep` か `delete`。必須）。論理削除で、完了とクリアの記録（`completed_at`、`completions`）と経験値（`story_completed`、`task_completed` などの `xp_grants`）は残す。完了や中止したものも削除できる。削除できるのは作った人（`created_by`）とリーダー（管理者を含む。`task-delete` と同じ判定）で、ほかは 403（`forbidden`）。無い（別の組織、別のワークスペース、削除済みを含む）ときは権限より先に 404、閉じたワークスペースは 409（`workspace_closed`）。
  - `keep` は直接の子だけを親なしにする。エピックなら配下のストーリーの `epic_id` を空にし（その下のタスクはストーリーの下のまま）、ストーリーなら配下のタスクの `story_id` を空にする。動かす子は、移す先（親のないストーリー、親のないバックログのタスク。どちらも完了したものを含む）の末尾に、元の並び（`position`、`id` の順）のまま置く（値の作り方は「決まりごと」。移す先の最後の値は `ORDER BY position DESC LIMIT 1` で読む）。親から引き継いでいた区分を子に写し、削除の前後で集計の区分を変えない。エピックの削除ではストーリーへエピックの区分を、ストーリーの削除ではタスクへストーリーが引き継いでいた区分（親のエピックの区分、ストーリー自身の区分の順）を書く。どちらも同じワークスペースの削除していない区分だけを写し、写すものが無ければ子の区分は今の値のまま。
  - `delete` は木の下すべてを片付ける。エピックなら配下のストーリーと、その下のタスク、ストーリーなら配下のタスク（どちらも完了したものを含む）。手で作ったタスクとストーリーは論理削除し、取り込んだタスク（`is_imported = 1`。`task-delete` が 409 にするもの）は削除せずアーカイブへ移す（`tray = 'archive'`、`story_id`、`sprint_id`、`column_id`、`column_position` を空、`position` はアーカイブの末尾に、親のストーリーの並び、その中のタスクの並びの順）。リーダー（管理者を含む）でない人の `delete` は、削除していない配下（エピックなら配下のストーリーと、その下の手で作ったタスク、ストーリーなら手で作ったタスク。完了したものも含む）の `created_by` がすべて呼んだ人のときだけ通し、他の人の作ったものがあれば 403（`forbidden`、`details.reason` は `others_children`。`src/shared/operations/delete-children.ts`）。取り込んだタスクは `created_by` が空で、削除せずアーカイブへ移すだけ（アーカイブはメンバーなら誰でもできる）なので数えない。読んだ時点で判定し、書く文すべての条件にも「他の人の作った配下が無い」を入れる（読んでから書くまでに他の人の子が移されても止まる）。`get` の `can_delete_children` は、`can_delete` が真で、リーダーか管理者か、他の人の作った配下が無いとき真。
  - 履歴（`change_logs`）は、削除した根と、まとめて削除したストーリーとタスクに `action = 'delete'`（`{"deleted_at": [null, 日時]}`）。親なしにした子に `action = 'update'` の `{"epic": [{id, title}, null]}` か `{"story": [{id, title}, null]}`（`story-move`、`task-move` と同じ形）で、写して区分が変わった行は同じ履歴に `{"category": [前, 後]}`（値は `{id, name}` か null）を足す。アーカイブへ移したタスクは `action = 'update'` の `{"story": [{id, title}, null], "tray": ["backlog", "archive"]}`。書き方は「書き込みの単位」の「エピックとストーリーの削除」。

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
- 主キーは `(epic_id, user_id)` で、同じ人は同じエピックに1回だけ入る。
- `workspace_id` は持たない（組織の中の表だが、ワークスペースはエピックを通して決まる）。読み書きする文は、ワークスペースで絞ったエピックを結ぶ（別のワークスペースのエピックの討伐隊を、自分のワークスペースの ID で読めない）。組織の解約で消す文は、エピックのワークスペースが組織のものであることで絞る（`scripts/purge-organization-sql.ts`）。
- 作ったのは `migrations/0009_add_epic_party_members_and_thanks.sql`（#265）。読むのは `epic-detail`。行を足すのは受注（`epic-party-join`）、割り振り（`epic-party-assign`）、配下のタスクの担当（`task-assign` と担当つきの `task-create`）で、消すのは抜ける（`epic-party-leave`）（#266）。メンバーの離脱とユーザーの無効化で行を消す文は、後の Issue（#267）で足す。
- 討伐隊に入れるのは、そのワークスペースに今所属し、無効でなく `login_subject` のある人だけ（担当にできる人と同じ `activeMemberName`）。受注、割り振り、抜けるは、どれも `member` の書き込みで、入力は `workspace_id`、`epic_id`（割り振りは `user_id` も）。出力は `changed`（この要求が行を足したか消したか）。
  - 受注（`epic-party-join`）は呼んだ人を `joined_via = 'self'`、`added_by` を呼んだ人で足す。呼んだ人が入れる人でなければ 404（所属していない管理者も）。
  - 割り振り（`epic-party-assign`）は、エピックの依頼主とリーダー（管理者を含む）だけ。それ以外の人は 403（`forbidden`）。相手を `joined_via = 'assigned'`、`added_by` を呼んだ人で足す。相手が入れる人でなければ 404（別の組織の人、所属していない人、抜けた人、無効の人を含む）。
  - 抜ける（`epic-party-leave`）は呼んだ人の行だけを消す（依頼主とリーダーが人を外す口は無い）。
  - 無いエピック（別の組織、別のワークスペース、削除済みを含む）は 404。クリアか中止したエピックは、受注、割り振り、抜けるのどれも 409（`conflict`）で、配下のタスクの担当でも加わらない（クリアした時点の討伐隊が報酬の記録なので、終わった後は変えない）。閉じたワークスペースは 409（`workspace_closed`）。
  - 既に討伐隊にいれば（入り方を問わず）受注も割り振りも何も書かずに 200、抜けるときに討伐隊にいなければ何も書かずに 200。
  - 配下のタスクの担当で加わるのは、担当を付ける `task-assign` と、担当つきで親のストーリーの下に作る `task-create` だけ。同じ担当を送り直した `task-assign`（担当が替わらないので何も書かない）、担当の付いたタスクやストーリーをエピックの下へ移す `task-move` と `story-move` では加わらない（移した後に担当を付け直せば加わる）。
- 履歴は `change_logs` に `entity_type = 'epic'`、`entity_id` はエピックの ID、`action = 'update'` で、加わったら `{"party_member": [null, {"id", "name", "via"}]}`、抜けたら `{"party_member": [{"id", "name", "via"}, null]}`。`name` はそのときの名前、`via` は入り方（`self`、`assigned`、`task_assignee`。抜けたときは消した行の入り方）。`actor_user_id` は、受注と抜けるは本人、割り振りは割り振った人、配下のタスクの担当は担当を替えた人。行を足したか消したときだけ書く。
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
- 作る操作と変える操作は区分（`category_id`）も受ける。区分は親のないストーリーだけが持ち、エピックの下のストーリーへ送ると 409（`conflict`、理由は `has_parent`）。変える文は、区分を書くときは `epic_id IS NULL` も条件にする。作る操作（`story-create`）は、親なし（`epic_id` は空）で、`position` は親のないストーリーの末尾、`created_by` は呼んだ人。変える操作（`story-update`）は、送られた欄のうち今の値と違うものだけを、読んだ値のままなら、という条件つきで書き（書き方は「書き込みの単位」の「ストーリーの変更」）、変えた欄だけを `change_logs` に `{"列名": [前, 後]}` で残す。変える欄が無ければ何も書かない。ダイアログを開くときの読み取り（`story-get`）は、1件の全部の欄と、親のエピック（`epic_id`）、引き継ぎを解いた区分（`category`。`{ id, name, inherited }` か null。親のエピックがあればその区分で `inherited` が真）、呼んだ人が削除できるか（`can_delete`。作った人かリーダー（管理者を含む））、まとめて削除できるか（`can_delete_children`）、配下の件数（`children`。削除していないタスク。完了したものも含む）を返す（`backlog-tree` には載せない）。削除（`story-delete`）は `epics` の「削除」と同じ決まり。無い（別の組織、別のワークスペース、削除済みを含む）ときは 404 で、閉じたワークスペースでも読める。
- 手での完了（`story-complete`）は、配下に削除していない未完了のバックログのタスクが無いときだけ `completed_at`、`completed_by`（呼んだ人）、`updated_at` を書く。配下にタスクが1件も無いストーリーも完了にできる。完了の経験値（`xp_grants` の `story_completed`）を同じ `batch()` で付ける（書き方は「書き込みの単位」の「ストーリーの完了」）。断るもの。無い（別の組織、別のワークスペース、削除済みを含む）ときは 404、すでに完了していれば 409（`conflict`、理由は `completed`。2つの画面から同時に完了にした後の方も同じ）、親のエピックが完了か中止していれば 409（`conflict`、理由は `parent_completed`。完了にすると取り消せず、付けた経験値も打ち消せなくなるため。削除したエピックは親として数えない）、配下に未完了のタスクが残っていれば 409（`conflict`、理由は `open_tasks`）、閉じたワークスペースは 409（`workspace_closed`）。履歴は `action = 'complete'`、`{"completed_at": [null, 日時], "completed_by": [null, {id, name}]}`。
- 完了の取り消し（`story-reopen`）は、`completed_at` と `completed_by` を空に戻し、打ち消されていない `story_completed` の付与を打ち消しの明細で取り消す。もう一度完了にすると、新しい回のキーで付け直す。完了していなければ 409（`conflict`、理由は `not_completed`）、親のエピックが完了か中止していれば 409（`conflict`、理由は `parent_completed`）。完了と同じく、削除したエピックは親として数えない（取り消せる）。エピックの削除（`epic-delete`）は、配下のストーリーを親なしにするか一緒に削除するので、削除したエピックの下に削除していないストーリーは残らない（それより前に入った行があれば、木には出ない）。打ち消しは、受け取った人が所属を外れていても行う。履歴は `action = 'reopen'`、`{"completed_at": [前の日時, null], "completed_by": [{id, name}, null]}`。
- 完了と取り消しの 409 の `conflict` は、理由を `details.reason` に載せる（`open_tasks`、`completed`、`not_completed`、`parent_completed`、`changed`。`src/shared/operations/story/story-complete.ts` の `storyCompletionConflictReasons`）。`changed` は、読んでから書くまでに別の要求が受け取り手か完了の回を変え、やり直しても書けなかったとき。
- 完了したストーリーへのタスクの作成と移動は 409（`tasks` の「並べ替えと親の移動」）。完了したストーリーの中の並べ替えはできる。

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
  - `tasks_story_open`: `(story_id, position) WHERE deleted_at IS NULL AND completed_at IS NULL`: バックログの木のストーリーの配下の未完了のタスク（完了したタスクを読み飛ばさない。#165 で 5 万件を測って足した。数は下の「バックログの木」）
  - `(sprint_id, column_id, column_position) WHERE deleted_at IS NULL`: スプリントの列
  - `(assignee_user_id, deleted_at, completed_at) WHERE assignee_user_id IS NOT NULL`: 外部キーの検査と、自分の今日、積載量（担当の未完了のタスク）
  - `(completed_by) WHERE completed_by IS NOT NULL`、`(created_by) WHERE created_by IS NOT NULL`: 外部キーの検査
  - `(created_by, completed_at) WHERE created_by IS NOT NULL AND deleted_at IS NULL`（`tasks_created_by_open`）: 経験値の見込み（`experience-summary`）が、本人が作った未完了で削除していないタスクだけを引く。問い合わせは `deleted_at IS NULL` を文字のまま書く。`migrations/0011_add_xp_grants_read_indexes.sql`（#296）で足した。
- 手で作るタスクの `title` は、前後の空白を除いて 1〜200 字。字数の数え方と断る文字は `workspaces.name` と同じ。
- 引き出しの読み取り（`task-detail`）と、引き出しで書いた後の値（`task-update`、`task-assign`）の `reopenable`（完了を戻せるか）は、閉じていないワークスペースで、`task-reopen` と同じ判定（`reopenBlockOf`）に当たらないとき真。バックログのタスク（`tray = 'backlog'`。アーカイブへ移った完了済みのタスクは偽）で、完了していて、スプリントに入っていないか入っているスプリントが削除していない進行中のもので、親のストーリーが完了していないこと。
- 引き出しで直す欄（`task-update`）の決まりは、ストーリーと同じ。`body_md` は 1 万字まで（`stories.body_md` と同じ正規化。空は `NULL`）、`link_url` は http と https の URL だけで 2048 字まで（解釈した URL にそろえる）、`due_on` は暦に存在する日付。取り込んだタスクはリンクを持たず（上の CHECK）、タイトルは同期で書き直すので、どちらも直せない。完了したタスクのポイントは直せない（「書き込みの単位」の「タスクの変更」）。1件の読み取り（`task-detail`）は、これらの欄と、親のストーリー（`story_id`）、引き継ぎを解いた区分（`category`。`{ id, name, inherited }` か null。親のエピック、親のストーリー、タスク自身の順で、親から引き継いだものは `inherited` が真）、リポジトリ（`repository`。`{ id, name }` か null）、入っているスプリント（`sprint`。`backlog-tree` の行と同じ形）、担当（`assignee`。ID、名前と、今そのワークスペースに所属していないか（`left`。抜けた、無効にされた、所属が無い）。名前は組織で絞った `users` から、所属はそのワークスペースの `left_at IS NULL` の `memberships` から読む）、取り込んだタスクか、完了した日時、呼んだ人が削除できるかに加えて、期日の印を決める今日（`today`。ワークスペースのタイムゾーン）と週の始まり（`week_start`）を返す（`backlog-tree` と同じ決め方。ワークスペースの行は組織とワークスペースで絞って読む）。本文は長いので、バックログの木には載せない。
- 担当は `task-assign` で替える（`task-update` では替えない）。担当にできるのは、そのワークスペースに今所属している、無効でなく `login_subject` のある人（`task-create` と同じ条件。候補を出すメンバーの一覧（`member-list`）と同じ人で、Google で待っている行は担当にしない）で、外す（`NULL`）のはいつでもできる。完了したタスクの担当は替えない（完了の経験値と `completions` が完了した時点の担当を使うため。直すのは完了の記録の修正）。取り込んだタスクの担当は替えられる。書き方は「書き込みの単位」の「タスクの担当の変更」。
- 「今日やる」は、`today_on` が今日（ワークスペースのタイムゾーン）なら今日の印、それより前で未完了なら前日からの持ち越しとして示す。担当が替わったら消す（`task-assign` が担当を書く同じ文で `NULL` にする。同じ担当を送ったときは消さない）。
- 区分は、親のエピック、親のストーリー、タスク自身の順に、最初に入っているものを使う。読むときに結合して出し、タスクには写さない。完了の記録（`completions.category_id`）には、完了した時点の値を写す。
- `repository_id` は、取り込むときに `repositories` の `(workspace_id, provider, source_container_id)` が `task_sources` と一致する行があれば入れる。同期では書き換えない。
- 表示する期日は `due_on`、なければ `task_sources.source_due_on`（接続の `ignore_source_due` が 0 のとき）。
- 完了したバックログの読み取り（`backlog-completed-tasks`。`member`、`read`、`workspace: true`）は閉じたワークスペースでも読める。入力は `workspace_id`、`story_id`（IDかnullで親なし）、任意の `before`（`{ completed_at, id }`。日時はミリ秒までのUTC ISO形式）、`limit`（1〜200、既定20）。組織とワークスペースで絞り、`tray = 'backlog'`、`deleted_at IS NULL`、`completed_at IS NOT NULL` の行だけを `completed_at` の降順、同じなら `id` の降順に返す。ストーリーが無い（別組織、別ワークスペース、削除済みを含む）ときは404。完了したストーリーも読める。応答の `tasks` は `id`、`title`、現在の `points`、`completed_at`、現在の担当 `assignee`（組織で絞った `users` の `{ id, name }` かnull。離脱者も含む）。続きがあれば最後の行の `{ completed_at, id }` を `next` に返し、次の `before` に渡す。無ければnull。親なしの分岐は `story_id` を単項の `+`（`unindexed('tasks.story_id')`）で索引に使わせず、`tasks_workspace_tray` で引く。`ANALYZE` の後は、`tasks_story` の統計が `story_id` の NULL を別々の値と数え、SQLite が `tasks_story` を選んで全組織の親なしタスクを読む計画に変わるため。ストーリーの分岐は `story_id` の等号で `tasks_story` を使う（`test/backlog-completed-tasks.test.ts` が `ANALYZE` の後の実行計画で確かめる）。木の応答には完了した行を載せず、索引とマイグレーションは追加しない。
- バックログの木（`backlog-tree`。エピックとその配下のストーリー、親のないストーリー、ストーリーの配下の未完了のタスク、親のない未完了のタスク）は、件数に上限を付けず、1回の読み取りで全部を返す（上限や、ストーリーを開いたときに配下を読む形には分けない。下の測った数で決めた）。完了したタスクは行を返さず件数だけ返すが、完了と中止したエピックと、完了したストーリーは行を返すので、返す行は使い続けると増える（読む行は完了したタスクの分も増える。ストーリーごとの合計は完了した分も数える）。上限で切ると、優先順位の後ろにあるタスクが見えなくなるため。ストーリーの配下を引く文は、`FROM stories CROSS JOIN tasks`（結ぶ条件は `WHERE`）で順序を固定する。INNER JOIN だと SQLite が `tasks_workspace_tray` を先に走査する計画を選ぶため。ストーリーは親のないものとエピックの下のものを `stories.workspace_id` だけで絞って1つの文で読み（`stories_workspace_epic` の先頭の列で引き、タスク側は、未完了の行は `tasks_story_open`、合計は `tasks_story`）、`epic_id` で分ける。削除したエピックの下のストーリーは出さない。配下の未完了のタスクは、`ORDER BY` を付けると索引を使わない計画になるので、読んだ後に `position`、`id` の順に並べる。担当で絞るときは、担当の列を単項の `+` で索引に使わせない（`unindexed`）。`tasks_story_open` を足す前は、SQLite がストーリーごとに `tasks_assignee_user` を引く計画を選び、5 万件で 10 秒かかった（今は `tasks_story_open` を選ぶが、計画が揺れないよう止めておく。`test/backlog-filter.test.ts` が実行計画で確かめる）。親のないタスクを引く文（木の親のない未完了のタスクと完了の件数、起票で親なしの末尾の位置を決める文、並べ替えで親なしの兄弟を引く文、ストーリーの削除（`keep`）で配下のタスクを親なしの末尾へ移す文）は、`story_id` を同じく単項の `+`（`unindexed('tasks.story_id')`）で索引に使わせず、`tasks_workspace_tray` で引く。`tasks_story` は `workspace_id` を持たず `story_id` が NULL の行を全組織のぶん持つので、`ANALYZE` の後は統計が NULL を別々の値と数え、SQLite が `tasks_story` を選んで全組織の親のないタスクを読んでから絞る計画に変わるため（`backlog-completed-tasks` の親なしの分岐と同じ止め方）。ストーリーの配下を引く文（`story_id` の等号）は変えず、`tasks_story` を使う。`test/backlog-filter.test.ts` が `ANALYZE` の後の実行計画で、親のない文が `tasks_workspace_tray` を使い `tasks_story` を使わないことを確かめる。
  - 5 万件で測った数（#165。`scripts/backlog-bench.ts`。手元の D1（`wrangler dev --local`）で API を往復した時間の中央値。エピック 50、ストーリー 1,000（800 はエピックの下）、タスクの 8 割はストーリーの下。目安は現実の形で 500 ms。数は手元の D1 の往復の値で、本番の D1 では測っていない。1回の読み込みは、ストーリーごとの合計のために、完了したものも含めてストーリーの配下のタスクを全部読む）:

    | 形 | 絞らない | 担当（自分） | 検索（1% に当たる語） | 応答の大きさ（絞らない） |
    | --- | --- | --- | --- | --- |
    | 現実の形（完了 45,000、未完了 5,000）、`tasks_story_open` なし | 224 ms | 193 ms | 176 ms | 1.3 MB |
    | 現実の形、`tasks_story_open` あり | 184 ms | 136 ms | 113 ms | 1.3 MB |
    | 最悪の形（未完了 50,000）、`tasks_story_open` あり | 659 ms | 332 ms | 207 ms | 10.9 MB |

    `tasks_story_open` なしの行は、検索を `LIKE` で書いていたときの数。ありの2行は、検索を `instr` に変えた後に測り直した数。

    現実の形は目安に収まるので、分けて読む形（木はエピックとストーリーだけを返し、配下はストーリーを開いたときに読む。親のないタスクは先頭の数百件と「さらに読む」）には分けない。区分、リポジトリ、エピック、担当なしで絞っても、現実の形で 104〜138 ms、最悪の形で 107〜325 ms。検索は索引が効かないが、当たらない語でも、どちらの形でも 200 ms を下回る（現実の形 121 ms、最悪の形 183 ms）ので、FTS5 は足さない。最悪の形の絞らない読み取りは、時間の多くが 10.9 MB の応答を作って運ぶ分で、未完了が数万件に積もる使い方が出てきたら、そのときに分けて読む形を決める。
- バックログの絞り込み（`backlog-tree` の入力。決まりは `docs/requirements.md` の「絞り込みと検索」）。担当（`assignee_user_id`。ID、`'me'`（呼んだ人）、null（担当なし））、区分（`category_id`。引き継ぎを解いた区分の ID か null）、リポジトリ（`repository_id`）、エピック（`epic_id`。null は親のないストーリーと親のないタスクだけ）、タイトルの検索（`query`）で、どれも省けば絞らない。絞るのはタスクの2つの文（ストーリーの配下と親のないタスク）の `WHERE` で、区分は `CASE`（親のないストーリーは自身、エピックの下ならエピック）と、生きている区分の `EXISTS` で決める。リポジトリは結んだ生きている行で決める。どれもワークスペースで絞った行の中で当てるので、別のワークスペースや別の組織の ID は何にも当たらない（404 にはしない）。エピックとストーリーは絞らずに全部読み（ポイントの合計を全体の値で返すため）、検索しているときだけ、題が語をそろえて含むかの印（`title_hit`）を足して、どの親を残すかを Worker で決める。検索は語ごとに `instr(lower(title), lower(語)) > 0` を `AND` でつなぐ（`titleContainsAll`。`lower` は英字だけを小文字にするので、英字の大文字と小文字は区別せず、全角と半角はそろえない。`%`、`_`、`\` も普通の文字として探す）。ストーリーの配下のタスクは、タスク、ストーリー、親のエピック（`EXISTS`）のどれかの題がすべての語を含めば当たる。`LIKE` を使わないのは、D1 が `LIKE` の型を 50 バイトまでしか受けず、全角で 16 字を超える語を探せないため。検索の文字は前後の空白を除いて 100 字まで、語は 5 つまで。
- 絞り込みの選択肢（`backlog-tree` の `choices`）。担当（`assignees`）は、組織で絞った `users` のうち、そのワークスペースに今所属していて担当にできる人（`current` が真。`activeMemberName` と同じ条件）と、未完了のバックログのタスクの担当に残っている人（`tasks_assignee_user` で引く）を、今所属している人を先に名前の順で返す。エピック（`epics`）は、絞って木から消えたものも選べるよう、削除していないエピックを全部返す（`finished` は完了か中止したもの。ストーリーの親に選べない）。絞っているときだけ、完了していないストーリー（`stories`。`id`、`title`、`epic_id`、引き継ぎを解いた `category`）も木の順で返し、起票と親を移すダイアログの親の候補にする（木から消えたストーリーも親に選べるように。絞っていなければ null で、画面は木から作る）。区分とリポジトリは `category-repository-list` で読む。どれも木と同じ `batch()` で読む（ストーリーとエピックは木の文の行から作る）。
- `backlog-tree` が返すもの。最上段は「エピック」「親のないストーリー」「親のない未完了のタスク」の3段で、それぞれ `position`（同じ値なら `id`）の順に並べる。エピックは、完了と中止したものも含めて削除していないものを返し、`id`、`title`、`due_on`、`link_url`、`completed_at`、`canceled_at`（長い `body_md` は載せない）、配下の削除していないストーリー（`position` の順。完了したものも含め、形は親のないストーリーと同じ）、配下のポイントの合計（`points_done` と `points_all`。配下のストーリーの合計）を付ける。ストーリーには `id`、`title`、`due_on`、`link_url`、`completed_at`（長い `acceptance_criteria_md` と `body_md` は載せない）、配下の未完了のタスク、配下の完了したタスクの件数（`completed_task_count`）と未完了のタスクの件数（`open_task_count`。絞って出していない行も数え、画面が完了にできるかを決める）、配下のポイントの合計（`points_done` は完了したタスク、`points_all` は削除していないタスク全部。未見積もりは 0）を付ける。絞っても、件数とポイントの合計は、そのストーリーとエピックの全体の値を返す。タスクの行には `id`、`title`、`points`、`due_on`、担当、リポジトリ（`{ id, name }` か null）、入っているスプリント（`sprint`。同じワークスペースの削除していないスプリントの `{ id, name, start_on, end_on }` か null。画面は名前、無ければ期間を出す）を付ける。スプリントに入ったタスクも木から外さない。エピック、ストーリー、タスクの行には、引き継ぎを解いた区分（`category`。エピック、ストーリー、タスク自身の順に最初に入っているもので、`{ id, name }` か null）を付ける。区分とリポジトリは、同じワークスペースの削除していないものだけを結ぶ。親のない完了したタスクは件数だけ返し、絞っているときは返さない（`completed_count` が null）。ワークスペースのタイムゾーンでの今日の日付（`today`）と週の始まり（`week_start`）も返し、期日の印（過ぎた、今日、今週、それ以外）はこの2つと `src/shared/due.ts` で決める。組織とワークスペースで絞り、ストーリー側もワークスペースで絞る。
- タスクの親は、同じワークスペースの削除していないストーリー。作るとき（`task-create` の `story_id`）に無ければ 404、完了していれば（`stories.completed_at` が空でない）409（`conflict`）で、`position` はそのストーリーの配下の末尾。作るときはリポジトリ（`repository_id`）と、親のないときだけ区分（`category_id`。親と一緒に送ると 409 の `has_parent`）も受け、作ったときの履歴に `category`、`repository`（`[null, {id, name}]`）を残す。
- 並べ替えと親の移動（`task-move`）。入力は動かすタスク、移す先の親（`story_id`。null は親なし）、直前の行（`after_task_id`。null は先頭、ID はその行の直後、省くと末尾）。画面の「親を移す」は直前の行を送らず、移す先の末尾に置く。
  - 移す先の並びは、親の配下（親なしなら親のないタスク）の削除していないバックログのタスクを、完了したものも含めて `position, id` の順に並べ、移すタスクを除いたもの。直前の行とその次の行の間の値（`generateKeyBetween`）を振る。先頭なら最初の行の前、末尾なら最後の行の後。
  - 直前の行と次の行が同じ値（同時に作った行）なら、直前の行と同じ値で `id` が後ろの行の続きを、移す行と一緒に、直前の行の値と次の違う値（無ければ上限なし）の間で振り直す（`generateNKeysBetween`。最初の値が移す行、残りが続きの `id` の順）。親の行を全件は読まず、同じ値の続き（`position = 直前の値 AND id > 直前の id`。41 行まで）と、直前の値より大きい最初の1行だけを読む。続きが 40 行を超えたら、振り直さずに 409（`conflict`、理由は `ties`）で断る（1回の `batch()` を際限なく大きくしない。同じ値は同時に作った行にしかできないので、ふつうは数行）。振り直しの文は、移す行の更新が通った（その `id` の行が新しい `position`、親、`updated_at` を持つ）ことと、その行の `position` が読んだ値のままであることを条件にし、移す行の更新と同じ `batch()` で書く。振り直した行の `updated_at` も書く。
  - 断るもの。動かすタスクか移す先の親が無い（別の組織、同じ組織の別のワークスペースを含む）ときは 404。動かすタスクが受信箱かアーカイブにあるときも 404。直前の行が移す先に無い（別の親、削除済み、受信箱とアーカイブ、別のワークスペース、別の組織）ときも 404。直前の行が動かすタスク自身なら 400（`invalid_input`）。完了したタスクを動かすのは 409（`conflict`、理由は `task_completed`）。完了したストーリーの下へ親を移すのは 409（`conflict`、理由は `parent_completed`）。同じ親の中の並べ替えは、親のストーリーが完了していてもできる。閉じたワークスペースは 409（`workspace_closed`）。
  - 409 の `conflict` は、理由を `details.reason` に載せる（`parent_completed`、`task_completed`、`changed`、`ties`。`src/shared/operations/task/task-move.ts` の `moveConflictReasons`）。画面は理由で知らせる文を選ぶ。
  - 書く文は条件つきの `UPDATE`（読んだときの親のまま、閉じていないワークスペース、移す先の親が今もあり、親が変わるならその親が完了していない、直前の行が今も読んだ値の位置にある）で、変わった行が 0 なら読み直して理由を決める（閉じていれば `workspace_closed`、タスクか親か直前の行が無ければ 404、タスクが完了していれば `task_completed`、移す先の親が完了していれば `parent_completed`、どれでもなければ別の要求が先に親を移したか直前の行を動かしたので `changed`）。`updated_at` は並べ替えだけでも書く。
  - 親が変わったときだけ `change_logs`（`action` は `update`、`changes_json` は `{"story": [前, 後]}`、値は `{id, title}` か null）を、移す行の更新が通ったときだけ書く。並べ替えだけなら履歴を残さない。ストーリーの下へ移したら `category_id` を空にする（区分は親なしのときだけ入る）。空にした区分は、同じ履歴に `{"category": [{id, name}, null]}` で残し（`name` は読んだ時点の名前。改名と競合すると前の名前が残るが、`id` で引ける）、親が変わるときの書く文は区分が読んだ値（空も含む）のままであることも条件にする。応答は `task_id` と `story_id` で、`position` は返さない。
- タイトルの検索は `instr(lower(title), lower(語))` で行う（上の「バックログの絞り込み」）。取り込み元のキー（`task_sources.source_key`）で探すのは、`task_sources` が入るとき（#67）に同じ形で足す。5 万件で測って、ワークスペースの索引で絞れば足りた（上の数）。遅くなれば FTS5 を足す。

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
| body_md | TEXT | NOT NULL、`CHECK (length(body_md) <= 100000)` | Markdown。削除したら空文字にする |
| edited_at | TEXT | | 最後に直した日時。入っていれば「編集済み」 |
| deleted_at | TEXT | | 入っていれば「削除されました」 |
| deleted_by | TEXT | FK users | 消した人。本人でなければ画面は「〇〇が削除しました」 |
| created_at | TEXT | NOT NULL | |

- 消したら中身がどこにも残らないようにする: `CHECK ((deleted_at IS NULL) = (body_md <> ''))`（消していない行の本文は空でなく、消した行の本文は空）、`CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))`。編集の前の本文も残さない（`edited_at` と、`change_logs` の「誰がいつ直したか」だけを書く。前の本文を履歴に残すと、消した後も履歴に残るため）。
- 索引: `(task_id, created_at, id)`（`comments_task`）。一覧の並びとカーソルに `id` まで使う。
- 索引（外部キーの検査）: `(author_user_id)`、`(deleted_by) WHERE deleted_by IS NOT NULL`。
- 操作は `comment-list`、`comment-create`、`comment-update`、`comment-delete`（どれも `member`。閉じたワークスペースでは読むだけで、書く3つは 409 の `workspace_closed`）。対象のタスクは `task-detail` と同じ（そのワークスペースの削除していないタスク。受信箱、アーカイブ、完了済みも含む）で、それ以外（無いタスク、削除したタスク、別のワークスペースと別の組織のタスクとコメント）は 404。存在（404）を権限（403）より先に決める。
- 一覧（`comment-list`）は、そのタスクのコメントを `workspace_id` で絞り、新しい順（`created_at` の降順、同じなら `id` の降順）に 51 件読んで、50 件を古い順（書いた順）にして返す。51 件目があれば、返した中で最も古いコメントの `{ created_at, id }` を `next` にし、次は `before` に渡して `created_at < :c OR (created_at = :c AND id < :id)` で読む。消したコメントも本文を空にして返し、50 件に数える。添えるのは、消していないコメントの数（`count`。タブの「コメント N」）、時刻を出すワークスペースの `timezone`、書いた人と消した人の今の名前（組織で絞った `users`。抜けた人、無効にされた人も名前を出す）、呼んだ人が直せるか（`can_edit`。書いた本人）と消せるか（`can_delete`。書いた本人とリーダー、管理者。`mayDeleteOwned` と同じ判定）。どちらも消したコメントと閉じたワークスペースでは偽。
- 一覧は、1件 10 万字までの本文を 50 件まで全文で返すので、応答が大きくなりうる。最悪は、4 バイトの文字（絵文字など）だけの 10 万字が 50 件並ぶときで、本文だけで約 20MB（JSON の逃がしで増えればそれ以上）。作成と編集はアカウントごとに 10 分に 30 回までなので、1人がこの状態を作るには数十分かかる。タスクの本文と同じ上限で、今はそのまま許す。困ったら、長い本文は先頭だけを返し、全文は1件ずつ読む形にする。
- 本文は、タスクの本文と同じ整え方（改行を `\n` にそろえ、前後の空行と末尾の空白を落とす）をし、空か空白だけなら 400。10 万字（コードポイント）を超えるか見えない文字を含めば 400。
- 直せるのは書いた本人だけ（リーダーと管理者も、人のコメントは直せない）で、それ以外は 403 の `forbidden`。版の番号は持たず、後から保存したほうを生かす。整えた本文が今と同じなら何も書かない。消せるのは書いた本人とリーダー（管理者を含む）で、それ以外は 403。消えたコメントへの編集と削除は、404 でなく 409 の `conflict`（`details.reason: 'deleted'`）で断る（消したコメントは「削除されました」として一覧に残り、見えているのに無いことになるため）。書き方は「書き込みの単位」の「コメントの作成」「コメントの編集」「コメントの削除」。

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
- 期間を重ねないことはアプリが検査する。重なりは、同じワークスペースの削除していないスプリント（終了したものも含む。変える行そのものは除く）のうち `start_on <= :最終日 AND end_on >= :開始日` のものがあることで、作成と変更の書く文の条件（`NOT EXISTS`）に入れる。読んでから書くのではないので、2つの画面から同時に同じ期間を作っても、後の要求の文は先に入った行を見て何も入れず、409 の `conflict`（`details.reason` は `overlap`）になる。延長で後ろのスプリントを重なる分だけ押し出すときは、1回のバッチで全部を書き直す。間の空きで吸収できる分は動かさず、重ならないスプリントが出たらそこで止める。
- 名前は前後の空白を除いて 0〜100 字で、空（空白だけを含む）は `NULL`。字数の数え方と断る文字は `workspaces.name` と同じ（`src/shared/sprint.ts`）。長さは 1〜28 日で、開始日は今日より前でもよい。開始の操作（`sprint-start`）は、最終日がワークスペースの今日（タイムゾーンで数える）より前のスプリントを断る（409 の `conflict`、理由は `ended`）。開始日より前に始めることは許す。ゴールは始めるときに書く任意の文で、前後の空白を除いて 0〜200 字（コードポイントで数える）。改行は LF にそろえて入れられ、断る文字は名前と同じ（改行とタブは通す）。空白だけのゴールは空と同じで `NULL`（`src/shared/sprint.ts`）。始まっていないスプリントのゴールは `NULL`。
- 一覧（`sprint-list`、`member`、読み取り）は、削除していない `planned` と `active` を `start_on` の順に返し、作るときの初期値を添える。各スプリントには、入っている削除していないタスク（`tasks`。`id`、`title`、`points`、担当（`{ id, name }` か null）、`completed_at`）を、列の順（`ORDER BY is_done, position, id`）、その中の `column_position`、`id` の順（同じ列の同じ位置の行は `id` の順）で添える。件数はその長さ。スプリントから引いてタスクを結び（`FROM sprints CROSS JOIN tasks`）、タスク側は `tasks_sprint_column` の索引で引く。計画の画面が、スプリントの行に入っているタスクを並べ、件数とポイントの合計を出すのに使う。入っているタスクは件数で区切らず全部返す。見込みは1スプリントに数十件、先のスプリントが十数本でも数百行で、計画の画面の応答が遅くなるか、1スプリントに数百件を入れる使い方が出てきたら、スプリントごとに件数だけ返して行は開いたときに読む形を考える。ワークスペースのタイムゾーンでの今日の日付（`today`）も返す。画面は、進行中のスプリントの `end_on` が `today` より前なら、終えるのを促す。初期値は、削除していないスプリント（終了したものも含む）のうち `end_on` がいちばん後のものの翌日と同じ長さ。無ければ、ワークスペースのタイムゾーンでの今日より後で最初の `week_start` の曜日（今日がその曜日なら翌週）と 14 日。閉じたワークスペースでも読める。件数に上限は付けず、先のスプリントの本数にも上限を置かない。作れるのはリーダーだけで、増やしても重くなるのはそのワークスペースの計画の画面だけのため（想定は数か月先までの数本から十数本）。上限で切ると、後ろのスプリントが見えないまま、重なりで作れない理由も分からなくなる。タスクの出し入れ（#238）でも、スプリントと入っているタスクを全部並べる。計画の画面が長くなって先のスプリントを探しにくくなったら、見せ方（今日以降の先頭の何本かと「さらに見る」など）を決める。
- 計画の画面の集計（`plan-summary`、`member`、読み取り。入力は `workspace_id`）は、ベロシティ、先のスプリントごとの集計、エピックごとのポイントを1回の `batch()` で読む。`sprint-list` は広げない（タスクの行まで返す重い操作で、集計は行が要らないため）。どの文もワークスペースで絞り、ワークスペースの行は組織でも絞る。閉じたワークスペースでも読める。
  - ベロシティ（`velocity`）は、削除していない `closed` で `extended_days = 0` のスプリントのうち、`start_on` の新しい 3 つ（3 つに満たなければあるだけ）の、完了の記録の `points` の合計の平均。合計は `completions.sprint_id` がそのスプリントの行で数え（`(sprint_id)` の索引）、ポイントが空の記録は足さない。完了の記録の修正（#71）で直した `points` はそのまま使い、タスクの `points` は見ない。スプリントの外の完了（`sprint_id` が空）と、ほかのスプリントの記録は混ぜない。平均は丸めずに返し、画面が小数 1 桁で出す。対象が 0 なら `average` は `null`（画面は「まだ出ません」）。`sprints` には、平均に入れた各回（`counted` が真）と、その 3 つのうち最も古いものより後に始まった、延長した終了したスプリント（`extended_days >= 1`。`counted` が偽で、平均に入れない。新しい 6 つまで。3 つに満たなければ、終了した延長したスプリントの新しい 6 つまで）を、古い順に、各回の `points`、`extended_days` と一緒に返す。画面が除いたことを示すため。1つのタスクに完了の記録が複数行あっても（再依頼で未完了に戻って完了し直したとき）、`sprint_id` が合う全行の `points` を足す。再依頼の機能が入ったときに、数え方（最後の行だけにするかなど）を決める。
  - 先のスプリントごとの集計（`lanes`）は、削除していない `planned` と `active` を `start_on`、`id` の順に、入っている削除していないタスクのポイントの合計（`points`。未見積もりは 0。進行中で完了したタスクも含む）、件数（`task_count`）、入っている完了していないタスクのうち `points` が空のものの件数（`unestimated_count`）を返す。タスクの無いスプリントも 0 で返す。画面は `points` が `average` を上回るかで棒を赤にして文字で示す（同じ値は上回らない。比べるのは画面）。未記入の件数は、決まった欄の値（`task_field_values`）が `src/server` にまだ無いので返さない。
  - エピックごとのポイント（`epics`）は、削除していない、完了も中止もしていないエピックを `position`、`id` の順に、`title`、`due_on`、`points_done`、`points_all` で返す。数え方はバックログの木（`backlog-tree`）のエピックと同じ（配下の削除していないストーリーの、バックログの削除していないタスクのポイントの合計。`points_done` は完了したタスクの分、`points_all` は全体で、未見積もりは 0）。残りのポイントは `points_all - points_done`（配下の未完了のタスクのポイントの合計）で、画面が出す。ワークスペースのタイムゾーンでの今日（`today`）と週の始まり（`week_start`）も返し、画面が期日の印を決める。エピックには `LIMIT` を置かない。バックログの木（`backlog-tree`）が完了と中止のエピックも含めて全部返すのと同じで、想定は1ワークスペースに数個から数十個のため。
- 作成（`sprint-create`）、変更（`sprint-update`）、削除（`sprint-delete`）はリーダー（管理者を含む）だけ。削除と期間の変更（`start_on`、`length`）は `planned` だけで、始まった（`active`、`closed`）スプリントは 409 の `conflict`（`details.reason` は `started`）。変更は `active` の `name` と `goal` にも使える。`goal` は `sprintGoalSchema` で検証し、`planned` へ送れば 409（`not_active`）、`closed` への変更は 409（`started`）。変更した列だけを読んだ値で条件づけ、状態も読んだままなら書く。別の組織、別のワークスペース、削除済みの ID は 404。変更の履歴は `entity_type = 'sprint'` で残す。削除すると、入っていたタスクをバックログへ戻す（`sprint_entries` の行を `removed` で閉じ、タスクの `sprint_id`、`column_id`、`column_position` を空にし、タスクごとの変更の履歴 `{"sprint": [前, null]}` を残す。同じ `batch()`。「書き込みの単位」の「スプリントの削除」）。
- 終了（`sprint-close`）はリーダー（管理者を含む）だけで、進行中（`active`）のスプリントを `closed` にし、終わらなかったタスクの行き先とゴールの達成を記録する（「書き込みの単位」の「スプリントの終了」）。入力は `sprint_id`、`carry_sprint_id`（持ち越し先。先のスプリントの ID か、`null` でバックログ）、`is_goal_achieved`（ゴールを書いて始めたスプリントでは真偽が要り、ゴールのないスプリントでは `null`。合わなければ 400 の `invalid_input`）。持ち越し先に選べるのは、削除していない `planned` のうち、終えるスプリントの最終日より後に始まり、最終日がワークスペースの今日以降のもの（最終日を過ぎたスプリントは始められない。違えば 409 の `conflict`、理由は `carry_target`）。進行中でないスプリント（始まっていない、終了した。2つの画面から同時に終えた後の要求を含む）は 409（`not_active`）、スプリントか持ち越し先が無い（別の組織、別のワークスペース、削除したものを含む）は 404、閉じたワークスペースは 409（`workspace_closed`）。最終日の前でも終えられる。終えたスプリントは `closed_at`、`closed_by`、`is_goal_achieved`（真偽。ゴールがなければ空）を持ち、期間と中身を変えられない。入れる、外す（`sprint-task-add`、`sprint-task-remove`）は 409（`closed`）、列の移動（`task-column-move`）は 409（`not_active`）、完了を戻す（`task-reopen`）は 409（`sprint_closed`）、変更と削除（`sprint-update`、`sprint-delete`）は 409（`started`）で断る。理由の一覧は `src/shared/operations/sprint/sprint-close.ts` の `sprintCloseConflictReasons`。終えたスプリントの完了したタスクは、完了の列に残る。延長（`sprint-extend`）も 409（`not_active`）で断る。
- 延長（`sprint-extend`）はリーダー（管理者を含む）だけ。入力は `workspace_id`、`sprint_id`、`days`（1〜27 の整数）、`end_on`（画面が読んだ今の最終日。`YYYY-MM-DD`）、出力は `{ sprint, shifted }`。`sprint` は延長後の要約、`shifted` は押し出した `{ id, name, start_on, end_on }`（この4項目だけ）の開始日順。読んだ進行中のスプリントの最終日が入力の `end_on` と違えば（別の人が先に延ばした）、足さずに 409（`changed`）で断る。やり直しの中で進行中の最終日が変わっていたときも同じで、足し直さない（同じ `days` と `end_on` を2回送ると、2回目は `changed` で最終日は1回分だけ延びる）。押し出す後ろの行だけが変わったときは、同じ最終日から押し出しを計算し直してやり直す。今の最終日に日数を足し、削除していない `planned` のうち今の最終日より後に始まるものを開始日順に見て、直前の新しい最終日以前に始まるものだけ重なる日数（直前の新しい最終日 − 開始日 + 1）だけ開始日と最終日を後ろへずらす。長さは保ち、重ならないものが出たら止める。計算は `src/shared/sprint.ts` の純粋な関数を API とダイアログで共有する。延長後が28日を超えるか暦を外れれば 400（`invalid_input`）、閉じたワークスペースは 409（`workspace_closed`）で、進行中でないことの断り（`not_active`）より先に判定する（`sprint-update` が `planned` にゴールを送って断る `not_active` も同じ）。進行中でなければ 409（`not_active`）、動かせないスプリントと重なれば 409（`overlap`）、無いスプリントは 404。書けなければ読み直し、競合が続けば3回まで試し、超えたら 409（`changed`）。延長日数は `extended_days` に加算し、ベロシティから除く。
- 開始（`sprint-start`）はリーダー（管理者を含む）だけで、`planned` のスプリントを `active` にし、ゴールを書く（「書き込みの単位」の「スプリントの開始」）。進行中は同時に1つで、2つ目は 409 の `conflict`（`details.reason` は `active_exists`）。始まった、終了したスプリントは 409（`started`）。最終日がワークスペースの今日より前のスプリントは 409（`ended`）。一覧（`sprint-list`）、画面（`sprint-board`）、作成、変更、開始、延長の応答のスプリント要約は `goal` と `extended_days` も持つ。
- スプリントの画面の読み取り（`sprint-board`、`member`、読み取り）は、進行中のスプリント（`status = 'active'`、削除していない。無ければ `sprint` が `null` で列は空）、ワークスペースの削除していない列（`ORDER BY is_done, position, id`。完了の列は最後）、その列に入っているカードを1回の `batch()` で読む。カードは入っている削除していないタスクを `column_position`、`id` の順に並べ、親のストーリーの題と担当の名前を添える。完了したタスク（`completed_at` がある）は、`column_id` によらず完了の列に置く。削除した列を指す未完了のタスクは、先頭の完了でない列に置いて見失わない。ワークスペースのタイムゾーンでの今日（`today`）も返し、画面は「N 日のうち M 日目」と残りの日数を出す。閉じたワークスペースでも読める。
- カードの `reopenable`（完了を戻せるか）は、`task-reopen` と同じ判定（`src/server/operations/task-reopen.ts` の `reopenBlockOf`）で、バックログのタスクで（`tray = 'backlog'`）、完了していて、親のストーリーが完了していないとき真（スプリントは進行中のものだけを読む）。書き込めるか（閉じたワークスペースか）は画面が見る。

### sprint_entries

タスクとスプリントの所属の履歴。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| sprint_id | TEXT | NOT NULL、FK sprints | |
| task_id | TEXT | NOT NULL、FK tasks | |
| added_at | TEXT | NOT NULL | |
| added_by | TEXT | NOT NULL、FK users | |
| ended_at | TEXT | | 出た日時。外したとき、スプリントの削除とタスクの削除で戻ったとき、始まっていないスプリントの中で完了にしたときはその日時。スプリントの終了で閉じる行（`completed` と `carried_over`）は、終了の日時 |
| outcome | TEXT | `completed`、`carried_over`、`removed` | 完了、持ち越し、外した。入っている間は空 |

- 作ったのは `migrations/0008_add_sprint_entries.sql`（#238）。ほかのワークスペースの中の表と同じく `workspace_id` を持ち、読み書きする文はどれも `workspace_id` でも絞る（同じスプリントの ID を指す別の組織の行があっても触らない）。
- `CHECK ((ended_at IS NULL) = (outcome IS NULL))`。出た日時と出方は同時に書く。
- 一意: `(task_id) WHERE ended_at IS NULL`。1つのタスクが入っている行は1つ。
- 索引: `(workspace_id, sprint_id)`（スプリントの行を引く。スプリントの削除と終了）、`(task_id)`、`(added_by)`（外部キーの検査）。
- タスクの `sprint_id` があることと、そのタスクの入っている行（`ended_at` が空）が1つあることを常に一致させる（行の `sprint_id` はタスクの `sprint_id` と同じ）。入れる、外す、移す、スプリントの削除、タスクの削除、始まっていないスプリントの中の完了は、タスクと行を同じ `batch()` で書く。
- 完了では書かない。進行中のスプリントの中で完了したタスクは、`sprint_id` を持ったまま完了の列の末尾へ移り、行は開いたまま残る。このスプリントで何がいつ完了したかは `completions`（`sprint_id`、`completed_at`）から読む。完了を戻す（`task-reopen`）ときは列を戻すだけで、行を足さない。
- 始まっていない（`planned`）スプリントの中で完了したタスクは、同じ `batch()` でスプリントから外れ（行を `removed` で閉じ、`sprint_id`、`column_id`、`column_position` を空にする）、スプリントの外の完了になる（「書き込みの単位」の「タスクの完了」）。先のスプリントには完了したタスクが入らない。削除したスプリントを指す未完了のタスク（前の版に戻したときのスプリントの削除で残りうる）も、完了にすると同じく外れる。
- スプリントの終了（`sprint-close`）で、完了したタスク（`completed_at` がある。完了の列にある）の行を `completed`、残りを `carried_over` で閉じ、どちらの `ended_at` も終了の日時にする。持ち越し先がスプリントなら、持ち越すタスクの新しい行を足す（`added_at` は終了の日時）。
- 積載量では `outcome = 'carried_over'` の行を数えない。持ち越したタスクは最後に入ったスプリントでだけ数える。
- 入れる（`sprint-task-add`）と外す（`sprint-task-remove`）は、どちらもメンバー（`member`、書き込み）。入れられるのは、そのワークスペースのバックログ（`tray = 'backlog'`）の、未完了の、削除していないタスクで、入れる先は削除していない `planned` か `active` のスプリント。終了した（`closed`）スプリントへは入れられず、終了したスプリントからは外せない（409 の `conflict`、`details.reason` は `closed`。終了したスプリントの中身は変えない）。完了したタスクは外せない（409 の `conflict`、`details.reason` は `completed`。外したいときは先に完了を戻す）。理由の一覧は `src/shared/operations/sprint/sprint.ts` の `sprintTaskConflictReasons`。
- 入れたタスクは、削除していない列のうち先頭（`ORDER BY is_done, position, id` の最初）の列の、そのスプリントでの末尾の `column_position` に置く。まとめて入れるときは、送った順に並べる（`generateNKeysBetween`）。別のスプリントに入っているタスクは、前の行を `removed` で閉じて移す。ただし終了した（削除していない `closed` の）スプリントに入っているタスクは移さず、入れられないもの（`unavailable`）に数え、その行も閉じない（終了したスプリントの中身は変えない）。削除したスプリントを指すタスクは移せる。同じスプリントに既に入っているタスクは、何も書かずに飛ばす。同じ列の同じ `column_position` の行（同時に入れたもの）は `id` の順に並ぶ。
- まとめて入れる（入力はタスクの ID の配列。1回 200 件まで。ストーリーをまとめて入れる画面は、配下の未完了のタスクを送る）ときは、入れられるものだけを入れ、入れた件数（`added`）と、飛ばした件数を理由ごとに返す（`skipped`。`completed` は完了したもの、`unavailable` はそれ以外の入れられないもの（削除した、無い、別のワークスペースや別の組織、バックログにない、終了したスプリントに入っている。あるかどうかを漏らさないよう区別しない）、`already` は同じスプリントに既に入っていたもの）。ダイアログを開いてから送るまでに他の人が1件を完了にしただけで、全体が失敗しないようにするため。1件も入らず、既に入っていたものも無ければ、1件のときと同じエラーにする（終了したスプリントは 409 の `closed`、スプリントが無いか別の組織なら 404、入れられないタスクがあれば 404、完了したタスクだけなら 409 の `completed`）。
- 変更の履歴は、タスクごとに `entity_type = 'task'`、`action = 'update'`、`{"sprint": [前, 後]}` で残す。値は `{id, name}` か null で、`name` は書くときのスプリントの名前（読んだ値ではなく、書く文の中で `sprints` を結んで引く。`db/json-list.ts` の `sprintLogRefSql`）、名前が空なら期間（`YYYY-MM-DD〜YYYY-MM-DD`）。入れる、外す、移す、スプリントの削除で戻る、始まっていないスプリントの中の完了で外れるときに残す。タスクの削除では残さない（削除の行が残る）。
- スプリントを削除したら、入っていた行を `removed` で閉じ、タスクの `sprint_id`、`column_id`、`column_position` を空にする（「書き込みの単位」の「スプリントの削除」）。
- タスクを削除したら（エピックとストーリーの配下ごとの削除を含む）、入っていた行を `removed` で閉じ、タスクの `sprint_id`、`column_id`、`column_position` を空にする。取り込んだタスクをアーカイブへ移すときも同じ。

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
| sprint_id | TEXT | FK sprints | 完了したときに進行中（`active`）だったスプリント。スプリントの外で完了したら空。始まっていないスプリントの中で完了したタスクは、スプリントから外れるので空 |
| category_id | TEXT | FK categories | 完了した時点の区分（引き継いだもの） |
| billing_month | TEXT | | 計上月。月ごとに計上する区分のときだけ入る。リーダーが直せる |
| created_at、updated_at | TEXT | NOT NULL | |
| previous_column_id | TEXT | FK board_columns | 進行中のスプリントの中で完了したときに、完了の前にいた列。スプリントの外の完了では空。完了を戻す（`task-reopen`）ときにこの列の末尾へ戻す（空か、削除されているか、完了の列なら先頭の完了でない列） |

- 索引: `(workspace_id, completed_at)`、`(workspace_id, billing_month)`、`(sprint_id)`、`(task_id)`。
- 索引（外部キーの検査）: `(completed_by)`、`(assignee_user_id) WHERE assignee_user_id IS NOT NULL`、`(previous_column_id) WHERE previous_column_id IS NOT NULL`。
- `previous_column_id` は `migrations/0008_add_sprint_entries.sql`（#238）で足した。足す前の行は空。
- スプリントの集計（ベロシティ、ボス戦）は `sprint_id` で数える。始まる前に終えた仕事で、ベロシティが膨らまない。ベロシティの数え方は `sprints` の `plan-summary`。
- 未完了に戻したら行を消す。完了を戻す（`task-reopen`）は、そのタスクの行のうち `completed_at` が `tasks.completed_at` と同じ行を消す（「書き込みの単位」の「完了を戻す（`task-reopen`）の文と条件」）。ただし、レビュー依頼が再依頼されて未完了に戻るときは消さない。このため1つのタスクに複数の行がありうる。

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
- 送付は `thanks-send`、取り消しは `thanks-revoke`（ワークスペースの下の `write`、権限は `member`）。送れるのは今の担当で、担当が空なら作った人だけ。両方空なら誰も送れず、管理者も例外にしない（403）。受取人は同じ組織の無効でない人で、ログインの手段と ID が決まっていて（招待で待っている人は除く。担当の候補と同じ）、そのワークスペースに今所属していること（`memberships.left_at IS NULL`）。満たさない相手は、存在しないときと同じ 404。
- 送れるのは削除していない未完了のタスクだけ。自分宛て、同じタスクで同じ相手への重複、完了済みは 409 の `conflict`（`details.reason` は `self`、`duplicate`、`completed`）。取り消せるのは送った本人だけ（403）。担当が替わっても送った本人なら取り消せるが、完了済みは 409（`completed`）。無い、別組織、別ワークスペース、取り消し済みは 404。閉じたワークスペースはどちらも 409 の `workspace_closed`。
- `task-detail` の `thanks` は感謝の ID、送り手 `sender` と受取人 `recipient`（各 `{id, name}`）、`created_at`、呼んだ人が取り消せるか `can_revoke`。名前は組織の `users` の今の名前で、離脱後も残す。並びは `created_at`、`id` の昇順で、同じワークスペースのほかのメンバーにも返す。`can_send_thanks` は未完了で、呼んだ人が担当（空なら作った人）のときに真。閉じたワークスペースでは両方の権限フラグを偽にする。タスクの変更や担当変更の応答の詳細も同じ形。
- 送付と取り消しの履歴は `change_logs` に残す。これらの操作は経験値を付けない。文と条件は「書き込みの単位」の「感謝を送る」「感謝を取り消す」。

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
- 「同じタスクの同じ行動で有効な付与は1回だけ」は、上のキーと、付与の前に「打ち消されていない同じ行動の付与がないか」をアプリが見ることで守る。ストーリーの完了は例外で、付与の前に見ない。完了の文が `completed_at IS NULL` を条件にするので、完了の回ごとに1回しか通らず、回のキー（`completed_at` を含む）が一意制約で重複を止める（開発用の時計で同じ時刻に完了、取り消し、完了を流したときは、同じキーの行が残っているので付け直さない）。
- 起票、詳細、完了、手助けは、タスクを完了にしたときに同じバッチで付け、未完了に戻したときに同じバッチで打ち消す。
- ストーリーの完了（`story_completed`、`XP_STORY_COMPLETED` の 20）は、ストーリーを完了にしたときに同じバッチで付け、取り消したときに同じバッチで打ち消す。受け取るのは、配下の削除していないタスクで打ち消されていない完了の経験値（`task_completed`）を受け取った人のうち、今そのワークスペースに所属している人で、1人1回ずつ（`story_id` に元のストーリー、`task_id` と `completion_id` は空）。打ち消しの行は、元の行の `user_id`、`action`、`story_id` を写し、`amount` を負にして `reverses_grant_id` に元の行を指す。
- 手助け（`help`、`XP_HELP` の 10）は、タスクを完了にしたときに同じバッチで、そのタスクの感謝（`thanks`）1件につき1行を、感謝を受け取った人（`recipient_user_id`）に付ける。`thank_id` に元の感謝、`helper_sender_user_id` に送った人（`sender_user_id`）、`completion_id` にその完了の記録、`task_id` に元のタスクを入れる。未完了に戻したときは、起票、完了と同じく `completion_id` で見つけて同じバッチで打ち消す（打ち消しの行は元の行の `user_id`、`action`、`task_id`、`completion_id` を写し、`helper_sender_user_id` と `thank_id` は空）。完了にし直すと新しい `completion_id` で付け直す。ポイントが無いタスクにも付ける（ポイントの条件は起票と完了の経験値だけにある）。
- 感謝の回数の上限（`XP_HELP_WEEKLY_LIMIT` の 3）は、同じワークスペースの `action = 'help'` の行を `helper_sender_user_id` と `user_id`（受け取った人）で絞り、`confirmed_at` がワークスペースのタイムゾーンと週の始まり（`workspaces.week_start`）で完了と同じ週に入るものを数えて判定し、数が上限に満たなければ付ける。数えるのは打ち消されていない行だけで、`amount > 0` で、`reverses_grant_id` で別の行に指されていないもの。打ち消しの行（負の値）と、打ち消された元の行は数えないので、戻した分の枠は付け直しと同じ週のほかの完了に空く。週の範囲は SQLite がタイムゾーンを扱えないので、アプリが完了の時刻から計算し（`src/shared/clock.ts` の `weekRangeIn`。完了の時刻をワークスペースのタイムゾーンの日付にし、週の始まりの日の 0 時から7日後の 0 時を UTC にする）、始まり（含む）と終わり（含まない）を `confirmed_at` と同じ形の文字列で束縛する。
- 索引: `(user_id, workspace_id)`（`xp_grants_user_workspace`）、`(user_id, confirmed_at, id)`（`xp_grants_user_confirmed`）、`(user_id, workspace_id, amount)`（`xp_grants_user_workspace_amount`）、`(workspace_id, user_id)`、`(task_id)`、`(story_id)`、`(epic_id)`、`(reverses_grant_id)`。新しい2つは `migrations/0011_add_xp_grants_read_indexes.sql`（#296）で足した。`xp_grants_user_workspace` は残し、置き換えに伴う削除は縮める変更として別の PR（#560）で行う。`(workspace_id, user_id)` はチーム全体の合計とメンバーごとの合計に使う。`(user_id, workspace_id)` は `user_id` の外部キーの検査にも使う。
- 索引: `(helper_sender_user_id) WHERE helper_sender_user_id IS NOT NULL`。外部キーの検査。
- レベル、合計、チーム全体の合計は `SUM(amount)` で出す。読み方は次の「経験値の読み方」。

#### 経験値の読み方

`xp_grants` は `organization_id` を持たないので、どの読み取りも `workspaces` と結合して `workspaces.organization_id` を入口の組織で絞る（別の組織のワークスペースを指す行は数えない）。経験値の数値と明細は本人にだけ返し、ほかの人に返すのはレベルだけにする（`docs/requirements.md` の「ゲームの仕組み」）。ほかの人の数値を返す操作は作らない。

- 組織の合計: その組織のワークスペースの `xp_grants` のうち、`user_id` が本人の行の `SUM(amount)`。抜けたワークスペースと閉じたワークスペースの分も含む。行が無ければ 0。索引 `xp_grants_user_workspace_amount`（`user_id, workspace_id, amount`）だけで合計を出す。
- レベル: 組織の合計から `src/shared/experience.ts` の `levelOf` で出す（レベル `L` に達する合計は `50 × L × (L − 1)`、次のレベルまでに要るのは `100 × L`、合計が 0 を下回ってもレベル1、上限なし）。DB に列を持たず、読むたびに計算する。`levelProgressOf` が、今のレベルの始まり、次のレベルに要る合計、ゲージの割合（確定 = `(合計 − 今のレベルの始まり) / (100 × L)`、負なら 0。見込み = `見込み / (100 × L)` を残りの幅 `1 − 確定` で切る）を出す。
- 見込み: 今所属している（`memberships.left_at IS NULL`）閉じていないワークスペースで、本人が作った（`tasks.created_by`）、手で作った（`is_imported = 0`）、未完了（`completed_at IS NULL`）、削除していない（`deleted_at IS NULL`）、ポイントが1以上のタスク1件につき `XP_TASK_CREATED`（起票の経験値）。手で作ったタスクはいつもバックログにある（`tasks` の CHECK）ので、アーカイブで外れるものは無い（`tray = 'backlog'` の条件は結果を変えない念押しとして残す）。実行計画は、部分索引 `tasks_created_by_open`（`created_by`、`completed_at`）から本人の未完了のタスクだけを引き、`memberships_current` で今の所属を、`workspaces` の主キーで組織と閉じたかを確かめる。詳細の経験値の見込みは、詳細を作る Issue で足す。
- ワークスペースごとの内訳（`experience-summary` の `workspaces`）: 明細のあるワークスペースと、今所属しているワークスペース（閉じたものも含む。明細が無ければ 0）。各行はワークスペースの確定の合計と見込み。並びは名前の昇順、同じ名前は ID の昇順。2つの文（明細のあるワークスペースと、今の所属）の結果を処理の中で合わせて並べるので、SQL の `ORDER BY` ではなく JavaScript の文字列の比較（UTF-16 の符号単位の順）で決まる。組織の合計と見込みは、内訳の合計と同じ。
- 受け取った感謝の数（`experience-summary` の `thanks_received`。トップレベルが組織の合計、`workspaces` の各行がそのワークスペースの数）: `thanks` のうち `recipient_user_id` が本人の行をワークスペースごとに数える（索引 `thanks_recipient_user`）。結合した `workspaces.organization_id` を入口の組織で絞り、別の組織のワークスペースを指す行は数えない。抜けたワークスペースと閉じたワークスペースで受け取った分も数え、感謝があるのに明細も今の所属も無いワークスペースは、内訳に数だけを持つ行（`total` と `prospective` は 0）で出す。感謝を送った人は返さず、本人以外の応答（メンバーの一覧、組織の枠）にも載せない。手助けの経験値（`xp_grants`）とは別に数えるので、上限で経験値が付かなかった感謝も、手助けを打ち消した（完了を戻した）感謝も数える。
- 明細（`experience-grants`）: 本人の行を `confirmed_at` の降順、同じなら `id` の降順に、1回 50 件まで。続きは、前の応答の `next`（最後の行の `{confirmed_at, id}`。無ければ null）を `before` に渡し、`(confirmed_at, id) < before` で読む。`confirmed_at` はミリ秒まで UTC の形（`toISOString`）だけを受け付け、形の違うカーソルは 400。各行は ID、確定日時、ワークスペースの ID と名前、`action`、内容、`amount`（打ち消しは負の値。画面は元の行動に「の打ち消し」を添える）。内容は、付与が指すタスク、ストーリー、エピックのタイトル（この順に最初にあるもの。論理削除なので削除したものも出す。結合する行も付与と同じワークスペースに絞る）で、どれも指さない行は null。今所属していないワークスペース（抜けたワークスペースと、所属していない管理者のワークスペース。所属は `memberships.left_at IS NULL` の行があるかで見る）の行は、内容を null にして `content_hidden` を真にする。抜けた後に書き換わったタイトルを、所属していない人に読ませないため。ワークスペースの名前と値（自分の経験値）は出す。画面は「（今所属していない<ワークスペース>の内容は表示しません）」と出す。
- チーム全体の合計（`experience-team-total`）: そのワークスペースの `xp_grants` の `SUM(amount)` の1つの数（抜けた人の分も含む）。人ごとの値は返さない。索引 `(workspace_id, user_id)` に乗る。所属している人と管理者が読める。
  - 受け入れた制約: チーム全体の合計から、自分の内訳（`experience-summary` のそのワークスペースの合計）を引くと、ほかの人の合計の和が求まる。2人のワークスペースなら、もう1人の数値がそのまま分かる。要件の「チーム全体の合計は全員が見られる」と表裏の関係にあるので、少人数のワークスペースでは差し引きで分かることを受け入れ、合計をぼかしたり人数で出し分けたりはしない。
- メンバーの一覧（`member-list`）の各行の `level` と、組織の枠（`organization`）の `me.level`: その人の組織の合計から出したレベルだけを返し、合計は返さない。メンバーの一覧は、そのワークスペースに今所属している人ごとの組織の合計を、1つの文（`GROUP BY user_id`）で、所属を読む文と同じ `batch()` で読む。
- エピックの画面（`epic-detail`）の討伐隊の各行の `level`: メンバーの一覧と同じく、レベルだけを返し、合計は返さない。討伐隊は抜けた人も含むので、今の所属でなく討伐隊の行（`epic_party_members`）の人で絞って、1つの文で読む。
- 読む量: 明細は `xp_grants_user_confirmed`（`user_id, confirmed_at, id`）を逆順にたどり、`ORDER BY confirmed_at DESC, id DESC` のための一時 B-tree を作らず、条件に合う51行までを読む（50件と続きの有無を確かめる1件）。続きの頁は、カーソルを行値の比較 `(confirmed_at, id) < (?, ?)` で書くので、索引の範囲として直接その位置から読み、カーソルより新しい側の項目は読まない。組織の合計は `xp_grants_user_workspace_amount` の `COVERING INDEX` で本人の `workspace_id` と `amount` を読み、`xp_grants` の表の行は引かない。合計のために読む索引の項目数は本人の明細の総数に比例する。どちらも結合した `workspaces` で組織を確かめる。実際の文が使う索引と、明細の並べ替えが不要なこと、合計が索引だけで読めることは `test/schema.test.ts` の実行計画のテストで確かめる。

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
| workspace_id | TEXT | FK workspaces | 組織の変更（組織の作成、停止、再開、管理者の指名、ユーザーの無効化、組織の設定の変更、上限の変更）では空 |
| actor_user_id | TEXT | FK users | 空なら同期などの定期処理か運用者の操作 |
| operator | TEXT | | 運用者の操作（組織の作成、停止、再開、管理者の指名し直し、上限の変更）のときの運用者のログインの ID（`github:12345`、`google:<sub>` の形） |
| entity_type | TEXT | NOT NULL | `task`、`story`、`epic`、`comment`、`sprint`、`membership`、`invitation`、`allocation`、`connection`、`completion`、`user`、`workspace`、`organization`、`category`、`repository` など |
| entity_id | TEXT | NOT NULL | |
| action | TEXT | NOT NULL | `create`、`update`、`delete`、`complete`、`reopen`、`archive`、`close` など |
| changes_json | TEXT | NOT NULL、既定 `'{}'` | `{"列名": [前, 後]}`。人や列は ID と、そのときの表示名を並べて残す |
| created_at | TEXT | NOT NULL | |

- 索引: `(entity_type, entity_id, created_at)`、`(organization_id, created_at)`、`(workspace_id, created_at)`。
- 索引: `(organization_id, created_at, id) WHERE workspace_id IS NULL OR (entity_type = 'workspace' AND action IN ('create', 'close', 'reopen'))`（`change_logs_organization_history`、`migrations/0005_add_change_logs_organization_history_index.sql`、#193）。組織の変更の履歴（下）に出す行だけを持つ部分索引。
- 索引: `(actor_user_id) WHERE actor_user_id IS NOT NULL`。外部キーの検査。
- タスク、ストーリー、エピックの履歴はメンバー全員が、それ以外はリーダーと管理者が見られる。見られる範囲は `entity_type` で決める。
- タスクの履歴は `task-history`（`member`、読み取り）で読む。`entity_type = 'task'`、`entity_id`、`organization_id`、`workspace_id` で絞り、新しい順（`created_at` の降順、同じなら `id` の降順）に1回 50 件まで返す。`created_at` が同じ行（同じミリ秒の書き込み）の並びは `id`（UUIDv7 の時刻より後ろは乱数）で決まり、操作の順とは限らない。51 件目まで読み、続きがあれば `next`（`{ created_at, id }`）を返し、次は `before` に渡して `created_at < :c OR (created_at = :c AND id < :id)` で読む。索引は `change_logs_entity` でそのタスクの行（`entity_type`、`entity_id`）を引き、続きの条件はその中で絞る（1件のタスクの履歴は多くても数百行。`created_at` の範囲を書き足すと、SQLite が `change_logs_organization` か `change_logs_workspace` を選び、組織やワークスペースの全履歴を読むため）。閉じたワークスペースでも読める。無いタスク、削除したタスク（`docs/requirements.md` の「削除」のとおり画面から隠す。削除の行は、リーダーと管理者が見る変更の履歴の画面で出す）、別のワークスペース、別の組織のタスクは 404。返すのは、行ごとの `action`、`created_at`、変えた人（`actor`。組織で絞った `users` の今の名前の `{ id, name }` か、`actor_user_id` が空なら `null`。`actor_user_id` があっても組織で絞った `users` に行が無ければ、壊れた行として `null`）、変えた欄（`changes`。`changes_json` に保存した順の `{ field, before, after }`）と、時刻を出すワークスペースの `timezone`。値は `null`、文字列、数、`{ id, name }`（人、区分、リポジトリ、スプリント、親。親のストーリーの `{ id, title }` も `{ id, name }` にそろえる）で、感謝（`thanks`）も受取人の `{ id, name }` と `null` の組で返す。人や親の名前は `changes_json` に残したそのときの名前。本文（`body_md`）は長いので、値を返さず欄の名前だけを返す（`before` と `after` は `null`。読む文が `json_set` で `[null, null]` に置き換えてから読むので、全文を Worker へ運ばない）。人、区分、親の値は、ID があれば、名前が空か読めない（親のタイトルが `null` など）ときも落とさず `{ id, name: '' }` にする（画面は「不明」と出す）。欄ごとに決まった形に合わない値は `null` にし、知らない欄も落とさず欄の名前だけを返す。オブジェクトでない `changes_json` は変更なしとして扱う。
- 組織の変更の履歴（`organization-history`、管理者だけ。組織の管理の画面の「変更の履歴」）:
  - 出す行は、組織で絞った `workspace_id` が空の行（組織の作成、停止、再開、停止の理由の切り替え、上限の変更、管理者の指名と指名し直し、Google の招待の URL から結んだ記録のうち `users` のもの）と、`entity_type = 'workspace'` で `action` が `create`、`close`、`reopen` の行。所属、招待、タスクなど、ワークスペースの中の行は出さない。
  - 並びは `created_at` の新しい順で、同じ日時は `id` の大きい順。50件ずつ返し、51件目を読めたら、50件目の `created_at` と `id` を続きのカーソル（`next`）にする。次は入力の `before` にそのカーソルを渡し、`created_at <= :c AND (created_at < :c OR id < :id)` で続きを読む（重なりも抜けも無い）。期間で消さない表なので、カーソルをたどれば全部を読める。
  - 索引は部分索引 `change_logs_organization_history` を、組織の等号と `created_at` の範囲で使い、`created_at` と `id` の並べ替えも索引の順で済ませる。履歴の大半はワークスペースの中の行（タスクなど）なので、`(organization_id, created_at)` で引くと、組織の変更が少ない組織では、出さない行を読み飛ばし続けて組織の行のほとんどを読む。部分索引は出す行だけを持つので、読むのは返す51行までになる。SQLite は、問い合わせの条件が索引の条件と同じ式だと示せたときだけ部分索引を使い、束縛の値（`?`）の入った式からは示せないので、問い合わせは出す行の条件を索引と同じ式で、値を文字のまま書く（`src/server/db/organization-history-filter.ts`）。条件を変えるときは、索引を作り直すマイグレーションと一緒に変える。
  - した人は、`actor_user_id` があれば `users` の今の名前（`login_subject` の無い、Google の招待でログインを待つ行は名前がメールアドレスなので、名前を返さない）、無くて `operator` があれば「運用者」とだけ返し（`operator` の値は返さない）、どちらも空なら自動の処理。
  - 内容は `entity_type` と `action`（と `changes_json` の列）の組ごとに決めた種類で返し、`changes_json` はそのまま返さない。種類と返す値: 組織の作成（そのときの名前）、停止（消す予定日。一時的な停止は空）、再開、停止の理由の切り替え（切り替えた後の消す予定日）、組織の設定の変更（`organization` の `update` で `vocabulary` か `theme` の列）、管理者の指名（`user` の `create` で `is_admin` が 1 になったもの、と `update` で `is_admin` が 0 から 1 になったもの。名前は記録のそのときの名前で、ログインを待つ行の仮の名前と、メールアドレスに見える名前（`@` を含む）は使わず `users` の今の名前にし、ログインを待つ行ならまだ分からないので空）、前の指名の取り消し（運用者の記録（`operator` が空でなく `actor_user_id` が空）の `user` の `delete` で、`is_admin` が 1 から空になったもの。運用者が管理者を指名し直したときに消した、まだログインしていない前の指名。行は消えているので、名前は記録の前の値で、ログインを待つ行の仮の名前と `@` を含む名前は空。人がした `user` の `delete` は「その他」）、Google の招待で指名した人のログイン（本人（`actor_user_id` が `entity_id` と同じ）が空の `login_subject` を埋めた記録）、既にいる人へのまとめ（本人の記録で、列が `is_admin`（1 へ）と `disabled_at`（空へ）の2つだけのもの。別の管理者が有効に戻して管理者にした記録は「その他」）、管理者の解除（`is_admin` が 1 から 0）、ユーザーの無効化と有効化（`disabled_at` が空から日時、日時から空）、ワークスペースの作成（そのときの名前）、終了と再開（`workspaces` の今の名前）。どれにも当たらない組は「その他」で、値を持たない。人とワークスペースの名前は、同じ文で `users` と `workspaces` を組織で絞って結んで引く（別の組織の行を指せば空）。ログインの ID、`account_id`、メールアドレスは返さない。
  - 組織の設定の変更は、`organization-settings-update` が `organization` の `update`（`{"vocabulary": [前, 後], "theme": [前, 後]}` のうち変えた列）で書く。
  - 人数と添付ファイルの上限の変更は、`organization-quota-update` が `organization` の `update`（`member_limit`、`attachment_quota_bytes`、`attachment_quota_warned_at` のうち変わった列）で書く。専用の種類はまだ持たず、知らない組と同じく「組織を変更しました」と出す（した人は「運用者」）。
  - 管理者の指名と解除は `user-admin-update` が `{"is_admin": [前, 後]}` で、ユーザーの無効化は `user-disable` が `{"disabled_at": [null, 日時]}`（管理者なら同じ記録に `"is_admin": [1, 0]` も）で、有効化は `user-enable` が `{"disabled_at": [前の日時, null]}` で書く（どれも `user` の `update`、`workspace_id` は空、した人は操作した管理者）。管理者の無効化の記録は `is_admin` と `disabled_at` の両方を持つが、`is_admin` が 1 から 0、`disabled_at` が空から日時のものは無効化と読む（既にいる人へのまとめは、`is_admin` が 1 へ、`disabled_at` が空へで、本人の記録のものだけ）。形が合わない記録は「その他」として出る。
- コメントは、編集（`action = 'update'`）と削除（`action = 'delete'`）だけを `entity_type = 'comment'`、`entity_id` はコメントの ID で書く。作成は `comments` の行そのものが記録なので書かない。`actor_user_id` は直した人か消した人で、`changes_json` は `{"task_id": [<タスクの ID>, <同じ値>], "author": [{"id", "name"}, <同じ値>]}`（どのタスクの、誰が書いたコメントかだけ。コメントの行のこの2つは変わらないので、`{"列名": [前, 後]}` の形のまま前と後に同じ値を入れる。名前は書いた人のそのときの名前）。本文（前の本文も後の本文も）は入れない。消した後に中身がどこにも残らないようにするため。タスクの履歴（`task-history`）は `entity_type = 'task'` だけを読むので、コメントの行は出さない。
- コメントの変更の履歴（`entity_type = 'comment'`）は、今はどの画面も読まない。リーダーと管理者が見る変更の履歴の画面を作るときに拾う。
- 同期による取り込み元の属性の書き換えは残さない。量が多く、取り込み元で見られるため。
- 期間で消さず、残し続ける。容量が気になったら、手順書のエクスポート（`wrangler d1 export`）で退避する。

## 書き込みの単位

D1 は対話的なトランザクションを持たない。まとめて書く操作は D1 の `batch()` で1回に送る。`batch()` の中の文は1つのトランザクションとして全部が通るか全部が戻る。主な操作と、1回のバッチで書くもの。

| 操作 | 書くもの |
| --- | --- |
| タスクの完了 | `tasks`、`completions`、`xp_grants`（完了、起票、詳細、手助け）、`change_logs`、`notifications`。`sprint_entries` は書かない（進行中のスプリントの中の完了でも行は開いたまま。終了で閉じる）。ただし始まっていないスプリント（と削除したスプリント）の中の完了だけは、同じ `batch()` でスプリントから外す（`sprint_entries` を `removed` で閉じ、`change_logs` に `{"sprint": [前, null]}`）。文と条件は下の「タスクの完了（`task-complete`）の文と条件」 |
| タスクの作成 | `tasks`、`change_logs`。`tasks` の文は `INSERT ... SELECT ... WHERE EXISTS`（閉じていないワークスペース。担当を指すときは、そのワークスペースに今所属している、無効でなく `login_subject` のある人。親を指すときは、同じワークスペースの削除していない、完了していないストーリー）にし、`change_logs`（担当と親も残す）は作った行があるときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、親が完了していれば 409（`conflict`）、そうでなければ 404。担当つきで作るときは、続けて `epic_party_members` と `change_logs` を同じ `batch()` に足す（下の「タスクの担当の変更」の討伐隊の文と同じ。条件のタスクの時刻は作った時刻） |
| タスクの変更 | `tasks`、`change_logs`。ストーリーの変更と同じ書き方: 先に読んだ今の値と違う欄だけを `UPDATE` の `SET` に入れ（送られない欄は触らない）、条件は `id`、`workspace_id`、`deleted_at IS NULL`、閉じていないワークスペースと、書く欄ごとの `<列> IS :読んだ値`。`change_logs`（`entity_type = 'task'`、`action = 'update'`、変わった列だけの `{"列": [前, 後]}`）は、直前の `UPDATE` が行を変えたときだけ入れる（`INSERT ... SELECT ... WHERE changes() > 0`。下の「直前の文に結ぶ」）。欄は `title`、`points`、`due_on`、`link_url`、`body_md`、`category_id`、`repository_id` で、担当（下の「タスクの担当の変更」）は変えない。区分とリポジトリは、同じワークスペースの削除していないものだけで（書く文の条件にも `EXISTS` を入れる。無ければ 404）、履歴は `{"category": [前, 後]}`、`{"repository": [前, 後]}`（値は `{id, name}` か null）。区分は親のないタスクだけが持ち、親のあるタスクへ送ると読んだ時点で 409（`conflict`、理由は `has_parent`）、書く文は `story_id IS NULL` も条件にする（読んでから書くまでに親の下へ移されたら、次の周の読み直しで 409）。断る変更は読んだ時点で 409（`conflict`）にする: 完了したタスク（`completed_at IS NOT NULL`）のポイント（経験値とスプリントの集計が `completions.points` を使うため。同じ値を送るだけなら断らない）と、取り込んだタスク（`is_imported = 1`）のタイトルとリンク。ポイントを書く文は `completed_at IS NULL` も条件にし、読んでから書くまでに完了にされたら止める（次の周の読み直しで 409）。何も入らなければ、閉じていれば 409（`workspace_closed`）、タスクが無ければ 404、どちらでもなければ（別の要求が先に同じ欄を変えた）読み直して差を作り直し、やり直す（3 回まで。超えたら 409 の `conflict`）。変える欄が無い要求は何も書かず、閉じたワークスペースは 409 にする |
| タスクの担当の変更 | `tasks`（`assignee_user_id`、`today_on`、`updated_at`）、`change_logs`。`task-assign` が、読んだ担当と違う担当（か `NULL`）を送られたときだけ書く。`tasks` の文は `assignee_user_id` を書き、同じ文で `today_on` を `NULL` にする。条件は `id`、`workspace_id`、`deleted_at IS NULL`、`completed_at IS NULL`、`assignee_user_id IS :読んだ担当`、`today_on IS :読んだ値`、閉じていないワークスペースと、新しい担当を指すときは、その人がそのワークスペースに今所属していて、無効でなく `login_subject` があること（`EXISTS`）。`change_logs`（`entity_type = 'task'`、`action = 'update'`、`{"assignee": [前, 後]}`。前と後は `{"id", "name"}`（そのときの名前）か `null`。`today_on` が入っていたら `"today_on": [前の日付, null]` も）は、直前の `UPDATE` が行を変えたときだけ入れる。読んだ時点で、タスクが無ければ 404、同じ担当なら何も書かない（閉じたワークスペースは 409 の `workspace_closed`）、完了していれば 409（`conflict`）、新しい担当が今所属していなければ 404。何も入らなければ、閉じていれば 409（`workspace_closed`）、タスクが無いか新しい担当が所属を外れていれば 404、どちらでもなければ（別の要求が先に担当か今日やるの印を変えた、完了にした）読み直してやり直す（3 回まで。超えたら 409 の `conflict`）。担当を付けるとき（`NULL` でないとき）は、続けて同じ `batch()` に討伐隊の2文を足す。`epic_party_members` は、タスクの親のストーリーの親の、進行中（削除、クリア、中止していない）のエピック（ストーリーもエピックも同じワークスペースで、ストーリーは削除していない）に、担当を `joined_via = 'task_assignee'`、`added_by` を呼んだ人で `INSERT ... SELECT ... ON CONFLICT DO NOTHING` する（既に討伐隊にいれば、入り方を問わず何もしない）。条件は、直前の文（タスクの履歴）が行を足した（タスクの更新が通った）ことと、タスクの行が今その担当でこの要求の `updated_at` であること。親のないタスク、エピックの下でないストーリーのタスクでは、行を選ばないので何も入らない。その後の `change_logs`（`entity_type = 'epic'`、`{"party_member": [null, {"id", "name", "via": "task_assignee"}]}`）は、直前の `INSERT` が行を足したときだけ入れる。担当を外すときと、前の担当は討伐隊から外さない |
| 感謝を送る、取り消す | `thanks`、`change_logs`。文と条件は下の「感謝を送る」「感謝を取り消す」 |
| タスクの削除 | `tasks`（`deleted_at` と `updated_at`。スプリントに入っていれば `sprint_id`、`column_id`、`column_position` も空にする）、`change_logs`（`action = 'delete'`、`{"deleted_at": [null, <日時>]}`）、`sprint_entries`（入っていれば、その行を `removed` で閉じる。`tasks` の文でこの要求が削除した（`deleted_at` が自分の時刻）ことを条件にし、履歴の後ろに置く）。論理削除なので、`completions`、`xp_grants`（経験値）は残す。バックログの木のストーリーごとの合計（削除していないタスクだけ）からは外れる。削除できるのは、手で作ったタスクの作った人（`tasks.created_by`）とリーダー（管理者を含む）で、権限が無ければ 403（`forbidden`）。取り込んだタスクは、権限があっても 409（`conflict`）で削除できず（アーカイブで外す。`docs/requirements.md` の「削除」）、`task-detail` の `can_delete` も偽にする。タスクが無ければ（別の組織、別のワークスペース、削除済みを含む）権限より先に 404。`tasks` の文の条件は `id`、`workspace_id`、`deleted_at IS NULL`、閉じていないワークスペースで、`change_logs` は直前の `UPDATE` が行を変えたときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 404（別の要求が先に削除した） |
| ストーリーの作成 | `stories`、`change_logs`。`stories` の文は `INSERT ... SELECT ... WHERE EXISTS`（閉じていないワークスペース）にし、`change_logs` は作った行があるときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 404 |
| ストーリーの変更 | `stories`、`change_logs`。先に読んだ今の値と違う欄だけを `UPDATE` の `SET` に入れる（送られない欄は触らない）。条件は `id`、`workspace_id`、`deleted_at IS NULL`、閉じていないワークスペースと、書く欄ごとの `<列> IS :読んだ値`（読んでから書くまでに別の要求が同じ欄を変えていたら、更新は通らない。履歴の「前」がずれるのと、同じ値の指定の取りこぼしを防ぐ）。`change_logs` は、この更新の `updated_at` と書いた値が入った行があるときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、ストーリーが無ければ 404、どちらでもなければ（別の要求が先に同じ欄を変えた）読み直して差を作り直し、やり直す（3 回まで。超えたら 409 の `conflict`）。読み直して書くものが無くなれば、何も書かずに今の値を返す。変える欄が無い要求も、閉じたワークスペースは 409 にする |
| タスクの移動 | `tasks`（移す行と、同じ値の続きの振り直し）、`change_logs`（親が変わったときだけ）。移す行の文は条件つきの `UPDATE`（読んだときの親のまま、閉じていないワークスペース、移す先の親が今もある、直前の行が読んだ値の位置にある）。振り直し（40 行まで）と `change_logs` は、移す行の更新が通ったことを条件にする。何も変わらなければ、閉じていれば 409（`workspace_closed`）、無ければ 404、そうでなければ理由つきの 409（`conflict`）。決まりは `tasks` の「並べ替えと親の移動」 |
| ストーリーの移動 | `stories`（移す行と、同じ値の続きの振り直し）、`change_logs`（親が変わったときだけ）。形はタスクの移動と同じで、親はエピック |
| ストーリーの完了 | `stories`、`change_logs`、`xp_grants`（ストーリーの完了。受け取り手1人に1行）。先に、ストーリー、配下の未完了のタスクの件数、受け取り手（配下の削除していないタスクの、打ち消されていない `task_completed` の付与を受けた、今所属している人）を1回の `batch()` で読む。`stories` の文は条件つきの `UPDATE`（`id`、`workspace_id`、`deleted_at IS NULL`、`completed_at IS NULL`、閉じていないワークスペース、`NOT EXISTS (配下の削除していない未完了のバックログのタスク)`、`NOT EXISTS (今の親の、削除していない、完了か中止したエピック)`、`NOT EXISTS (読んだ受け取り手の外の受け取り手)`。読んだ受け取り手は JSON の配列1つで渡し、`json_each` で開く。人数によらず bind は1つで、D1 の1文あたりの上限（100）に当たらない）。`change_logs` は直前の `UPDATE` が行を変えたときだけ入れ（下の「直前の文に結ぶ」）、`xp_grants` は、その履歴の行（この要求だけの `id`）があることと、受け取る人の元の付与が今も打ち消されておらず所属していること、同じ `dedupe_key` の行が無いことを条件にする。何も変わらなければ、閉じていれば 409（`workspace_closed`）、そうでなければ読み直して、無ければ 404、完了していれば 409（`completed`）、親のエピックが完了か中止していれば 409（`parent_completed`）、未完了のタスクがあれば 409（`open_tasks`）、どれでもなければ（受け取り手が増えた）読み直した受け取り手でやり直す（3 回まで。超えたら 409 の `changed`） |
| ストーリーの完了の取り消し | `stories`、`change_logs`、`xp_grants`（打ち消し。元の付与1行に1行）。先に、ストーリー（完了した日時と完了にした人の名前、親のエピックの完了と中止）と、打ち消されていない `story_completed` の付与を読む。`stories` の文は条件つきの `UPDATE`（`completed_at = 読んだ値`、読んだときの親のまま、閉じていないワークスペース、親がエピックならそのエピックが完了も中止もしていない）。完了した日時が読んだ値のままなら、読んでから書くまでに新しい付与は入らない（入るのは、取り消してからもう一度完了にしたときだけ）。`change_logs` は直前の `UPDATE` が行を変えたときだけ入れ、打ち消しの行は、その履歴の行があることと、元の行の打ち消しがまだ無いことを条件にする。何も変わらなければ、閉じていれば 409（`workspace_closed`）、無ければ 404、完了していなければ 409（`not_completed`）、親が完了か中止していれば 409（`parent_completed`）、どれでもなければ 409（`changed`） |
| エピックの作成 | `epics`、`change_logs`。ストーリーの作成と同じ書き方（`INSERT ... SELECT ... WHERE EXISTS`（閉じていないワークスペース）、履歴は作った行があるときだけ） |
| エピックの移動 | `epics`（移す行と、同じ値の続きの振り直し）。形はストーリーの移動と同じで、親が無いので `change_logs` は書かない。並べるのは削除していないエピック（完了と中止を含む） |
| エピックの変更 | `epics`、`change_logs`。ストーリーの変更と同じ書き方（変える欄ごとの `<列> IS :読んだ値`、通らなければ読み直してやり直す。3 回まで）。`change_logs` は、直前の `UPDATE` が行を変えたときだけ入れる（下の「直前の文に結ぶ」） |
| 討伐隊の受注と割り振り | `epic_party_members`、`change_logs`。`epic-party-join`（呼んだ人を `self` で）と `epic-party-assign`（相手を `assigned` で）。`epic_party_members` の文は `INSERT ... SELECT ... WHERE ... ON CONFLICT DO NOTHING` で、条件は、同じワークスペースの削除、クリア、中止していないエピック、閉じていないワークスペース、加わる人がそのワークスペースに今所属し、無効でなく `login_subject` があること（`EXISTS`）と、割り振りでリーダー（管理者を含む）でない人なら、エピックの依頼主が今も呼んだ人であること（読んでから書くまでに依頼主が替わった競合を止める）。同時の受注でも主キーで1行になる。`change_logs`（`{"party_member": [null, {"id", "name", "via"}]}`）は直前の `INSERT` が行を足したときだけ入れる。読んだ時点で、エピックが無ければ 404、割り振りで依頼主でもリーダーでもなければ 403（`forbidden`）、加わる人が入れる人でなければ 404、終わったエピックなら 409（`conflict`）、既にいれば何も書かない。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ読み直して同じ順で決め直す（3 回まで。超えたら 409 の `conflict`） |
| 討伐隊を抜ける | `epic_party_members`、`change_logs`。`epic-party-leave` が呼んだ人の行を、読んだ入り方（`joined_via IS :読んだ値`）のまま、同じワークスペースの削除、クリア、中止していないエピックと、閉じていないワークスペースを条件に消す。`change_logs`（`{"party_member": [{"id", "name", "via"}, null]}`。`via` は消した行の入り方）は直前の `DELETE` が行を消したときだけ入れる。読んだ時点で、エピックが無ければ 404、終わったエピックなら 409（`conflict`）、討伐隊にいなければ何も書かない。消せなければ、閉じていれば 409（`workspace_closed`）、そうでなければ読み直して決め直す（3 回まで） |
| エピックとストーリーの削除 | 根の `epics` か `stories`（`deleted_at`、`updated_at`）と、配下の `stories`、`tasks`、`change_logs`（決まりは `epics` の「削除」）。先に根を読み（作った人。無ければ 404、権限が無ければ 403）、リーダーと管理者でない人の `delete` なら他の人の作った配下を探し（あれば 403 の `others_children`）、書く文を子の数によらない決まった数（エピックの `keep` は4文、`delete` は9文、ストーリーの `keep` は4文、`delete` は7文）で1回の `batch()` に並べる。どの文も同じ前提（組織の閉じていないワークスペースで、根が削除されていない。リーダーと管理者でない人の `delete` なら、さらに他の人の作った配下が無い）を、1行を返す副問い合わせの `EXISTS` で条件に持つ。`UPDATE ... FROM` の文は、書く表の側も `workspace_id` で絞る。配下のタスクは `story_id` で `tasks_story` の索引に乗せ、エピックの配下は `FROM stories CROSS JOIN tasks` で、配下のストーリーを `stories_workspace_epic` で引いてからタスクを引く（`INNER JOIN` や `story_id IN (...)` では、SQLite が `tasks_workspace_tray` でワークスペースの全タスクを走査する計画を選ぶ。`test/tree-delete.test.ts` が実行計画で確かめる）。並びは、子の履歴、子の書き込み、根の `UPDATE`、根の履歴の順。子の行ごとの履歴は表ごとに1つの `INSERT ... SELECT` で入れ（ID は SQL の中で UUIDv7 の形に作る。区分とリポジトリの削除と同じ）、子を書き換える前に置く（書き換えた後は配下の条件に当たらなくなる）。根の `UPDATE` を子の文より前に置くと、後ろの文は根が削除されていることを条件にするしかなく、止めた時計（`DEV_NOW`）では先の要求の削除と自分の削除を見分けられないので、最後に置く。1つのトランザクションの中で条件は変わらないので、子の文が書けば根の `UPDATE` も通り、根の `UPDATE` が通らなければ子の文も何も書いていない。根の履歴は直前の `UPDATE` に結ぶ（下の「直前の文に結ぶ」）。`keep` は、子の履歴と、子を親なしにする `UPDATE ... FROM`（子ごとの写す区分と末尾の位置を、窓関数 `row_number()` で元の並びの順番を振った副問い合わせで作る）。`delete` は、配下のタスク（手で作ったものと取り込んだもの）のスプリントに入っている行を `removed` で閉じる `UPDATE`、手で作ったタスクの削除の履歴、取り込んだタスクのアーカイブの履歴、取り込んだタスクをアーカイブの末尾へ移す `UPDATE ... FROM`、手で作ったタスクの論理削除（スプリント、列、列の中の位置も空にする）、（エピックなら）ストーリーの削除の履歴と論理削除。タスクの文は配下のストーリーで絞るので、ストーリーの文より前に置く。根の `UPDATE` が行を変えなければ読み直して、閉じていれば 409（`workspace_closed`）、根が無ければ 404（読んでから書くまでに別の要求が先に削除した）、他の人の作った配下が移されてきていれば 403（`others_children`）。配下の件数に上限は置かない。文の数は決まっていても1文が書く行は配下の数に比例し、木の想定（1ワークスペースに数百件）の範囲では1回の `batch()` で書ける。数万件の配下を1回で消すと D1 の1回の実行の時間の上限に当たりうるが、`batch()` ごと戻るので木は壊れない（その規模を扱うときに上限か分け方を決める）。取り込んだタスクをアーカイブへ移すときは `sprint_id`、`column_id`、`column_position` を空にし、入っている行（`ended_at IS NULL`）は最初の文で閉じる（`sprint` の変更の履歴は残さない。削除とアーカイブの履歴が残る） |
| スプリントの作成 | `sprints`、`change_logs`（`action = 'create'`、`{"name": [null, …], "start_on": [null, …], "end_on": [null, …]}`。名前が空なら `name` を入れない）。`sprints` の文は `INSERT ... SELECT ... WHERE EXISTS (閉じていないワークスペース) AND NOT EXISTS (期間の重なるスプリント)` にし、`change_logs` は直前の文が行を入れたときだけ入れる（下の「直前の文に結ぶ」）。何も入らなければ、閉じていれば 409（`workspace_closed`）、重なるスプリントがあれば 409（`conflict`、`overlap`）、どちらでもなければ 404 |
| スプリントの変更 | `sprints`、`change_logs`。エピックの変更と同じ書き方で、変える列は、`planned` では `name`、`start_on`、`end_on`、`active` では `name` と `goal`（長さだけを送ると、今の開始日から最終日を決め直す。開始日だけを送ると、今の長さのまま最終日もずらす）。条件は `id`、`workspace_id`、`deleted_at IS NULL`、`status = :読んだ状態`、閉じていないワークスペースと、書く列ごとの `<列> IS :読んだ値`、期間を変えるときは `start_on` と `end_on` の両方の `IS :読んだ値`（片側だけを書くときも。最終日と重なりの検査を読んだ期間から決めるため）と `NOT EXISTS (期間の重なるほかのスプリント)`。`change_logs`（変わった列だけの `{"列": [前, 後]}`）は直前の `UPDATE` が行を変えたときだけ入れる。何も変わらなければ、閉じていれば 409（`workspace_closed`）、無ければ 404、終了したか進行中に期間を送れば 409（`conflict`、`started`）、始まっていないものにゴールを送れば 409（`conflict`、`not_active`）、重なれば 409（`conflict`、`overlap`）、どれでもなければ読み直してやり直す（3 回まで。超えたら 409 の `conflict`） |
| スプリントの削除 | `sprints`（`deleted_at` と `updated_at`）、`change_logs`（`action = 'delete'`、`{"deleted_at": [null, <日時>]}`）、入っていたタスクをバックログへ戻す3文。条件は `id`、`workspace_id`、`deleted_at IS NULL`、`status = 'planned'`、閉じていないワークスペースで、`change_logs` は直前の `UPDATE` が行を変えたときだけ入れる。戻す3文は、子の数によらない決まった数の文で、どれもこの要求がスプリントを削除した（`sprints.deleted_at` が自分の時刻）ことを条件にする: 1. 入っていた削除していないタスクごとの `change_logs`（`entity_type = 'task'`、`action = 'update'`、`{"sprint": [前, null]}`。前の名前は書くときの今の名前を `sprints` から引く）を `INSERT ... SELECT` の1文で（ID は SQL の中で作る）、2. `sprint_entries` の入っている行（`workspace_id` とスプリントで絞る）を `removed` で閉じる、3. タスクの `sprint_id`、`column_id`、`column_position` を空にする。履歴を先に置く（戻した後は、入っていた条件に当たらなくなるため） |
| スプリントへ入れる | `change_logs`、`sprint_entries`（前の行を閉じる `UPDATE` と、入った行の `INSERT`）、`tasks`（`sprint_id`、`column_id`、`column_position`、`updated_at`）。操作は `sprint-task-add`（メンバー）。先にスプリント、送られたタスク、先頭の列、その列のスプリントでの末尾を1回の `batch()` で読み、入れられるタスクと飛ばす理由を分ける（決まりは `sprint_entries` の節）。書く文は送られたタスクの数によらない4文で、送られたタスクの ID は JSON の配列1つで渡す（`json_each`。bind は1つ）。どの文も同じ前提（閉じていないワークスペース、入れる先が削除していない `planned` か `active`、読んだ先頭の列が削除されていない）と、タスクごとの条件（そのワークスペースの、バックログの、未完了の、削除していない、このスプリントに入っていない、終了した（削除していない）スプリントに入っていない）を持つ。1. タスクごとの `change_logs`（`{"sprint": [前, 後]}`。前は今入っているスプリント、後は入れる先を結び、どちらも書くときの今の名前を SQL の中で作る）、2. 入っている行（別のスプリントのもの。`workspace_id` で絞り、終了したスプリントの行は閉じない）を `removed` で閉じる、3. 入った行を足す（ID は SQL の中で作る）、4. タスクを書く（列の中の位置は、タスクごとの値を JSON の組の一覧から引く）。1〜3 はタスクを書き換えないので、4 まで同じタスクに当たる。4 が書いた件数が入れた件数で、読んだ時点で入れられるとしたタスクより少なければ（読んでから書くまでに、別の要求が完了にした、削除した、同じスプリントへ入れた、またはスプリントか列かワークスペースが変わった）、入れられなかったタスクを読み直して理由ごとに数え直す。1件も入らなければ、閉じていれば 409（`workspace_closed`）、スプリントが無ければ 404、終了していれば 409（`closed`）、スプリントもタスクも入れられるまま（読んだ先頭の列が書く前に消えたなど）なら読み直してやり直し（3 回まで。超えたら 409 の `conflict`）、そうでなければ数え直した理由で 1件のときと同じエラー |
| スプリントから外す | `tasks`（`sprint_id`、`column_id`、`column_position` を空にし、`updated_at`）、`change_logs`（`{"sprint": [前, null]}`）、`sprint_entries`（入っている行を `removed` で閉じる）。操作は `sprint-task-remove`（メンバー）。先にスプリントとタスク（そのスプリントに入っている削除していないもの）を読み、無ければ 404、スプリントが終了していれば 409（`closed`）、完了していれば 409（`completed`）。`tasks` の文の条件は `id`、`workspace_id`、`sprint_id = :スプリント`、`completed_at IS NULL`、`deleted_at IS NULL`、閉じていないワークスペース、スプリントが削除していない `planned` か `active`。`change_logs`（スプリントの名前は書くときの今の名前を `sprints` から引く）は直前の `UPDATE` が行を変えたときだけ入れ、`sprint_entries`（`workspace_id` で絞る）はこの要求がタスクを書いた（`updated_at` が自分の時刻で `sprint_id` が空）ことを条件にする。何も変わらなければ、読み直して同じ順で理由を返し、どれでもなければ 409（`conflict`） |
| 区分とリポジトリの作成と変更 | `categories` か `repositories`、`change_logs`。作成は `INSERT ... SELECT ... WHERE`（閉じていない、同じ名前が無い、数が 50 未満）、変更は読んだ値のままで同じ名前が無いことを条件にした `UPDATE`。`change_logs` は直前の文が行を変えたときだけ入れる。並べ替えは `tasks` の移動と同じ文で、`change_logs` を書かない |
| 区分とリポジトリの削除 | `categories` か `repositories`（`deleted_at`、`updated_at`）、`change_logs`（定義の `delete` と、振っていた行ごとの `update`）、振っていた `epics`、`stories`、`tasks` の `category_id` か `tasks` の `repository_id` を空にする `UPDATE`。振っていた行の履歴と戻す文は、表ごとに1文（`INSERT ... SELECT` と `UPDATE`）で、どちらも自分の削除が通った（`deleted_at` が自分の時刻）ことと、今振っている削除していない行であることを条件にし、履歴を先に置く。削除の文の条件は、閉じていないことと削除していないこと。`completions` は変えない |
| 完了を戻す | `tasks`（`completed_at`、`completed_by` を空にし、進行中のスプリントの中で完了したタスクは `column_id`、`column_position` も戻す）、`change_logs`（`action = 'reopen'`）、`xp_grants`（その完了の記録で付いた付与の打ち消し）、`completions` の削除。`sprint_entries` は書かない。操作は `task-reopen`（メンバー）。文と条件は下の「完了を戻す（`task-reopen`）の文と条件」 |
| スプリントの開始 | `sprints`（`status = 'active'`、`goal`、`started_at`、`started_by`、`updated_at`）、`change_logs`（`entity_type = 'sprint'`、`action = 'update'`、`{"status": ["planned", "active"], "goal": [null, …]}`。ゴールを書かなければ `goal` を入れない）。操作は `sprint-start`（リーダー。管理者を含む）で、入力は `workspace_id`、`sprint_id`、`goal`（任意）。先に `planned` のスプリントを読み、無ければ 404、`active` か `closed` なら 409（`conflict`、理由は `started`）。先にワークスペースのタイムゾーンでの今日を求め（`sprint-list` の初期値と同じ求め方）、最終日が今日より前なら 409（`ended`）で断る。`sprints` の文の条件は `id`、`workspace_id`、`deleted_at IS NULL`、`status = 'planned'`、`end_on >= :今日`（読んだ今日の値を渡すので、判定と書き込みで今日がずれない）、閉じていないワークスペース、そのワークスペースに進行中（`status = 'active' AND deleted_at IS NULL`）のスプリントが無いこと（`NOT EXISTS`）。D1 は書き込みを1つずつ流すので、2つの画面から別のスプリントを同時に始めても、後の文は先に始まった行を見て何も書かず、一意の索引 `sprints_active` が最後の砦になる。`change_logs` は直前の `UPDATE` が行を変えたときだけ入れる。何も変わらなければ、閉じていれば 409（`workspace_closed`）、読み直して無ければ 404、`planned` でなければ 409（`started`）、最終日が今日より前なら 409（`ended`）、進行中が既にあれば 409（`active_exists`）、どれでもなければ 409（`conflict`）。入っているタスクの列と位置は変えない（入れたときの先頭の列のまま） |
| カードの列の移動 | `tasks`（`column_id`、`column_position`、`updated_at`。移す行と、同じ値の続きの振り直し）、`change_logs`（列が変わったときだけ）。操作は `task-column-move`（メンバー）で、入力は `workspace_id`、`task_id`、`column_id`（移す先。今の列でもよい）、`after_task_id`（移す先の列の中で直前に置くカード。`null` は先頭、省くと末尾）。位置はサーバーが移す先の列の隣のカード（同じスプリントの、その列の削除していないタスクから移す行を除いたもの）から決める（`tasks` の「並べ替えと親の移動」と同じ決まりで、`column_position` に当てる。同じ値の行は 40 行まで振り直し、超えれば 409 の `ties`）。断るもの。タスクが無い、スプリントに入っていない、移す先の列が無い、直前のカードが移す先の列に無い（別の組織、別のワークスペースを含む）ときは 404、直前が自分自身なら 400（`invalid_input`）、完了の列へは 409（`conflict`、理由は `done_column`。完了にするのは `task-complete`）、完了したタスクは 409（`task_completed`）、スプリントが進行中でなければ 409（`not_active`）、閉じたワークスペースは 409（`workspace_closed`）。移す行の文は条件つきの `UPDATE`（読んだときのスプリントと列のまま、未完了、スプリントが進行中のまま、閉じていないワークスペース、移す先の列が今も完了でない列として在る、直前のカードが読んだ値の位置にある）。書く文は、振り直し、移す行の更新、履歴の順に並べる。振り直しと移す行の更新は同じ「移せる状態」の条件（上の `UPDATE` の条件を `EXISTS` にしたもの）を持つので、断られた要求は振り直しも書かない。時刻や位置の一致では、同じミリ秒に同じ先へ移す別の要求と区別できないため、自分の更新かどうかを時刻で決めない。履歴は列が変わったときだけ `{"column": [{id, name}, {id, name}]}` を残し、直前の `UPDATE` が行を変えたときだけ入れる（`previousStatementChanged`）。列の中の並べ替えは残さない（`task-move` と同じ）。何も変わらなければ、閉じていれば 409（`workspace_closed`）、読み直して上の順で理由を返す。同じ移動の要求が2回届いた（二重送信、再送）ときは、先の要求が通った後に2つ目の更新が列の条件で何も書かない。読み直したカードが既に移す先の列にいて、求められた位置（`after_task_id` が指すカードの直後、`null` なら先頭、省けば末尾）に収まっていれば、何も書かず履歴も足さずに成功として返す。どれでもなければ 409（`changed`）。先頭（`null`）と末尾（省略）へ移すときは、読んだ端のカードがまだ端にいることを条件にしない。2人が同じ列の同じ端へ同時に移すと2枚が同じ値になり、並びは移した順でなく `id` の順になるが、行は壊れず、次に間へ入れるときに振り直す。端に隣が無いので確かめる相手が無く、その数ミリ秒の競合で並びが1つ入れ替わるだけのため、断らずに受け入れる。位置を決める隣のカードと直前の確かめでは、削除した列を指す未完了のカード（列の削除で移し損ねたもの）は先頭の完了でない列に数える（スプリントの画面の読み取りと同じ。列の削除（`column-delete`）はカードを移してから消し、書く文の条件で移し損ねを止めるので、ふつうは無い。終了したスプリントの行は削除した列を指したまま残るが、スプリントの画面は進行中のものだけを読む。見失わないための備え） |
| スプリントの延長 | 1回の `batch()` で `sprints` と `change_logs` を書く。最初の `UPDATE` は進行中の `end_on`、`extended_days`（加算）、`updated_at`。条件は `status = 'active'`、`deleted_at IS NULL`、`end_on IS :読んだ値`、`extended_days IS :読んだ値`、閉じていないワークスペース。読んだ値は、入力の `end_on` と一致したことを確かめた行の値。全押し出し対象が削除していない `planned` のままで開始日と最終日が読んだ値のままであることも最初の文で検査する。全対象の更新後の期間がほかの削除していないスプリント（終了したものと押し出さないものを含む。自分を除く）と重ならない `NOT EXISTS` を持つ。同じバッチで動かす行は更新後の期間で比較する。この重なりの検査は全対象の全組み合わせを見る重い式なので、最初の `UPDATE` だけに置く。後ろの `UPDATE` は直前の文に結ばれ、同じ `batch()` の中は別の要求に割り込まれないため、最初の文が通れば重ならない。対象の一覧は JSON で渡し、bind 数を一定にする。JSON の1行は `id`、`status`、`start_on`、`end_on`、`extended_days`、`next_start_on`、`next_end_on` だけにする。各 UPDATE の後に変更の履歴（`entity_type = 'sprint'`、延長は `{"end_on": [前, 後], "extended_days": [前, 後]}`、押し出しは `{"start_on": [前, 後], "end_on": [前, 後]}`）を置き、直前の文が行を書いたときだけ次の文が通る（`changes()`）。押し出す UPDATE は状態と読んだ期間を条件にし、直前の文に結んで `start_on`、`end_on`、`updated_at` を書く。最初の文で全条件を確かめるため、一部だけ書かれない。失敗後は読み直して `workspace_closed`、404、`not_active`、`changed`（進行中の最終日が入力の `end_on` と違う）、`overlap` を判定し、どれでもなければ同じ最終日から再計算して再試行する（3回まで。超えれば `changed`） |
| スプリントの終了 | `sprints`（`status = 'closed'`、`closed_at`、`closed_by`、`is_goal_achieved`、`updated_at`）、`change_logs`、`sprint_entries`（入っている行を閉じる `UPDATE` と、持ち越し先がスプリントなら新しい行の `INSERT`）、持ち越すタスクの `tasks`（`sprint_id`、`column_id`、`column_position`、`updated_at`）。操作は `sprint-close`（リーダー。管理者を含む）で、入力は `workspace_id`、`sprint_id`、`carry_sprint_id`、`is_goal_achieved`、出力は `{ sprint_id, carried_count, carry_to }`（`carry_to` は持ち越し先の `{ id, name, start_on, end_on }`、バックログは `null`）。先に1回の `batch()` で、スプリント、入っている削除していない未完了のタスクの ID（終えるスプリントでの並びの順。列の順（`board_columns` を結んで `ORDER BY is_done, position, id`）、`column_position`、`id`）、持ち越し先のスプリント、先頭の列、ワークスペースのタイムゾーン、持ち越し先の先頭の列の末尾の `column_position` を読む（末尾の位置も同じ `batch()` で読むので、1往復で済む。読んでから書くまでに別の要求が同じ列の末尾へ入れると位置が重なるが、重なった行は `id` の順に並び、次に間へ入れるときに振り直す）。スプリントが無ければ 404、`active` でなければ 409（`conflict`、`not_active`）、ゴールの有無と `is_goal_achieved` が合わなければ 400（`invalid_input`）、持ち越し先が無ければ 404、`planned` でないか、`start_on <= 終えるスプリントの end_on` か、`end_on <` ワークスペースの今日（最終日を過ぎたスプリントは `sprint-start` が始められない）なら 409（`carry_target`）で断る。書く文は持ち越すタスクの数によらない決まった数（バックログへなら5文、スプリントへなら新しい行を足す1文を加えた6文）で、持ち越すタスクの ID の一覧と、持ち越し先に置く位置（ID と位置の組の一覧）は JSON の配列1つで渡す（`json_each`。bind は1つなので、1文の bind の上限（100）にも `batch()` の大きさにも当たらず、分けない。JSON は1件100バイトほど。手元の miniflare の D1 で測ると、未完了のタスク 253 件を先のスプリントへ持ち越すのに 0.5 秒ほど、バックログへ戻すのに 0.03 秒ほど、1003 件で 1.2 秒ほどと 0.03 秒ほどで、件数にほぼ比例する（`test/sprint-close.test.ts` が 250 件で件数、並び、行、履歴を確かめる）。本番の D1 では測っていない）。1. `sprints` の `UPDATE`。条件は `id`、`workspace_id`、`deleted_at IS NULL`、`status = 'active'`、`goal IS :読んだゴール`、`end_on = :読んだ最終日`（延長で最終日が動いたら、持ち越し先の判定を読み直す）、閉じていないワークスペース、未完了のタスクの集合が読んだものと同じこと（読んだ以外の未完了のタスクが無く、読んだものが全部ある）、持ち越し先が削除されていない `planned` のままで、終えるスプリントの最終日より後に始まり、最終日が読んだ今日以降であること（今日は読んだ値を渡すので、判定と書き込みでずれない）、持ち越し先の列が削除されていないこと。2. スプリントの `change_logs`（`entity_type = 'sprint'`、`action = 'update'`、`{"status": ["active", "closed"], "is_goal_achieved": [null, 真偽]}`。ゴールが無ければ `status` だけ）は、直前の `UPDATE` が行を変えたときだけ入れる（下の「直前の文に結ぶ」）。3 以降は、この履歴の行（この要求だけの `id`）があることを自分の条件にする。止めた時計（`DEV_NOW`）では、先に終えた要求と自分の終了を時刻や値で見分けられず、負けた要求の文も通ってしまうため。3. 持ち越すタスクごとの `change_logs`（`entity_type = 'task'`、`{"sprint": [前, 後]}`。バックログへなら後は `null`。スプリントの名前は書くときの今の名前を `sprints` から引く）。4. 入っている行（`workspace_id` とスプリントで絞る）を、完了したタスク（`completed_at` がある）は `completed`、それ以外は `carried_over` で閉じる（`ended_at` は終了の日時）。5. 持ち越し先がスプリントなら、持ち越すタスクの新しい行を足す（`added_at` は終了の日時、`added_by` は終えた人）。6. 持ち越すタスクの `tasks` を書く（持ち越し先がスプリントなら、[ID, 位置] の組の JSON を `json_each` で行にした副問い合わせを `UPDATE ... FROM` で `tasks.id` に結ぶ。位置を相関副問い合わせで行ごとに引くと件数の2乗に比例して遅くなるため、書くのは `sprint_id`、先頭の列、位置。バックログなら三つとも空にする普通の `UPDATE`）。3〜5 はタスクを書き換えないので、6 まで同じタスクに当たり、履歴を先に置く（書き換えた後は条件に当たらなくなるため）。持ち越すタスクは、終えるスプリントでの並びの順に、持ち越し先の先頭の列の末尾へ並べる（`generateNKeysBetween`）。完了したタスクは `sprint_id`、列、位置を変えず、終えたスプリントの完了の列に残る。1 が行を変えなければ、閉じていれば 409（`workspace_closed`）、そうでなければ読み直して（上の順で 404、`not_active`、`carry_target` を返す）、どれでもなければ（未完了のタスクが入った、外れた、完了した。持ち越し先の先頭の列が消えた）やり直す（3回まで。超えたら 409 の `conflict`、理由は `changed`）。返す `carried_count` は6の件数 |
| 列の作成、名前の変更、並べ替え | `board_columns`、`change_logs`（作成と名前の変更だけ。`entity_type = 'workspace'`、`action = 'update'`、`{"column": [null, {id, name}]}` と `{"column": [{id, name: 前}, {id, name: 後}]}`。並べ替えは残さない）。操作は `column-create`、`column-update`、`column-move`（どれもリーダー。管理者を含む）。条件と理由は `board_columns` の節。作成は `INSERT ... SELECT ... WHERE`（閉じていないワークスペース、同じ名前の削除していない完了以外の列が無い、削除していない完了以外の列が 12 未満）、名前の変更は `UPDATE`（`is_done = 0`、読んだ名前のまま、同じ名前が無い、閉じていないワークスペース）、並べ替えは `categories` と同じ（直前の列が今も読んだ位置にあることを条件にした `UPDATE` と、同じ値の振り直し）。履歴は直前の文が行を変えたときだけ入れる。何も変わらなければ、閉じていれば 409（`workspace_closed`）、読み直して無ければ 404 を返す。残りは操作で分ける。作成は同じ名前があれば 409（`duplicate_name`）、数が上限なら 409（`limit`）、どれでもなければやり直さず 409（`changed`）。並べ替えは直前の列が読んだ位置から動いていれば、やり直さず 409（`changed`。同じ値が多すぎれば `ties`）。名前の変更は同じ名前があれば 409（`duplicate_name`）、どれでもなければ読み直してやり直す（3回まで。超えれば `changed`）。応答の `column` の `task_count` は、書いた後に `column-list` と同じ集計で読み直した値 |
| 列の削除 | `board_columns`（`deleted_at`、`updated_at`）、`change_logs`（ワークスペースの1行と、移したタスクごとの行）、`tasks`（`column_id`、`column_position`、`updated_at`）。操作は `column-delete`（リーダー。管理者を含む）で、入力は `workspace_id`、`column_id`、`target_column_id`（移すタスクがあるときだけ要る）、出力は `{ column_id, moved_count }`。先に1回の `batch()` で、削除する列、ほかの完了以外の列の有無、移し先の列、移すタスク（進行中と先のスプリントの未完了。列の中の順）、移し先の列のスプリントごとの末尾の `column_position` を読み、`assertDeletable` で 404、`done_column`、`last_column`、`target_invalid`、`target_required` を決める。書く文は移すタスクの数によらない決まった数（最大4文）で、移すタスクの ID の一覧と、移し先に置く位置（ID と位置の組。スプリントごとに末尾から `generateNKeysBetween` で振る）は JSON の配列で渡す（`json_each`。`sprint-close` と同じ）。1. `board_columns` の `UPDATE`。条件は `id`、`workspace_id`、`deleted_at IS NULL`、`is_done = 0`、読んだ `name`、閉じていないワークスペース、ほかに削除していない完了以外の列がある（同時に2つ消して完了以外が0になるのを止める。D1 は書き込みを1つずつ流すので、後の文は先の削除を見て何も書かない）、移し先が今も削除していない完了以外の列である、読んだ以外の移すタスクがこの列に残っていない（読んだ後に入ったタスクを置き去りにしない）。2. ワークスペースの `change_logs`（`{"column": [{id, name}, null], "target_column": [null, {id, name}]}`。移すタスクが無ければ、移し先を送っても `target_column` を入れない）は、直前の `UPDATE` が行を変えたときだけ入れる。3 以降は、この履歴の行（この要求だけの `id`）があることを条件にする（止めた時計 `DEV_NOW` でも、先に削除した要求と見分けられるように。`sprint-close` と同じ）。3. 移すタスクごとの `change_logs`（`{"column": [{id, name}, {id, name}]}`。名前は書くときの今の名前を `board_columns` から引く）。4. 移すタスクを書く（`UPDATE ... FROM` で `tasks.id` に結ぶ。条件は今も削除した列にいる未完了のタスクで、タスクの `sprint_id` が読んだ値のままであり、そのスプリントが削除されておらず `planned` か `active` であること。読んだ後に終了したスプリントのカードや、別のスプリントへ移ったカードは書かない。JSON は [ID, 位置] の組と [ID, スプリントの ID] の組の2つで、3 の履歴にも同じ条件を持たせる）。3 は 4 より前に置く（書き換えた後は条件に当たらなくなるため）。移すタスクが無ければ 3 と 4 は書かない。1 が行を変えなければ、閉じていれば 409（`workspace_closed`）、読み直して上の順で理由を返し、どれでもなければ（読んだ後に列かタスクが変わった）やり直す（3回まで。超えれば 409 の `changed`）。終了したスプリントのカードと、完了したタスクは書かない |
| エピックのクリア | `epics`、`xp_grants`（クリア報酬）、`change_logs` |
| ロールの付け替え | `memberships`（`role`）、`change_logs`（`entity_type = 'membership'`、`entity_id` は所属の ID、`action = 'update'`、`{"role": [前, 後]}`）。操作は `membership-role-update`（リーダー。管理者は所属していなくても通る）で、入力は `workspace_id`、`user_id`（`member-list` の各行の `id`）、`role`。相手は `member-list` に出る人（そのワークスペースに今所属し、無効でなく、`login_subject` がある）だけで、それ以外（別の組織の ID を含む）は 404。同じロールなら何も書かずに今の値を返す。`memberships` の文の条件は所属の ID、`workspace_id`、`user_id`、`left_at IS NULL`、`role = :読んだロール`、相手が一覧に出る人であること、閉じていないワークスペース、呼んだ人が今も権限を持つこと（`EXISTS (同じ組織の無効でない管理者。users.is_admin = 1 AND disabled_at IS NULL) OR EXISTS (このワークスペースの今のリーダー。memberships.left_at IS NULL AND role = 'leader')`。登録の関数が確かめた権限は読み取りの時点の値なので、読んでから書くまでに外された人の要求を書く文で止める）で、`change_logs` は直前の文が行を変えたときだけ入れる（下の「直前の文に結ぶ」）。何も変わらなければ、閉じていれば 409（`workspace_closed`）、読み直して所属が無ければ 404、呼んだ人がもう権限を持たなければ 403（`forbidden`）、そうでなければ 409（`conflict`）。自分を一般に戻すことも、リーダーが0人になる付け替えも止めない（リーダーのいないワークスペースでは管理者が任命する） |
| メンバーの離脱 | `memberships`（`left_on`、`left_at`）、所属の `change_logs`、担当を外すタスクごとの `change_logs`、担当を外す `tasks`（`assignee_user_id`、`today_on`、`updated_at`）を1回の `batch()` で書き、所属が終わったときだけ、続けて組織の道具の `endSessionsIfLoginLost` で、入れる組織を失った人の共通の DB の `sessions` を消す（応答を待たせない `defer`）。操作は `membership-leave`（一般）で、入力は `workspace_id`、`user_id`。相手は `member-list` に出る人だけで、それ以外（別の組織の ID、もう抜けた人を含む。所属していない管理者が自分を指したときも）は 404。自分なら誰でも抜けられ、他人を外せるのはそのワークスペースのリーダーと管理者だけで、一般のメンバーは 403（`forbidden`）。1. `memberships` は所属の ID、`workspace_id`、`user_id`、`left_at IS NULL`、閉じていないワークスペースと、他人を外すときは呼んだ人が今も権限を持つこと（ロールの付け替えと同じ `EXISTS`。自分が抜けるときは見ない）を条件に、`left_on`（ワークスペースのタイムゾーンの今日）と `left_at` を書く。2. 所属の `change_logs`（`entity_type = 'membership'`、`action = 'delete'`、`{"user": [{"id", "name"}, null], "role": [前のロール, null]}`。所属の作成の対で、人のそのときの名前とロールは終えた行から取る）は、1 が行を変えたときだけ入れる。3. 担当を外すタスクの `change_logs` は、タスクの担当の変更と同じ形（`{"assignee": [{"id", "name"}, null]}`、`today_on` が入っていれば `"today_on": [日付, null]` も）を、`INSERT ... SELECT` の1文で、そのワークスペースの未完了で削除していない、その人が担当のタスクのすべてに書く（ID は行ごとに SQL の中で作る）。4. `tasks` は 3 と同じタスクの担当と今日やるの印を空にする。3 と 4 は「この要求で所属が終わった（その所属の行の `left_at` がこの要求の時刻）」を条件にし、履歴を先に置く。2 の `memberships` は所属の ID とワークスペースで絞る。1 が書けなければ、閉じていれば 409（`workspace_closed`）、読み直して所属が無ければ 404（先に抜けた。二重の離脱）、他人を外す人がもう権限を持たなければ 403（`forbidden`）、そうでなければ 404。完了したタスク、`completions`、`xp_grants` は変えない。リーダーが0人になる離脱も止めない。討伐隊（`epic_party_members`）の文は #267、接続（`connections`）の文は #67 でこの `batch()` に足す |
| 管理者の指名と解除 | `users`（`is_admin`、`updated_at`）、`change_logs`（`entity_type = 'user'`、`action = 'update'`、`workspace_id` は空、`{"is_admin": [前, 後]}`）を1回の `batch()` で書く。操作は `user-admin-update`（管理者）で、入力は `user_id`、`is_admin`。相手は同じ組織の `login_subject` のある行だけで、それ以外（別の組織の ID、Google の指名でログインを待つ行）は 404。同じ値なら何も書かずに今の値を返す。無効の人の指名は 409（`conflict`、`details.reason` は `disabled`）。管理者は組織の人数（`organizations` の「人数」）に数えるので、指名の前に招待と同じ関数（`seatHoldersOf`、`readSeats`）で人数を数え、相手がまだ数えられておらず（その人の `personKey` が集合に無い）、人数が `member_limit` 以上なら 409（`conflict`、`details.reason` は `member_limit`）。所属しているか、数えられる承諾待ちの招待を持つ人は、上限でも指名できる。人数は招待と同じく書く文の条件に入れない（数えてから書くまでの間に同時に指名か招待をして超えたときは、そのまま認める。超えるのは同時に送った数まで）。解除は上限を見ない。1. `users` は ID、組織、`login_subject IS NOT NULL`、読んだ `is_admin` のままであること、指名なら `disabled_at IS NULL`、解除なら「同じ組織に、ほかに無効でなく `login_subject` のある管理者がいる」`EXISTS`、呼んだ人が今も無効でない管理者である `EXISTS` を条件にする。2. 記録は 1 が行を変えたときだけ入れる。1 が書けなければ読み直し、相手が無ければ 404、解除で相手がまだ管理者で、ほかに管理者がいなければ 409（`last_admin`。呼んだ人も解除されていても、こちらを先に見る。2人が同時にお互いを解除したときの後の要求は呼んだ人の `EXISTS` で、それぞれ自分を解除したときの後の要求はほかの管理者の `EXISTS` で止まり、どちらもこれになる）、呼んだ人がもう管理者でなければ 403（`forbidden`）、相手が既に送った値なら今の値を返し、そうでなければ 409（`conflict`）。自分の解除は、最後の管理者でなければできる |
| ユーザーの無効化 | `users`（`disabled_at`、管理者なら `is_admin = 0`、`updated_at`）、ユーザーの `change_logs`、承諾待ちの招待の取り消しの `change_logs` と `invitations`（`status`、`responded_at`）、所属の終わりの `change_logs`、担当を外すタスクごとの `change_logs`、担当を外す `tasks`（`assignee_user_id`、`today_on`、`updated_at`）、`memberships`（`left_on`、`left_at`）を1回の `batch()` で書き、続けて組織の道具の `endSessionsIfLoginLost` で、入れる組織を失った人の共通の DB の `sessions` を消す（応答を待たせない `defer`）。操作は `user-disable`（管理者）で、入力は `user_id`。相手は管理者の指名と同じく同じ組織の `login_subject` のある行だけで、ほかは 404。自分は 409（`conflict`、`details.reason` は `self`）。無効の人なら何も書かずに今の値を返す。1. `users` は ID、組織、`login_subject IS NOT NULL`、`disabled_at IS NULL`、読んだ `is_admin` のまま、自分でないこと、管理者なら「ほかに無効でなく `login_subject` のある管理者がいる」`EXISTS`、呼んだ人が今も無効でない管理者である `EXISTS` を条件にする。2. ユーザーの記録（`{"disabled_at": [null, 日時]}`、管理者なら `"is_admin": [1, 0]` も。`workspace_id` は空）は 1 が行を変えたときだけ入れる。3. 招待の取り消しの記録（招待の取り消しと同じ `{"status": ["pending", "revoked"]}`、`workspace_id` は招待のワークスペース）と 4. `invitations` は、組織のすべてのワークスペースの、その人の `login_provider` と `login_subject` への承諾待ちの招待。5. 所属の終わりの記録（メンバーの離脱と同じ形）、6. 担当を外すタスクの記録（メンバーの離脱と同じ形）、7. `tasks`（未完了で削除していない、その人が担当のタスク）、8. `memberships`（今の所属）は、閉じたものも含めた組織のすべてのワークスペースに当てる（読み取り専用は利用者の操作の決まりで、管理者の無効化は組織の操作として書く）。3〜8 は「この要求で無効になった（`users.disabled_at` がこの要求の時刻）」を条件にし、記録は変える文より前に置く。行の ID は SQL の中で作り、件数によらず文の数は決まっている。離脱日（`left_on`）はワークスペースのタイムゾーンの今日で、SQLite はタイムゾーンを扱えないので、先に今の所属のワークスペースのタイムゾーンを読み、ワークスペースの ID ごとの日付を1つの JSON の値で文に渡す（読んだ後に足された所属は UTC の今日。参加日より前にはしない）。1 が書けなければ読み直し、相手が無ければ 404、相手が管理者で、ほかに管理者がいなければ 409（`last_admin`）、呼んだ人がもう管理者でなければ 403（`forbidden`）、相手が既に無効なら今の値を返し、そうでなければ 409（`conflict`）。完了したタスク、`completions`、`xp_grants` は変えない。離脱と同じく、リーダーが0人になる無効化も止めない。閉じたワークスペースでも最後のリーダーを外すので、開き直すとリーダーのいないワークスペースになり、管理者が新しいリーダーを任命する（組織の管理の画面の「リーダーがいない」の印）。討伐隊（`epic_party_members`）の文は #267、接続（`connections`）の文は #67 でこの `batch()` に足す |
| ユーザーの有効化 | `users`（`disabled_at` を空に、`updated_at`）、`change_logs`（`{"disabled_at": [前の日時, null]}`、`workspace_id` は空）、無効にする前に作った招待の取り消しの `change_logs` と `invitations` を1回の `batch()` で書く。招待の2文は、無効化の 3 と 4 と同じ形で、その人の `login_provider` と `login_subject` への承諾待ちの招待のうち `created_at` が読んだ `disabled_at` より前のものに当て、「この要求で有効に戻した（`updated_at` がこの要求の時刻で `disabled_at` が空）」を条件にする（`users` の節の限界も参照）。操作は `user-enable`（管理者）で、入力は `user_id`。相手は管理者の指名と同じで、有効な人なら何も書かずに今の値を返す。`users` の条件は ID、組織、`login_subject IS NOT NULL`、読んだ `disabled_at` のまま、呼んだ人が今も無効でない管理者である `EXISTS`。記録は直前の文が行を変えたときだけ入れる。所属と管理者の指名は戻さない（入るには招待し直すか、指名し直す）。書けなければ読み直し、相手が無ければ 404、呼んだ人がもう管理者でなければ 403、既に有効なら今の値を返し、そうでなければ 409（`conflict`） |
| 取り込み（1件） | `tasks`（結ばれたリポジトリがあれば `repository_id` も）、`task_sources`、`task_source_payloads` |
| 組織の作成 | 共通の DB の `organizations`、続けて組織の DB の最初の管理者の `users` と `change_logs` の2行（組織の作成と管理者の指名） |
| 組織の設定の変更 | 共通の DB の `organizations`（`vocabulary`、`theme`、`updated_at`）を、それだけの `batch()` で書き、続けて組織の DB の `change_logs` を別の `batch()` で書く。`organizations` の文の条件は `id`、`suspended_at IS NULL`、書く欄ごとの `<列> IS :読んだ値`。同じ `batch()` の後ろで組織の行の `suspended_at` を読む（書く文と同じ時点の状態）。変わった行が無ければ `change_logs` は書かず、読んだ値で、停止していれば（入ってから書くまでに運用者が停止した）403 の `organization_suspended`、そうでなければ（別の要求が先に変えた）409 の `conflict` を返す。停止していて読んだ値も古いときは、停止を先に返す。操作は `organization-settings-update`（管理者）で、入力は `vocabulary` と `theme` のどちらか1つ以上（無ければ 400）で、それぞれ画面が見ていた前の値と書く値の組（`{ from, to }`）。`from` が入るときに引いた組織の行の値と違えば（ほかの管理者が先に変えた）、どの項目も書かずに 409 の `conflict`。`from` と `to` が同じ項目は書かず、書く文の条件にも入れない。管理者かどうかは入るときに確かめた値で決め、`organizations` の文の条件には入れない（共通の表の文に組織の中の `users` を結合しないため）。入ってから書くまでの間に管理者を外されたり無効にされたりした人の要求は、1回だけ通りうる（ワークスペースを閉じる操作のように、書く文で呼んだ人を確かめる形は取れない）。書く項目が無ければ何も書かずに今の値を返す。返すのは書いた後の `{ vocabulary, theme }`。`change_logs` は `entity_type` が `organization`、`entity_id` が組織の ID、`workspace_id` と `operator` が空、`actor_user_id` が管理者の `users` の ID、`action` が `update`、`changes_json` が変えた項目だけの `{"vocabulary": [前, 後], "theme": [前, 後]}`。`change_logs` の `batch()` が例外を投げたときは、`organizations` の値を正として成功を返し、ログに操作、`action`、組織の ID、`changes_json` と同じ前後の値、操作の日時、例外の名前だけを出す（欠けた行はこのログから手で補える）。`organizations` を書いた後に処理そのものが止まったとき（Worker の打ち切りなど）は、履歴もログも残らない |
| 組織の停止、再開、停止の理由の切り替え | 共通の DB の `organizations`（`suspended_at`、`purge_on`、`updated_at`）、続けて組織の DB の `change_logs` の1行。`organizations` の `UPDATE` は今の状態を条件にする（停止は `suspended_at IS NULL`、再開は読んだ `suspended_at` と同じ、理由の切り替えは停止中で、読んだ `purge_on` と同じ）。再開と理由の切り替えには、消す予定日を過ぎていないこと（`purge_on IS NULL OR (purge_on >= <今日の UTC の日付> AND purge_on >= date('now'))`。束縛値の日付は `now()` から作り、開発用の時計で境目を確かめられるようにする。D1 の `date('now')` も見るのは、Worker と D1 の時計が UTC の 0 時をまたいでずれても、消す SQL のガードが真の組織を必ず外すため。`src/server/db/purge-due.ts`）も条件に足す。読んだ時点で過ぎていれば書く前に 409 の `purge_due` で断る。条件に外れたら（`changes` が 0）、組織を読み直し、停止中で `purge_on` が今日（UTC。Worker の日付か D1 の `date('now')` のどちらか）より前なら 409 の `purge_due`（読んだ後に日付が変わったとき）、そうでなければ 409 の `conflict` で、どちらも `change_logs` は書かない。理由の切り替えは `suspended_at` を変えず、解約にすると `purge_on` を切り替えた日の UTC の日付の30日後に、一時的な停止にすると空にする。今と同じ理由（`purge_on` が空かどうかで決まる）への切り替えも 409。`change_logs` は `entity_type` が `organization`、`entity_id` が組織の ID、`workspace_id` と `actor_user_id` が空、`operator` が運用者のログインの ID。`action` と `changes_json` は、停止が `suspend` と `{"suspended_at": [前, 後], "purge_on": [前, 後]}`、再開が `resume` と同じ形、理由の切り替えが `update` と `{"purge_on": [前, 後]}`。`change_logs` の書き込みに失敗しても、`organizations` の状態を正として成功を返す（ログには操作、`action`、組織の ID、`changes_json` と同じ前後の値、操作の日時、例外の名前だけを出し、欠けた行は運用者がログから手で補う） |
| 人数と添付ファイルの上限の変更（運用者） | 共通の DB の `organizations`（`member_limit`、`attachment_quota_bytes`、上げたときの `attachment_quota_warned_at`、`updated_at`）、続けて組織の DB の `change_logs` の1行。操作は `organization-quota-update`（運用者）で、入力は `slug`、`member_limit`（1〜10,000 の整数）、`attachment_quota_bytes`（1 以上、100 TB（100 × 1024⁴ バイト）以下の整数）と、画面が見ていた前の値 `expected: { member_limit, attachment_quota_bytes }`（同じ範囲）。0 以下と範囲の外は 400（`invalid_input`）。応答は `slug`、`member_limit`、`attachment_quota_bytes` だけ。値段の段階（小さい組織 15 人・30 GB、標準 50 人・100 GB。1 GB = 1024³ バイト）は画面だけが知る共通の定数（`quotaTiers`）で、サーバーは値だけを受ける。無い slug は 404。停止中の組織も変えられ、人数を今の人数より小さくしてもよい（今いる人は残り、招待と管理者への指名だけが止まる）。今の値が送った値と同じなら（`expected` が違っても）何も書かず、履歴も残さずに今の値を返す。それ以外で今の値が `expected` と違えば（ダイアログを開いた後に別の運用者が変えた）409 の `conflict`。`UPDATE` は `expected` の `member_limit` と `attachment_quota_bytes` のままであることを条件にし、外れたら（`changes` が 0）409 の `conflict` で、`change_logs` は書かない。添付ファイルの上限を上げたときだけ `attachment_quota_warned_at` を空に戻し（読んだ値のままであること（空なら `IS NULL`）も条件にし、外れたら 409。履歴の前の値と実際に消した値をそろえるため）、下げたときは触らない（合計（#68）がまだ無いので、80% を下回ったかは見ない）。`change_logs` は停止と同じく `entity_type` が `organization`、`action` が `update`、`operator` が運用者のログインの ID で、`changes_json` は変わった列だけの `{"member_limit": [前, 後], "attachment_quota_bytes": [前, 後], "attachment_quota_warned_at": [前, null]}`（通知の日時は、空でなかった値を空に戻したときだけ入れる）。書き込みに失敗しても成功を返す扱いは停止と同じ |
| 管理者の指名し直し（運用者） | 共通の DB の `organizations` を slug で読み（無ければ 404）、停止中で `purge_on` が今日（Worker の `now()` の UTC の日付か、D1 の `date('now')` のどちらか）より前なら、GitHub に問い合わせる前、招待の URL を作る前に 409 の `purge_due` で断る（消している途中で組織の中に行を足さないため。境目は組織の再開と同じ）。書くのは組織の DB で `organizations` と同じ `batch()` に混ぜられないので、書く文の条件にはできず、読んでから組織の DB に書くまでの間に日付が変わる窓は塞げない（その窓で書かれた行は、消す手順を流し直せば消える）。続けて、GitHub は `account_logins` を引いた後に、組織の DB の `users` と `change_logs` を1回の `batch()` で書く（共通の表と混ぜない。書く関数は `reassignOrganizationAdmin`）。先に、指名する人の行と前の指名（`account_id` が空の行）を1つの文で読む。書く文は、指名（新しい行は組織の作成と同じ `users` と `change_logs` の2行。既にいる人は、読んだ `is_admin` と `disabled_at` を条件にした `UPDATE`（`is_admin = 1`、`disabled_at` を空）と、変えた列ごとの `change_logs` の `user` の `update`（`{"disabled_at": [前, null]}` と `{"is_admin": [0, 1]}` を別の行に。履歴の「有効化」と「管理者の指名」に当たる）。既にいる行がアカウントに結ばれておらず、指名する人が既にアカウントを持つときは、同じ `UPDATE` で `account_id` も埋める（条件に読んだ `account_id` の空も入れる。結ぶことは記録に残さない。ログインの結び直しと同じ）。既に有効な管理者で結ぶアカウントも無ければ書かない）と、前の指名の `change_logs` の `user` の `delete` を `INSERT ... SELECT` で消す行ごとに作り（`{"is_admin": [1, null], "name": [名前, null], "login_provider": [手段, null], "login_subject": [ID, null]}`。Google の待つ行は名前を仮の名前にし、`login_subject`、メールアドレス、秘密のハッシュ、期限を入れない）、その後に `DELETE` する。続けて、所属を持つ前の指名の印を外す2つの文（管理者の解除の記録の `INSERT ... SELECT` と `is_admin = 0` の `UPDATE`。下の「前の指名の記録と `DELETE` は、ワークスペースの所属…」）を置き、前の指名を取り消す文は4つになる。4つの文の条件は共通で、読んだ ID には絞らず、書く時点の行に当てる: 組織、`account_id IS NULL`、指名する人の行でない、指名する人の行が次の状態であること（`EXISTS`）。新しい行を入れるときと既に有効な管理者のときは、4つの文を指名の文の後ろに置き、指名する人がこの組織の有効な管理者であること。既にいる人を `UPDATE` するときは、4つの文を `UPDATE` の前に置き（順は消す記録、`DELETE`、解除の記録、印を外す `UPDATE`、指名の `UPDATE`、指名する人の記録）、指名する人の行が読んだ `is_admin`、`disabled_at`、`account_id` のままであること（`UPDATE` と同じ述語）。同じトランザクションで `UPDATE` の前に同じ述語を評価するので、`UPDATE` が条件に外れるときは（その人が別の経路で有効な管理者になっていても）前の指名も記録も書かない。時刻や書いた値の一致で自分の書き込みかを見分けない（止めた時計や同じミリ秒の別の書き込みで一致するため）。読んでから書くまでに別の指名し直しが入れた、まだログインしていない指名も消え、読んだ後に結ばれた行（`account_id` が埋まった行）は消えない。どの `change_logs` も `operator` に運用者のログインの ID を入れ、`actor_user_id` と `workspace_id` は空。既にいる人の `UPDATE` が条件に外れたとき（前の指名も消えない）、既に有効な管理者と読んだ人が同じ `batch()` の後ろの読み取りで有効な管理者でなくなっていたとき、新しい行が一意に当たったとき（`batch()` ごと戻る。指名する人の行を読み直して見分ける）は 409（`conflict`）。新しい行を入れる `batch()` が例外で終わっても、読み直して自分が採番した行があれば、書き込みは済んで応答だけが失われたので成功として返す（消した前の指名の数は分からない）。`batch()` の例外を読み直して 409 にするのは新しい行を入れるときだけで、既にいる人の経路の例外（D1 の一時的な失敗、外部キーの失敗など）はそのまま投げる（500 としてログに残る）。前の指名の記録と `DELETE` は、ワークスペースの所属（`memberships` を組織で絞った `workspaces` と結んで見る）を持つ行に当てない。所属を持つ前の指名は、`DELETE` の後ろで、同じ条件に所属を持つことと `is_admin = 1` を足した `INSERT ... SELECT` で `change_logs`（`user` の `update`、`{"is_admin": [1, 0]}`、`operator` あり。履歴の「管理者の解除」）を作り、続けて `UPDATE`（`is_admin = 0`、`updated_at`）で管理者の印を外す（所属を持つ行はリーダーの候補で `login_subject` があるので、Google で待つ行は含まれない）。`removed` は消した行の数で、印を外した行は数えない。GitHub でアカウントが無いと読んだ人は、書いた後に `account_logins` を引き直して結ぶ（組織の作成と同じ）。並行した2回の指名し直しでは、後に書いた要求が、先の要求の指名を前の指名として消す（先の要求が返した Google の招待の URL も使えなくなる）。取り消しの記録と新しい指名の記録は同じ日時なので、組織の変更の履歴での前後は `id` で決まり、入れ替わって見えうる |
| ワークスペースの作成 | `workspaces`、`workspace_point_rates`（作った月、4）、`board_columns`（4行。完了の列は末尾）、`detail_fields`（1行）、最初のリーダーの `memberships`、`change_logs`（ワークスペースと所属の2行）。どの文も `INSERT ... SELECT ... WHERE EXISTS`（最初のリーダーが同じ組織にいて、無効でなく、`login_subject` があり、管理者か、いずれかのワークスペースに今所属している。かつ、作る人が同じ組織の、無効でない管理者）にし、全部入るか何も入らないかにする。何も入らなければ 404 |
| ワークスペースを閉じる | `change_logs`（`entity_type` は `workspace`、`action` は `close`、`changes_json` は `{"closed_at": [null, 閉じた日時]}`）、`workspaces`（`closed_at`、`updated_at`）。この順に書き、どちらの文も同じ条件（ワークスペースが組織のもので `closed_at IS NULL`、かつ呼んだ人が同じ組織の無効でない管理者）を持つ。1回の `batch()` は文を順に流すので、履歴が入るのは `workspaces` が書き換わるときだけ。何も入らなければ、読み直して閉じていれば 409（`workspace_closed`）、そうでなければ 404 |
| ワークスペースを開き直す | 閉じるのと同じ形で、`action` は `reopen`、`changes_json` は `{"closed_at": [前の日時, null]}`、`workspaces` の条件は `closed_at = 前の日時`（読んだ値）。何も入らなければ、読み直して `closed_at` が読んだ値と違えば 409（`conflict`）、同じなら 404。開いているワークスペースには、書く前に 409（`conflict`） |
| 完成の定義の変更 | `workspaces`（`definition_of_done_md`、`updated_at`）、`change_logs`（`entity_type` は `workspace`、`action` は `update`、`changes_json` は `{"definition_of_done_md_length": [前の字数, 後の字数]}`。字数はコードポイントで数え、空は 0。全文（10 万字まで）を前後で積むと共有の D1 が膨らむので、本文は残さない）。操作は `workspace-dod-update`（リーダー。管理者を含む）で、入力は `definition_of_done_md` の文字列。本文（`body_md`）と同じ整え方（改行を `\n` にそろえ、前後の空行と末尾の空白を落とす）をし、空白だけなら `NULL` にする。10 万字（コードポイント）を超えるか見えない文字を含めば 400。先に今の値を読み、同じなら何も書かない。違えば、`workspaces` の文の条件を `id`、`organization_id`、`closed_at IS NULL`、`definition_of_done_md IS :読んだ値` にし、`change_logs` は直前の文が行を変えたときだけ入れる（下の「直前の文に結ぶ」）。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ（別の要求が先に変えた）読み直してやり直す（3 回まで。超えたら 409 の `conflict`）。返すのは書いた後の `{ definition_of_done_md }`。リーダーか管理者かは入るときに確かめた値で決め、書く文の条件には入れないので、入ってから書くまでの間にリーダーを外されたり無効にされたりした人の要求は、1回だけ通りうる。アカウントごとに 10 分に 30 回まで（超えたら 429 の `rate_limited`。10 万字の本文を書く操作なので、回数で抑える）。`workspace` の操作は、空の文字列が入っていても `null` にそろえて返す |
| 招待（GitHub） | `invitations`（`login_name` は GitHub のユーザー名）、`change_logs`（`entity_type = 'invitation'`、`action = 'create'`、`{"login_provider": [null, …], "login_subject": [null, …], "login_name": [null, …], "role": [null, …]}`）。書く前に、ユーザー名を解決し直して画面が確かめた ID と違えば 409（`invitee_changed`）、そのワークスペースに今所属している無効でない人なら 409（`already_member`）、同じワークスペースに同じ `(login_provider, login_subject)` の承諾待ちの招待があれば 409（`already_invited`）、人数（`organizations` の「人数」）が `member_limit` 以上で、招待する人がまだ数えられていなければ 409（`member_limit_reached`）。無効にされた人であることでは断らない（人数には数えないので、上限では新しい人と同じく `member_limit_reached` になる）。`invitations` の文は `INSERT ... SELECT ... WHERE`（閉じていないワークスペース、所属していない、承諾待ちの招待が無い）にし、`change_logs` は直前の文が行を入れたときだけ入れる（下の「直前の文に結ぶ」）。何も入らなければ、読み直して閉じていれば 409（`workspace_closed`）、所属か招待があればその 409、どちらでもなければ 404。人数は書く文の条件に入れない（同時に招待して超えたときは、そのまま認める。超えるのは同時に送った招待の数まで） |
| 招待（Google） | 取り消しの `change_logs`（`action = 'update'`、`{"status": ["pending", "revoked"]}`、取り消す招待ごとに1行。行の ID は SQL の中で作る）、`invitations`（取り消す招待の `status = 'revoked'`、`responded_at`）、新しい `invitations`、作成の `change_logs`（`entity_type = 'invitation'`、`action = 'create'`、`{"login_provider": [null, "google"], "login_name": [null, "Google の招待（ログイン待ち）"], "role": [null, …]}`）を1回の `batch()` で書く。作成の記録には、メールアドレス、`login_subject`、秘密、ハッシュ、期限を入れない（待つ指名の記録と同じ）。書く前に、メールアドレスを `normalizeEmail` でそろえ（そろえられなければ 400 の `invalid_input`、`details` の `code` は `email_invalid`）、人数が `member_limit` 以上で、招待する人（`(google, login_email)`）がまだ数えられていなければ 409（`member_limit_reached`）。同じアドレスの期限内の承諾待ちの招待があれば数えられているので、上限でも招待し直せる（期限切れなら断る）。人数は書く文の条件に入れない（GitHub の招待と同じく、同時に招待して超えたときはそのまま認める。超えるのは同時に送った招待の数まで）。限界: 判定はメールアドレスの形（`(google, login_email)`）だけで見るので、招待の URL から結び終えた人（`sub` の形で数えられている）を同じアドレスで別のワークスペースへ招待すると、上限では新しい人として断る（メールアドレスから `sub` を引けないため。画面は Google を選んでいるときの上限の枠にこのことを添える）。所属（`already_member`）と承諾待ち（`already_invited`）の検査はしない（「`invitations`」の節）。取り消しの2文は、読んだ ID でなく、書く時点の同じワークスペースの、`login_provider = 'google'`、`login_subject IS NULL`、同じ `login_email`、`status = 'pending'` の招待に当てる（同時に招待し直しても、新しい招待が一意の索引に当たらない）。`status = 'pending' AND login_subject IS NULL` は束縛せず文字のまま書き（`pendingEmailInvitationRowFilter`）、部分索引 `invitations_pending_email` で引く（`test/schema.test.ts` が実行計画を確かめる）。取り消しの2文と新しい招待の `INSERT ... SELECT ... WHERE` は、どれも閉じていないワークスペースを条件にし、作成の記録は直前の文が行を入れたときだけ入れる（下の「直前の文に結ぶ」）。何も入らなければ、読み直して閉じていれば 409（`workspace_closed`）、そうでなければ 404。秘密と招待の URL（`<公開 URL のオリジン>/invite#<秘密>`。組織の道具の `inviteUrl` で作る）は応答の本文にだけ入れる。Google のログインの資格情報が未設定でも断らない |
| 招待の取り消し | `invitations`（`status = 'revoked'`、`responded_at`）、`change_logs`（`action = 'update'`、`{"status": ["pending", "revoked"]}`）。招待はワークスペースで絞って読み、無ければ（別のワークスペース、別の組織を含む）404、承諾待ちでなければ 409（`conflict`）。`invitations` の文の条件は `id`、`workspace_id`、`status = 'pending'`、閉じていないワークスペースで、`change_logs` は直前の文が行を変えたときだけ入れる。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 409（`conflict`） |
| 招待の承諾 | `users`（行が無い人だけ）、`memberships`、`invitations`（`status = 'accepted'`、`responded_at`）、`change_logs` の2行。書く前に、招待を組織のワークスペースで絞って読み、無いか呼んだ人のログインに当たらなければ 404、同じ組織に招待のログインか呼んだ人のアカウントの無効にされた `users` の行があれば 404（組織に入るときの確かめは、`users` の行がある人には招待のログインの無効な行を見ないため）、承諾待ちでなければ 409（`conflict`）、閉じていれば 409（`workspace_closed`）、その人がそのワークスペースに今所属していれば 409（`already_member`）。どの文も「招待が ID で一致し、`status = 'pending'`、ワークスペースが同じ組織で閉じていない、招待の `(login_provider, login_subject)` が呼んだ人のログイン、同じ組織に同じログインか同じアカウントの無効にされた `users` の行が無い」を `EXISTS` で持つ。1. `users` は、呼んだ人がこの組織に `users` の行を持たないときだけ、同じ組織に同じログインの行も同じアカウントの行も無ければ `INSERT ... SELECT ... WHERE` で入れる（`account_id` は呼んだ人のアカウント、名前はそのログインの手段の側の名前、`is_admin` は 0）。行があればそのまま使うので、前に抜けた人は同じ `users` の ID で戻り、経験値（`xp_grants`）も引き継ぐ。2. `memberships` は `INSERT ... SELECT` で `invitations` からロールを取り、`user_id` は同じ組織の `users` をログインの手段と ID で引き直すサブクエリ（`users` の行がある人はその行）、`joined_on` はワークスペースのタイムゾーンの今日。条件にさらに「その人がそのワークスペースに今所属していない」。3. `invitations` は ID、`status = 'pending'` と、2 の所属の行（この要求の ID）があることを条件にする。4. `change_logs` は、招待の更新（`entity_type = 'invitation'`、`action = 'update'`、`{"status": ["pending", "accepted"]}`。3 の直後に置き、下の「直前の文に結ぶ」）と、所属の作成（`entity_type = 'membership'`、`action = 'create'`、`{"user": [null, {"id", "name"}], "role": [null, …]}`。この要求の所属の行があることが条件で、人とロールはその行から取る）。どちらも `actor_user_id` は所属した人。人数の上限は見ない（承諾待ちの招待は人数に数えている）。3 が書けなければ、読み直して同じ順で理由を返し、どれでもなければ 409（`conflict`） |
| 招待の辞退 | `invitations`（`status = 'declined'`、`responded_at`）、`change_logs`（`action = 'update'`、`{"status": ["pending", "declined"]}`、`actor_user_id` は呼んだ人の `users` の行で、招待だけの人は空）。招待を組織のワークスペースで絞って読み、無いか呼んだ人のログインに当たらなければ（別の人、別の組織の招待を含む）404、承諾待ちでなければ 409（`conflict`）。閉じたワークスペースへの招待も辞退できる。`invitations` の文の条件は ID、`status = 'pending'`、招待のログイン、組織のワークスペースで、`change_logs` は直前の文が行を変えたときだけ入れる。何も入らなければ、読み直して無ければ 404、そうでなければ 409（`conflict`） |
| 組織の休日の登録 | `organization_holidays`。1文の束縛は100個までなので、20行ずつの `INSERT ... ON CONFLICT DO NOTHING RETURNING holiday_on` に分け、全部を1回の `batch()` で送る。返った行の数が登録した日数で、残りは登録済み。`change_logs` は書かない |
| 組織の休日の削除 | `organization_holidays`（組織と日付で絞る1行）。消えた行が無ければ 404。`change_logs` は書かない |
| Google の招待の URL から結ぶ | 組織の DB の `users` か `invitations`、`change_logs`（「メールアドレスで待つ指名と招待」の 6）、続けて共通の DB の `accounts` と `account_logins` |
| 初めてのログイン | 共通の DB の `accounts` と `account_logins`、続けて組織の DB の `users.account_id`（指名で待っていた行に結ぶ）、続けて共通の DB の `sessions`。2回目以降は `account_logins` と `accounts.last_login_at` の書き直し、`users.account_id` を結び直す書き込み、`sessions` の順 |
| 添付ファイルを上げる | R2 にファイルを書き、続けて `attachments` |
| 添付ファイルを消す | `attachments` の削除と `change_logs`、続けて R2 のファイルの削除 |
| コメントの作成 | `comments`。`comment-create` が `INSERT ... SELECT ... WHERE EXISTS (そのワークスペースの削除していないタスク) AND EXISTS (閉じていないワークスペース)` の1文で入れ、`change_logs` は書かない（行そのものが記録）。何も入らなければ、閉じていれば 409（`workspace_closed`）、そうでなければ 404 |
| コメントの編集 | `comments`（`body_md`、`edited_at`）、`change_logs`（`entity_type = 'comment'`、`action = 'update'`。形は `change_logs` の節）。先にコメントを読み（ワークスペースで絞り、削除していないタスクのコメントだけ。無ければ 404）、書いた本人でなければ 403（`forbidden`）、消えていれば 409（`conflict`、`deleted`）、整えた本文が今と同じなら何も書かない。`comments` の文の条件は `id`、`workspace_id`、`author_user_id = :呼んだ人`、`deleted_at IS NULL`、`EXISTS (削除していないタスク)`、閉じていないワークスペースで、`change_logs` は直前の `UPDATE` が行を変えたときだけ入れる（下の「直前の文に結ぶ」）。何も変わらなければ、存在を先に決め、読み直してコメントかタスクが無ければ（読んでから書くまでにタスクが削除された）404、閉じていれば 409（`workspace_closed`）、消されていれば 409（`conflict`、`deleted`。読んでから書くまでにリーダーが消した）。先に読んだ時点でも、無いコメントは閉じたワークスペースでも 404 で、あるコメントへの書き込みだけが `workspace_closed` になる（同じ本文の更新も、閉じていれば `workspace_closed`） |
| コメントの削除 | `comments`（`body_md` を空文字、`deleted_at`、`deleted_by`）、`change_logs`（`entity_type = 'comment'`、`action = 'delete'`。形は `change_logs` の節）。編集と同じく、先に読んで、無ければ 404、書いた本人でもリーダー（管理者を含む）でもなければ 403、消えていれば 409（`conflict`、`deleted`）。`comments` の文の条件は `id`、`workspace_id`、`deleted_at IS NULL`、`EXISTS (削除していないタスク)`、閉じていないワークスペースで、`change_logs` は直前の `UPDATE` が行を変えたときだけ入れる。何も変わらなければ、編集と同じ順で理由を返す（先に別の要求が消していれば 409 の `deleted` で、履歴は1行だけ）。コメントの添付ファイル（#68）が入ったら、そのコメントの `attachments` の削除をこの `batch()` に足し、続けて R2 のファイルを消す |

先に読んだ値で判定してから書く操作（最後の管理者、完了の可否など）は、書く文の `WHERE` に同じ条件を入れ、影響した行の数で競合を見つける。

直前の文に結ぶ: 履歴の `INSERT ... SELECT` は、直前の `UPDATE` が行を変えたことを `WHERE changes() > 0` で条件にする（`src/server/db/previous-statement.ts` の `previousStatementChanged`）。D1 の `batch()` は全部の文を1つの接続の1つのトランザクションで順に流すので、`changes()` は直前の文の件数になる（テストで確かめている）。履歴の行や時刻の一致で「自分の更新か」を見分けると、止めた時計（`DEV_NOW`）や同じ値を書く要求では、負けた要求も一致して履歴を二重に書く。この条件は直前の文だけを見るので、変える文の直後に置く。タスクの変更と削除、感謝の送付と取り消し、コメントの編集と削除、招待と取り消し、ロールの付け替えと離脱、管理者の指名と解除、ユーザーの無効化と有効化、エピックの変更、エピックとストーリーの削除（根の履歴）、ストーリーの完了と取り消し、タスクの完了を戻す、スプリントの作成と変更と削除と終了、スプリントから外す、完成の定義の変更が使う（ストーリーの変更は、まだ時刻と値の一致で見ている）。ストーリーの完了と取り消し、タスクの完了を戻すでは、さらに後ろの文（経験値の付与と打ち消し、完了の記録の削除）が、その履歴の行（この要求だけの `id`）があることを自分の条件にする。スプリントの終了も、スプリントの履歴の行を、持ち越しの文すべての条件にする。

タスクの完了（`task-complete`）の文と条件。ポイント、担当、区分、作った人は先に読まず、`INSERT ... SELECT` で `tasks` の行から取る。読むのは、計上月と手助けの週を決めるワークスペースのタイムゾーンと週の始まり、そのタスクの感謝の ID（手助けの文を感謝ごとに並べるため）、変更の履歴に残す完了にした人の名前だけ。`batch()` は件数 0 の文があっても後ろの文を書くので、後ろの文は先の文が通ったことを自分の条件に持つ。完了の対象は、バックログのタスク（親のないタスクと、ストーリーの下のタスク）で、スプリントに入っているものも含む。対象でないタスク（受信箱やアーカイブのタスク）は、何も書かず 404 にする。

先に、タスクの今のスプリントと列、スプリントの状態を読み（削除していないバックログのタスク。無ければ、閉じていれば 409 の `workspace_closed`、そうでなければ 404。完了していれば 409 の `conflict`）、置き場所で書くものを決める。

- スプリントの外（`sprint_id` が空）: 下の 1〜4 だけ
- 進行中（`active`）のスプリントの中: 1 で完了の列（ワークスペースに1つ）の、そのスプリントでの末尾へ移す（`column_id`、`column_position`。完了の列に既にいれば位置は変えない）。2 の `completions.sprint_id` はそのスプリント、`previous_column_id` は完了の前にいた列。`sprint_entries` は書かない
- 始まっていない（`planned`）スプリントの中と、削除したスプリントを指すタスク（前の版に戻したときのスプリントの削除で残りうる）: 1 の前に 0 で入っている行を閉じ、1 で `sprint_id`、`column_id`、`column_position` を空にし、スプリントの外の完了として記録する（2 の `sprint_id` と `previous_column_id` は空）。続けて 5 を書く
- 終了したスプリントに残った未完了のタスク（終了で持ち越すので、ふつうは無い）は、何も書かず 409（`conflict`）

0. （始まっていないスプリントの中と、削除したスプリントを指すタスクだけ）`sprint_entries`: そのタスクとスプリントの入っている行を `removed` で閉じ、`ended_at` は完了の日時。条件は `workspace_id`、`task_id`、`sprint_id = :読んだスプリント`、`ended_at IS NULL` と、1 と同じ前提（閉じていないワークスペース、読んだスプリントと列のままの未完了のバックログのタスク、スプリントが読んだ状態のまま）。1 はこの要求がその行を閉じた（`ended_at` が自分の時刻）ことを条件にするので、0 が負けたら（入っている行が無い、読んでから書くまでに閉じられた）何も書かない（読み直してやり直し、3 回で 409 の `conflict`）

1. `tasks`: `completed_at`、`completed_by`、`updated_at`（と、置き場所ごとの上の列）を書く。条件は `id = :task AND workspace_id = :ws AND tray = 'backlog' AND completed_at IS NULL AND deleted_at IS NULL AND EXISTS (閉じていないワークスペース)` と、置き場所ごとに、スプリントの外なら `sprint_id IS NULL`、スプリントの中なら `sprint_id = :読んだスプリント AND column_id IS :読んだ列 AND EXISTS (そのスプリントが読んだ状態のまま。削除していない planned か active、削除したスプリントなら削除したまま)`、0 を書いたときは `EXISTS (この要求が閉じた行)`。ワークスペースの条件は、読んでから書くまでの間にワークスペースが閉じた競合を止める。変わった行が0なら、`batch()` の後に読み直して分ける。ワークスペースが閉じていれば 409（`workspace_closed`）、タスクの行が無い（別の組織のタスクと、バックログに無いタスクを含む）なら 404、完了していれば 409（`conflict`）、どれでもなければ（読んでから書くまでにスプリントか列が変わった）読み直してやり直す（3 回まで。超えたら 409 の `conflict`）
2. `completions`: `tasks LEFT JOIN stories LEFT JOIN epics`（どちらも同じワークスペースのものだけ）に、段ごとに同じワークスペースの `categories` を `LEFT JOIN` したもの（エピックの区分 `ec`、ストーリーの区分 `sc`、タスクの区分 `tc`）から入れる。`category_id` は `COALESCE(ec.id, sc.id, tc.id)`。別のワークスペースの区分が結ばれた段は結ばれないので飛ばし、次の段へ下りる（全部だめなら空）。条件は `tasks.completed_at = :at AND tasks.completed_by = :me AND NOT EXISTS (同じタスクで同じ完了日時の completions)`。開発用の時計（`DEV_NOW`）で止めた時刻では、同じ人が2回完了にした要求の完了日時と完了にした人が同じになる。1 の値との一致だけでは自分の更新か先の要求の更新かを見分けられないので、先に入った記録があれば何も入らないようにする。レビュー依頼の再依頼で1つのタスクに完了の記録が複数ありうるため、`task_id` の一意制約では守らない。`billing_month` は、`category_id` に入れた段の区分が `is_billed_monthly = 1` のときだけ `:at` の月（ワークスペースのタイムゾーン）、ほかは空。`sprint_id` は 1 を書いた後の `tasks.sprint_id`（始まっていないスプリントの中の完了では、1 が空にしている）、`previous_column_id` は進行中のスプリントの中の完了だけ、読んだ列
3. `xp_grants`: 起票（`task_created`。受け取るのは `created_by`、`created_by IS NOT NULL` が条件）と完了（`task_completed`。受け取るのは `COALESCE(assignee_user_id, :me)`）。どちらも `tasks.points >= 1`、受け取る人がそのワークスペースに今所属している（`EXISTS (SELECT 1 FROM memberships WHERE workspace_id = :ws AND user_id = <受け取る人> AND left_at IS NULL)`）こと、`EXISTS (SELECT 1 FROM completions WHERE id = :自分の completion_id)` が条件。所属していない管理者や所属を外れた担当は、経験値の対象にならない（`docs/requirements.md`）ので、担当のいないタスクを所属していない管理者が完了にすると、完了の経験値は誰にも付かない。`dedupe_key` は `task_created:<completion_id>`、`task_completed:<completion_id>`
   - 手助け（`help`）: 起票と完了の文のあとに、読んだ感謝の ID ごとに1文を、感謝の `created_at`、`id` の順に並べる。`thanks` の行（`id = :thank AND workspace_id = :ws AND task_id = :task`）から `INSERT ... SELECT` し、`user_id` は `thanks.recipient_user_id`、`helper_sender_user_id` は `thanks.sender_user_id`、`dedupe_key` は `help:<thank_id>:<completion_id>`、`amount` は `XP_HELP`。条件は、受け取る人がそのワークスペースに今所属している（上と同じ `EXISTS`）こと、`EXISTS (SELECT 1 FROM completions WHERE id = :自分の completion_id)`、同じ送り手と相手の週の上限に満たないこと（`SELECT COUNT(*) FROM xp_grants h WHERE h.workspace_id = :ws AND h.action = 'help' AND h.user_id = thanks.recipient_user_id AND h.helper_sender_user_id = thanks.sender_user_id AND h.amount > 0 AND h.confirmed_at >= :週の始まり AND h.confirmed_at < :週の終わり AND NOT EXISTS (reverses_grant_id が h.id の行)` が `XP_HELP_WEEKLY_LIMIT` 未満）。ポイントの条件は付けない。感謝は完了したタスクでは増減しない（`thanks-send` と `thanks-revoke` は完了したタスクを断る）ので、読んだ感謝の ID の集まりは書くまで変わらない。完了の要求が `tasks` を更新する前の短い間に届いた感謝は、読んだ ID に入らず、手助けが付かない（感謝の行は残る）。
   - 上限を超える競合は文の条件で守る。D1 の `batch()` は1つのトランザクションで、別の要求の `batch()` と交わらず、同じ `batch()` の前の文が挿入した行は次の文から見える。上限の件数の条件を手助けの各文に持たせるので、同じ送り手と相手の感謝を持つ2つのタスクを同時に完了にしても、1つのタスクの感謝が上限をまたいでも、打ち消されていない手助けは上限を超えない（先に `batch()` が流れた要求が枠を使い、後の要求は上限に達した分を付けない）。上限を1回分超えることは受け入れない。
4. `change_logs`: 3 と同じ `EXISTS` が条件
5. （0 を書いたときだけ）`change_logs`: `action = 'update'`、`{"sprint": [前, null]}`（前の名前は書くときの今の名前を `sprints` から引く）。3 と同じ `EXISTS` が条件

自分の `completion_id` の記録が入ったことを後ろの文の条件にするので、遅れた要求は `completions`、`xp_grants`、`change_logs` を1行も書かない（`sprint_entries` は 0 と 1 の条件で守る）。

完了を戻す（`task-reopen`）の文と条件。入力は `workspace_id`、`task_id`。出力は `task_id` と、戻した後の `sprint_id` と `column_id`（スプリントの外なら空）。完了の列へ落としたカードを受ける入力（`column_id`）は、ドラッグを足す #245 で足す。

先に1回の `batch()` で、タスク（削除していないバックログのタスク。今のスプリントとその状態、今の列の名前、親のストーリーの完了、完了にした人の名前）、戻す完了の記録（そのタスクの `completions` のうち `completed_at` が `tasks.completed_at` と同じ行。レビューの再依頼で複数ありうるため、日時で選ぶ）と完了の前の列（削除していない完了でない列のときだけ）、先頭の完了でない列を読む。読んだ状態で断る（どれも 409 の `conflict` で、`details.reason` は `src/shared/operations/task/task-reopen.ts` の `taskReopenConflictReasons`）。

- タスクが無い（別の組織のタスクと、バックログに無いタスクを含む）: 404
- 完了していない: `not_completed`
- スプリントに入ったまま完了していて、そのスプリントが進行中でない（終了したか削除した）: `sprint_closed`。終了したスプリントの中身は変えない。完了で始まっていないスプリントからは外れるので、始まっていないスプリントの中の完了したタスクはふつう無いが、あれば同じに断る
- 親のストーリーが完了している: `parent_completed`（先にストーリーの完了を取り消す）

戻す列は、タスクが進行中のスプリントにいるときだけ決める。完了の前の列（`previous_column_id`）が削除していない完了でない列ならその列、そうでなければ（空、削除した、完了の列）先頭の完了でない列で、その列のそのスプリントでの末尾（`column_position` の最大の後ろ）に置く。スプリントの外で完了したタスクは列なしのまま。打ち消す付与は、その記録の `completion_id` を持つ、打ち消されていない付与（起票、完了、手助け。後から足す詳細もそのまま乗る）で、受け取った人が所属を外れていても取り消す。書く文は次の順に並べる。

1. `tasks`: `completed_at` と `completed_by` を空にし、`updated_at` と、スプリントの中なら `column_id`、`column_position` を書く。条件は `id`、`workspace_id`、`tray = 'backlog'`、`deleted_at IS NULL`、`completed_at = :読んだ完了日時`、`sprint_id IS :読んだスプリント`、閉じていないワークスペース、親のストーリーが完了していない（`NOT EXISTS`）、スプリントの中なら読んだスプリントが進行中のまま、戻す列が削除していない完了でない列のまま
2. `change_logs`: `entity_type = 'task'`、`action = 'reopen'`、`{"completed_at": [日時, null], "completed_by": [{id, name}, null], "column": [{id, name}, {id, name}]}`。`column` はスプリントの中だけで、前は今の列（完了の列は名前が空）、後は戻した列。直前の `UPDATE` が行を変えたときだけ入れる（`previousStatementChanged`）
3. `xp_grants`: 打ち消す付与ごとに、`user_id`、`action`、`task_id`、`completion_id` を写し、`amount` を負に、`reverses_grant_id` に元の行、`dedupe_key` は `reversal:<元の id>`（`story-reopen` と同じ形）。条件は 2 の自分の履歴が入ったこと（`EXISTS`。履歴の ID はこの要求だけの値なので、止めた時計でも負けた要求と一致しない）と、元の行を打ち消す行がまだ無いこと
4. `completions`: 戻す記録を消す。3 と同じ `EXISTS` が条件

1 が行を変えなければ、閉じていれば 409（`workspace_closed`）、読み直して上の順で理由を返し、どれでもなければ（読んでから書くまでに、戻してからもう一度完了にされた、戻す列が削除された、など）409（`changed`）。2つの画面から同時に戻すと、後の要求の 1 は完了日時が変わって通らず、記録の削除と打ち消しは1回だけになる（後の要求は `not_completed`）。記録を消すので、止めた時計（`DEV_NOW`）で完了、戻す、同じ時刻にもう一度完了にしても、`task-complete` の 2 の完了の記録は同じ日時の行に当たらずに入り、付与のキー（新しい `completion_id`）も重ならない。もう一度戻すと、新しい記録の付与だけを打ち消す。

共通の DB と組織の DB に分けて書く操作は、途中で失敗したときの扱いを決めておく。

- 組織の作成で `users` が入らなかったときは、管理者のいない組織が残る。運用者の一覧では管理者の状態が `none` になり、画面は「管理者がいない」と出す。運用者が管理者を指名し直して入れる（上の表の管理者の指名し直し）。`change_logs` は `users` と同じ `batch()` で書くので、残らない。
- 組織の設定の変更で `change_logs` が入らなかったときは、`organizations` の変更だけが残り、その変更の履歴は残らない。`change_logs` の `batch()` が例外を投げたときは、応答は成功のまま返し、画面も成功として扱う。そのときは欠けた行を、ログ（操作、組織の ID、前後の値、日時）から手で補える。`organizations` を書いた後に処理そのものが止まったときは、履歴もログも残らない。
- Google の招待の URL から結んだあと、アカウントが作れなかったときは、`sub` を埋めた行だけが残る。次に Google でログインすれば `sub` で当たり、アカウントの作成に進む。
- ログインで `users.account_id` を結べなかったときは、`accounts` と `account_logins` だけが残る。セッションは作らず、「もう一度ログインしてください」を出す。ログインのたびに、そのログインの ID（手段と手段の中の ID）で `account_id` が空の `users` を結び直す（結んだ行は当たらなくなるので、何度流しても同じ結果）ので、次のログインで結ばれる。組織に入れるかの判定は `users.account_id` で行うので、結ばれるまでその組織には入れない。
- 同じ人の最初のログインが並行したときは、片方の `batch()` が `account_logins` の主キーで落ちて、`accounts` ごと戻る。落ちた側は、もう片方が作った行を読み直して続ける。
- 添付ファイルを上げるときに `attachments` が入らなかったら、書いた R2 のファイルを消す。添付ファイルを消すときに R2 のファイルが消えなかったら、どの行も指さないファイルが残る。容量の上限には数えず、組織を消すときにまとめて消える。
- メンバーの離脱とユーザーの無効化で `sessions` が消えなかったときも、組織に入れるかはリクエストのたびに確かめるので、離脱した組織と無効にされた組織には入れない。ログインできる条件を失った人のセッションは、次にその人がリクエストしたときに消す。
### 感謝を送る

`thanks-send` は、タスクを組織とワークスペースで絞って読み、送り手、完了、相手、重複を確かめる。書く文は `INSERT INTO thanks ... SELECT` で、同じ組織・ワークスペースの削除していないタスクを引き、`completed_at IS NULL`、今の担当が送り手（担当が空なら作った人が送り手）、閉じていないワークスペース、相手が同じ組織の無効でない今のメンバーで `login_subject` が決まっていること、を条件にする。`ON CONFLICT (task_id, recipient_user_id) DO NOTHING` で重複の一意制約違反を防ぐ。

1つの `batch()` に感謝の INSERT と履歴の INSERT を並べ、履歴は `previousStatementChanged`（`changes() > 0`）で直前の感謝が入ったときだけ書く。履歴は `entity_type = 'task'`、`action = 'update'`、`{"thanks": [null, {id, name}]}`。受取人の名前は履歴を書く文の中で組織の `users` から引き、書く時点の名前を残す。感謝の `changes` が 0 なら読み直し、閉じた、無い、送り手でない、完了、相手の離脱や無効化、重複の理由を決め直す。3 回まで試し、超えたら 409 の `conflict`。完了が先に通れば INSERT は止まり、送付が先なら完了前に送った行として残る。

### 感謝を取り消す

`thanks-revoke` は感謝とタスクを組織・ワークスペースで絞って読み、送った本人か、未完了かを確かめる。DELETE は感謝の ID、ワークスペース、送り手が呼んだ人、同じ組織・ワークスペースの削除していない未完了のタスクがあること、閉じていないワークスペースを条件にする。同じ `batch()` に履歴を続け、`previousStatementChanged` で消せたときだけ `{"thanks": [{id, name}, null]}` を `task` の `update` として書く。受取人の名前は書く文の中で組織の `users` から引く。

DELETE の `changes` が 0 なら読み直す。閉じていれば `workspace_closed`、完了していれば `completed`、既に取り消されていれば 404 とし、3 回まで試して超えたら 409 の `conflict`。担当が替わったことは取り消しを断る条件にしない。


## 要件からの補い

要件定義に書いていないが、テーブルにするために決めたこと。

- 稼働する曜日も、1日の時間と同じく適用開始月付きの履歴で持つ。変えても過去の月の積載量は動かない。
- ストーリーとエピックの完了は、行の `completed_at` と `completed_by` だけで持ち、`completions` には入れない。請求と振り返りはタスクの完了の記録で足りるため。
- エピックは Markdown の本文を1つ持つ。経験値は付かない。
- 感謝の取り消しと、討伐隊から抜けることは行の削除で表し、記録は `change_logs` に残す。
- 招待は承諾したときにユーザーの行を作る。
- 既読の通知は90日で消す。変更の履歴は消さない。
- 区分を削除したら、振っていたものは区分なしに戻す。完了の記録は削除した区分を指したまま残す。

