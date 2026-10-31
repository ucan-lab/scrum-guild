// sg の入口（cli/sg.ts）の設定ファイルの場所を、子プロセスで確かめる。XDG Base Directory の決まり:
// XDG_CONFIG_HOME は絶対パスのときだけ使い、空や相対パスは未設定と同じく $HOME/.config を使う
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../sg.ts', import.meta.url));

function sg(argv: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [ENTRY, ...argv],
      { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv, cwd },
      (error, _stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr });
      },
    );
    child.stdin!.end('');
  });
}

describe('XDG_CONFIG_HOME が絶対パスでないとき', () => {
  for (const xdg of ['relative/config', './config', '~/config']) {
    test(`${xdg} は使わず、~/.config/scrum-guild/config.json に書く`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'sg-review-home-'));
      const cwd = mkdtempSync(join(tmpdir(), 'sg-review-cwd-'));
      try {
        const result = await sg(
          ['config', 'set', 'url', 'https://guild.example'],
          { HOME: home, XDG_CONFIG_HOME: xdg },
          cwd,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.ok(existsSync(join(home, '.config', 'scrum-guild', 'config.json')));
        assert.ok(!existsSync(join(cwd, xdg)), 'カレントディレクトリの下に書かない');
        assert.ok(!existsSync(join(home, xdg)), 'HOME の下の相対パスに書かない');
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
