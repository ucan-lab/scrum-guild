# Scrum Guild（Codex 向け）

`CLAUDE.md` の「守ること」と「コマンド」に従う。ここには同じ決まりを写さない。

## Codex に固有の注意

`.claude/` のフックは Codex に効かない。フックが止めていた主なことを自分で守る。次の禁止のうち、コミットと PR に関するものと `.codex/` に関するものは、`increment-build` から `implementer` として呼ばれたときの決まり（人が対話で Codex を使うときは、その人の指示に従う）。

- wrangler の本番の操作（`deploy`、`versions deploy`、`rollback`）と、`--remote` を付けた `wrangler d1` を打たない。wrangler の設定に remote の binding を足さない
- `.dev.vars` と `.env`、ホームの `~/.wrangler` と `~/.config/.wrangler` を読まず、書き込まない
- `CLAUDE.md` の「コミットし、`done-check` を通して PR を作る」は呼び出し元のセッションの手順で、Codex は行わない
- `.claude/settings*.json`、`.claude/hooks/`、`.codex/` を書き換えない
- コミットしない。コミットと PR は呼び出し元のセッションが行う
