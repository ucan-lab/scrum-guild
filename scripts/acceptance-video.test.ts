import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// acceptance-video で、セッションが受け入れ動画を撮る前に手順書と字幕の区間を確かめ、字幕の帯を載せるスクリプト
const skillDir = fileURLToPath(new URL('../.claude/skills/acceptance-video/', import.meta.url));
const recordScript = join(skillDir, 'record.mjs');
const composeScript = join(skillDir, 'compose.py');
const FONT = '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc';

function inTempDir<T>(files: Record<string, string>, run: (path: (name: string) => string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-video-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return run((name) => join(dir, name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('record.mjs --check', () => {
  const checkRaw = (text: string) =>
    inTempDir({ 'steps.json': text }, (path) => {
      const result = spawnSync(process.execPath, [recordScript, '--check', path('steps.json')], { encoding: 'utf8' });
      assert.ifError(result.error);
      return result;
    });
  const check = (plan: unknown) => checkRaw(JSON.stringify(plan));
  const seconds = (stdout: string) => Number(/見積もり (\d+\.\d) 秒/.exec(stdout)?.[1]);
  const rejected = (plan: unknown, message: RegExp) => {
    const result = check(plan);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  };

  test('見本の手順書は通り、見積もりを出す', () => {
    const result = spawnSync(process.execPath, [recordScript, '--check', join(skillDir, 'example-574.json')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /場面 8、見積もり \d+\.\d 秒/);
  });

  test('JSON として読めない手順書は、読めないと断る', () => {
    const result = checkRaw('{ "steps": [');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /手順書を読めない/);
  });

  test('言葉づかいの指定は scrum、game、seed のどれかで、省けば通る', () => {
    const steps = [{ hold: 1000 }];
    for (const vocabulary of ['scrum', 'game', 'seed'])
      assert.equal(check({ vocabulary, steps }).status, 0, vocabulary);
    assert.equal(check({ steps }).status, 0);
    rejected({ vocabulary: 'klingon', steps }, /vocabulary は scrum、game、seed のどれか/);
  });

  test('steps が空の手順書は断る', () => {
    rejected({ steps: [] }, /steps が空/);
  });

  test('操作が1つの動詞に決まらない手順書は、場所を添えて断る', () => {
    rejected({ steps: [{ actions: [{ click: { css: 'a' }, check: { css: 'b' } }] }] }, /steps\[0\]\.actions\[0\]/);
  });

  test('綴りの誤り（未知のキー）は黙って通さず断る', () => {
    rejected({ steps: [{ caption: 'あ', action: [{ click: { css: 'a' } }] }] }, /steps\[0\]: action は使えない/);
    rejected({ steps: [{ actions: [{ click: { css: 'a' }, lable: 'x' }] }] }, /lable は使えない/);
    rejected({ step: [] }, /step は使えない/);
  });

  test('role を指すのに name が無い要素は断る', () => {
    rejected({ steps: [{ mark: { role: 'button' } }] }, /steps\[0\]\.mark: role には name も指定する/);
  });

  test('空の css や label、不正な nth と state は断る', () => {
    rejected({ steps: [{ mark: { css: '' } }] }, /css は空でない文字列/);
    rejected({ steps: [{ mark: { css: 'a', nth: -1 } }] }, /nth は 0 以上の整数/);
    rejected({ steps: [{ actions: [{ wait: { css: 'a' }, state: 'gone' }] }] }, /state は visible/);
  });

  test('goto、select、fill、pause の値の誤りは断る', () => {
    rejected({ steps: [{ actions: [{ goto: 'x' }] }] }, /goto は \/ で始まるパス/);
    rejected({ steps: [{ actions: [{ select: { css: 'a' } }] }] }, /select には label/);
    rejected({ steps: [{ actions: [{ fill: { css: 'a' } }] }] }, /fill には text/);
    rejected({ steps: [{ actions: [{ pause: 10_001 }] }] }, /pause は 0 から 10000/);
  });

  test('入れ子の within の誤りも場所を添えて断る', () => {
    rejected(
      { steps: [{ mark: { css: 'a', within: { role: 'region' } } }] },
      /mark\.within: role には name も指定する/,
    );
  });

  test('字幕が帯に収まらない長さなら断り、38 文字ちょうど（と空白だけの字幕）の扱いを分ける', () => {
    rejected({ steps: [{ caption: 'あ'.repeat(39) }] }, /caption が 38 文字を超える/);
    assert.equal(check({ steps: [{ caption: 'あ'.repeat(38) }] }).status, 0);
    rejected({ steps: [{ caption: '   ' }] }, /caption は空でない文/);
  });

  test('字幕のある場面で、読む時間と結果を見る時間が短すぎる手順書は断る', () => {
    const click = { click: { css: 'a' } };
    rejected({ steps: [{ caption: 'あ', read: 0, actions: [click] }] }, /read を 1500 ミリ秒以上にする/);
    rejected({ steps: [{ caption: 'あ', hold: 300 }] }, /hold を 1500 ミリ秒以上にする/);
    assert.equal(check({ steps: [{ caption: 'あ', read: 1500, actions: [click], hold: 0 }] }).status, 0);
  });

  test('字幕を出した後の、字幕の無い操作の場面は断る（前の字幕が出たまま画面が動くため）', () => {
    const click = { actions: [{ click: { css: 'a' } }] };
    rejected({ steps: [{ caption: 'あ' }, click] }, /steps\[1\]: 字幕を出した後の操作のある場面には caption が要る/);
    // 最初の字幕の前の準備と、字幕の無い結果だけの場面は通る
    assert.equal(check({ steps: [{ actions: [{ goto: '/x' }] }, { caption: 'あ' }] }).status, 0);
    assert.equal(check({ steps: [{ caption: 'あ' }, { hold: 500 }] }).status, 0);
  });

  test('見積もりは 28 秒ちょうどまで通り、1 ミリ秒でも超えれば断る', () => {
    assert.equal(check({ steps: [{ hold: 10_000 }, { hold: 10_000 }, { hold: 7_700 }] }).status, 0);
    rejected({ steps: [{ hold: 10_000 }, { hold: 10_000 }, { hold: 7_701 }] }, /28 秒を超える/);
  });

  test('操作の間は、見える操作が続くときだけ 1 秒を数える', () => {
    const only = (...actions: object[]) => seconds(check({ steps: [{ actions, hold: 0 }] }).stdout);
    const check_ = { check: { css: 'a' } };
    const click = { click: { css: 'b' } };
    const wait = { wait: { css: 'c' } };
    // 見える操作が 2 つ並ぶ check → click だけが 1 秒増える。待つだけの操作の前後は増えない
    assert.equal(only(check_, click) - only(click, wait), 1);
    assert.equal(only(wait, click), only(click, wait));
  });
});

describe('withVocabulary', () => {
  const planUrl = JSON.stringify(pathToFileURL(join(skillDir, 'plan.mjs')).href);
  const rewrite = (value: unknown, vocabulary: string) => {
    const code = `import { withVocabulary } from ${planUrl};
      console.log(JSON.stringify(withVocabulary(JSON.parse(process.argv[1]), ${JSON.stringify(vocabulary)})));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(value)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  test('どの深さの vocabulary も指定した言葉づかいにそろえ、ほかの値は変えない', () => {
    const response = {
      organization: { name: 'game', vocabulary: 'game' },
      workspaces: [{ vocabulary: 'scrum', title: 'scrum' }, { vocabulary: 'game' }],
      vocabulary: 'game',
    };
    assert.deepEqual(rewrite(response, 'scrum'), {
      organization: { name: 'game', vocabulary: 'scrum' },
      workspaces: [{ vocabulary: 'scrum', title: 'scrum' }, { vocabulary: 'scrum' }],
      vocabulary: 'scrum',
    });
    assert.deepEqual(rewrite({ nested: [{ vocabulary: 'scrum' }] }, 'game'), { nested: [{ vocabulary: 'game' }] });
  });

  test('vocabulary が言葉づかいの値でないもの（オブジェクトや別の文字列）は替えない', () => {
    const response = { vocabulary: { game: 1 }, other: { vocabulary: 'x' }, list: [1, null, 'game'] };
    assert.deepEqual(rewrite(response, 'scrum'), response);
  });
});

describe('gallery.mjs', () => {
  const galleryScript = join(skillDir, 'gallery.mjs');
  const galleryUrl = JSON.stringify(pathToFileURL(galleryScript).href);
  // export した関数を、JSON で渡した値で呼ぶ
  const call = (fn: 'validateManifest' | 'renderGallery' | 'buildResult', value: unknown) => {
    const code = `import * as g from ${galleryUrl}; console.log(JSON.stringify(g[process.argv[1]](JSON.parse(process.argv[2]))));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, fn, JSON.stringify(value)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const video = {
    issue: 574,
    title: 'クリア報酬を変える',
    video: 'issue-574.mp4',
    captions: ['報酬を変える', '依頼主を替える'],
  };
  const run = (dir: string) => spawnSync(process.execPath, [galleryScript, dir], { encoding: 'utf8' });

  test('動画、飛ばした Issue、撮れなかった Issue が、それぞれの形で並び、数が出る', () => {
    const html: string = call('renderGallery', {
      items: [
        video,
        { issue: 575, title: 'API だけ', skipped: '画面が変わらない' },
        { issue: 576, title: '撮れず', failed: '要素が見つからない' },
      ],
    });
    // 再生前のサムネイルを、録画の頭の白い画面でなく、2 秒目にする
    assert.match(html, /<video controls preload="metadata" src="issue-574\.mp4#t=2">/);
    assert.match(html, /<li>報酬を変える<\/li><li>依頼主を替える<\/li>/);
    assert.match(html, /飛ばした: 画面が変わらない/);
    assert.match(html, /撮れなかった: 要素が見つからない/);
    assert.match(html, /動画 1 本、飛ばした 1 件、撮れなかった 1 件/);
  });

  test('Issue の題、理由、字幕に入った HTML は、タグとして働かない', () => {
    const attack = '<script>alert(1)</script><img src=x onerror=alert(2)> & "q"';
    const html: string = call('renderGallery', {
      title: attack,
      items: [
        { ...video, title: attack, captions: [attack] },
        { issue: 2, title: 't', skipped: attack },
      ],
    });
    assert.doesNotMatch(html, /<script>alert|<img src=x/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&amp; &quot;q&quot;/);
  });

  test('manifest の誤りは、場所を添えて断る', () => {
    const problems = (value: unknown): string => (call('validateManifest', value) as string[]).join('\n');
    assert.equal(problems({ items: [video] }), '');
    assert.match(problems({ items: [] }), /items が空/);
    assert.match(
      problems({ items: [{ ...video, skipped: '理由' }] }),
      /items\[0\]: video、skipped、failed のどれか 1 つ/,
    );
    assert.match(problems({ items: [{ issue: 1, title: 't' }] }), /items\[0\]: video、skipped、failed のどれか 1 つ/);
    assert.match(problems({ items: [{ ...video, issue: 0 }] }), /issue は正の整数/);
    assert.match(problems({ items: [{ ...video, vidoe: 'x' }] }), /vidoe は使えない/);
    assert.match(problems({ items: [{ ...video, captions: [''] }] }), /captions は空でない文字列の配列/);
  });

  test('動画のファイル名は、置き場所の直下の mp4 だけを通す', () => {
    const problems = (name: string): string =>
      (call('validateManifest', { items: [{ ...video, video: name }] }) as string[]).join('\n');
    assert.equal(problems('issue-574.mp4'), '');
    for (const name of [
      '../secret.mp4',
      'a/b.mp4',
      '/etc/x.mp4',
      'x.mp4"onerror="y',
      'issue.webm',
      'file:x.mp4',
      '.mp4',
    ]) {
      assert.match(problems(name), /置き場所の直下の \.mp4/, name);
    }
  });

  test('置き場所に manifest.json があれば index.html を書き、開く URL を出す', () => {
    inTempDir({ 'manifest.json': JSON.stringify({ items: [video] }), 'issue-574.mp4': 'dummy' }, (path) => {
      const result = run(join(path('manifest.json'), '..'));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), pathToFileURL(path('index.html')).href);
      assert.ok(existsSync(path('index.html')));
    });
  });

  test('動画のファイルが置き場所に無い、または manifest.json が読めないときは、書かずに断る', () => {
    inTempDir({ 'manifest.json': JSON.stringify({ items: [video] }) }, (path) => {
      const result = run(join(path('manifest.json'), '..'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /#574: issue-574\.mp4 が置き場所に無い/);
      assert.equal(existsSync(path('index.html')), false);
    });
    inTempDir({ 'manifest.json': '{ "items": [' }, (path) => {
      const result = run(join(path('manifest.json'), '..'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /manifest を読めない/);
    });
  });

  test('シングルクォートもエスケープし、外のファイルと通信を止める CSP を付ける', () => {
    const html: string = call('renderGallery', { items: [{ issue: 1, title: "it's", skipped: 'r' }] });
    assert.match(html, /it&#39;s/);
    assert.match(
      html,
      /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src file: 'self'">/,
    );
  });

  test('Issue ごとのタブと、先頭の状況タブ（一覧の項目で移る）に分かれる', () => {
    const html: string = call('renderGallery', {
      items: [video, { issue: 575, title: 'API だけ', skipped: '画面が変わらない' }],
    });
    assert.match(html, /<button[^>]*id="tab-status"[^>]*aria-selected="true"[^>]*>状況<\/button>/);
    assert.match(html, /<button[^>]*id="tab-574"[^>]*data-tab="574">#574/);
    assert.match(html, /<button[^>]*id="tab-575"[^>]*data-tab="575">#575/);
    assert.match(html, /<button type="button" class="row" data-goto="574">/);
    assert.match(html, /<section[^>]*id="panel-574"[^>]*hidden>/);
    // judge でなければ、判定の部品は出さない
    assert.doesNotMatch(html, /data-set=|id="copy"|<body data-judge>/);
  });

  test('judge なら、動画の Issue にだけ ok / ng と理由とコメントを付け、結果をコピーする部品が出る', () => {
    const html: string = call('renderGallery', {
      judge: true,
      items: [video, { issue: 575, title: 'API だけ', skipped: '画面が変わらない' }],
    });
    assert.match(html, /<body data-judge>/);
    assert.equal(html.match(/data-set="ok"/g)?.length, 1);
    assert.equal(html.match(/data-set="ng"/g)?.length, 1);
    assert.match(html, /<input type="checkbox" value="条件を満たさない">/);
    assert.match(html, /id="copy"/);
    assert.match(html, /動画が無いので、ここでは判定しない/);
  });

  test('埋め込むスクリプトは構文が正しく、題をスクリプトに埋め込まない', () => {
    const attack = '</script><script>alert(1)</script>';
    const html: string = call('renderGallery', { judge: true, items: [{ ...video, title: attack }] });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new vm.Script(scripts[0]));
    assert.doesNotMatch(scripts[0], /alert\(1\)/);
  });

  test('judge は真偽値だけを通す', () => {
    const problems = (judge: unknown): string =>
      (call('validateManifest', { judge, items: [video] }) as string[]).join('\n');
    assert.equal(problems(true), '');
    assert.match(problems('yes'), /judge は true か false/);
  });

  test('結果の文は、ok / ng / 未判定の件数と、ng の理由とコメントを含む', () => {
    const text: string = call('buildResult', [
      { issue: 574, title: '報酬を変える', status: 'ok', reasons: ['要望がある'], comment: '' },
      {
        issue: 576,
        title: '一覧',
        status: 'ng',
        reasons: ['条件を満たさない', '想定と違う'],
        comment: '1 行目\n2 行目',
      },
      { issue: 577, title: '未着手', status: '', reasons: [], comment: '' },
      { issue: 578, title: 'API だけ', status: '', reasons: [], comment: '', note: '飛ばした: 画面が変わらない' },
    ]);
    assert.match(text, /ok 1 件、ng 1 件、未判定 2 件/);
    assert.match(text, /- #574 報酬を変える: ok\n- #576 一覧: ng\n/);
    assert.match(text, / {2}- 理由: 条件を満たさない、想定と違う\n/);
    assert.match(text, / {2}- コメント: 1 行目\n {6}2 行目\n/);
    assert.match(text, /- #577 未着手: 未判定\n- #578 API だけ: 未判定\n {2}- メモ: 飛ばした: 画面が変わらない/);
    // ng でない Issue の理由は、選び直す前の残りなので出さない
    assert.doesNotMatch(text, /要望がある/);
  });

  test('同じ Issue の重複、動画の無い Issue の captions、title の欠落、同時指定は断る', () => {
    const problems = (items: unknown[]): string => (call('validateManifest', { items }) as string[]).join('\n');
    assert.match(problems([video, { ...video, title: 'もう 1 枚' }]), /issue #574 が重複している/);
    assert.match(
      problems([{ issue: 2, title: 't', skipped: 'r', captions: ['あ'] }]),
      /captions は video の Issue にだけ付ける/,
    );
    assert.match(problems([{ issue: 2, skipped: 'r' }]), /title は空でない文字列/);
    assert.match(
      problems([{ issue: 2, title: 't', skipped: 'r', failed: 'f' }]),
      /video、skipped、failed のどれか 1 つ/,
    );
  });

  test('manifest がオブジェクトでないときは、スタックトレースでなく理由を出して断る', () => {
    for (const text of ['null', '[]', '"x"']) {
      inTempDir({ 'manifest.json': text }, (path) => {
        const result = run(join(path('manifest.json'), '..'));
        assert.equal(result.status, 1, text);
        assert.match(result.stderr, /manifest がオブジェクトでない/);
        assert.doesNotMatch(result.stderr, /TypeError|at /);
      });
    }
  });

  test('引数が無ければ使い方を出して終了コード 2', () => {
    const result = spawnSync(process.execPath, [galleryScript], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /使い方/);
  });

  test('動画がディレクトリや空のファイルなら断り、index.html を書かない', () => {
    inTempDir({ 'manifest.json': JSON.stringify({ items: [video] }), 'issue-574.mp4': '' }, (path) => {
      const result = run(join(path('manifest.json'), '..'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /#574: issue-574\.mp4 が空か、ファイルでない/);
      assert.equal(existsSync(path('index.html')), false);
    });
    inTempDir({ 'manifest.json': JSON.stringify({ items: [video] }) }, (path) => {
      mkdirSync(path('issue-574.mp4'));
      const result = run(join(path('manifest.json'), '..'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /issue-574\.mp4 が空か、ファイルでない/);
    });
  });

  test('index.html が通常のファイルでなければ（symlink など）、リンク先を上書きせず断る', () => {
    inTempDir(
      { 'manifest.json': JSON.stringify({ items: [video] }), 'issue-574.mp4': 'dummy', 'target.txt': 'そのまま' },
      (path) => {
        symlinkSync(path('target.txt'), path('index.html'));
        const result = run(join(path('manifest.json'), '..'));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /index\.html が通常のファイルでない/);
        assert.equal(readFileSync(path('target.txt'), 'utf8'), 'そのまま');
      },
    );
  });

  test('symlink 経由のパスで呼んでも、何もせずに成功扱いにならず、index.html を書く', () => {
    inTempDir({ 'manifest.json': JSON.stringify({ items: [video] }), 'issue-574.mp4': 'dummy' }, (path) => {
      symlinkSync(galleryScript, path('gallery-link.mjs'));
      const result = spawnSync(process.execPath, [path('gallery-link.mjs'), join(path('manifest.json'), '..')], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(path('index.html')));
    });
  });

  test('SKILL.md の manifest の例は、検査を通る', () => {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const example = /## まとめて撮る[\s\S]*?```json\n([\s\S]*?)\n```/.exec(skill)?.[1];
    assert.ok(example, 'SKILL.md に manifest の例が無い');
    assert.deepEqual(call('validateManifest', JSON.parse(example)), []);
  });
});

describe('compose.py --spans', () => {
  const spans = (cues: unknown) =>
    inTempDir({ 'cues.json': typeof cues === 'string' ? cues : JSON.stringify(cues) }, (path) => {
      const result = spawnSync('python3', ['-I', composeScript, '--spans', path('cues.json')], { encoding: 'utf8' });
      assert.ifError(result.error);
      return result;
    });
  const rejected = (cues: unknown, message: RegExp) => {
    const result = spans(cues);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /Traceback/);
  };

  test('字幕は次の字幕の時刻まで出し、空の字幕は帯を空にする', () => {
    const result = spans([
      { t: 0.5, text: '一つ目' },
      { t: 4.5, text: '二つ目' },
      { t: 8, text: '' },
      { t: 9, text: '三つ目' },
      { t: 12, text: '' },
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { text: '一つ目', start: 0.5, end: 4.5 },
      { text: '二つ目', start: 4.5, end: 8 },
      { text: '三つ目', start: 9, end: 12 },
    ]);
  });

  test('最後が空の字幕でなければ、最後の字幕を閉じられないので断る', () => {
    rejected([{ t: 0, text: '閉じない' }], /最後は、字幕を閉じる空の文/);
  });

  test('時刻が戻っている字幕と、同じ時刻に並ぶ字幕は断る', () => {
    const closing = { t: 6, text: '' };
    rejected([{ t: 5, text: 'あ' }, { t: 3, text: 'い' }, closing], /時刻が戻っている/);
    rejected([{ t: 3, text: 'あ' }, { t: 3, text: 'い' }, closing], /同じ時刻に2つの字幕/);
  });

  test('字幕が1つも無い cues と、空白だけの字幕は断る', () => {
    rejected([{ t: 0, text: '' }], /字幕が1つも無い/);
    rejected(
      [
        { t: 0, text: '   ' },
        { t: 1, text: '' },
      ],
      /字幕が1つも無い/,
    );
  });

  test('t や text の欠落、負の時刻、配列でない cues は、スタックトレースでなく理由を出して断る', () => {
    rejected([{ text: 'あ' }, { t: 1, text: '' }], /cues\[0\] の t は 0 以上の数/);
    rejected(
      [
        { t: -1, text: 'あ' },
        { t: 1, text: '' },
      ],
      /cues\[0\] の t は 0 以上の数/,
    );
    rejected(
      [
        { t: 0, text: 5 },
        { t: 1, text: '' },
      ],
      /cues\[0\] の text は文字列/,
    );
    rejected({}, /cues は、\{t, text\} の配列/);
    rejected('[', /Expecting value|Unterminated/);
  });
});

// ffmpeg と Pillow と日本語フォントが要る。無い環境では飛ばす
describe('compose.py', () => {
  const tool = (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8' });
  const ready =
    tool('ffmpeg', ['-version']).status === 0 &&
    tool('python3', ['-I', '-c', 'import PIL']).status === 0 &&
    existsSync(FONT);
  const options = { skip: ready ? false : 'ffmpeg、Pillow、日本語フォントのどれかが無い' };

  const run = (size: string, seconds: number, cues: unknown) =>
    inTempDir({ 'cues.json': JSON.stringify(cues) }, (path) => {
      const made = tool('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=${size}:rate=5`,
        '-t',
        String(seconds),
        '-pix_fmt',
        'yuv420p',
        path('in.mp4'),
      ]);
      assert.equal(made.status, 0, made.stderr);
      const result = tool('python3', ['-I', composeScript, path('in.mp4'), path('cues.json'), path('out.mp4')]);
      const probe = existsSync(path('out.mp4'))
        ? JSON.parse(
            tool('ffprobe', [
              '-v',
              'error',
              '-show_entries',
              'stream=codec_type,width,height:format=duration',
              '-of',
              'json',
              path('out.mp4'),
            ]).stdout,
          )
        : undefined;
      return { result, probe };
    });

  test('1280×640 の録画に帯を足して、音声の無い 1280×720 にし、最後の字幕のすぐ後で切る', options, () => {
    const { result, probe } = run('1280x640', 5, [
      { t: 0.2, text: 'テストの字幕' },
      { t: 2, text: '' },
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      probe.streams.map((s: { codec_type: string; width: number; height: number }) => [
        s.codec_type,
        s.width,
        s.height,
      ]),
      [['video', 1280, 720]],
    );
    // 録画は 5 秒だが、最後の字幕を閉じた 2 秒の 0.3 秒後で切る
    assert.ok(Math.abs(Number(probe.format.duration) - 2.3) < 0.25, probe.format.duration);
  });

  test('1280×640 でない録画は、帯が画面を覆うので断る', options, () => {
    const { result, probe } = run('1280x720', 3, [
      { t: 0.2, text: 'あ' },
      { t: 2, text: '' },
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /録画は 1280×640 で撮る/);
    assert.equal(probe, undefined, '断るときは動画を書かない');
  });

  test('帯に収まらない字幕は断る', options, () => {
    const { result } = run('1280x640', 3, [
      { t: 0.2, text: 'あ'.repeat(60) },
      { t: 2, text: '' },
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /字幕が帯に収まらない/);
  });

  test('30 秒を超える動画は、書いたうえで終了コード 3 を返す', options, () => {
    const { result, probe } = run('1280x640', 32, [
      { t: 0.2, text: 'あ' },
      { t: 31, text: '' },
    ]);
    assert.equal(result.status, 3, result.stderr);
    assert.ok(Number(probe.format.duration) > 30);
  });
});
