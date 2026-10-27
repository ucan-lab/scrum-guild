// 落とした行を、少しのあいだ光らせる印（.is-dropped）の状態。BacklogDnd と ListDnd が使う。
// 光らせる長さは design/tokens.css の --duration-flash（800ms）より少し長くして、演出の終わりまで印を残す
export const FLASH_MS = 900;

export class DropFlash<T> {
  // 光らせている行
  value = $state<T | null>(null);
  #frame: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  // 光らせる。同じ行を続けて落としても、印をいったん外し、描き直された後の次のフレームで付け直すので、もう一度光る
  // （同じフレームの中で外して付けると、ブラウザは変化に気づかず、演出が始まり直さない）
  show(value: T): void {
    this.clear();
    this.#frame = requestAnimationFrame(() => {
      this.#frame = requestAnimationFrame(() => {
        this.#frame = undefined;
        this.value = value;
        this.#timer = setTimeout(() => (this.value = null), FLASH_MS);
      });
    });
  }

  // 光らせている行も、付け直しの予約も捨てる（木が読み直されたときなど）
  clear(): void {
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    clearTimeout(this.#timer);
    this.value = null;
  }
}
