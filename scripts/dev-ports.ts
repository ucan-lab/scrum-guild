// pnpm dev と pnpm preview のポート。3つを同じ幅（オフセット）だけずらし、ワークツリーを並べても重ならないようにする。
// オフセットは DEV_PORT_OFFSET > 根の .dev-port-offset > worktrees/ 直下の名前から導いた値 > 0 の順で決める。
// vite の /api の転送先もここから作るので、画面が別のワークツリーの API につながることはない。
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DevPorts = { app: number; api: number; inspector: number };

const base: DevPorts = { app: 5173, api: 8787, inspector: 9229 };

// API は 8787 + n。n が 442 以上だとデバッガーの 9229（オフセット 0）と重なる
const MAX_OFFSET = 441;

const OFFSET_FILE = '.dev-port-offset';
const WORKTREES_DIR = 'worktrees';

// cwd に頼らない。vite と Playwright の設定ファイルから読んでも、scripts/ の親が根になる
const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ファイルが無ければ undefined。ENOENT 以外の読み込みの失敗は黙らせず投げる
function readOffsetFileFromDisk(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// 画面を開く URL。API の Origin の検査（wrangler の vars の PUBLIC_ORIGIN）をこれで上書きする。
// pnpm dev は vite の画面から /api を転送するのでブラウザの Origin は vite の URL、pnpm preview は wrangler dev の URL になる
export function devPublicOrigin(ports: DevPorts, preview: boolean): string {
  return `http://localhost:${preview ? ports.api : ports.app}`;
}

function parseOffset(raw: string, source: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_OFFSET) {
    throw new Error(`${source} は 0 から ${MAX_OFFSET} の整数にする（今の値: ${JSON.stringify(raw)}）`);
  }
  return Number(raw);
}

// FNV-1a 32 ビット。番号の無い名前でも、同じ名前なら誰が計算しても同じオフセットになる
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// `<番号>-<名前>` は 1 + (番号 - 1) mod 441。番号 0 や番号の無い名前は、名前のハッシュを 1〜441 に落とす
function offsetFromWorktreeName(name: string): number {
  const number = /^(\d+)-/.exec(name)?.[1];
  // 桁数に上限が無いので BigInt で割る
  if (number !== undefined && BigInt(number) > 0n) {
    return 1 + Number((BigInt(number) - 1n) % BigInt(MAX_OFFSET));
  }
  return 1 + (fnv1a32(name) % MAX_OFFSET);
}

function resolveOffset(
  env: Record<string, string | undefined>,
  root: string,
  readOffsetFile: (path: string) => string | undefined,
): number {
  if (env.DEV_PORT_OFFSET !== undefined) return parseOffset(env.DEV_PORT_OFFSET, 'DEV_PORT_OFFSET');

  const file = join(root, OFFSET_FILE);
  const content = readOffsetFile(file);
  if (content !== undefined) return parseOffset(content.trim(), file);

  if (basename(dirname(root)) === WORKTREES_DIR) return offsetFromWorktreeName(basename(root));
  return 0;
}

export function devPorts(
  env: Record<string, string | undefined>,
  root: string = defaultRoot,
  readOffsetFile: (path: string) => string | undefined = readOffsetFileFromDisk,
): DevPorts {
  const offset = resolveOffset(env, root, readOffsetFile);
  return { app: base.app + offset, api: base.api + offset, inspector: base.inspector + offset };
}
