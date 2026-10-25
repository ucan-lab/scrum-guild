// Markdown の変換の Worker（src/lib/markdown.worker.ts）が読む decode-named-character-reference の場所。
// micromark が使うこのパッケージは、`browser` の条件で DOM 版（index.dom.js）を選ぶ。DOM 版は `document.createElement`
// を呼ぶので、Worker では `document is not defined` で落ちる。Node の条件で解決すると DOM を使わない index.js
// （character-entities の表を持つ）になるので、vite.config.ts の `resolve.alias` でこの場所へ寄せる。
// pnpm では micromark の隣にしか無いので、ここから解決できるよう直の依存にしてある。
// 画面の本体は micromark を型でしか読まない。dev の Worker と build の Worker の束の両方に効く
import { fileURLToPath } from 'node:url';

export const decodeNamedCharacterReferenceFile = fileURLToPath(import.meta.resolve('decode-named-character-reference'));
