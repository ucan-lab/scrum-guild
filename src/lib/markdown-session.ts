// Markdown.svelte の振る舞い。Worker での変換（markdown-parser.ts）の前に結果を覚え、本文が変わったときの描き替えを決める。
// 部品はこれを呼ぶだけにして、parser を差し込んでテストできるようにしてある。
import type { MarkdownBlock } from './markdown.ts';
import type { MarkdownParser } from './markdown-parser.ts';
import { blockWeight } from './markdown-render.ts';

// 覚えておく本文の数。同じ本文を画面を移るたびに変換し直さず、時間切れの本文を二度と Worker に送らないための記憶
export const MARKDOWN_CACHE_SIZE = 100;
// 覚えておく量の合計（本文の字数と、節の数の合計）。1件は本文が最大10万字、節が最大5万なので、件数だけでは
// 上限近い本文が並ぶと数百 MB に届く。上限近い本文で13件ほど
export const MARKDOWN_CACHE_WEIGHT = 2_000_000;

// 変換した節。null は、時間切れ、変換の失敗、出力の上限を超えたこと（文字のまま出す）
export type MarkdownResult = MarkdownBlock[] | null;

export type MarkdownLoader = {
  // 覚えている結果を取り出し、使った本文として LRU の順を新しくする。覚えていなければ undefined
  // （結果が null のときも、覚えていれば { result: null }）
  recall(source: string): { result: MarkdownResult } | undefined;
  load(source: string): { result: Promise<MarkdownResult>; cancel: () => void };
};

type Inflight = {
  result: Promise<MarkdownResult>;
  refs: number;
  // Worker に送る前に取り下げた（結果の null は、時間切れや失敗ではない）
  withdrawn: boolean;
  cancel: () => boolean;
};

const weightOf = (source: string, result: MarkdownResult): number =>
  source.length + (result ? result.reduce((sum, block) => sum + blockWeight(block), 0) : 0);

// 結果を、本文をキーに件数と量に上限のある Map（LRU）で覚える。同じ本文の変換が進んでいるときは、その結果を分け合う。
// 送り済みの要求は、待つ人が全員いなくなっても進めて結果を覚える（時間切れの本文を、あとで二度送らないため）。
// 同じ本文を新しく頼まれたら、その変換に相乗りして、同じ本文を2本変換しない
export function createMarkdownLoader(
  parser: MarkdownParser,
  cacheSize = MARKDOWN_CACHE_SIZE,
  cacheWeight = MARKDOWN_CACHE_WEIGHT,
): MarkdownLoader {
  const cache = new Map<string, { result: MarkdownResult; weight: number }>();
  const inflight = new Map<string, Inflight>();
  let total = 0;

  function forget(source: string) {
    const entry = cache.get(source);
    if (!entry) return;
    cache.delete(source);
    total -= entry.weight;
  }

  function remember(source: string, result: MarkdownResult) {
    forget(source);
    const weight = weightOf(source, result);
    cache.set(source, { result, weight });
    total += weight;
    // 古いものから追い出す。今入れた1件は残す
    while (cache.size > 1 && (cache.size > cacheSize || total > cacheWeight)) {
      forget(cache.keys().next().value as string);
    }
  }

  return {
    recall(source) {
      const entry = cache.get(source);
      if (!entry) return undefined;
      // 使った本文として、LRU の末尾へ移す
      cache.delete(source);
      cache.set(source, entry);
      return { result: entry.result };
    },
    load(source) {
      const known = cache.get(source);
      if (known) return { result: Promise.resolve(known.result), cancel() {} };
      let entry = inflight.get(source);
      if (!entry) {
        const request = parser.parse(source);
        const created: Inflight = {
          refs: 0,
          withdrawn: false,
          cancel: request.cancel,
          result: request.result.then((result) => {
            if (inflight.get(source) === created) inflight.delete(source);
            // 待ちの中で取り下げただけの null は、時間切れとして覚えない。送った後の null は、取り下げても覚える
            if (!created.withdrawn) remember(source, result);
            return result;
          }),
        };
        inflight.set(source, created);
        entry = created;
      }
      const shared = entry;
      shared.refs++;
      let released = false;
      return {
        result: shared.result,
        cancel() {
          if (released) return;
          released = true;
          if (--shared.refs > 0) return;
          // 送る前なら取り下げて、待ちから外す。送り済みなら、そのまま進めて相乗りを待つ
          if (shared.cancel()) {
            shared.withdrawn = true;
            if (inflight.get(source) === shared) inflight.delete(source);
          }
        },
      };
    },
  };
}

export type MarkdownView = {
  // loading: 結果を待っている。ready: 今の本文の節。plain: 時間切れか失敗で、文字のまま出す
  status: 'loading' | 'ready' | 'plain';
  // 描く節。loading の間は、前の本文の節を残す（無ければ null）
  blocks: MarkdownBlock[] | null;
};

export class MarkdownSession {
  #loader: MarkdownLoader;
  #notify: (view: MarkdownView) => void;
  #view: MarkdownView = { status: 'loading', blocks: null };
  #cancel: (() => void) | null = null;
  // 取り下げた要求と古い本文の結果を捨てるための番号
  #generation = 0;

  constructor(loader: MarkdownLoader, notify: (view: MarkdownView) => void) {
    this.#loader = loader;
    this.#notify = notify;
  }

  get view(): MarkdownView {
    return this.#view;
  }

  // 本文を表示する。覚えた結果があれば同じ手番で描き、無ければ、結果が来るまで前の描画を残す
  show(source: string): void {
    this.cancel();
    const generation = this.#generation;
    const known = this.#loader.recall(source);
    if (known) return this.#settle(known.result);

    this.#update({ status: 'loading', blocks: this.#view.blocks });
    const request = this.#loader.load(source);
    this.#cancel = request.cancel;
    void request.result.then((result) => {
      if (generation !== this.#generation) return;
      this.#cancel = null;
      this.#settle(result);
    });
  }

  // 待っている要求を取り下げ、遅れて届く結果を捨てる。描いてある節は残す
  cancel(): void {
    this.#generation++;
    this.#cancel?.();
    this.#cancel = null;
  }

  #settle(result: MarkdownResult) {
    this.#update(result ? { status: 'ready', blocks: result } : { status: 'plain', blocks: null });
  }

  #update(view: MarkdownView) {
    this.#view = view;
    this.#notify(view);
  }
}
