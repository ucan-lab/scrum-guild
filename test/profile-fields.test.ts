// GitHub と Google が共有するプロフィールの項目の整え方（src/server/auth/profile-fields.ts）
import { describe, expect, test } from 'vitest';
import { avatarUrlOf } from '../src/server/auth/profile-fields.ts';

const HOST = 'lh3.googleusercontent.com';

describe('avatarUrlOf', () => {
  test('ホストが合う https の URL はそのまま返す。既定のポート 443 の明示も同じ', () => {
    expect(avatarUrlOf(`https://${HOST}/a/x`, HOST)).toBe(`https://${HOST}/a/x`);
    expect(avatarUrlOf(`https://${HOST}:443/a/x`, HOST)).toBe(`https://${HOST}:443/a/x`);
  });

  test.each([
    ['ポートの指定', `https://${HOST}:8443/a/x`],
    ['ユーザー情報', `https://user@${HOST}/a/x`],
    ['ユーザー情報とパスワード', `https://user:secret@${HOST}/a/x`],
    ['別のホスト', 'https://avatars.githubusercontent.com/u/1'],
    ['ホストの後ろに別のドメイン', `https://${HOST}.evil.example/a/x`],
    ['ホストを userinfo に置いた別のホスト', `https://${HOST}@evil.example/a/x`],
    ['http', `http://${HOST}/a/x`],
    ['スキームが無い', `//${HOST}/a/x`],
    ['URL でない', 'not a url'],
  ])('%sは null', (_label, value) => {
    expect(avatarUrlOf(value, HOST)).toBeNull();
  });

  test('文字列でない値と、長すぎる値は null', () => {
    expect(avatarUrlOf(undefined, HOST)).toBeNull();
    expect(avatarUrlOf(42, HOST)).toBeNull();
    expect(avatarUrlOf(`https://${HOST}/${'a'.repeat(500)}`, HOST)).toBeNull();
  });
});
