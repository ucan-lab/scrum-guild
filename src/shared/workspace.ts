// ワークスペースの共通の値。作る操作と、名前を変える設定の画面（#72）が同じ値を使う。
// 画面の束にも入るので、Worker のコードを引かない。scripts/ からも読むので、Node の型の除去で動く書き方に留める
import { z } from 'zod';
import './zod-config.ts';
import { isValidTimezone } from './timezone.ts';
import type { Vocabulary } from './vocabulary.ts';

// 名前は前後の空白を除いて 1〜50 字
export const WORKSPACE_NAME_MAX_LENGTH = 50;

export const workspaceNameSchema = z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH);

// 時差の表記と存在しない名前は断る。保存する正規の名前は normalizeTimezone で作る
export const timezoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimezone, { message: '存在するタイムゾーンの名前ではない' });

export const workspaceVocabularySchema = z.enum(['game', 'scrum']);

// ワークスペースを作った直後の値（docs/requirements.md の「機能」）
export const DEFAULT_HOURS_PER_POINT = 4;
// 0 が日曜。1 は月曜
export const DEFAULT_WEEK_START = 1;

// 列と決まった欄に付けた名前は、言葉づかいを切り替えても訳さない。作るときの言葉づかいで名前を決める。
// 完了の列は name を空にして保存し、言葉づかいに合わせた名前を辞書の done から出す
export const defaultColumnNames = {
  game: ['出発前', '遂行中', '査定中'],
  scrum: ['未着手', '作業中', 'レビュー'],
} as const satisfies Record<Vocabulary, readonly [string, string, string]>;

// 辞書の ac と同じ言葉（scripts/workspace.test.ts が突き合わせる）
export const defaultDetailFieldNames = {
  game: '達成条件',
  scrum: '受け入れ基準',
} as const satisfies Record<Vocabulary, string>;
