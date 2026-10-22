# Team Leveling データモデル

状態: 確定。要件定義（`requirements.md`）を D1（SQLite）のテーブルに落としたもの。次は最初のマイグレーションを書く

## 決まりごと

- 名前はスクラムの言葉で、テーブルは複数形のスネークケース、列はスネークケース。
- 主キーは UUIDv7 の文字列（`TEXT`）で、列名は `id`。行を作る Worker が採番する。単一の行しか持たない表と、他の表の組を主キーにする表は除く。
- 日時は UTC の ISO 8601（`2026-10-20T01:23:45.678Z`）を `TEXT` で持ち、列名は `_at` で終える。
- 日付は `YYYY-MM-DD` を `TEXT` で持ち、列名は `_on` か `_date` で終える。検査は `CHECK (x = date(x))`。
- 月は `YYYY-MM` を `TEXT` で持ち、列名は `_month` で終える。検査は `CHECK (x || '-01' = date(x || '-01'))`。
- 真偽は `INTEGER` の 0 と 1 で持ち、列名は `is_` で始める。
- 列挙は `TEXT` に `CHECK (x IN (...))` を付ける。値は英語の小文字とスネークケース。
- JSON は `TEXT` に `CHECK (json_valid(x))` を付け、列名は `_json` で終える。
- 本文とコメントは `CHECK (length(x) <= 100000)` で10万字に抑える。
- 論理削除は `deleted_at` で持つ。一覧の索引は `deleted_at IS NULL` の部分索引にする。
- SQL は D1 で通る SQLite の方言で書く（部分索引、`json_valid`、`date()`、CHECK を使う）。
- 外部キーは張る。D1 は検査が有効。`ON DELETE` は付けず、物理削除はアプリが順に行う。
- 作成日時と更新日時は `created_at`、`updated_at` で、更新はアプリが書く。
- 手で並べ替える並びは、分数の並び（fractional indexing）の文字列 `position` で持つ。間に入れても他の行を書き換えない。新しく入ったものは末尾の値を取る。
- 集計（積載量、経験値の合計、ポイントの合計、ベロシティ）は保存せず、読むたびに計算する。
- 1つの D1 に複数の王国を入れる。王国の中の行は、リクエストの王国から辿って引く。ID だけで行を引かず、必ず `kingdom_id` か、王国を確かめた `workspace_id` で絞る。他の王国の行が見えないことはテストで確かめる。
- 表を共通の表と王国の中の表に分け、後から王国ごとにデータベースを分けられるようにしておく。決まりは「データベースの分け方」。

## 全体の構成

| まとまり | テーブル |
| --- | --- |
| アカウント | `accounts`、`sessions`、`oauth_states`、`rate_limits` |
| 王国 | `kingdoms`、`users`、`kingdom_holidays` |
| ユーザーの稼働 | `user_capacity_settings`、`user_monthly_overrides`、`user_time_off` |
| ワークスペース | `workspaces`、`workspace_point_rates`、`workspace_holidays`、`memberships`、`invitations`、`allocations` |
| ワークスペースの定義 | `board_columns`、`detail_fields`、`categories` |
| 接続 | `connections`、`connection_scopes`、`connection_status_mappings` |
| 計画と作業 | `epics`、`epic_party_members`、`stories`、`tasks`、`task_sources`、`task_source_payloads`、`task_field_values`、`comments`、`attachments`、`sprints`、`sprint_entries` |
| 記録 | `completions`、`thanks`、`xp_grants`、`notifications`、`change_logs` |

親子の向きの要点。

