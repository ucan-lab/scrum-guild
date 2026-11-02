# Scrum Guild（Codex 向け）

最初に `CLAUDE.md` を読み、文書の案内、「守ること」と「コマンド」に従う。
共通の技術・設計の決まりはそこを原本とし、ここには Codex での使い分けだけを書く。
使い方とスキルの配置は `docs/development.md` の「Codex で開発する」。

## 直接依頼と実装の委譲

人が Codex に直接依頼したときは、その依頼を調査から実装、検証まで受け持つ。
`implementer` の定義が存在するだけでは実装専用の役割にならない。

- Issue の実装は `.agents/skills/increment-build/SKILL.md`、自分の差分の点検と修正は `.agents/skills/done-check/SKILL.md` を使う。レビューだけの依頼ではコードを直さない
- コミットは依頼されたときに行う。push、PR の作成・更新・マージ、Issue への書き込みとコメント送信は、対象と操作について人の明示的な指示があるときに行う。既に指示があれば聞き直さない
- `CLAUDE.md` と `.claude/skills/` の「確認せずコミットし、PR を作る」は Claude が進行する手順。Codex への直接依頼では、上の承認の範囲を優先する。承認が無くても、ローカルの実装・検証と PR 本文案の準備までは終える
- 手元では `main` を書き換えず、作業用のワークツリーで進める。既に指定されたワークツリーがあればそれを使う。Issue があれば `<Issue番号>-<短い名前>`、Issue の無い直接依頼は内容の分かる短い名前にする
- `post-checkout` は Issue のラベル更新と `.dev.vars` のリンク作成も行う。これらを承認されていないワークツリーの作成では、そのコマンドだけ `git -c core.hooksPath=/dev/null worktree add ...` として副作用を避ける。コミットや push の保護を迂回するためには使わない

Claude などの呼び出し元が **`implementer` として実装を委譲したときだけ**、`.codex/agents/implementer.toml` の役割に従う。

- ワークツリーの絶対パス、Issue の番号とやること、完了条件、変えてよい範囲、受け入れ条件の5つを受け取る。不足は推測で埋めずに呼び出し元へ返す
- 実装と指定された検査だけを行う。独立したレビュー、コミット、push、PR や Issue への書き込みは呼び出し元が受け持つ
- `.claude/settings*.json`、`.claude/hooks/`、`.codex/`、`.agents/` は書き換えない。指定された範囲を超える必要があれば、差分を残して呼び出し元へ返す
- 呼び出し元へ、変更ファイル、検査の結果、残った問題、Issue と文書に無い判断と根拠を返す

## スキルと点検の原本

Codex 用の入口は `.agents/skills/`。`add-operation`、`d1-migration`、`ui-polish` は `.claude/skills/` の原本への相対リンクで共有する。
`increment-build` と `done-check` は Codex 向けの手順を持ち、共通の判定やチェックリストは Claude 側の原本を参照する。
同名の Claude 用スキルを Codex の工程として直接実行しない。

`.claude/agents/` のレビュー定義は、点検の観点として読める。Claude の `model`、`tools`、`effort` は Codex のエージェント設定としては扱わない。
`Skill`、`Agent`、`AskUserQuestion`、`SendMessage`、Artifact は Claude 固有の道具名で、その名前の道具が Codex にあるとは限らない。
スキルはファイルを読み、質問や委譲は利用できる Codex の道具を使う。必要な道具が無ければ、その工程を実施済みとせず報告する。

## フックが代行しないこと

`.claude/` のフックは Codex に効かない。次は指示として守るもので、Codex の操作を機械的に遮断する設定ではない。

- wrangler の本番の操作（`deploy`、`versions deploy`、`rollback`）と、`--remote` を付けた `wrangler d1` を打たない。wrangler の設定に remote の binding を足さない
- `.dev.vars` と `.env`、ホームの `~/.wrangler` と `~/.config/.wrangler` を読まず、書き込まない
- セッションは手元で e2e を走らせない。必要なテストを差分に足し、PR の CI で確かめる
- `pkill` を使わない。自分で起動したプロセスだけを、その PID や実行セッションで止める
- 自動整形は走らない。変更したファイルだけをプロジェクトの Prettier 設定で整形し、`.prettierignore` に従う。無関係の差分を含む作業コピー全体へ `pnpm format` を掛けない
- 終わる前に、コミット済みの差分、未コミットの差分、新規ファイルを確かめ、変更に合う `CLAUDE.md` の検査を走らせる。実施できなかった検査と独立レビューは、通ったものと分けて報告する
