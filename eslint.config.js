import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

// db/ のうち外から import してよいのは入口のモジュール（index.ts）だけ。testing.ts は test/ からだけ（下の dbTestingPattern）
const restrictedImportsOutsideDb = [
  {
    group: ['kysely', 'kysely/*'],
    message:
      'kysely を src/server/db/ の外で import しない。問い合わせは入口（commonDb、orgDb）から、sql などは db/index.ts から取る',
  },
  {
    regex: '(^|/)db/(?!(index|testing)(\\.ts)?$)',
    message: 'src/server/db/ の内部のファイルを import しない。入口のモジュール（db/index.ts）から取る',
  },
];
const dbTestingPattern = {
  regex: '(^|/)db/testing(\\.ts)?$',
  message: 'db/testing.ts は test/ からだけ import する。組織を確かめずに入口を作る口を、src/ の束に入れない',
};

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
  {
    // 入口を守る規則（docs/development.md の「入口を守る規則」）。D1 には src/server/db/ の入口（commonDb と orgDb）からだけ
    // 問い合わせる。src/server/db/ の外では、kysely の import、D1 の binding（env.DB）、D1Database の型、db/ の内部のファイルの import を禁じる。
    // 例外は、入口を通さない次の 2 つのテストだけ。
    //   test/apply-migrations.ts: 全マイグレーションを D1 の binding に直に当てる。入口より前に要る
    //   test/schema.test.ts: CHECK や一意を確かめるため、型を外れた生の INSERT を送る。入口の型を通すと、壊れた値を書けない
    ignores: ['src/server/db/**', 'test/apply-migrations.ts', 'test/schema.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: restrictedImportsOutsideDb }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name="DB"], MemberExpression[computed=true][property.value="DB"]',
          message: 'D1 の binding（env.DB）を直に使わない。src/server/db/ の入口（commonDb、orgDb）から問い合わせる',
        },
        {
          selector: 'ObjectPattern > Property[key.name="DB"]',
          message: 'D1 の binding（DB）を取り出さない。src/server/db/ の入口（commonDb、orgDb）から問い合わせる',
        },
        {
          selector: 'Identifier[name="D1Database"]',
          message:
            'D1Database の型を src/server/db/ の外で使わない。src/server/db/ の入口（commonDb、orgDb）から問い合わせる',
        },
      ],
    },
  },
  {
    // テストが組織の中の入口を使うための口（db/testing.ts）は、src/ の束に入れない
    files: ['src/**'],
    ignores: ['src/server/db/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...restrictedImportsOutsideDb, dbTestingPattern] }],
    },
  },
  {
    // 画面は API を HTTP で呼ぶ。Worker のコード（と、その先の D1 の binding や秘密）を画面の束に入れない。
    // src/shared は画面の束にも入るので、同じく src/server を引かせない。相対パスと $lib だけを見て、
    // 外部のパッケージの server（svelte/server など）は止めない。
    // no-restricted-imports は後ろの設定が前の設定を置き換えるので、入口を守る規則の patterns もここに並べる
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
            ...restrictedImportsOutsideDb,
            dbTestingPattern,
          ],
        },
      ],
    },
  },
);