- アカウントは GitHub のアカウントごとに1行で、王国をまたぐ。ログインとセッションはアカウントに付く。
- ユーザーは王国ごとの人で、アカウントと王国の組に1行。王国の中の表はすべてユーザーを指し、アカウントは指さない。
- 王国の直下のもの（`users`、`workspaces`、`kingdom_holidays`、`change_logs`）は `kingdom_id` を持つ。
- ワークスペースの中のものは、すべて `workspace_id` を持つ。権限の検査と絞り込みを1つの列で行うため、親から辿れるものにも持たせる。`kingdom_id` は持たせず、`workspaces.kingdom_id` で王国を確かめる。
- タスクの親はストーリーだけ（`tasks.story_id`）、ストーリーの親はエピックだけ（`stories.epic_id`）。
- 取り込んだタスクは `tasks` の1行に `task_sources` の1行が付く。手で作ったタスクには付かない。

## データベースの分け方

初めは全王国を1つの D1 に入れる。容量か負荷が足りなくなったら、決まった数の D1 に王国を振り分ける。そのときにコードを書き直さずに済むよう、今から次の決まりを守る。

### 共通の表と王国の中の表

| 区分 | テーブル | 置き場所 |
| --- | --- | --- |
| 共通 | `accounts`、`sessions`、`oauth_states`、`rate_limits`、`kingdoms` | 共通の DB に1つだけ |
| 王国の中 | それ以外のすべて | 王国が置かれた DB |

添付ファイルの中身は D1 ではなく R2 に置く。R2 のキーの先頭は王国の ID なので、D1 を分けても R2 は分けずに済む。

- 共通の表から王国の中の表へは外部キーを張らない。
- 王国の中の表から共通の表へ張る外部キーは、`users.account_id` と、`users`、`workspaces`、`kingdom_holidays`、`change_logs` の `kingdom_id` だけにする。分けるときはこれらを外し、アプリの検査に替える。
- 共通の表と王国の中の表を1つの SQL で結合しない。`users` に GitHub のログイン名とアバターを添えるときも、`accounts` を別に引いてアプリで合わせる。

### 読み書きの入口

- 王国の中の表は、リクエストの王国から DB を選ぶ1つの関数を通して読み書きする。今はどの王国でも同じ DB を返す。
- 共通の表は、共通の DB を返す別の関数を通して読み書きする。
- 1回の `batch()` に、共通の表と王国の中の表を混ぜない。今これに当たる操作は「書き込みの単位」の王国の作成とメンバーの離脱で、どちらも2回に分けて書く。
- 王国をまたいで読む処理は、1つの関数にまとめる。当たるのは、ログインできるか（入れる王国と届いた招待があるか）、ログインの直後の王国の選択、届いた招待の一覧、初めてのログインで `users.account_id` を埋めること。今は1つの DB に1回の問い合わせで済む。分けたときは、この関数だけを、各 DB に問い合わせる形か、共通の DB に GitHub ユーザー ID と王国の組の索引を持つ形に直す。どちらにするかは分けるときに決める。

### 分けるとき

- wrangler の設定に、決まった数の D1（`DB_0`、`DB_1` など）を並べる。D1 の接続は設定に固定で書くもので、王国を作るたびには増やせないため。
- `kingdoms` に置き場所の列を足し、王国の DB を選ぶ関数はその列を見る。
- マイグレーションは、共通の DB と、王国を置くすべての DB に当てる。王国の中の表の定義はどの DB でも同じにする。
- 王国を移すときは、その王国の行を書き出して移し先へ入れ、`kingdoms` の置き場所を書き換える。手順は運用の手順書に書く。
- 王国ごとに Durable Objects の SQLite を持つ形は選ばない。API が Durable Objects を経由する形になり、マイグレーションの当て方も変わって、作りが大きく変わるため。

### 分ける目安

- 量の大半は取り込み元の応答（`task_source_payloads`）で、1件 5〜10KB とみると、上限いっぱい（タスク5万件）の王国で 0.5GB 前後になる。1つの D1 の上限は 10GB。
- 容量が上限の半分を超えたら、分ける準備を始める。
- D1 は1つのデータベースへの問い合わせを順に処理するため、容量より先に負荷が効くことがある。画面の API が 500ms の目安を超える状態が続き、索引や問い合わせを直しても戻らなければ分ける。

