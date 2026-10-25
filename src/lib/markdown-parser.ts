// 本文の変換を Worker に頼み、時間切れなら Worker を止める。parseMarkdown は、悪意のある本文（`*_` の連なり、深い入れ子）で
// 数秒から分のあいだ画面の本体を止めうるので、メインのスレッドでは走らせない。
// Worker は1つを共有し、要求は1本ずつ順に送る。時間切れの数え始めは、Worker に送った時点。
import type { MarkdownBlock } from './markdown.ts';

// この時間で変換が終わらない本文は、変換せずに文字のまま出す
export const MARKDOWN_TIMEOUT_MS = 1000;

export type MarkdownRequest = { id: number; source: string };
// blocks が null なのは、Worker の中で変換が失敗したとき
export type MarkdownResponse = { id: number; blocks: MarkdownBlock[] | null };

// Worker のうち、ここで使う部分。テストでは偽物を渡す
export type MarkdownWorker = {
  postMessage(request: MarkdownRequest): void;
  terminate(): void;
  onmessage: ((event: { data: MarkdownResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type MarkdownParseRequest = {
  // 変換した節。時間切れ、Worker の失敗、Worker が作れない環境では null（呼び出し側が文字のまま出す）
  result: Promise<MarkdownBlock[] | null>;
  // 結果が要らなくなったとき。待っている要求は取り下げる。送り済みの要求は、結果を捨てて時間切れまで Worker に任せる
  cancel: () => void;
};

export type MarkdownParser = { parse(source: string): MarkdownParseRequest };

type Pending = {
  id: number;
  source: string;
  resolve: (blocks: MarkdownBlock[] | null) => void;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export function createMarkdownParser(options: {
  createWorker: () => MarkdownWorker;
  timeoutMs?: number;
}): MarkdownParser {
  const timeoutMs = options.timeoutMs ?? MARKDOWN_TIMEOUT_MS;
  const queue: Pending[] = [];
  let current: Pending | null = null;
  let worker: MarkdownWorker | null = null;
  let nextId = 0;

  // 止めた Worker から遅れて届く応答は、次の要求に混ぜない
  function discardWorker() {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  }

  function finish(pending: Pending, blocks: MarkdownBlock[] | null) {
    clearTimeout(pending.timer);
    if (current === pending) current = null;
    pending.resolve(blocks);
    pump();
  }

  // 失敗した Worker は止めて捨て、次の要求のときに作り直す
  function fail(pending: Pending) {
    discardWorker();
    finish(pending, null);
  }

  function start(): MarkdownWorker | null {
    try {
      const created = options.createWorker();
      created.onmessage = (event) => {
        const response = event.data;
        if (current && response.id === current.id) finish(current, response.blocks);
      };
      created.onerror = () => {
        if (current) fail(current);
      };
      return created;
    } catch {
      // Worker が使えない環境
      return null;
    }
  }

  function pump() {
    if (current) return;
    const pending = queue.shift();
    if (!pending) return;
    if (pending.cancelled) return pump();
    current = pending;
    worker ??= start();
    if (!worker) return finish(pending, null);
    pending.timer = setTimeout(() => fail(pending), timeoutMs);
    try {
      worker.postMessage({ id: pending.id, source: pending.source });
    } catch {
      fail(pending);
    }
  }

  return {
    parse(source) {
      let pending!: Pending;
      const result = new Promise<MarkdownBlock[] | null>((resolve) => {
        pending = { id: nextId++, source, resolve, cancelled: false };
      });
      queue.push(pending);
      pump();
      return {
        result,
        cancel() {
          pending.cancelled = true;
          const queued = queue.indexOf(pending);
          if (queued >= 0) {
            queue.splice(queued, 1);
            pending.resolve(null);
          }
        },
      };
    },
  };
}
