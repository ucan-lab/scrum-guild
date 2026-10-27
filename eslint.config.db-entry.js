// 入口を守る規則（docs/development.md の「入口を守る規則」）。D1 には src/server/db/ の入口（commonDb と orgDb）からだけ問い合わせる。
// 禁止の定義はこの1つの規則に置く。ESLint は同じ規則を設定ごとに書くと後ろが前を置き換えるので、
// no-restricted-imports などに分けて並べると、設定を足したときに黙って消える。ファイルごとの違いは規則の中で判定する。
//
// src/server/db/ の外で禁じるもの:
//   - kysely の import（静的、動的、型の import()、require、export from）
//   - db/ の内部のファイルの import（入口のモジュール db/index.ts 以外）
//   - db/testing.ts の import（test/ だけが使える）
//   - 引数が文字列のリテラルでない import()、createRequire、process.getBuiltinModule（import の検査を抜けるため）
//   - D1 の binding（env.DB、env['DB']、env[`DB`]、{ DB } の取り出し、Reflect.get(env, 'DB')、Env['DB']）
//   - D1Database の型
//   - 運用者の道具だけの関数（運用者の履歴の appendOperatorChangeLog と、管理者の指名し直しの reassignOrganizationAdmin と、
//     組織をまたいで数える adminStatusesOf、organizationUsageOf。import、export from、名前空間からの参照（. と ['...']）、
//     取り出し（{ name } と、Reflect.get、Reflect.getOwnPropertyDescriptor、Object.getOwnPropertyDescriptor の文字列のキー））。
//     使えるのは運用者の道具 src/server/operations/operator-tools.ts だけ。
//     組織の中の表に運用者が書く口と、組織で絞らずに数える口を、処理から直に呼ばせない
// Reflect と Object のプロパティを読むメソッドは、直に呼ぶ形だけを見る。.call、.apply、取り出した get、カンマ式で呼ぶ形は
// 止めない（D1 の binding も運用者の道具だけの関数も同じ。差分を読む人が見る。docs/development.md の「入口を守る規則」）。
// 例外は、入口を通さない次の 2 つのテストだけ（規則を丸ごと外す）。
//   test/apply-migrations.ts: 全マイグレーションを D1 の binding に直に当てる。入口より前に要る
//   test/schema.test.ts: CHECK や一意を確かめるため、型を外れた生の INSERT を送る。入口の型を通すと、壊れた値を書けない
import path from 'node:path';

const DB_DIR = 'src/server/db/';
const EXCEPTIONS = new Set(['test/apply-migrations.ts', 'test/schema.test.ts']);
const BINDING = 'DB';
// 運用者の道具だけが使える db/ の関数
// appendOperatorChangeLog と reassignOrganizationAdmin は、既にある組織の中の表に運用者が書く口（組織の中の入口を渡さない）。
// adminStatusesOf と organizationUsageOf は、組織で絞らずにすべての組織の中の表を数える口（運用者の組織の一覧だけが使う）
const OPERATOR_TOOLS_ONLY = new Set([
  'appendOperatorChangeLog',
  'reassignOrganizationAdmin',
  'adminStatusesOf',
  'organizationUsageOf',
]);
const OPERATOR_TOOLS = 'src/server/operations/operator-tools.ts';
// 第2引数に名前を取って、プロパティを読む関数
const PROPERTY_READERS = new Set(['get', 'getOwnPropertyDescriptor']);

function stringOf(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined;
  return undefined;
}

// キーの名前。{ DB }、{ 'DB': d }、{ ['DB']: d }、{ [`DB`]: d } のどれでも DB を返す
function keyName(key, computed) {
  if (!computed && key.type === 'Identifier') return key.name;
  return stringOf(key);
}

const rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      kysely:
        'kysely を src/server/db/ の外で使わない。問い合わせは入口（commonDb、orgDb）から、型は db/index.ts から取る',
      internal: 'src/server/db/ の内部のファイルを import しない。入口のモジュール（db/index.ts）から取る',
      testing: 'db/testing.ts は test/ からだけ import する。組織を確かめずに入口を作る口を、本番のコードに入れない',
      dynamicImport:
        'import() の引数は文字列のリテラルにする。式で渡すと、kysely と db/ の内部のファイルの検査を抜けられる',
      operatorToolsOnly:
        '運用者の履歴の関数、管理者の指名し直しの関数、組織をまたいで数える関数は、運用者の道具（src/server/operations/operator-tools.ts）だけが使う。処理には道具が包んだ関数を渡す',
      createRequire:
        'createRequire と process.getBuiltinModule を使わない。import の検査を抜けて kysely と db/ の内部のファイルを読めてしまう',
      binding: 'D1 の binding（DB）を直に使わない。src/server/db/ の入口（commonDb、orgDb）から問い合わせる',
      d1Database:
        'D1Database の型を src/server/db/ の外で使わない。src/server/db/ の入口（commonDb、orgDb）から問い合わせる',
    },
  },
  create(context) {
    const rel = path.relative(context.cwd, context.filename).split(path.sep).join('/');
    if (rel.startsWith(DB_DIR) || EXCEPTIONS.has(rel)) return {};

    const inTest = rel.startsWith('test/');
    const isOperatorTools = rel === OPERATOR_TOOLS;

    function checkOperatorToolsOnly(node, name) {
      if (!isOperatorTools && name !== undefined && OPERATOR_TOOLS_ONLY.has(name)) {
        context.report({ node, messageId: 'operatorToolsOnly' });
      }
    }

    function checkSpecifier(node, specifier) {
      if (specifier === undefined) return;
      if (/^kysely(\/|$)/.test(specifier)) {
        context.report({ node, messageId: 'kysely' });
      } else if (/(^|\/)db\/(?!(index|testing)(\.ts)?$).+/.test(specifier)) {
        context.report({ node, messageId: 'internal' });
      } else if (!inTest && /(^|\/)db\/testing(\.ts)?$/.test(specifier)) {
        context.report({ node, messageId: 'testing' });
      }
    }

    const checkSource = (node) => node.source && checkSpecifier(node, stringOf(node.source));

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression(node) {
        const specifier = stringOf(node.source);
        if (specifier === undefined) context.report({ node, messageId: 'dynamicImport' });
        else checkSpecifier(node, specifier);
      },
      // type K = import('kysely').Kysely
      TSImportType(node) {
        checkSpecifier(node, stringOf(node.argument?.literal ?? node.argument));
      },
      // import k = require('kysely')
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          checkSpecifier(node, stringOf(node.moduleReference.expression));
        }
      },
      ImportSpecifier(node) {
        const imported = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
        if (imported === 'createRequire') context.report({ node, messageId: 'createRequire' });
        checkOperatorToolsOnly(node, imported);
      },
      // export { appendOperatorChangeLog } from '...'（別名で再び出す形も、元の名前で止める）
      ExportSpecifier(node) {
        checkOperatorToolsOnly(node, node.local.type === 'Identifier' ? node.local.name : node.local.value);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Identifier') {
          if (callee.name === 'require') checkSpecifier(node, stringOf(node.arguments[0]));
          if (callee.name === 'createRequire') context.report({ node, messageId: 'createRequire' });
          return;
        }
        if (callee.type !== 'MemberExpression') return;
        const name = keyName(callee.property, callee.computed);
        if (name === 'createRequire' || name === 'getBuiltinModule') {
          context.report({ node, messageId: 'createRequire' });
        } else if (
          callee.object.type === 'Identifier' &&
          (callee.object.name === 'Reflect' || callee.object.name === 'Object') &&
          PROPERTY_READERS.has(name ?? '')
        ) {
          // Reflect.get(x, 'DB')、Object.getOwnPropertyDescriptor(x, 'appendOperatorChangeLog') など、
          // 文字列のリテラルのキーでプロパティを読む形。D1 の binding と運用者の道具だけの関数の両方を止める
          const key = stringOf(node.arguments[1]);
          if (key === BINDING) context.report({ node, messageId: 'binding' });
          checkOperatorToolsOnly(node, key);
        }
      },
      MemberExpression(node) {
        const name = keyName(node.property, node.computed);
        if (name === BINDING) context.report({ node, messageId: 'binding' });
        checkOperatorToolsOnly(node, name);
      },
      // const { DB } = env、const { 'DB': d } = env、const { ['DB']: d } = env
      'ObjectPattern > Property'(node) {
        const name = keyName(node.key, node.computed);
        if (name === BINDING) context.report({ node, messageId: 'binding' });
        checkOperatorToolsOnly(node, name);
      },
      // Env['DB']
      TSIndexedAccessType(node) {
        if (stringOf(node.indexType.literal) === BINDING) context.report({ node, messageId: 'binding' });
      },
      Identifier(node) {
        if (node.name === 'D1Database') context.report({ node, messageId: 'd1Database' });
      },
    };
  },
};

export const dbEntryConfig = {
  plugins: { 'db-entry': { rules: { guard: rule } } },
  rules: { 'db-entry/guard': 'error' },
};
