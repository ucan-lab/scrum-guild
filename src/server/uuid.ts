// 行の ID（docs/data-model.md の「決まりごと」）。UUIDv7 の文字列を、行を作る Worker が採番する
import { now } from '../shared/clock.ts';

const HEX = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// 時刻は Date でもミリ秒の数でも受ける（ログインは数で、ワークスペースの作成は Date で渡す）。
// 同じミリ秒の中では、作った順に並ぶことを保証しない（時刻の後ろはすべて乱数）。順を持たせたい行は position などの別の列で並べる
export function uuidv7(at: Date | number = now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 先頭の48ビットはミリ秒の時刻
  const millis = typeof at === 'number' ? at : at.getTime();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(millis / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = HEX(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
