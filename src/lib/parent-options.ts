// 親の選択欄（起票のダイアログと、親を移すダイアログ）の候補を、選択欄の見出し（optgroup）ごとに分ける。
// group はエピックの下のストーリーなら親のエピック（id と題）、親のないストーリーなら null。エピックを候補にするときは group を持たせない

export type ParentOption = { id: string; title: string; group?: { id: string; title: string } | null };

// label が null の見出しは、親のないストーリーのまとまり（画面が「親なしの<ストーリー>」と出す）
export type ParentGroup = { key: string | null; label: string | null; options: ParentOption[] };

// 並びを保ったまま、続く同じ親のエピック（id で見る。同じ題の別のエピックは分ける）をまとめる。
// エピックの下の候補が1つも無ければ、見出しを付けない（grouped が偽）。親のないストーリーだけの選択欄に「親なし」の見出しを出さないため
export function groupParents(options: readonly ParentOption[]): { grouped: boolean; groups: ParentGroup[] } {
  const grouped = options.some((option) => option.group != null);
  if (!grouped) return { grouped, groups: [{ key: null, label: null, options: [...options] }] };
  const groups: ParentGroup[] = [];
  for (const option of options) {
    const key = option.group?.id ?? null;
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) last.options.push(option);
    else groups.push({ key, label: option.group?.title ?? null, options: [option] });
  }
  return { grouped, groups };
}