## アカウント

### accounts

GitHub のアカウントごとの1行。王国をまたぐ。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| github_user_id | INTEGER | NOT NULL、UNIQUE | 突き合わせに使う不変の ID |
| github_login | TEXT | NOT NULL | ログインのたびに書き直す表示用の名前 |
| github_name | TEXT | | GitHub の名前。王国で初めてユーザーを作るときの表示名の既定 |
| avatar_url | TEXT | | |
| last_login_at | TEXT | | |
| created_at、updated_at | TEXT | NOT NULL | |

- 初めてログインできたときに行を作る。入れる王国が1つもない人の行は作らない。
- 運用者かどうかは、この表ではなくシークレットの GitHub ユーザー ID の一覧で決める。

### sessions

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| token_hash | TEXT | PK | Cookie に入れたランダムな ID の SHA-256 |
| account_id | TEXT | NOT NULL、FK accounts | |
| created_at | TEXT | NOT NULL | |
| last_used_at | TEXT | NOT NULL | 使うたびに書き直す |
| expires_at | TEXT | NOT NULL | `last_used_at` の30日後 |

- 索引: `(account_id)`。ログアウトと、ログインできる条件を失ったとき（入れる王国が1つもなくなったとき）に、その人の行を消す。
- 王国に入れるかは、リクエストのたびにその王国の `users`、`memberships`、`invitations` で確かめる。1つの王国で無効にされても、セッションは消さない。
- 書き込みを減らすため、`last_used_at` は前回から1時間以上たったときだけ書き直す。
- 切れた行は定期処理で消す。

### oauth_states

GitHub OAuth の state と PKCE の code_verifier。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| state | TEXT | PK | |
| code_verifier | TEXT | NOT NULL | |
| return_to | TEXT | | ログイン後に戻る画面のパス |
| expires_at | TEXT | NOT NULL | 作ってから10分 |

使ったら消す。切れた行は定期処理で消す。

### rate_limits

ログインと手動の同期のレート制限。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| key | TEXT | PK | `login:<IP>` など |
| window_start_at | TEXT | NOT NULL | |
| count | INTEGER | NOT NULL | |

- 手動の同期の「接続ごとに5分に1回」は、この表ではなく `connections.last_manual_sync_at` で判定する。
- 窓を過ぎた行は定期処理で消す。

## 王国

### kingdoms

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| slug | TEXT | NOT NULL、UNIQUE、`CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40)` | URL の先頭に入れる名前。後から変えない |
| name | TEXT | NOT NULL | 王国の表示名 |
| vocabulary | TEXT | NOT NULL、`game` か `scrum`、既定 `game` | ワークスペースの外の言葉づかい |
| theme | TEXT | NOT NULL、`simple`、`simple_light`、`simple_dark`、`medieval`、`modern` のどれか、既定 `simple` | 王国の既定のテーマ。`simple` は OS の明暗に合わせる |
| suspended_at | TEXT | | 停止した日時。入っていれば誰も入れず、定期処理も止める |
| purge_on | TEXT | | 解約で停止したときの、データを消す予定日（停止から30日後）。一時的な停止では空 |
| attachment_quota_bytes | INTEGER | NOT NULL、既定 10737418240 | 添付ファイルの合計の上限（既定 10GB）。運用者が決める |
| attachment_quota_warned_at | TEXT | | 合計が上限の80%を超えたと管理者に通知した日時。合計が80%を下回るか、上限を上げたら空に戻す |
| created_by_github_user_id | INTEGER | NOT NULL | 作った運用者 |
| created_at、updated_at | TEXT | NOT NULL | |

