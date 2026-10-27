// 画面で起きた JavaScript のエラーを、Workers Logs に1行で残すために送る本文（POST /api/client-errors）。
// 画面の束にも入るので、Worker のコードを引かない（Issue #376）
import { z } from 'zod';
import './zod-config.ts';

// 受け取る本文の上限。超えたら 413
export const CLIENT_ERROR_MAX_BODY_BYTES = 4096;
// 画面が送るメッセージの長さの上限。画面は元の文字列をこの長さに切って送る
export const CLIENT_ERROR_SENT_MESSAGE_LENGTH = 1000;
// サーバーが伏せた後にログへ出すメッセージの長さ
export const CLIENT_ERROR_LOGGED_MESSAGE_LENGTH = 200;

export const clientErrorReportSchema = z
  .object({
    kind: z.enum(['error', 'unhandledrejection']),
    name: z.string().min(1).max(200),
    message: z.string().max(CLIENT_ERROR_SENT_MESSAGE_LENGTH),
    location: z
      .object({
        file: z.string().min(1).max(500),
        line: z.number().int().min(0),
        column: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    route: z.string().min(1).max(200).nullable(),
    clientVersion: z.string().min(1).max(64),
  })
  .strict();

export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;
