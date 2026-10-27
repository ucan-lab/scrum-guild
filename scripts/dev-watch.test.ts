import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { devWatchIgnored } from './dev-watch.ts';

describe('devWatchIgnored', () => {
  // 根のパスの記号を glob と読むと一致しなくなるので、記号を含む置き場所でも外れることを見る
  for (const root of ['/work/scrum-guild/', '/Users/a/Dropbox (Personal)/scrum-guild/', '/w/p[1]{a,b}*?!/']) {
    test(`根が ${root} でも、根の worktrees/、playwright-report/、build/ の下を外す`, () => {
      const ignored = devWatchIgnored(root);
      for (const file of [
        'worktrees',
        'worktrees/325-x/playwright-report/index.html',
        'worktrees/289-x/design/backlog.html',
        'playwright-report',
        'playwright-report/index.html',
        'build/index.html',
      ]) {
        assert.equal(ignored(`${root}${file}`), true, file);
      }
    });

    test(`根が ${root} でも、src/ と根の外と、名前が前方一致するだけのものは監視する`, () => {
      const ignored = devWatchIgnored(root);
      for (const file of [
        'src/routes/+layout.svelte',
        'src/build/x.html',
        'src/worktrees/x.html',
        'design/index.html',
        'builder/x.html',
        'worktrees-old/x.html',
      ]) {
        assert.equal(ignored(`${root}${file}`), false, file);
      }
      assert.equal(ignored('/elsewhere/worktrees/x.html'), false);
    });
  }

  test('根の末尾に区切りが無くても同じに判定する', () => {
    const ignored = devWatchIgnored('/work/scrum-guild');
    assert.equal(ignored('/work/scrum-guild/build/index.html'), true);
    assert.equal(ignored('/work/scrum-guild/src/app.html'), false);
  });
});
