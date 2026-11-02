// 決まった欄を直している間の、読んだ値（task-field-set の read_md）の持ち方。
// 保存の時点の欄の値ではなく、編集を始めた時点の値を保存まで持つ。直している間に引き出しが読み直して（refresh）、
// 別の人が書いた値が欄に入っても、読んだ値は変わらないので、保存は 409 の changed で断られ、黙って上書きしない。
// 断られて読み直した後は、読み直した値を新しい読んだ値にする（読み直した内容を知らせた上で、もう一度保存すると上書きする）。
// 画面の状態に頼らない（テストが画面なしで呼べる）
export class EditBases {
  #bases = new Map<string, string | null>();

  // 編集を始めた。started はそのときの値（行が無ければ null）
  begin(fieldId: string, started: string | null): void {
    this.#bases.set(fieldId, started);
  }

  // 保存で送る読んだ値。編集を始めていなければ（始めた記録が無ければ）今の値
  readFor(fieldId: string, current: string | null): string | null {
    return this.#bases.has(fieldId) ? this.#bases.get(fieldId)! : current;
  }

  // 断られて読み直した。読み直した値を、次の保存の読んだ値にする
  rebase(fieldId: string, latest: string | null): void {
    this.#bases.set(fieldId, latest);
  }

  // 保存できたか、編集をやめた
  finish(fieldId: string): void {
    this.#bases.delete(fieldId);
  }
}
