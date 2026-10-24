import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractMetaCsp, headersFile, missingStyleHashes, withIgnoredDirectives } from './headers.ts';
import { devPorts } from './dev-ports.ts';

const meta = `default-src 'self'; script-src 'self' 'sha256-abc='`;
const html = `<head><meta http-equiv="content-security-policy" content="${meta}"></head>`;

describe('headers', () => {
  test('meta の CSP を取り出す', () => {
    assert.equal(extractMetaCsp(html), meta);
  });

  test('meta が無ければ失敗する', () => {
    assert.throws(() => extractMetaCsp('<head></head>'), /CSP の meta/);
  });

  test('meta が2つあれば失敗する', () => {
    assert.throws(() => extractMetaCsp(html + html), /2 個/);
  });

  test('SvelteKit が meta で捨てる frame-ancestors を末尾に足す', () => {
    assert.equal(withIgnoredDirectives(meta), `${meta}; frame-ancestors 'none'`);
  });

  test('既にある指令は足さない', () => {
    const csp = `${meta}; frame-ancestors 'self'`;
    assert.equal(withIgnoredDirectives(csp), csp);
  });

  test('_headers に CSP、固定のヘッダー、immutable のキャッシュを書く', () => {
    const file = headersFile(html);
    assert.match(
      file,
      /^\/\*\n {2}Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-abc='; frame-ancestors 'none'\n/,
    );
    assert.match(file, /\n {2}X-Content-Type-Options: nosniff\n/);
    assert.match(file, /\n\/_app\/immutable\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n$/);
  });
});

describe('missingStyleHashes', () => {
  // 'color: red' の sha256
  const hash = "'sha256-NerDAUWfwD31YdZHveMrq0GLjsNFMwxLpZl0dPUeCcw='";

  test('style-src のハッシュにある style 属性は通す', () => {
    assert.deepEqual(missingStyleHashes(`style-src 'self' 'unsafe-hashes' ${hash}`, ['<div style="color: red">']), []);
  });

  test('ハッシュに無い style 属性を返す', () => {
    assert.deepEqual(missingStyleHashes("default-src 'self'", ['<div style="color: red">']), [`color: red → ${hash}`]);
  });

  test('単一引用符と、JS の文字列の中でエスケープされた引用符の style 属性も拾う', () => {
    const scripts = [
      `'<div style=\\'color: red\\'>'`,
      `"<div style=\\"color: red\\">"`,
      `\`<div style='color: red'>\``,
    ];
    assert.deepEqual(missingStyleHashes("default-src 'self'", scripts), [`color: red → ${hash}`]);
  });

  test('文字参照を戻した値でハッシュを取る', () => {
    // 'a: "b"' の sha256
    const quoted = "'sha256-PEGGa67ITlp99HLdDIET74cCxYimSFdhCJcLnjWYfGA='";
    assert.deepEqual(missingStyleHashes(`style-src ${quoted}`, ['<i style="a: &quot;b&quot;">']), []);
  });
});

describe('devPorts', () => {
  test('既定のポート', () => {
    assert.deepEqual(devPorts({}), { app: 5173, api: 8787, inspector: 9229 });
  });

  test('DEV_PORT_OFFSET で3つを同じ幅ずらす', () => {
    assert.deepEqual(devPorts({ DEV_PORT_OFFSET: '10' }), { app: 5183, api: 8797, inspector: 9239 });
  });

  test('整数でなければ失敗する', () => {
    assert.throws(() => devPorts({ DEV_PORT_OFFSET: 'x' }), /DEV_PORT_OFFSET/);
    assert.throws(() => devPorts({ DEV_PORT_OFFSET: '-1' }), /DEV_PORT_OFFSET/);
  });
});
