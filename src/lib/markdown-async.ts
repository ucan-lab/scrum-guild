// 画面が使う、共有の Worker での変換。Worker は自分のオリジンのファイルとして出る（CSP の script-src 'self' で通る。blob: や data: は使わない）。
// `new Worker(new URL(…), import.meta.url)` の形は、Vite が Worker の束を作る目印なので、式を変えない
import { createMarkdownParser, type MarkdownParser, type MarkdownWorker } from './markdown-parser.ts';

let shared: MarkdownParser | undefined;

export function sharedMarkdownParser(): MarkdownParser {
  shared ??= createMarkdownParser({
    createWorker: () =>
      new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' }) as unknown as MarkdownWorker,
  });
  return shared;
}
