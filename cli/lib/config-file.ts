// 設定ファイルのストア。本人だけが読めるよう 0600 で書く
import type { Config, ConfigStore } from './main.ts';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function fileConfigStore(path: string): ConfigStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as Config;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(config) {
      await mkdir(dirname(path), { recursive: true });
      // writeFile の mode は新しく作るときにしか効かない。既にある 0644 のファイルへトークンを書く前に、権限を絞る
      try {
        await chmod(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    },
  };
}
