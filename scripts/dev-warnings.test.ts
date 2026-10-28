import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatDevWarnings,
  isKnownDevWarning,
  isUnjudgeableDevWarning,
  KNOWN_DEV_WARNINGS,
  parseDevWarning,
  UNJUDGEABLE_DEV_WARNINGS,
} from './dev-warnings.ts';

// 開発モードの build で Playwright が受け取った本文（#368 の修正前のバックログ）
const SVELTE =
  '%c[svelte] binding_property_non_reactive\n%c`bind:this={entries[task.id]}` (src/routes/[slug]/w/[id]/+page.svelte:851:4) is binding to a non-reactive property\nhttps://svelte.dev/e/binding_property_non_reactive font-weight: bold font-weight: normal';
const KIT =
  '%c[sveltekit] link_option_replaced\n%c`data-sveltekit-keepfocus="true"` has been replaced with `data-sveltekit-reset="false"`\nhttps://svelte.dev/e/kit/link_option_replaced font-weight: bold font-weight: normal JSHandle@node';

describe('parseDevWarning', () => {
  test('Svelte の警告の名前と中身を、%c を除いて読む', () => {
    assert.deepEqual(parseDevWarning(SVELTE), {
      name: '[svelte] binding_property_non_reactive',
      detail:
        '`bind:this={entries[task.id]}` (src/routes/[slug]/w/[id]/+page.svelte:851:4) is binding to a non-reactive property',
    });
  });

  test('SvelteKit の警告も読む', () => {
    assert.deepEqual(parseDevWarning(KIT), {
      name: '[sveltekit] link_option_replaced',
      detail: '`data-sveltekit-keepfocus="true"` has been replaced with `data-sveltekit-reset="false"`',
    });
  });

  test('%c の無い形も読む', () => {
    assert.equal(
      parseDevWarning('[svelte] state_snapshot_uncloneable\n中身')?.name,
      '[svelte] state_snapshot_uncloneable',
    );
  });

  test('名前に数字を含むものも読む', () => {
    assert.equal(parseDevWarning('%c[svelte] a11y2_some_warning\n%c中身')?.name, '[svelte] a11y2_some_warning');
  });

  test('[svelte] か [sveltekit] で始まるのに名前の形が違うものも、握りつぶさずに警告として読む', () => {
    assert.deepEqual(parseDevWarning('%c[svelte] Some-New Warning\n%c中身'), {
      name: '[svelte] Some-New Warning',
      detail: '中身',
    });
    assert.equal(parseDevWarning('%c[sveltekit]\n%c中身')?.name, '[sveltekit]');
  });

  test('Svelte と SvelteKit でない警告は数えない', () => {
    assert.equal(parseDevWarning('Download the React DevTools'), undefined);
    assert.equal(parseDevWarning('[vite] connected.'), undefined);
    assert.equal(parseDevWarning('%c[sveltekitx] link_option_replaced\n中身'), undefined);
    assert.equal(parseDevWarning('本文の中の [svelte] binding_property_non_reactive'), undefined);
    assert.equal(parseDevWarning(''), undefined);
  });

  test('本番の build の短い形（https://svelte.dev/e/<名前> だけ）は数えない', () => {
    assert.equal(parseDevWarning('https://svelte.dev/e/binding_property_non_reactive'), undefined);
  });
});

