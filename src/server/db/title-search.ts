import { sql, type RawBuilder } from 'kysely';

// column（表の別名つきの列）が、words のどの語も含む、という条件。語ごとに `instr(lower(列), lower(語)) > 0` を AND でつなぐ。
// LIKE を使わないのは、D1 が LIKE の型を 50 バイトまでしか受けず、全角で 16 字を超える語を探せないため。
// lower は SQLite の決まりで英字だけを小文字にするので、LIKE と同じく英字の大文字と小文字は区別せず、全角と半角はそろえない。
// %、_、\ も普通の文字として探す。語は束縛の値で渡す。words は空にしない（空なら呼ぶ側が条件を付けない）。
// 列は、バックログの木が探す題の列（別名つき）だけを受ける（任意の文字列を SQL の参照にしない）
export type TitleColumn = 'tasks.title' | 'stories.title' | 'epics.title' | 'hit_epic.title';

export function titleContainsAll(column: TitleColumn, words: readonly string[]): RawBuilder<boolean> {
  if (words.length === 0) throw new Error('titleContainsAll に語が無い');
  const parts = words.map((word) => sql`instr(lower(${sql.ref(column)}), lower(${word})) > 0`);
  return sql<boolean>`(${sql.join(parts, sql` AND `)})`;
}
