// エピックの共通の値。作る操作・変える操作と、エピックのダイアログが同じ決まりを使う。
// 本文、期日、リンクはストーリーと同じ決まり（story.ts の longTextSchema、dueOnSchema、linkUrlSchema）を使う。
// 画面の束にも入るので、Worker のコードを引かない
import { z } from 'zod';
import type { EpicRewardTier } from './experience.ts';
import './zod-config.ts';
import { shortTextProblem, type ShortTextProblem } from './text-rules.ts';

// タイトルはストーリーと同じ決まり。前後の空白を除いて 1〜200 字（コードポイントで数える）
export const EPIC_TITLE_MAX_LENGTH = 200;

export type EpicTitleProblem = ShortTextProblem;

// 画面の検査と API の検証が同じ判定を使う。title は前後の空白を除いた後の値
export function epicTitleProblem(title: string): EpicTitleProblem | null {
  return shortTextProblem(title, EPIC_TITLE_MAX_LENGTH);
}

export const epicTitleSchema = z
  .string()
  .trim()
  .superRefine((title, ctx) => {
    const problem = epicTitleProblem(title);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `エピックのタイトルが使えない（${problem}）` });
  });

// 作るときの既定。依頼主は作った人、クリア報酬の段階は中。段階の並びと額は experience.ts
export const EPIC_DEFAULT_REWARD_TIER = 'medium' satisfies EpicRewardTier;
