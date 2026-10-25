// 本文の変換を走らせる Worker（markdown-async.ts が作る）。メインのスレッドを止めないために、変換はここで行う
import { parseMarkdown } from './markdown.ts';
import type { MarkdownRequest, MarkdownResponse } from './markdown-parser.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MarkdownRequest>) => void) | null;
  postMessage(response: MarkdownResponse): void;
};

scope.onmessage = ({ data: { id, source } }) => {
  try {
    scope.postMessage({ id, blocks: parseMarkdown(source) });
  } catch {
    scope.postMessage({ id, blocks: null });
  }
};