describe('isKnownDevWarning', () => {
  const at = (name: string, detail: string, path: string) => ({ name, detail, path });

  test('#368 の警告は既知に数えない', () => {
    assert.equal(isKnownDevWarning({ ...parseDevWarning(SVELTE)!, path: '/aoba/w/1' }), false);
    assert.equal(isKnownDevWarning({ ...parseDevWarning(KIT)!, path: '/aoba/w/1' }), false);
  });

  test('goto の invalidateAll は、今使っている画面（組織の管理、招待、メンバー）だけ既知（#388）', () => {
    const name = '[sveltekit] goto_invalidate_all_deprecated';
    const detail = 'The `goto(..., { invalidateAll: true })` option has been deprecated in favour of `refreshAll`';
    assert.equal(isKnownDevWarning(at(name, detail, '/aoba/admin')), true);
    assert.equal(isKnownDevWarning(at(name, detail, '/hibari/invitations')), true);
    assert.equal(isKnownDevWarning(at(name, detail, '/aoba/w/019a0000-0000-7000-8000-000000000401/members')), true);
    assert.equal(isKnownDevWarning(at(name, detail, '/aoba/w/019a0000-0000-7000-8000-000000000401')), false);
    assert.equal(isKnownDevWarning(at(name, detail, '/aoba/admin/x')), false);
    assert.equal(isKnownDevWarning(at(name, detail, '/aoba/w/1/members/x')), false);
  });

  test('history_api_conflict は招待の画面でも既知に数えない（#394 で直した）', () => {
    const name = '[sveltekit] history_api_conflict';
    assert.equal(isKnownDevWarning(at(name, 'Avoid using', '/invite')), false);
    assert.equal(isKnownDevWarning(at(name, 'Avoid using', '/aoba/w/1')), false);
  });

  test('hmr_reload_after_error は、存在しないパスを開くテストの画面だけ既知（ほかは予期しない例外の印なので数える）', () => {
    const name = '[sveltekit] hmr_reload_after_error';
    assert.equal(
      isKnownDevWarning(at(name, 'The next HMR update will cause the page to reload', '/foo/bar/baz')),
      true,
    );
    assert.equal(isKnownDevWarning(at(name, 'The next HMR update will cause the page to reload', '/aoba/w/1')), false);
    assert.equal(isKnownDevWarning(at(name, 'The next HMR update will cause the page to reload', '/foo')), false);
  });

  test('名前が近いだけのものは既知に数えない', () => {
    assert.equal(isKnownDevWarning(at('[svelte] goto_invalidate_all_deprecated', '', '/aoba/admin')), false);
  });

  test('理由には、直す Issue の番号か、わざと出すテストのことを書く', () => {
    for (const known of KNOWN_DEV_WARNINGS) assert.match(known.reason, /#\d+|テスト/);
  });

  test('どの既知の警告も、名前だけでなく中身か画面のパスで絞る', () => {
    for (const known of KNOWN_DEV_WARNINGS) assert.ok(known.detail ?? known.path, known.name);
  });

  test('判定の働かない警告は、既知の一覧に重ねない', () => {
    for (const unjudgeable of UNJUDGEABLE_DEV_WARNINGS) {
      assert.ok(!KNOWN_DEV_WARNINGS.some((known) => known.name === unjudgeable.name), unjudgeable.name);
    }
  });
});

describe('isUnjudgeableDevWarning', () => {
  const tail = ' using `window.fetch`. For best results, use the `fetch` that is passed to your `load` function';

  test('window_fetch_in_load は、どの操作でも数えない（#429）', () => {
    const name = '[sveltekit] window_fetch_in_load';
    for (const operation of ['task-update', 'member-list', 'story-create', 'task-history']) {
      assert.equal(isUnjudgeableDevWarning({ name, detail: `Loading \`/api/aoba/${operation}\`` + tail }), true);
    }
  });

  test('名前が近いだけのものと、ほかの警告は数える', () => {
    assert.equal(isUnjudgeableDevWarning({ name: '[svelte] window_fetch_in_load', detail: '' }), false);
    assert.equal(isUnjudgeableDevWarning({ name: '[sveltekit] window_fetch_in_load_x', detail: '' }), false);
    assert.equal(isUnjudgeableDevWarning(parseDevWarning(KIT)!), false);
    assert.equal(isUnjudgeableDevWarning(parseDevWarning(SVELTE)!), false);
  });

  test('理由に Issue の番号を、代わりに確かめる場所にファイルを書く', () => {
    for (const unjudgeable of UNJUDGEABLE_DEV_WARNINGS) {
      assert.match(unjudgeable.reason, /#\d+/);
      assert.match(unjudgeable.instead, /\.test\.ts/);
    }
  });
});

describe('formatDevWarnings', () => {
  test('同じ警告を1つにまとめ、名前、中身、画面のパスを並べる', () => {
    const warning = { ...parseDevWarning(SVELTE)!, path: '/aoba/w/1' };
    const kit = { ...parseDevWarning(KIT)!, path: '/aoba/w/1' };
    const message = formatDevWarnings([warning, warning, kit, { ...warning, path: '/aoba/w/2' }]);
    const lines = message.split('\n');
    assert.match(lines[0] ?? '', /3 種類/);
    assert.equal(lines.length, 4);
    assert.match(
      lines[1] ?? '',
      /^- \[svelte\] binding_property_non_reactive: `bind:this=\{entries\[task\.id\]\}`.*（画面 \/aoba\/w\/1）$/,
    );
    assert.match(lines[2] ?? '', /^- \[sveltekit\] link_option_replaced: .*（画面 \/aoba\/w\/1）$/);
    assert.match(lines[3] ?? '', /（画面 \/aoba\/w\/2）$/);
  });
});
