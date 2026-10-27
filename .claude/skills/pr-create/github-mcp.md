# `gh` が使えないとき

クラウドのセッションでは、`gh` が無いか、`GH_TOKEN` が無効で認証に失敗する（`gh auth status` が「The token in GH_TOKEN is invalid」）ことがある。`gh auth status` が失敗するか `gh` が無いときは、GitHub の MCP ツール（`mcp__github__*`。名前だけ見えていれば ToolSearch で読み込む）で同じ操作を行う。`gh` が動き、GraphQL だけが 403 になるときは、[SKILL.md](SKILL.md) の「GitHub の操作」のとおり REST で行う。

| 操作 | MCP ツール |
| --- | --- |
| 開いた PR の一覧 | `list_pull_requests`（`head` は `<owner>:<branch>`。`fields` で絞るときは `number`、`head`、`base` と、要るなら `body` を入れる） |
| PR の作成 | `create_pull_request` |
| PR の読み取り（本文、レビュー、レビューのスレッド、check-runs） | `pull_request_read` の `get`、`get_reviews`、`get_review_comments`、`get_check_runs` |
| PR のタイトルと本文の更新、レビュワーの依頼 | `update_pull_request`（`reviewers`） |
| アサイン、ラベル、マイルストーン | `issue_write` の `update`（PR の番号を渡す） |
| 自分のログイン | `get_me` |
| インラインコメント | `pull_request_review_write` の `create`（`event` 無しで PENDING）→ `add_comment_to_pending_review`（`subjectType` は `LINE`。`line` が通らなければ `FILE` で足すので、SKILL.md の Step 6 の GraphQL は要らない）→ `pull_request_review_write` の `submit_pending`（`COMMENT`） |
| Issue の本文の読み書き、コメント | `issue_read`、`issue_write`、`add_issue_comment` |

- `milestone` は番号で渡す。`issue_read` と `list_pull_requests` はマイルストーンのタイトルしか返さないので、番号は SKILL.md の Step 1 の実績を `search_pull_requests`（`repo:<owner>/<repo> is:merged`、`fields` に `milestone`）で引き、結果の `milestone.number` で知る（`search_issues` は自然文の検索で、絞り込みの書式が効かないことがある）。付けた後に読み直し、意図したマイルストーンになったかを確かめる
- `issue_write` の `labels` と `assignees` は足すのでなく丸ごと置き換える。書く直前に取り直した今の一覧に足した形で渡し、外す変更はしない（SKILL.md の Step 5-B が置き換えの `PUT` を禁じるのと同じく、人が設定したものを消さないため）
- `issue_write` の `body` は行ごとに置き換えられず、本文を丸ごと渡す。書く直前に `issue_read` で取り直した本文を元にする（前に取った本文を元にすると、その後に人が書き足した分を消す）。書いた後に取り直し、意図した箇所だけが変わったことを確かめる
- マージは MCP ツールで代えない（`gh pr merge --match-head-commit` とフックの確認を通らないため）。人に任せる
- 表に無い操作は、ToolSearch で `mcp__github__` を引いて近いツールを探す。MCP ツールも無ければ push までで止め、PR の作成を人に頼む
