// vitest の環境。DOM は持たず、Svelte の実行（$effect と flushSync）をブラウザ向けの版で動かすためのもの。
// 既定の node の環境は、サーバー向けの変換（SSR）で .svelte.ts を読むので、$effect が動かない。
// ここでは viteEnvironment を client にして、ブラウザ向けの変換で読ませる（vitest.config.ts の web-client）
import type { Environment } from 'vitest/environments';

const environment: Environment = {
  name: 'svelte-client',
  viteEnvironment: 'client',
  setup() {
    return { teardown() {} };
  },
};

export default environment;
