import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { devPorts, devPublicOrigin } from './dev-ports.ts';

const MAIN_ROOT = '/work/scrum-guild';
const worktree = (name: string) => `/work/scrum-guild/worktrees/${name}`;
const noFile = () => undefined;
const fileOf = (content: string) => () => content;

function offsetOf(ports: { app: number }): number {
  return ports.app - 5173;
}

describe('devPorts の既定', () => {
  test('環境変数もファイルも無い本体の作業コピーは 5173、8787、9229', () => {
    assert.deepEqual(devPorts({}, MAIN_ROOT, noFile), { app: 5173, api: 8787, inspector: 9229 });
  });

  test('根の親が worktrees でなければ、名前が番号付きでも 0', () => {
    assert.deepEqual(devPorts({}, '/work/other/385-x', noFile), { app: 5173, api: 8787, inspector: 9229 });
    assert.deepEqual(devPorts({}, '/work/worktrees-x/385-x', noFile), { app: 5173, api: 8787, inspector: 9229 });
  });

  test('ファイルの読み込みには根の .dev-port-offset のパスを渡す', () => {
    const paths: string[] = [];
    devPorts({}, MAIN_ROOT, (path) => {
      paths.push(path);
      return undefined;
    });
    assert.deepEqual(paths, ['/work/scrum-guild/.dev-port-offset']);
  });
});

describe('devPorts の優先の順', () => {
  test('環境変数が、ファイルと名前に勝つ', () => {
    const ports = devPorts({ DEV_PORT_OFFSET: '10' }, worktree('385-x'), fileOf('20'));
    assert.deepEqual(ports, { app: 5183, api: 8797, inspector: 9239 });
  });

  test('環境変数の 0 も、ファイルと名前に勝つ', () => {
    assert.equal(offsetOf(devPorts({ DEV_PORT_OFFSET: '0' }, worktree('385-x'), fileOf('20'))), 0);
  });

  test('ファイルが名前に勝つ', () => {
    assert.equal(offsetOf(devPorts({}, worktree('385-x'), fileOf('20'))), 20);
  });

  test('ファイルの 0 は名前に勝つ（OAuth を確かめるときの置き方）', () => {
    assert.deepEqual(devPorts({}, worktree('385-x'), fileOf('0')), { app: 5173, api: 8787, inspector: 9229 });
  });

  test('ファイルが無ければ名前から導く', () => {
    assert.equal(offsetOf(devPorts({}, worktree('385-x'), noFile)), 385);
  });

  test('ファイルは前後の空白と改行を除いて読む', () => {
    assert.equal(offsetOf(devPorts({}, MAIN_ROOT, fileOf('7\n'))), 7);
    assert.equal(offsetOf(devPorts({}, MAIN_ROOT, fileOf('  12 \r\n\n'))), 12);
  });

  test('3つを同じ幅ずらす', () => {
    assert.deepEqual(devPorts({}, MAIN_ROOT, fileOf('441')), { app: 5614, api: 9228, inspector: 9670 });
  });
});

describe('名前からの導出', () => {
  const cases: [string, number][] = [
    ['1-x', 1],
    ['385-x', 385],
    ['441-x', 441],
    ['442-x', 1],
    ['443-x', 2],
    ['882-x', 441],
    ['883-x', 1],
    ['001-x', 1],
    ['385-dev-port-from-worktree', 385],
    // Number に収まらない桁数でも 1 + (番号 - 1) mod 441
    ['99999999999999999999-x', 288],
  ];
  for (const [name, expected] of cases) {
    test(`${name} は ${expected}`, () => {
      assert.equal(offsetOf(devPorts({}, worktree(name), noFile)), expected);
    });
  }

  test('番号の無い名前は決定的で 1 から 441', () => {
    for (const name of ['fix-login', 'a', 'x-385', '385', '385x', 'ワークツリー', '-1-x']) {
      const first = offsetOf(devPorts({}, worktree(name), noFile));
      assert.equal(first, offsetOf(devPorts({}, worktree(name), noFile)), name);
      assert.ok(Number.isInteger(first) && first >= 1 && first <= 441, `${name}: ${first}`);
    }
  });

  test('番号の無い名前は FNV-1a 32 ビットから 1 + (hash mod 441)', () => {
    // fnv1a32('a') = 0xe40c292c = 3826002220。3826002220 mod 441 = 439
    assert.equal(offsetOf(devPorts({}, worktree('a'), noFile)), 440);
  });

  test('番号 0 は名前のハッシュ側へ回り、1 から 441 に収まる', () => {
    const offset = offsetOf(devPorts({}, worktree('0-x'), noFile));
    assert.ok(offset >= 1 && offset <= 441, String(offset));
  });

  test('名前が違えば番号の無い名前でも別のオフセットになりうる（全部が同じ値ではない）', () => {
    const offsets = new Set(
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((name) => offsetOf(devPorts({}, worktree(name), noFile))),
    );
    assert.ok(offsets.size > 1);
  });
});

