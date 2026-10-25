import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import ts from 'typescript-eslint';
import { dbEntryConfig } from './eslint.config.db-entry.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  { ignores: ['design/', 'mock/', '.claude/', 'worker-configuration.d.ts'] },
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  prettier,
  svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // 型の検査が受け持つ（typescript-eslint の FAQ）
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
      },
    },
  },
  // 入口を守る規則。禁止の定義と例外は eslint.config.db-entry.js の1つの規則に置き、この設定からは足すだけにする
  dbEntryConfig,
  {
    // 画面は API を HTTP で呼ぶ。Worker のコード（と、その先の D1 の binding や秘密）を画面の束に入れない。
    // src/shared は画面の束にも入るので、同じく src/server を引かせない。相対パスと $lib だけを見て、
    // 外部のパッケージの server（svelte/server など）は止めない
    files: ['src/routes/**', 'src/lib/**', 'src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.{1,2}/)+(.*/)?server(/|$)|^\\$lib/server(/|$)',
              message: '画面と src/shared から src/server を import しない。データは Hono の API から取る',
            },
          ],
        },
      ],
    },
  },
);
