import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { defaultVocabularies, dictionary, format, word, type DictionaryKey } from '../src/shared/vocabulary.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('言葉の辞書', () => {
  test('{名前} の置き換えは、ゲームとスクラムで同じ名前を持つ', () => {
    for (const [key, entry] of Object.entries(dictionary)) {
      assert.deepEqual(placeholders(entry.game), placeholders(entry.scrum), key);
    }
  });

  test('列の節の説明は、切り替えを前提にした「言葉づかい」を含まない', () => {
    assert.ok(!dictionary.columnsDesc.game.includes('言葉づかい'));
    assert.ok(!dictionary.columnsDesc.scrum.includes('言葉づかい'));
    assert.ok(dictionary.columnsDesc.scrum.includes('名前は付けたままで、訳しません。'));
  });

  test('format は名前を埋め、params に無い名前はそのまま残す', () => {
    assert.equal(format('{page} - {app}', { page: '自分の今日', app: 'Scrum Guild' }), '自分の今日 - Scrum Guild');
    assert.equal(format('API: {status}（版 {version}）', { status: 'ok' }), 'API: ok（版 {version}）');
    assert.equal(format('{count} 件', { count: 0 }), '0 件');
    assert.equal(format('置き換えなし'), '置き換えなし');
  });

  test('組織の言葉とワークスペースの言葉は、別々に選べる', () => {
    assert.equal(word('task', defaultVocabularies), 'タスク');
    assert.equal(word('organization', defaultVocabularies), '組織');
    assert.equal(word('task', { workspace: 'game', organization: 'game' }), 'クエスト');
    assert.equal(word('organization', { workspace: 'game', organization: 'game' }), '冒険者ギルド');
    assert.equal(word('task', { workspace: 'scrum', organization: 'game' }), 'タスク');
    assert.equal(word('organization', { workspace: 'scrum', organization: 'game' }), '冒険者ギルド');
    assert.equal(word('organization', { workspace: 'game', organization: 'scrum' }), '組織');
  });

  test('ワークスペースの外の画面と枠の共通の文言は organization', () => {
    const organizationKeys: DictionaryKey[] = [
      'organization',
      'admin',
      'assistant',
      'appName',
      'pageTitle',
      'close',
      'countUnit',
      'pageToday',
      'pageNotifications',
      'pageMe',
      'pageOrgAdmin',
    ];
    for (const key of organizationKeys) assert.equal(dictionary[key].scope, 'organization', key);
  });

  test('題名の組み立ては辞書の1項目で、画面の既定の題名は辞書の名前と同じ', () => {
    const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
    assert.equal(/<title>([^<]*)<\/title>/.exec(html)?.[1], dictionary.appName.game);
    assert.equal(dictionary.appName.game, dictionary.appName.scrum);
    assert.equal(
      word('pageTitle', defaultVocabularies, {
        page: word('pageToday', defaultVocabularies),
        app: word('appName', defaultVocabularies),
      }),
      '自分の今日 - Scrum Guild',
    );
  });
});
