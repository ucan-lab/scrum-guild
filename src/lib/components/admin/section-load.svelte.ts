import { page } from '$app/state';
import type { ApiResult } from '../../api.ts';
import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';

export type SectionLoadState = 'loading' | 'ready' | 'failed';

type RunOutcome = 'stale' | 'ok' | 'failed';

// 組織の管理の画面の節（src/lib/components/admin/）が、自分のデータを読むときの共通の状態。節の部品は一覧と操作だけを持ち、
// 表示は SectionBoundary に任せる。状態は外から書けない（読むだけの getter）。
// - 初回の読み込みは state が loading、失敗は failed（節の中に「もう一度試す」を出す）。読めたら ready。
// - ready の後の読み直し（操作の後）が失敗したら、一覧を残したまま refreshFailed が真になる（節の中に更新できなかったことを出す）。
// - 401 は、今のパスを return_to に入れてログインへ移す。
// - 読み込みごとに連番を取り、最新の1回の応答だけを反映する。先に始めた読み直しが後で返っても、新しい一覧を上書きしない。
// - 部品が外れた、slug が替わった後に返った応答は捨てる。操作を送る側は token() と isCurrent() で同じ判定をする
export class SectionLoad<T> {
  #state = $state<SectionLoadState>('loading');
  #refreshFailed = $state(false);
  #retrying = $state(false);
  // 「もう一度試す」の読み直しが失敗に終わったこと。押していない読み込みの結果では出さない
  #retryFailed = $state(false);

  #epoch = 0;
  #sequence = 0;
  #fetch: () => Promise<ApiResult<T>>;
  #apply: (data: T) => void;

  constructor(fetch: () => Promise<ApiResult<T>>, apply: (data: T) => void) {
    this.#fetch = fetch;
    this.#apply = apply;
  }

  get state(): SectionLoadState {
    return this.#state;
  }
  get refreshFailed(): boolean {
    return this.#refreshFailed;
  }
  get retrying(): boolean {
    return this.#retrying;
  }
  get retryFailed(): boolean {
    return this.#retryFailed;
  }

  // 部品の初期化のときに1回呼ぶ。key（slug など）が替わるたびに reset を呼んで最初から読み直し、部品が外れたら応答を捨てる
  attach(key: () => unknown, reset?: () => void): void {
    $effect(() => {
      void key();
      reset?.();
      this.#restart();
      return () => this.#dispose();
    });
  }

  #restart(): void {
    this.#epoch++;
    this.#sequence++;
    this.#state = 'loading';
    this.#refreshFailed = false;
    this.#retrying = false;
    this.#retryFailed = false;
    void this.load();
  }

  #dispose(): void {
    this.#epoch++;
    this.#sequence++;
  }

  // 操作を送る前に取り、返ってきたときに isCurrent で確かめる。送っている間に部品が外れたり slug が替わったりしたら偽になる
  token(): number {
    return this.#epoch;
  }

  isCurrent(token: number): boolean {
    return token === this.#epoch;
  }

  // 読み直し。「もう一度試す」の結果ではないので、前の「まだ読み込めませんでした」は下げる
  async load(): Promise<void> {
    this.#retryFailed = false;
    await this.#run();
  }

  // 「もう一度試す」。読み直している間は押しても無視する。自分の読み込みが最新だったときだけ、結果で retryFailed を決める
  async retry(): Promise<void> {
    if (this.#retrying) return;
    const token = this.#epoch;
    this.#retrying = true;
    this.#retryFailed = false;
    try {
      const outcome = await this.#run();
      if (outcome !== 'stale' && this.isCurrent(token)) this.#retryFailed = outcome === 'failed';
    } finally {
      if (this.isCurrent(token)) this.#retrying = false;
    }
  }

  async #run(): Promise<RunOutcome> {
    const mine = ++this.#sequence;
    const result = await this.#fetch();
    if (mine !== this.#sequence) return 'stale';
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url, result));
      return 'failed';
    }
    if (!result.ok) {
      if (this.#state === 'ready') this.#refreshFailed = true;
      else this.#state = 'failed';
      return 'failed';
    }
    this.#apply(result.data);
    this.#state = 'ready';
    this.#refreshFailed = false;
    return 'ok';
  }
}
