// CSP の img-src。ログインの手段のアバターのホストだけを許し、`*.googleusercontent.com` のような広い指定は入れない
import { describe, expect, test } from 'vitest';
import { pageCspDirectives } from '../src/shared/security-headers.ts';

describe('form-action', () => {
  test('自分と、招待の URL の画面のフォームがリダイレクトで移る Google の認可の画面のホストだけを許す', () => {
    expect(pageCspDirectives['form-action']).toEqual(['self', 'https://accounts.google.com']);
  });
});

describe('img-src', () => {
  const imgSrc: readonly string[] = pageCspDirectives['img-src'];

  test('自分と、GitHub と Google のアバターのホストだけを許す', () => {
    expect(imgSrc).toEqual(['self', 'https://avatars.githubusercontent.com', 'https://lh3.googleusercontent.com']);
  });

  test('googleusercontent.com のワイルドカードと、素のホストを許さない', () => {
    for (const source of imgSrc) {
      expect(source, source).not.toContain('*');
      expect(source, source).not.toBe('https://googleusercontent.com');
    }
    expect(imgSrc).not.toContain('https://*.googleusercontent.com');
  });
});
