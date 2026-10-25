// ワークスペースのタイムゾーン。ワークスペースを作る操作と、設定の画面（タイムゾーンの変更）が同じ検査を使う。
// scripts/ と Worker からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';

// 時差の表記（+09:00、-0500、+9）。夏時間と過去の規則を持たないので受けない。
// Intl.DateTimeFormat は新しい実行環境で時差の表記も作れるため、作れるかだけでは断れない
const OFFSET_NOTATION = /^[+\-−]/;

export const TIMEZONE_MAX_LENGTH = 64;

// IANA のタイムゾーン名として使えるなら、Intl の正規の名前（asia/tokyo は Asia/Tokyo）を返す。使えなければ undefined。
// 正式名の一覧（Intl.supportedValuesOf）とは突き合わせない。ブラウザが旧名（Asia/Calcutta など）を返すことがあり、
// 一覧に無い旧名も Intl.DateTimeFormat は作れるため
export function normalizeTimezone(input: string): string | undefined {
  if (input.length === 0 || input.length > TIMEZONE_MAX_LENGTH || OFFSET_NOTATION.test(input)) return undefined;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: input }).resolvedOptions().timeZone;
    return OFFSET_NOTATION.test(resolved) ? undefined : resolved;
  } catch {
    // 存在しない名前は RangeError
    return undefined;
  }
}

// 検証と同時に正規の名前へそろえる。時差の表記と存在しない名前は 400 の invalid_input になる
export const timezoneSchema = z
  .string()
  .max(TIMEZONE_MAX_LENGTH)
  .transform((value, ctx) => {
    const normalized = normalizeTimezone(value);
    if (normalized === undefined) {
      ctx.addIssue({ code: 'custom', message: '存在するタイムゾーンの名前ではない' });
      return z.NEVER;
    }
    return normalized;
  });