describe('オフセットの範囲', () => {
  const bad = ['442', '1000', '-1', '', '1.5', 'abc', ' 10', '1e2', '0x10'];

  test('環境変数は 0 から 441 の整数だけ', () => {
    for (const value of bad) {
      assert.throws(
        () => devPorts({ DEV_PORT_OFFSET: value }, MAIN_ROOT, noFile),
        /DEV_PORT_OFFSET/,
        JSON.stringify(value),
      );
    }
    assert.equal(offsetOf(devPorts({ DEV_PORT_OFFSET: '441' }, MAIN_ROOT, noFile)), 441);
  });

  test('ファイルは 0 から 441 の整数だけで、誤りのメッセージにファイルのパスが入る', () => {
    for (const value of ['442', '-1', '', '   \n', '1.5', 'abc', '1 2', '1e2']) {
      assert.throws(
        () => devPorts({}, MAIN_ROOT, fileOf(value)),
        (err: Error) => err.message.includes('/work/scrum-guild/.dev-port-offset'),
        JSON.stringify(value),
      );
    }
    assert.equal(offsetOf(devPorts({}, MAIN_ROOT, fileOf('441\n'))), 441);
  });

  test('ファイルの誤りは、名前からの導出や 0 へ落ちずに投げる', () => {
    assert.throws(() => devPorts({}, worktree('385-x'), fileOf('abc')), /\.dev-port-offset/);
  });

  test('環境変数が正しければ、ファイルの誤りは読まない', () => {
    assert.equal(offsetOf(devPorts({ DEV_PORT_OFFSET: '3' }, MAIN_ROOT, fileOf('abc'))), 3);
  });

  test('最大のオフセットでも API がデバッガーの 9229 と重ならない', () => {
    const max = devPorts({ DEV_PORT_OFFSET: '441' }, MAIN_ROOT, noFile);
    assert.ok(max.api < 9229);
  });

  test('読み込みの失敗は黙らせずそのまま投げる', () => {
    assert.throws(
      () =>
        devPorts({}, MAIN_ROOT, () => {
          throw new Error('EACCES');
        }),
      /EACCES/,
    );
  });
});

// ほかのテストは根と読み込みを差し替えるので、既定の根とディスクからの読み込みはここでだけ通す
describe('devPorts の既定の根と読み込み', () => {
  const base = mkdtempSync(join(tmpdir(), 'dev-ports-'));
  after(() => rmSync(base, { recursive: true, force: true }));

  test('既定の根は scripts/ の親（package.json のあるディレクトリ）', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const paths: string[] = [];
    devPorts({}, undefined, (path) => {
      paths.push(path);
      return '0';
    });
    assert.deepEqual(paths, [join(repoRoot, '.dev-port-offset')]);
  });

  test('ディスクの .dev-port-offset を読み、無ければ名前から導く', () => {
    const root = join(base, 'worktrees', '7-x');
    mkdirSync(root, { recursive: true });
    assert.equal(offsetOf(devPorts({}, root)), 7);
    writeFileSync(join(root, '.dev-port-offset'), '0\n');
    assert.equal(offsetOf(devPorts({}, root)), 0);
  });
});

describe('devPublicOrigin', () => {
  test('pnpm dev は vite の画面の URL、pnpm preview は wrangler dev の URL', () => {
    const ports = devPorts({}, MAIN_ROOT, noFile);
    assert.equal(devPublicOrigin(ports, false), 'http://localhost:5173');
    assert.equal(devPublicOrigin(ports, true), 'http://localhost:8787');
  });

  test('オフセットでずらした値になる', () => {
    const ports = devPorts({ DEV_PORT_OFFSET: '10' }, MAIN_ROOT, noFile);
    assert.equal(devPublicOrigin(ports, false), 'http://localhost:5183');
    assert.equal(devPublicOrigin(ports, true), 'http://localhost:8797');
  });
});
