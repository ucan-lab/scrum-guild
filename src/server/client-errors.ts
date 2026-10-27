// 画面で起きた JavaScript のエラーを受け、Workers Logs に1行で残す口（POST /api/client-errors、Issue #376）。
// ログイン前の画面のエラーも拾うため、操作の定義の外に直に書く
import type { Hono } from 'hono';
import type { AppEnv } from './app-env.ts';

export type ClientBrowser = {
  family: 'chrome' | 'firefox' | 'safari' | 'edge' | 'other';
  major: number | null;
  mobile: boolean;
};

export function clientErrorRoutes(): Hono<AppEnv> {
  throw new Error('未実装');
}

export function maskClientErrorMessage(_text: string): string {
  throw new Error('未実装');
}

export function clientErrorName(_name: string): string {
  throw new Error('未実装');
}

export function clientErrorFile(_file: string): string {
  throw new Error('未実装');
}

export function browserOf(_userAgent: string | undefined): ClientBrowser {
  throw new Error('未実装');
}