- 運用者の画面で作る。作るときに最初の管理者の `users` を同じバッチで入れる（アカウントがまだなければ、`users` の代わりに管理者の招待を持つ。下の `users` を参照）。
- アプリが使う名前（`api`、`login`、`operator` など）を slug にできないことは、アプリが検査する。
- 解約した王国は、`purge_on` を過ぎたら運用の手順でこの王国の行をすべて消し、R2 の `<kingdom_id>/` で始まるファイルも消す。再開したら `suspended_at` と `purge_on` を空に戻す。

### users

王国ごとの人。アカウントと王国の組に1行。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| kingdom_id | TEXT | NOT NULL、FK kingdoms | |
| account_id | TEXT | FK accounts | アカウントができる前（管理者の招待）は空 |
| github_user_id | INTEGER | NOT NULL | 突き合わせに使う不変の ID。`accounts` と同じ値 |
| name | TEXT | NOT NULL | この王国での表示名。初回は GitHub の名前かログイン名 |
| is_admin | INTEGER | NOT NULL、既定 0 | 管理者（国王） |
| work_start_on | TEXT | | 稼働開始日。空なら区切らない |
| work_end_on | TEXT | | 稼働終了日。空なら区切らない |
| disabled_at | TEXT | | 無効にした日時。入っていればこの王国に入れない |
| last_seen_at | TEXT | | この王国に最後に入った日時。1時間に1回まで書く |
| theme | TEXT | `kingdoms.theme` と同じ値か NULL | 自分で選んだテーマ。NULL なら王国の既定に従う |
| created_at、updated_at | TEXT | NOT NULL | |

- 一意: `(kingdom_id, github_user_id)`。
- 索引: `(github_user_id)`。ログインのときに入れる王国を引く。
- 表示する GitHub のログイン名とアバターは `accounts` から引く。
- 運用者が王国を作るときは、最初の管理者を GitHub のユーザー ID に解決し、`is_admin = 1` の行を入れる。`account_id` は、その人が初めてログインしたときに埋める。管理者の指名し直しも同じ。
- 最後の管理者を解除できないことはアプリが検査する。
- 招待された人は、承諾した時点でその王国の行を作る（すでにあれば使う）。招待の時点では `invitations` に GitHub の ID だけを持つ。

### kingdom_holidays

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| kingdom_id | TEXT | PK、FK kingdoms | |
| holiday_on | TEXT | PK | |
| name | TEXT | | 「元日」など |
| created_by | TEXT | NOT NULL、FK users | |
| created_at | TEXT | NOT NULL | |

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
| kingdom_id | TEXT | NOT NULL、FK kingdoms | |
| name | TEXT | NOT NULL | |
| timezone | TEXT | NOT NULL | IANA のタイムゾーン名。作った人のブラウザの値を既定にする |
| week_start | INTEGER | NOT NULL、0〜6、既定 1 | 週の始まり。0 が日曜 |
| vocabulary | TEXT | NOT NULL、`game` か `scrum`、既定 `game` | 言葉づかい |
| definition_of_done_md | TEXT | | 完成の定義。空なら出さない |
| closed_at | TEXT | | 閉じた日時。入っていれば読み取り専用 |
| created_by | TEXT | NOT NULL、FK users | |
| created_at、updated_at | TEXT | NOT NULL | |

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
- 索引: `(user_id) WHERE left_at IS NULL`。ログインできるか、自分の今日に出すワークスペースはどれかを引く。
- 積載量では、日がいずれかの行の `joined_on`〜`left_on` に入るかで、所属していた期間を数える。
- 管理者が所属していないワークスペースを操作するときは、行を作らない。担当やパーティの候補は、この表の今の所属から選ぶ。

### invitations

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| github_user_id | INTEGER | NOT NULL | 招待のときに解決した ID |
| github_login | TEXT | NOT NULL | 招待のときの名前（表示用） |
| role | TEXT | NOT NULL、`leader` か `member` | |
| invited_by | TEXT | NOT NULL、FK users | |
| status | TEXT | NOT NULL、`pending`、`accepted`、`declined`、`revoked` | |
| responded_at | TEXT | | 承諾、辞退、取り消しの日時 |
| created_at | TEXT | NOT NULL | |

