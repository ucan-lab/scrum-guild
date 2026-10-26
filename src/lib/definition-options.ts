// 区分とリポジトリの選択肢。今振っているもの（current）が候補に無い（削除された、一覧を読めなかった）ときは末尾に足す。
// 選択欄が今の値を選んだまま描け、変えていない欄を「外した」として送らないため
import type { DefinitionRef } from '../shared/operations/definition/definition.ts';

export function withCurrent<T extends DefinitionRef>(
  options: readonly T[],
  current: DefinitionRef | null,
): DefinitionRef[] {
  if (current === null || options.some((option) => option.id === current.id)) return [...options];
  return [...options, current];
}
