# Scrum Guild（Codex 向け）

`CLAUDE.md` の「守ること」と「コマンド」に従う。ここには同じ決まりを写さない。

## Codex に固有の注意

`.claude/` のフックは Codex に効かない。フックが止めていたことを自分で守る。

- wrangler の本番の操作（`deploy`、`versions deploy`、`rollback`）と、`--remote` を付けた `wrangler d1` を打たない
- `.dev.vars` と `.env` を読まない
- コミットしない。コミットと PR は呼び出し元のセッションが行う