- 一意: `(workspace_id, github_user_id) WHERE status = 'pending'`。
- 索引: `(github_user_id) WHERE status = 'pending'`。ログインの可否と招待の一覧に使う。
- 今の所属がある人は招待できないことを、アプリが検査する。

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
- 索引: `(user_id, effective_month)`。本人の配分の合計に使う。

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

## 接続

### connections

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL、FK workspaces | |
| owner_user_id | TEXT | NOT NULL、FK users | 登録したメンバー |
| provider | TEXT | NOT NULL、`backlog` か `github` | 取り込み元の種類。取り込み元を足したら値を足す |
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

- 索引: `(workspace_id) WHERE deleted_at IS NULL`、`(owner_user_id) WHERE deleted_at IS NULL`。
- 定期処理は `status IN ('active', 'error') AND deleted_at IS NULL` を `last_success_at` の古い順に処理する。
- 削除は論理削除にする。取り込んだタスクが `task_sources.connection_id` で指すため。削除したら認証情報の列を消す。
- `credential_*` と `sync_state_json` は API で返さない。返すのは `credential_last4` まで。
- 鍵の入れ替えは `credential_key_version` が古い行を選んで書き直す。

### connection_scopes

取り込む範囲。`scope_mode` が `include` なら対象、`exclude` なら除外の一覧になる。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| connection_id | TEXT | PK、FK connections | |
| scope_kind | TEXT | PK、`backlog_project`、`github_owner`、`github_repo` | |
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
| link_url | TEXT | | http と https だけ |
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

### epic_party_members

パーティ。抜けたら行を消し、記録は `change_logs` に残す。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| epic_id | TEXT | PK、FK epics | |
| user_id | TEXT | PK、FK users | |
| joined_via | TEXT | NOT NULL、`self`、`assigned`、`task_assignee` | 受注、割り振り、配下のタスクの担当 |
| added_by | TEXT | NOT NULL、FK users | |
| joined_at | TEXT | NOT NULL | |

- 索引: `(user_id)`。
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
- 親を変えたら、新しい親の末尾の `position` を振る。

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
| sprint_id | TEXT | FK sprints | 今入っているスプリント。履歴は `sprint_entries` |
| column_id | TEXT | FK board_columns | スプリントの中の列 |
| assignee_user_id | TEXT | FK users | 担当。0〜1人 |
| points | INTEGER | `NULL` か 0、1、2、3、5、8、13 | 空は未見積もり |
| due_on | TEXT | | Team Leveling で振った期日 |
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
  - `(assignee_user_id) WHERE deleted_at IS NULL AND completed_at IS NULL`: 自分の今日、積載量
- 「今日やる」は、`today_on` が今日（ワークスペースのタイムゾーン）なら今日の印、それより前で未完了なら前日からの持ち越しとして示す。担当が替わったら消す。
- 区分は、親のエピック、親のストーリー、タスク自身の順に、最初に入っているものを使う。読むときに結合して出し、タスクには写さない。
- 表示する期日は `due_on`、なければ `task_sources.source_due_on`（接続の `ignore_source_due` が 0 のとき）。
- タイトルの検索は `title LIKE` と `task_sources.source_key LIKE` で行う。5万件の規模なら、ワークスペースの索引で絞れば足りる見込み。遅ければ FTS5 を足す。

### task_sources

