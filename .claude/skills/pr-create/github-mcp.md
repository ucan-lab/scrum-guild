# `gh` が使えないとき

クラウドのセッションでは、`gh` が無いか、`GH_TOKEN` が無効で認証に失敗する（`gh auth status` が「The token in GH_TOKEN is invalid」）ことがある。`gh auth status` が失敗するか `gh` が無いときは、GitHub の MCP ツール（`mcp__github__*`。名前だけ見えていれば ToolSearch で読み込む）で同じ操作を行う。`gh` が動き、GraphQL だけが 403 になるときは、[SKILL.md](SKILL.md) の「GitHub の操作」のとおり REST で行う。

| 操作 | MCP ツール |
| --- | --- |
| 開いた PR の一覧 | `list_pull_requests`（`head` は `<owner>:<branch>`。`fields` で絞るときは `number`、`head`、`base` と、要るなら `body` を入れる） |
| PR の作成 | `create_pull_request` |
| PR の読み取り（本文、レビュー、レビューのスレッド、check-runs、変更ファイル） | `pull_request_read` の `get`、`get_reviews`、`get_review_comments`、`get_check_runs`、`get_files` |
| PR のタイトルと本文の更新、レビュワーの依頼 | `update_pull_request`（`reviewers`） |
| アサイン、ラベル、マイルストーン | `issue_write` の `update`（PR の番号を渡す） |
| 自分のログイン | `get_me` |
| インラインコメント | `pull_request_review_write` の `create`（`event` 無しで PENDING）→ `add_comment_to_pending_review`（`subjectType` は `LINE`。`line` が通らなければ `FILE` で足すので、SKILL.md の Step 6 の GraphQL は要らない）→ `pull_request_review_write` の `submit_pending`（`COMMENT`） |
| Issue の本文とラベルの読み書き、コメント | `issue_read` の `get`、`get_labels`、`issue_write` の `update`、`add_issue_comment` |
| Issue の作成 | `issue_write` の `create`（`title`、`body`、`labels`、`milestone`。`parent_issue_number` を渡すと、作ると同時に親のサブ Issue になるので、`sub_issue_write` の `add` は要らない） |
| Issue の一覧 | `list_issues`（`state`、`labels`、`fields`）。親とサブ Issue の数（REST の `sub_issues_summary`）は、1件ずつ `issue_read` の `get_parent` と `get` で引く |
| サブ Issue の並びの読み取り、付け外し、並べ替え | `issue_read` の `get_sub_issues`、`sub_issue_write` の `add`（付け替えは `replace_parent` を true）、`remove`、`reprioritize`（`after_id` か `before_id`）。`sub_issue_id` は番号でなく Issue の `id` で、`issue_read` の `get` か `issue_write` の `create` の応答から取る |
| 前に要るもの（blocked by）の読み取り、付け外し | `issue_dependency_read`、`issue_dependency_write`（下の注記） |

- `milestone` は番号で渡す。`issue_read` と `list_pull_requests` はマイルストーンのタイトルしか返さないので、番号は SKILL.md の Step 1 の実績を `search_pull_requests`（`repo:<owner>/<repo> is:merged`、`fields` に `milestone`）で引き、結果の `milestone.number` で知る（`search_issues` は自然文の検索で、絞り込みの書式が効かないことがある）。付けた後に読み直し、意図したマイルストーンになったかを確かめる
- `issue_write` の `labels` と `assignees` は足すのでなく丸ごと置き換える。書く直前に取り直した今の一覧に足した形で渡し、外す変更はしない（SKILL.md の Step 5-B が置き換えの `PUT` を禁じるのと同じく、人が設定したものを消さないため）
- `issue_write` の `body` は行ごとに置き換えられず、本文を丸ごと渡す。書く直前に `issue_read` で取り直した本文を元にする（前に取った本文を元にすると、その後に人が書き足した分を消す）。書いた後に取り直し、意図した箇所だけが変わったことを確かめる
- `update_pull_request` の `body` は、`<img>` を `&lt;img` に逃がし、`![](URL)` の `!` を抜く（2026-10-28 に #414 で確かめた。#427）。`issue_write` の `body` も同じで、コードの中（`` ` `` で囲んだ所）の `<img` の並びまで逃がし、続く行をまとめて潰す（#427 の本文で起きた）。`create_pull_request` の `body` は確かめていないが、同じと見て画像を入れない。MCP で書く本文と Issue には、`<img` の並びを文字としても書かない（書くなら全角の `＜img` にするか、`gh` が使える人に頼む）。変更前と変更後の画像は、CI の `evidence` のコメントで見る。本文に `<img` がある PR は、本文を MCP で書き戻さない（どの手順でも。書き戻すと画像が崩れる）。書き換えが要るなら、書き換えた本文のファイルと `gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -F body=@<ファイル>` を人に渡す
- `milestone` の番号がマージ済みの PR の実績に無い（まだ使われていないマイルストーン）ときは、MCP ツールでは一覧を引けないので、人に番号を聞く
- 一覧を返すツール（`list_issues`、`pull_request_read` の `get_files` など）は1ページで切れる。`perPage` を 100 にし、`after` か `page` で最後まで送る（`gh` の `--paginate` と同じく、取りこぼすと Issue の組分けや `migrations/` の重なりの確かめを誤る）
- `issue_read` は前に要るものの数（REST の `issue_dependencies_summary`）を返さない。`issue_dependency_read` と `issue_dependency_write` は GitHub の MCP サーバーの機能の切り替えの後ろにあり、出ないことがあり、README に引数の説明が無い。出たら ToolSearch で出た定義に従い、Issue を番号で指すか `id` で指すかと、読んだ依存が開いているかを確かめてから使う。`.claude/settings.json` の許可に無いので、呼ぶと確認が挟まる。出ないときに依存関係だけを正とするスキル（`backlog-pick`、`backlog-add` の登録）は、本文の表から読んで代えずに止まり、依存の確認か付け外しを人に頼む
- `pull_request_read` の `get` が `merged_at` と `merge_commit_sha` を返さなければ、`d1-migration` の縮める変更の確かめは止まり、人に頼む
- マージは MCP ツールで代えない（`gh pr merge --match-head-commit` とフックの確認を通らないため）。人に任せる
- 表に無い操作は、ToolSearch で `mcp__github__` を引いて近いツールを探す。MCP ツールも無ければ push までで止め、PR の作成を人に頼む
