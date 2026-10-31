// テストだけが持つ binding（vitest.config.ts が渡す）
// vite の ?raw で読む SQL の文字列（test/api-token-seed.test.ts が seed/data.sql を読む）
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
