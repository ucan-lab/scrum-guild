# スタック PR（gh-stack）

`gh stack` が入っている手元の環境だけで使う。クラウドには無い。

依存し合う層に分けた PR 群は、公式の `gh-stack` スキルでブランチを作り、PR も[SKILL.md](SKILL.md) の手順で出す。
ブランチ名、マージ、push の扱いはグローバルの `CLAUDE.md` に従う。

- PR は `gh stack submit --auto` で下書きとして一括作成する。そのあと下から順に1層ずつ、SKILL.md の Step 1〜4 と Step 5-B（更新モード）で整える。差分の基点はその PR の `base.ref`（1つ下の層）
- SKILL.md の Step 4 の承認は作成モードと同じ扱いにする（done-check が通っていれば取らない）。`gh stack submit` が作った直後の PR を整えるのは作成の続きのため
- 本文の `## 概要` の冒頭に、スタック全体での位置（何層目か、下の層に何を依存しているか）を1行書く
- 下書きの PR は、SKILL.md の Step 2-B で作った PR と同じく、`ci-ok` の成功の後に `pr-feedback` がドラフトを外す。AI レビューが走るのは base が `main` の層だけ
