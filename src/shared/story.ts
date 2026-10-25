// ストーリーの共通の値。作る操作・変える操作と、ストーリーのダイアログが同じ決まりを使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import { isCalendarDate } from './due.ts';
import { hasHiddenCharacter } from './hidden-characters.ts';
import { shortTextProblem, type ShortTextProblem } from './text-rules.ts';

// タイトルはタスクと同じ決まり。前後の空白を除いて 1〜200 字（コードポイントで数える）
export const STORY_TITLE_MAX_LENGTH = 200;

export type StoryTitleProblem = ShortTextProblem;

// 画面の検査と API の検証が同じ判定を使う。title は前後の空白を除いた後の値
export function storyTitleProblem(title: string): StoryTitleProblem | null {
  return shortTextProblem(title, STORY_TITLE_MAX_LENGTH);
}

export const storyTitleSchema = z
  .string()
  .trim()
  .superRefine((title, ctx) => {
    const problem = storyTitleProblem(title);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `ストーリーのタイトルが使えない（${problem}）` });
  });

// 受け入れ基準と本文。Markdown の文字のまま持つ。字数はコードポイントで数える
export const STORY_TEXT_MAX_LENGTH = 10_000;

export type LongTextProblem = 'too_long' | 'invalid_character';

// 改行は \r\n と \r を \n にそろえ、前後の空白を除く。空は null
export function normalizeLongText(raw: string): string | null {
  const value = raw.replace(/\r\n?/g, '\n').trim();
  return value === '' ? null : value;
}

// 改行とタブは使える。それ以外の制御文字と見えない文字は断る。value は normalizeLongText を通した後の値
export function longTextProblem(value: string, maxLength: number = STORY_TEXT_MAX_LENGTH): LongTextProblem | null {
  if (hasHiddenCharacter(value.replace(/[\n\t]/g, ''))) return 'invalid_character';
  if ([...value].length > maxLength) return 'too_long';
  return null;
}

// 空（空白だけを含む）は null にそろえる。null はそのまま通す
export const longTextSchema = z
  .string()
  .transform((raw, ctx) => {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `本文が使えない（${problem}）` });
      return z.NEVER;
    }
    return value;
  })
  .nullable();

// 期日は YYYY-MM-DD。暦に存在する日付だけ。空は null
export const dueOnSchema = z
  .string()
  .refine(isCalendarDate, { message: '期日が使えない（YYYY-MM-DD の暦の日付）' })
  .nullable();

// リンクは http と https の URL だけ。2048 字まで（コードポイント）
export const LINK_URL_MAX_LENGTH = 2048;

export type LinkUrlProblem = 'too_long' | 'invalid_url';

// 前後の空白を除く。空は null
export function normalizeLinkUrl(raw: string): string | null {
  const value = raw.trim();
  return value === '' ? null : value;
}

// DB の CHECK（LIKE 'http://%' OR 'https://%'）に通る形だけを認める。value は normalizeLinkUrl を通した後の値
export function linkUrlProblem(value: string): LinkUrlProblem | null {
  if ([...value].length > LINK_URL_MAX_LENGTH) return 'too_long';
  if (!/^https?:\/\//i.test(value) || /\s/u.test(value) || hasHiddenCharacter(value)) return 'invalid_url';
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? null : 'invalid_url';
  } catch {
    return 'invalid_url';
  }
}

export const linkUrlSchema = z
  .string()
  .transform((raw, ctx) => {
    const value = normalizeLinkUrl(raw);
    const problem = value === null ? null : linkUrlProblem(value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `リンクが使えない（${problem}）` });
      return z.NEVER;
    }
    return value;
  })
  .nullable();
