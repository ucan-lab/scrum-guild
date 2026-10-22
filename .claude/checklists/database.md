# DB（言語に依存しないもの）

## クエリ

- WHERE や JOIN に使う列にインデックスが無い。外部キーにインデックスが無い
- 複合インデックスの列順が、等価条件の列より範囲条件の列が先になっている
- 大きなテーブルで OFFSET を使ったページングをしている（`WHERE id > ?` のカーソル方式にする）
- 本番コードでの `SELECT *`
- 1行ずつの INSERT をループで回している（複数行の INSERT かバルク処理にする）

## スキーマ

- 金額に浮動小数点型を使っている（固定小数点の `DECIMAL` や `NUMERIC` を使う）
- NOT NULL、外部キー、CHECK 制約を付けられるのに付けていない
- 親の削除時の挙動（`ON DELETE` の CASCADE、SET NULL、RESTRICT）が要件と合っていない（省略時は NO ACTION で削除が拒否される）
- ソフトデリートがあるのに、ユニーク制約やインデックスが削除済みの行を考慮していない

## トランザクション、ロック

- トランザクションの中で外部 API を呼んでいる
- 複数の行をロックする順番が処理によって違う（`ORDER BY id` で揃える）
- キューのワーカーが同じ行を取り合っている（`FOR UPDATE SKIP LOCKED` を使う）

## PostgreSQL

- ID に `int` や `serial` を使っている（`bigint GENERATED ALWAYS AS IDENTITY` にする）
- タイムゾーンの無い `timestamp` を使っている（`timestamptz` にする）
- テナントの分離を RLS で担保する設計なのに、RLS が有効になっていない。有効でも、テーブルの所有者ロールで接続していると効かない（`FORCE ROW LEVEL SECURITY` にする）
- RLS のポリシーで使う列にインデックスが無い
- アプリケーション用のユーザーに `GRANT ALL` している
