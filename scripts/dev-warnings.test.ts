import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatDevWarnings, parseDevWarning } from './dev-warnings.ts';

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
