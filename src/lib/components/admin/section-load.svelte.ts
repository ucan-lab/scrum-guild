import { page } from '$app/state';
import type { ApiResult } from '../../api.ts';
import { loginUrl, isUnauthenticated } from '../../login-redirect.ts';

export type SectionLoadState = 'loading' | 'ready' | 'failed';

// 組織の管理の画面の節（src/lib/components/admin/）が、自分のデータを読むときの共通の状態。節の部品は一覧と操作だけを持つ。
// - 初回の読み込みは state が loading、失敗は failed（節の中に「もう一度試す」を出す）。読めたら ready。
// - ready の後の読み直し（操作の後）が失敗したら、一覧を残したまま refreshFailed を真にする（節の中に更新できなかったことを出す）。
// - 401 は、今のパスを return_to に入れてログインへ移す。
// - 読み込みごとに連番を取り、最新の1回の応答だけを反映する。先に始めた読み直しが後で返っても、新しい一覧を上書きしない。
// - 部品が外れた（dispose）、slug が替わった（restart）後に返った応答は捨てる。epoch は操作を送る側が同じ判定に使う
export class SectionLoad<T> {
  state = $state<SectionLoadState>('loading');
  refreshFailed = $state(false);
  retrying = $state(false);
  // 「もう一度試す」の読み直しが失敗に終わったこと
  retryFailed = $state(false);
  epoch = 0;

  #sequence = 0;
  #fetch: () => Promise<ApiResult<T>>;
  #apply: (data: T) => void;

  constructor(fetch: () => Promise<ApiResult<T>>, apply: (data: T) => void) {
    this.#fetch = fetch;
    this.#apply = apply;
  }

  // 最初から読む。節が出たときと slug が替わったときに呼ぶ
  restart(): void {
    this.epoch++;
    this.#sequence++;
    this.state = 'loading';
    this.refreshFailed = false;
    this.retrying = false;
    this.retryFailed = false;
    void this.load();
  }

  // 部品が外れたとき。返ってくる応答を捨てる
  dispose(): void {
    this.epoch++;
    this.#sequence++;
  }

  async load(): Promise<void> {
    const mine = ++this.#sequence;
    const result = await this.#fetch();
    if (mine !== this.#sequence) return;
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return;
    }
    if (!result.ok) {
      if (this.state === 'ready') this.refreshFailed = true;
      else this.state = 'failed';
      return;
    }
    this.#apply(result.data);
    this.state = 'ready';
    this.refreshFailed = false;
  }

  // 「もう一度試す」。読み直している間は押しても無視する
  async retry(): Promise<void> {
    if (this.retrying) return;
    const mine = this.epoch;
    this.retrying = true;
    this.retryFailed = false;
    try {
      await this.load();
    } finally {
      if (mine === this.epoch) this.retrying = false;
    }
    if (mine === this.epoch) this.retryFailed = this.state === 'failed' || this.refreshFailed;
  }
}