取り込んだタスクの取り込み元への参照と、取り込み元が持つ属性。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| task_id | TEXT | PK、FK tasks | |
| workspace_id | TEXT | NOT NULL、FK workspaces | 一意のキーのために持つ |
| connection_id | TEXT | NOT NULL、FK connections | 最初に取り込んだ接続 |
| source_kind | TEXT | NOT NULL、`backlog_issue`、`github_issue`、`github_pr`、`github_review_request` | 種別 |
| source_id | TEXT | NOT NULL | 取り込み元の不変の ID |
| reviewer_source_id | TEXT | NOT NULL、既定 `''` | レビュー依頼のレビュアーの取り込み元での ID。他の種別は空文字 |
| source_key | TEXT | NOT NULL | 課題キーや `owner/repo#12`。移動で変わるので検索と表示にだけ使う |
| source_url | TEXT | NOT NULL | |
| source_container_id | TEXT | NOT NULL | Backlog のプロジェクトか GitHub のリポジトリの ID。絞り込みに使う |
| source_container_name | TEXT | NOT NULL | |
| source_status | TEXT | NOT NULL | 取り込み元での状態名 |
| source_due_on | TEXT | | 取り込み元の期限 |
| source_updated_at | TEXT | NOT NULL | 差分の判定に使う |
| is_source_done | INTEGER | NOT NULL、既定 0 | 「取り込み元で完了」の印 |
| missing_since_at | TEXT | | 「取り込み元で見つからない」の印。入っていれば印あり |
| last_seen_at | TEXT | NOT NULL | 最後に取り込み元で確認できた日時 |
| created_at、updated_at | TEXT | NOT NULL | |

- 一意: `(workspace_id, source_kind, source_id, reviewer_source_id)`。同じワークスペースで同じ項目を1件にまとめ、レビュー依頼だけはレビュアーごとに分ける。
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

### task_field_values

タスクの決まった欄の中身。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| task_id | TEXT | PK、FK tasks | |
| field_id | TEXT | PK、FK detail_fields | |
| value_md | TEXT | NOT NULL | 空にしたら行を消す |
| updated_by | TEXT | NOT NULL、FK users | |
| updated_at | TEXT | NOT NULL | |

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

索引: `(task_id, created_at)`。

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
| object_key | TEXT | NOT NULL、UNIQUE | R2 のキー。`<kingdom_id>/<workspace_id>/<id>` |
| file_name | TEXT | NOT NULL | 上げたときのファイル名。255字まで |
| content_type | TEXT | NOT NULL | 中身の先頭のバイトで確かめた種類。分からなければ `application/octet-stream` |
| size_bytes | INTEGER | NOT NULL、`CHECK (size_bytes BETWEEN 1 AND 52428800)` | |
| uploaded_by | TEXT | NOT NULL、FK users | 消す権限に使う |
| attached_at | TEXT | | 付く先が決まった日時。空なら書いている途中で上げたもの |
| created_at | TEXT | NOT NULL | |

- 付く先は4つの列のうち多くても1つ: `CHECK ((task_id IS NOT NULL) + (story_id IS NOT NULL) + (epic_id IS NOT NULL) + (comment_id IS NOT NULL) <= 1)`。付く先が決まったら `attached_at` を入れる: `CHECK ((attached_at IS NULL) = (task_id IS NULL AND story_id IS NULL AND epic_id IS NULL AND comment_id IS NULL))`。
- 起票の画面やコメントの欄では、保存する前に上げるため、付く先のない行を先に作る。保存したときに、本文やコメントが参照する行へ付く先を入れる。付く先のないまま1日たった行とファイルは定期処理で消す。
- 消すときは行を物理削除する。論理削除にしないのは、戻す手段がなく、残すと容量の上限に数え続けるため。消したことは付く先の `change_logs` に残す。
- 王国の合計は、王国のワークスペースの `size_bytes` の合計を上げるたびに計算する。集計は保存しない。同時に上げたときに少し超えることは許す。上げたことで80%を超え、`kingdoms.attachment_quota_warned_at` が空なら、管理者全員に通知し、その日時を入れる。
- 画面と Markdown からは `/api/<slug>/attachments/<id>` で参照する。返すときは権限を確かめ、`X-Content-Type-Options: nosniff` と `Cache-Control: private` を付ける。画像として出す4種類（PNG、JPEG、GIF、WebP）と動画として再生する2種類（MP4、WebM）以外は `Content-Disposition: attachment` で返す。動画は Range リクエストに応える。
- 索引: `(task_id)`、`(story_id)`、`(epic_id)`、`(comment_id)` をそれぞれ NOT NULL の部分索引で、`(workspace_id)`、`(created_at) WHERE attached_at IS NULL`。

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
- 索引: `(sprint_id)`、`(task_id)`。
- 起票と詳細の経験値は、終えたスプリントで `outcome` が `completed` か `carried_over` の行のタスクに付ける。外したタスクは `removed` なので報われない。
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
- 索引: `(recipient_user_id)`。
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
| sprint_id | TEXT | FK sprints | 起票と詳細では確定したスプリント |
| completion_id | TEXT | | 完了とレビューでは元の完了の記録。記録は消えうるので外部キーにしない |
| thank_id | TEXT | | 手助けでは元の感謝。同上 |
| helper_sender_user_id | TEXT | FK users | 手助けでは感謝を送った人。回数の上限の判定に使う |
| amount | INTEGER | NOT NULL | 正なら付与、負なら打ち消し |
| reverses_grant_id | TEXT | FK xp_grants | 打ち消しの行が指す元の行 |
| dedupe_key | TEXT | NOT NULL | 重複を防ぐキー（下記） |
| confirmed_at | TEXT | NOT NULL | 確定日時 |

