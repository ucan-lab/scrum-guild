// 本文の変換を Worker に頼み、時間切れなら Worker を止める。parseMarkdown は、悪意のある本文（`*_` の連なり、深い入れ子）で
// 数秒から分のあいだ画面の本体を止めうるので、メインのスレッドでは走らせない。
// Worker は1つを共有し、要求は1本ずつ順に送る。
// 変換の時間切れ（MARKDOWN_TIMEOUT_MS）の数え始めは、Worker が `ready` を返した後に要求を送った時点。
// Worker の起動（束の取得と評価）は回線に左右されるので、別の上限（MARKDOWN_START_TIMEOUT_MS）で見る。
import type { MarkdownBlock } from './markdown.ts';

// この時間で変換が終わらない本文は、変換せずに文字のまま出す
export const MARKDOWN_TIMEOUT_MS = 1000;

// Worker が起動して `ready` を返すまでの上限。超えたら、この画面では Worker を使わない
export const MARKDOWN_START_TIMEOUT_MS = 10_000;

export type MarkdownRequest = { id: number; source: string };
export type MarkdownMessage =
  // Worker の束を評価し終え、要求を受けられる
  | { type: 'ready' }
  // blocks が null なのは、変換が失敗したか、出力の上限を超えたとき
  | { type: 'result'; id: number; blocks: MarkdownBlock[] | null };

// Worker のうち、ここで使う部分。テストでは偽物を渡す
export type MarkdownWorker = {
  postMessage(request: MarkdownRequest): void;
  terminate(): void;
  onmessage: ((event: { data: MarkdownMessage }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type MarkdownParseRequest = {
  // 変換した節。時間切れ、変換の失敗、Worker の失敗、Worker が作れない環境では null（呼び出し側が文字のまま出す）
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
  startTimeoutMs?: number;
}): MarkdownParser {
  const timeoutMs = options.timeoutMs ?? MARKDOWN_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? MARKDOWN_START_TIMEOUT_MS;
  const queue: Pending[] = [];
  let current: Pending | null = null;
  let worker: MarkdownWorker | null = null;
  let ready = false;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  // 起動できなかった Worker は、再び作らない。以後の要求はすべて null
  let unavailable = false;
  let nextId = 0;

  // 止めた Worker から遅れて届く応答は、次の要求に混ぜない
  function discardWorker() {
    clearTimeout(startTimer);
    if (!worker) return;
    worker.onmessage = null;
    worker.onmessageerror = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
    ready = false;
  }

  function finish(pending: Pending, blocks: MarkdownBlock[] | null) {
    clearTimeout(pending.timer);
    if (current === pending) current = null;
    pending.resolve(blocks);
    pump();
  }

  // Worker が壊れたとき。起動の前なら使えない環境とみなし、起動の後なら、今の要求だけを諦めて次の要求で作り直す
  function broken() {
    const started = ready;
    discardWorker();
    if (!started) unavailable = true;
    if (current) finish(current, null);
    else pump();
  }

  function onMessage(event: { data: MarkdownMessage }) {
    const message = event.data;
    if (message.type === 'ready') {
      if (ready) return;
      ready = true;
      clearTimeout(startTimer);
      if (current) send(current);
    } else if (current && message.id === current.id) {
      finish(current, message.blocks);
    }
  }

  function start(): MarkdownWorker | null {
    try {
      const created = options.createWorker();
      created.onmessage = onMessage;
      created.onmessageerror = broken;
      created.onerror = broken;
      startTimer = setTimeout(broken, startTimeoutMs);
      return created;
    } catch {
      // Worker が使えない環境
      return null;
    }
  }

  function send(pending: Pending) {
    // 起動を待つ間に取り下げられた要求は、送らない
    if (pending.cancelled) return finish(pending, null);
    pending.timer = setTimeout(() => {
      // 時間切れ。Worker は止めて、次の要求のために作り直す
      discardWorker();
      finish(pending, null);
    }, timeoutMs);
    try {
      worker?.postMessage({ id: pending.id, source: pending.source });
    } catch {
      discardWorker();
      finish(pending, null);
    }
  }

  function pump() {
    if (current) return;
    const pending = queue.shift();
    if (!pending) return;
    if (pending.cancelled) return pump();
    current = pending;
    if (unavailable) return finish(pending, null);
    if (!worker) {
      worker = start();
      if (!worker) {
        unavailable = true;
        return finish(pending, null);
      }
    }
    // 起動の途中なら、`ready` が届いてから送る
    if (ready) send(pending);
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
