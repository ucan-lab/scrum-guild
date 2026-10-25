// バックログの並べ替えと親の移動を、押した順に1つずつ送る列。画面は先に並びを変えてから send() を呼ぶ。
// 木が読み直されたら（reloaded()）、まだ送っていない操作は送らずに捨てる。読み直した木には、その操作の前の並びが出ているため。
// 送っている操作があるうちに読み直されたら、その操作が読み直しの後にサーバーへ届いて古い並びが残りうるので、
// 列が空になった後にもう一度読み直す（hooks.reload）。捨てた操作があれば、そのことを知らせる（hooks.dropped）
export type MoveQueueHooks = {
  reload: () => Promise<void>;
  dropped: () => void;
};

export class MoveQueue<R extends { ok: boolean }> {
  readonly #hooks: MoveQueueHooks;
  #tail: Promise<void> = Promise.resolve();
  // 読み直すたびに進める。送る前に、押したときの世代と違えば捨てる
  #generation = 0;
  // 押したが、まだ結果を受け取っていない操作の数（待っているものと送っているもの）
  #pending = 0;
  #reloadedWhileMoving = false;
  #dropped = 0;

  constructor(hooks: MoveQueueHooks) {
    this.#hooks = hooks;
  }

  // 木が読み直された（画面の読み直しでも、失敗した後の読み直しでも呼ぶ）
  reloaded(): void {
    this.#generation++;
    if (this.#pending > 0) this.#reloadedWhileMoving = true;
  }

  // 画面で動かした並びを捨てた。まだ送っていない操作も捨てる（読み直しが失敗して木が変わらなかったときを含む）
  discard(): void {
    this.#generation++;
  }

  // 操作を列に足す。断られたら onFailed を呼ぶ（理由を知らせて読み直すのは画面の側）。戻り値は、この操作を終えるまで待てる
  send(call: () => Promise<R>, onFailed: (result: R) => Promise<void>): Promise<void> {
    const mine = this.#generation;
    this.#pending++;
    this.#tail = this.#tail
      .then(async () => {
        let result: R | undefined;
        try {
          if (mine !== this.#generation) this.#dropped++;
          else result = await call();
        } finally {
          this.#pending--;
        }
        if (result !== undefined && !result.ok) await onFailed(result);
        await this.#settle();
      })
      .catch(() => {});
    return this.#tail;
  }

  // 列が空になったときに、送っている間の読み直しがあれば、もう一度読み直して捨てた操作を知らせる
  // 読み直しの無いまま discard() で捨てた分は数え直す（読み直しに失敗したときは、画面が失敗を知らせている）
  async #settle(): Promise<void> {
    if (this.#pending > 0) return;
    if (!this.#reloadedWhileMoving) {
      this.#dropped = 0;
      return;
    }
    this.#reloadedWhileMoving = false;
    const dropped = this.#dropped;
    this.#dropped = 0;
    await this.#hooks.reload();
    if (dropped > 0) this.#hooks.dropped();
  }
}
