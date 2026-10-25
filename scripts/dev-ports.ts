// pnpm dev と pnpm preview のポート。ワークツリーを並べるときは DEV_PORT_OFFSET で3つを同じ幅だけずらす。
// vite の /api の転送先もここから作るので、画面が別のワークツリーの API につながることはない。

export type DevPorts = { app: number; api: number; inspector: number };

const base: DevPorts = { app: 5173, api: 8787, inspector: 9229 };

// 画面を開く URL。API の Origin の検査（wrangler の vars の PUBLIC_ORIGIN）をこれで上書きする。
// pnpm dev は vite の画面から /api を転送するのでブラウザの Origin は vite の URL、pnpm preview は wrangler dev の URL になる
export function devPublicOrigin(ports: DevPorts, preview: boolean): string {
  return `http://localhost:${preview ? ports.api : ports.app}`;
}

export function devPorts(env: Record<string, string | undefined>): DevPorts {
  const raw = env.DEV_PORT_OFFSET ?? '0';
  const offset = Number(raw);
  if (!/^\d+$/.test(raw) || offset > 1000) {
    throw new Error(`DEV_PORT_OFFSET は 0 から 1000 の整数にする（今の値: ${raw}）`);
  }
  return { app: base.app + offset, api: base.api + offset, inspector: base.inspector + offset };
}