- 一意: `(dedupe_key)`。
- `dedupe_key` の作り方。打ち消したあとに付け直せるよう、付与の「回」をキーに含める。
  - 起票: `task_created:<task_id>`
  - 詳細: `task_detailed:<task_id>`
  - 完了: `task_completed:<completion_id>`
  - レビュー: `review:<completion_id>`（依頼の回ごとに完了の記録が分かれる）
  - 手助け: `help:<thank_id>:<completion_id>`
  - ストーリーの完了: `story_completed:<story_id>:<user_id>:<completed_at>`
  - クリア報酬: `epic_reward:<epic_id>:<user_id>:<completed_at>`
  - 打ち消し: `reversal:<元の id>`
- 「同じタスクの同じ行動で有効な付与は1回だけ」は、上のキーと、付与の前に「打ち消されていない同じ行動の付与がないか」をアプリが見ることで守る。起票と詳細は打ち消さないので、キーだけで1回になる。
- 索引: `(user_id, workspace_id)`、`(task_id)`、`(story_id)`、`(epic_id)`、`(reverses_grant_id)`。
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

- 索引: `(user_id, created_at)`、`(user_id) WHERE read_at IS NULL`。
- 既読にしてから90日たった通知は定期処理で消す。未読は消さない。

### change_logs

変更の履歴。タスク、ストーリー、エピックの属性の変更と、権限、配分、接続、完了の記録の修正、削除を1つの表に残す。

| 列 | 型 | 制約 | 説明 |
| --- | --- | --- | --- |
| id | TEXT | PK | |
| kingdom_id | TEXT | NOT NULL、FK kingdoms | |
| workspace_id | TEXT | FK workspaces | 王国の変更（管理者の指名、ユーザーの無効化、王国の休日）では空 |
| actor_user_id | TEXT | FK users | 空なら同期などの定期処理か運用者の操作 |
| operator_github_user_id | INTEGER | | 運用者の操作（管理者の指名し直しなど）のときの運用者 |
| entity_type | TEXT | NOT NULL | `task`、`story`、`epic`、`sprint`、`membership`、`invitation`、`allocation`、`connection`、`completion`、`user`、`workspace` など |
| entity_id | TEXT | NOT NULL | |
| action | TEXT | NOT NULL | `create`、`update`、`delete`、`complete`、`reopen`、`archive` など |
| changes_json | TEXT | NOT NULL、既定 `'{}'` | `{"列名": [前, 後]}`。人や列は ID と、そのときの表示名を並べて残す |
| created_at | TEXT | NOT NULL | |

