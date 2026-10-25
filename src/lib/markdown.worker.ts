// 本文の変換を走らせる Worker（markdown-async.ts が作る）。メインのスレッドを止めないために、変換はここで行う
import { parseMarkdown } from './markdown.ts';
import type { MarkdownMessage, MarkdownRequest } from './markdown-parser.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MarkdownRequest>) => void) | null;
  postMessage(message: MarkdownMessage): void;
};

scope.onmessage = ({ data: { id, source } }) => {
  try {
    scope.postMessage({ type: 'result', id, blocks: parseMarkdown(source) });
  } catch (error) {
    // 本文は載せない（本文を含むログを出さない）。失敗の種類だけを残す
    console.error('Markdown の変換に失敗しました', error instanceof Error ? error.name : typeof error);
    scope.postMessage({ type: 'result', id, blocks: null });
  }
};

// 束の評価が終わり、要求を受けられる。親は、これを受けてから時間切れを数え始める
scope.postMessage({ type: 'ready' });
