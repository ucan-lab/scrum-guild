// 設定ファイルのストア。本人だけが読めるよう 0600 で書く
import type { ConfigStore } from './main.ts';

export function fileConfigStore(path: string): ConfigStore {
  void path;
  throw new Error('未実装');
}
