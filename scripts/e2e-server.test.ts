import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { e2eHealthURL, e2eServerVersion, reuseExistingServer, serverVersionMismatch } from './e2e-server.ts';

describe('reuseExistingServer', () => {
  test('手元では E2E_REUSE_SERVER=1 のときだけ使い回す', () => {
    assert.equal(reuseExistingServer({}), false);
    assert.equal(reuseExistingServer({ E2E_REUSE_SERVER: '1' }), true);
    assert.equal(reuseExistingServer({ E2E_REUSE_SERVER: 'true' }), false);
  });

  test('CI では付けても使い回さない', () => {
    assert.equal(reuseExistingServer({ CI: 'true', E2E_REUSE_SERVER: '1' }), false);
  });
});

describe('e2eServerVersion', () => {
  test('渡された版はそのまま使う', () => {
    assert.equal(e2eServerVersion({ CI: 'true', APP_VERSION: 'abc123' }, 0), 'abc123');
    assert.equal(e2eServerVersion({ APP_VERSION: 'mine', E2E_REUSE_SERVER: '1' }, 0), 'mine');
  });

  test('手元で渡されなければ、実行ごとに違う版にする', () => {
    const first = e2eServerVersion({}, 1_000);
    const second = e2eServerVersion({}, 2_000);
    assert.match(first, /^e2e-/);
    assert.notEqual(first, second);
  });

  test('使い回すときは、版を渡さずに立てた preview と同じ dev', () => {
    assert.equal(e2eServerVersion({ E2E_REUSE_SERVER: '1' }, 1_000), 'dev');
  });
});

describe('e2eHealthURL', () => {
  test('DEV_PORT_OFFSET でずらした API のポートを見る', () => {
    assert.equal(e2eHealthURL({}), 'http://localhost:8787/api/health');
    assert.equal(e2eHealthURL({ DEV_PORT_OFFSET: '60' }), 'http://localhost:8847/api/health');
  });
});

describe('serverVersionMismatch', () => {
  test('版が同じなら止めない', () => {
    assert.equal(serverVersionMismatch('e2e-1', 'e2e-1', {}), undefined);
  });

  test('前のサーバーが答えたら、ポートと止め方を出して止める', () => {
    const reason = serverVersionMismatch('e2e-2', 'e2e-1', { DEV_PORT_OFFSET: '60' }) ?? '';
    assert.match(reason, /"e2e-1"/);
    assert.match(reason, /e2e-2/);
    assert.match(reason, /lsof -i :8847/);
  });

  test('版が無い応答も違うものとして止める', () => {
    assert.notEqual(serverVersionMismatch('e2e-1', undefined, {}), undefined);
  });

  test('使い回したサーバーの版が違えば、E2E_REUSE_SERVER の直し方を出す', () => {
    const reason = serverVersionMismatch('dev', 'abc123', { E2E_REUSE_SERVER: '1' }) ?? '';
    assert.match(reason, /E2E_REUSE_SERVER/);
  });
});
