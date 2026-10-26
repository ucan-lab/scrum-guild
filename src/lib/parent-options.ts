// 親の選択欄（起票のダイアログと、親を移すダイアログ）の候補を、選択欄の見出し（optgroup）ごとに分ける。
// group はエピックの下のストーリーなら親のエピックの題、親のないストーリーなら null。エピックを候補にするときは group を持たせない

export type ParentOption = { id: string; title: string; group?: string | null };

// label が null の見出しは、親のないストーリーのまとまり（画面が「親なしの<ストーリー>」と出す）
export type ParentGroup = { label: string | null; options: ParentOption[] };

// 並びを保ったまま、続く同じ group をまとめる。どの候補も group を持たなければ、見出しを付けない（grouped が偽）
export function groupParents(options: readonly ParentOption[]): { grouped: boolean; groups: ParentGroup[] } {
  const grouped = options.some((option) => option.group !== undefined);
  if (!grouped) return { grouped, groups: [{ label: null, options: [...options] }] };
  const groups: ParentGroup[] = [];
  for (const option of options) {
    const label = option.group ?? null;
    const last = groups.at(-1);
    if (last !== undefined && last.label === label) last.options.push(option);
    else groups.push({ label, options: [option] });
  }
  return { grouped, groups };
}
