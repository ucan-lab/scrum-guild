import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { devPorts } from './scripts/dev-ports.ts';
import { pageCspDirectives } from './src/shared/security-headers.ts';

const ports = devPorts(process.env);

export default defineConfig({
  plugins: [
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
  server: {
    port: ports.app,
    // ずれた vite が別のワークツリーの API につながらないよう、ぶつかったら落とす
    strictPort: true,
    proxy: { '/api': `http://localhost:${ports.api}` },
  },
});