- 索引: `(entity_type, entity_id, created_at)`、`(kingdom_id, created_at)`、`(workspace_id, created_at)`。
- タスク、ストーリー、エピックの履歴はメンバー全員が、それ以外はリーダーと管理者が見られる。見られる範囲は `entity_type` で決める。
- 同期による取り込み元の属性の書き換えは残さない。量が多く、取り込み元で見られるため。
- 期間で消さず、残し続ける。容量が気になったら、手順書のエクスポート（`wrangler d1 export`）で退避する。

## 書き込みの単位

D1 は対話的なトランザクションを持たない。まとめて書く操作は D1 の `batch()` で1回に送る。`batch()` の中の文は1つのトランザクションとして全部が通るか全部が戻る。主な操作と、1回のバッチで書くもの。

| 操作 | 書くもの |
| --- | --- |
| タスクの完了 | `tasks`、`completions`、`sprint_entries`（スプリントの外なら書かない）、`xp_grants`（完了、手助け）、`change_logs`、`notifications` |
| 完了を戻す | `tasks`、`completions` の削除、`xp_grants`（打ち消し）、`change_logs` |
| スプリントの終了 | `sprints`、`sprint_entries`、持ち越すタスクの `tasks` と新しい `sprint_entries`、`xp_grants`（起票、詳細）、`change_logs` |
| エピックのクリア | `epics`、`xp_grants`（クリア報酬）、`change_logs` |
| メンバーの離脱 | `memberships`、担当を外す `tasks`、`epic_party_members`、`connections`、`change_logs`。ログインできなくなったときは、続けて共通の DB の `sessions` を消す |
| 取り込み（1件） | `tasks`、`task_sources`、`task_source_payloads` |
| 王国の作成 | 共通の DB の `kingdoms`、続けて王国の DB の最初の管理者の `users` |
| 添付ファイルを上げる | R2 にファイルを書き、続けて `attachments` |
| 添付ファイルを消す | `attachments` の削除と `change_logs`、続けて R2 のファイルの削除 |
| コメントの削除 | `comments`、そのコメントの `attachments` の削除、`change_logs`、続けて R2 のファイルの削除 |

先に読んだ値で判定してから書く操作（最後の管理者、完了の可否など）は、書く文の `WHERE` に同じ条件を入れ、影響した行の数で競合を見つける。

共通の DB と王国の DB に分けて書く操作は、途中で失敗したときの扱いを決めておく。

- 王国の作成で `users` が入らなかったときは、管理者のいない王国が残る。運用者の画面の管理者の指名し直しで入れる。
- 添付ファイルを上げるときに `attachments` が入らなかったら、書いた R2 のファイルを消す。添付ファイルを消すときに R2 のファイルが消えなかったら、どの行も指さないファイルが残る。容量の上限には数えず、王国を消すときにまとめて消える。
- メンバーの離脱で `sessions` が消えなかったときも、王国に入れるかはリクエストのたびに確かめるので、離脱した王国には入れない。ログインできる条件を失った人のセッションは、次にその人がリクエストしたときに消す。

## 要件からの補い

要件定義に書いていないが、テーブルにするために決めたこと。

- 稼働する曜日も、1日の時間と同じく適用開始月付きの履歴で持つ。変えても過去の月の積載量は動かない。
- ストーリーとエピックの完了は、行の `completed_at` と `completed_by` だけで持ち、`completions` には入れない。請求と振り返りはタスクの完了の記録で足りるため。
- エピックは Markdown の本文を1つ持つ。経験値は付かない。
- 感謝の取り消しと、パーティから抜けることは行の削除で表し、記録は `change_logs` に残す。
- 招待は承諾したときにユーザーの行を作る。
- 既読の通知は90日で消す。変更の履歴は消さない。
- 区分を削除したら、振っていたものは区分なしに戻す。完了の記録は削除した区分を指したまま残す。

