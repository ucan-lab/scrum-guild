// Markdown の変換の Worker（src/lib/markdown.worker.ts）の束に入れる Vite のプラグイン。
// micromark が使う decode-named-character-reference は、`browser` の条件で DOM 版（index.dom.js）を選ぶ。
// DOM 版は `document.createElement` を呼ぶので、Worker では `document is not defined` で落ちる。
// Worker の束だけ、DOM を使わない index.js（character-entities の表を持つ）へ解決する
import type { Plugin } from 'vite';

const PACKAGE = 'decode-named-character-reference';
const DOM_FILE = /index\.dom\.js$/;

export function markdownWorkerEntities(): Plugin {
  return {
    name: 'markdown-worker-entities',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== PACKAGE) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !DOM_FILE.test(resolved.id)) return resolved;
      return { ...resolved, id: resolved.id.replace(DOM_FILE, 'index.js') };
    },
  };
}
