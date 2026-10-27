import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { devPorts } from './scripts/dev-ports.ts';
import { devWatchIgnored } from './scripts/dev-watch.ts';
import { fontsourceWoff2Only } from './scripts/fontsource-woff2.ts';
import { decodeNamedCharacterReferenceFile } from './scripts/markdown-worker-entities.ts';
import { pageCspDirectives } from './src/shared/security-headers.ts';

const ports = devPorts(process.env);
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    fontsourceWoff2Only(),
    sveltekit({
      compilerOptions: {
        // Svelte 6 までは runes を明示する。依存のライブラリは各自の設定に任せる
        runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
      },
      // SPA として書き出す。どのページも prerender せず、fallback の index.html がすべての画面を受ける
      adapter: adapter({ fallback: 'index.html' }),
      csp: { mode: 'hash', directives: pageCspDirectives },
      // API の /api/health と同じ値（ビルドで埋めたコミットの SHA）。手元では dev
      version: { name: process.env.APP_VERSION || 'dev' },
    }),
  ],
  // 本文の変換の Worker（src/lib/markdown.worker.ts）が DOM を使わない版を読むようにする（理由は scripts/markdown-worker-entities.ts）
  resolve: { alias: { 'decode-named-character-reference': decodeNamedCharacterReferenceFile } },
  build: {
    // 小さい書体のファイルを data: URI にして CSS へ埋め込ませない。CSP の font-src（default-src 'self'）は data: を通さず、止まる
    assetsInlineLimit: 0,
  },
  server: {
    port: ports.app,
    // ずれた vite が別のワークツリーの API につながらないよう、ぶつかったら落とす
    strictPort: true,
    // 本番の run_worker_first と同じく /api と /api/ の下だけを送る（'/api' は前方一致で /api-keys まで拾う）
    proxy: { '^/api(/|$)': `http://localhost:${ports.api}` },
    // 根の worktrees/、playwright-report/、build/ を監視しない（理由は scripts/dev-watch.ts）
    watch: { ignored: [devWatchIgnored(root)] },
  },
});
