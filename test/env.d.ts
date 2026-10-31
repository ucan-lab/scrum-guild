// テストだけが持つ binding（vitest.config.ts が渡す）
// vite の ?raw で読む SQL の文字列（test/api-token-seed.test.ts が seed/data.sql を読む）
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

// vite の import.meta.glob の型（test/operation-registry.test.ts が塊のファイルの一覧と中身を取る）。
// vite/client を丸ごと入れると、Worker の型に無い名前が増えるので、必要な分だけ宣言する
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
}

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
