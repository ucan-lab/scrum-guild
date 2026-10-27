// 画面のエラーの1行に出す前の伏せ方と置き換え（src/server/client-errors.ts、Issue #376）
import { describe, expect, test } from 'vitest';
import { browserOf, clientErrorFile, clientErrorName, maskClientErrorMessage } from '../src/server/client-errors.ts';
import { CLIENT_ERROR_LOGGED_MESSAGE_LENGTH } from '../src/shared/client-error.ts';

describe('maskClientErrorMessage', () => {
  test.each([
    ["Cannot read properties of undefined (reading 'title')", "Cannot read properties of undefined (reading '…')"],
    // ` in ` の後ろは末尾まで伏せる（Issue #376 の「実装中に変えたこと」の手順3）
    ['Unexpected token "secret" in JSON', 'Unexpected token "…" in …'],
    ['Template `hidden value` failed', 'Template `…` failed'],
    [`a 'one' b "two" c \`three\` d`, `a '…' b "…" c \`…\` d`],
    ['task 0192f0aa-1b2c-7d3e-8f40-123456789abc not found', 'task … not found'],
    ['task C0A80001-ABCD-4EF0-9123-0123456789AB not found', 'task … not found'],
    ['no quotes and no ids', 'no quotes and no ids'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(maskClientErrorMessage(input)).toBe(expected);
  });

  test('伏せた後の先頭200字にする', () => {
    expect(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH).toBe(200);
    expect(maskClientErrorMessage('a'.repeat(1000))).toBe('a'.repeat(200));
    expect(maskClientErrorMessage('a'.repeat(200))).toBe('a'.repeat(200));
  });

  test('伏せてから切るので、200字をまたぐ引用符の中身も漏れない', () => {
    const masked = maskClientErrorMessage(`${'b'.repeat(190)}"${'s'.repeat(500)}"`);
    expect(masked).toBe(`${'b'.repeat(190)}"…"`);
    expect(masked).not.toContain('s');
  });

  test('200字の後にある UUID も、伏せてから切る', () => {
    const masked = maskClientErrorMessage(`${'c'.repeat(150)} 0192f0aa-1b2c-7d3e-8f40-123456789abc ${'d'.repeat(100)}`);
    expect(masked).toBe(`${'c'.repeat(150)} … ${'d'.repeat(47)}`);
  });
});

describe('clientErrorName', () => {
  test.each(['TypeError', 'Error', 'AbortError', 'A', 'X'.repeat(40)])('英字40字まで（%s）はそのまま', (name) => {
    expect(clientErrorName(name)).toBe(name);
  });

  test.each(['', 'Type Error', 'Err0r', 'X'.repeat(41), 'エラー', '<script>', 'Error\n'])(
    '英字40字までに合わない %j は Error',
    (name) => {
      expect(clientErrorName(name)).toBe('Error');
    },
  );
});

describe('clientErrorFile', () => {
  test.each(['/_app/immutable/chunks/abc.js', '/_app/immutable/entry/app.B-x_9.js', `/_app/${'a'.repeat(200)}`])(
    '/_app/ の下のパス %s はそのまま',
    (file) => {
      expect(clientErrorFile(file)).toBe(file);
    },
  );

  test.each([
    'https://scrum-guild.example.test/_app/immutable/chunks/abc.js',
    'https://cdn.example.test/evil.js',
    '/_app/immutable/chunks/abc.js?token=secret',
    '/_app/immutable/chunks/abc.js#frag',
    '/other/abc.js',
    '/_app/',
    `/_app/${'a'.repeat(201)}`,
    'chrome-extension://abcdef/content.js',
    '',
    '/_app/a b.js',
  ])('/_app/ の下に合わない %j は external', (file) => {
    expect(clientErrorFile(file)).toBe('external');
  });
});

describe('browserOf', () => {
  test.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { family: 'chrome', major: 141, mobile: false },
    ],
    [
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      { family: 'chrome', major: 141, mobile: true },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57',
      { family: 'edge', major: 141, mobile: false },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
      { family: 'firefox', major: 144, mobile: false },
    ],
    [
      'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
      { family: 'firefox', major: 144, mobile: true },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      { family: 'safari', major: 26, mobile: false },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      { family: 'safari', major: 18, mobile: true },
    ],
  ])('%s', (userAgent, expected) => {
    expect(browserOf(userAgent)).toEqual(expected);
  });

  test.each([undefined, '', 'curl/8.10.1', 'x'.repeat(5000)])('分からない User-Agent %j は other', (userAgent) => {
    expect(browserOf(userAgent)).toEqual({ family: 'other', major: null, mobile: false });
  });
});

describe('browserOf が、それぞれの種類にまとめると決めた UA', () => {
  test.each([
    [
      'Chrome の iOS 版（CriOS）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
      { family: 'chrome', major: 141, mobile: true },
    ],
    [
      'Firefox の iOS 版（FxiOS）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
      { family: 'firefox', major: 144, mobile: true },
    ],
    [
      'Edge の iOS 版（EdgiOS。Version/ と Safari/ を含み、Safari にも当たりうる）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.3537.57 Mobile/15E148 Safari/605.1.15',
      { family: 'edge', major: 141, mobile: true },
    ],
    [
      'Edge の Android 版（EdgA。Chrome/ を含み、Chrome にも当たりうる）',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.3537.57',
      { family: 'edge', major: 141, mobile: true },
    ],
    [
      '旧 Edge（Edge/）',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19045',
      { family: 'edge', major: 18, mobile: false },
    ],
  ])('%s', (_label, userAgent, expected) => {
    expect(browserOf(userAgent)).toEqual(expected);
  });
});
