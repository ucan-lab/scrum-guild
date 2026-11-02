import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

const workflow = load(readFileSync(new URL('../.github/workflows/ready.yml', import.meta.url), 'utf8')) as {
  on: {
    issues: { types: string[] };
    workflow_run: { workflows: string[]; types: string[] };
    schedule: { cron: string }[];
    workflow_dispatch: unknown;
  };
  jobs: { ready: { if: string } };
};

// 条件をテスト側に書き直さず、YAML の if をそのまま評価する。
// この式で使う論理演算子と文字列リテラルは JavaScript と共通。
// Actions の文字列関数は大文字小文字を区別しない。
function runs(eventName: string, event: Record<string, unknown> = {}): boolean {
  const sender = event.sender as { login?: string } | undefined;
  return Boolean(
    runInNewContext(`(${workflow.jobs.ready.if})`, {
      github: { event_name: eventName, event, actor: sender?.login ?? '' },
      startsWith: (value: string, prefix: string) => value.toLowerCase().startsWith(prefix.toLowerCase()),
      contains: (values: string[], value: string) =>
        values.some((candidate) => candidate.toLowerCase() === value.toLowerCase()),
      fromJSON: JSON.parse,
    }),
  );
}

function issueEvent(action: string, association: string, label = '', sender = 'aoba') {
  return {
    action,
    issue: { author_association: association, user: { login: 'aoba', type: 'User' } },
    sender: { login: sender, type: 'User' },
    label: { name: label },
  };
}

const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const external = ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'];
const labelActions = ['labeled', 'unlabeled'];

describe('ready の epic ラベルの起動条件', () => {
  for (const association of external) {
    for (const action of labelActions) {
      test(`${association} の作者自身による epic の ${action} では起動しない`, () => {
        // 起票時にテンプレートが自動付与する labeled は、作者と sender が同じになる。
        assert.equal(runs('issues', issueEvent(action, association, 'epic')), false);
      });

      test(`${association} の Issue に別の人が epic を ${action} したら起動する`, () => {
        // 別の人がラベルを付け外しできることは、GitHub の triage 以上の権限が前提。
        assert.equal(runs('issues', issueEvent(action, association, 'epic', 'kaede')), true);
      });
    }
  }

  for (const association of trusted) {
    for (const action of labelActions) {
      test(`${association} の作者自身による epic の ${action} では起動する`, () => {
        assert.equal(runs('issues', issueEvent(action, association, 'epic')), true);
      });
    }
  }
});

describe('ready の既存の Issue トリガー', () => {
  test('開閉とラベルの付け外しを購読する', () => {
    assert.deepEqual([...workflow.on.issues.types].sort(), ['closed', 'labeled', 'opened', 'reopened', 'unlabeled']);
  });

  for (const action of ['opened', 'reopened', 'closed']) {
    for (const association of [...trusted, ...external]) {
      test(`${association} の ${action} は作者の信頼区分で決まる`, () => {
        assert.equal(runs('issues', issueEvent(action, association)), trusted.includes(association));
      });
    }
  }

  for (const action of labelActions) {
    for (const label of ['pt:1', 'pt:8', 'status:ready', 'status:accepting', 'sprint-log']) {
      for (const association of ['OWNER', 'NONE']) {
        test(`${association} の ${label} の ${action} は起動する`, () => {
          assert.equal(runs('issues', issueEvent(action, association, label)), true);
        });
      }
    }

    for (const label of ['story', 'bug', 'area:docs', 'needs-human', 'sprint:2', 'pt', 'status', 'epic-other']) {
      for (const association of ['OWNER', 'NONE']) {
        test(`${association} の ${label} の ${action} は起動しない`, () => {
          assert.equal(runs('issues', issueEvent(action, association, label)), false);
        });
      }
    }
  }
});

describe('ready の Issue 以外のトリガー', () => {
  test('accepting の完了を購読する', () => {
    assert.deepEqual(workflow.on.workflow_run.workflows, ['accepting']);
    assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  });

  const accepting = {
    conclusion: 'success',
    event: 'pull_request_target',
    path: '.github/workflows/accepting.yml',
  };

  test('マージで成功した accepting の完了なら起動する', () => {
    assert.equal(runs('workflow_run', { workflow_run: accepting }), true);
  });

  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
    test(`accepting が ${conclusion} なら起動しない`, () => {
      assert.equal(runs('workflow_run', { workflow_run: { ...accepting, conclusion } }), false);
    });
  }

  test('別のイベントで動いた accepting の完了では起動しない', () => {
    assert.equal(runs('workflow_run', { workflow_run: { ...accepting, event: 'workflow_dispatch' } }), false);
  });

  test('別のワークフローの成功では起動しない', () => {
    assert.equal(runs('workflow_run', { workflow_run: { ...accepting, path: '.github/workflows/ci.yml' } }), false);
  });

  test('定期の実行を残し、Issue のペイロードが無くても起動する', () => {
    assert.deepEqual(workflow.on.schedule, [{ cron: '17 * * * *' }]);
    assert.equal(runs('schedule'), true);
  });

  test('手動の実行を残し、Issue のペイロードが無くても起動する', () => {
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.equal(runs('workflow_dispatch'), true);
  });
});

describe('ready の epic ガードの境界と他ラベルへの漏れ', () => {
  for (const action of labelActions) {
    for (const [author, sender] of [
      ['aoba', ''],
      ['', 'kaede'],
      ['', ''],
    ]) {
      test(`${action}: 作者 ${JSON.stringify(author)}・実行者 ${JSON.stringify(sender)} の識別が欠けた外部 Issue は起動しない`, () => {
        const event = issueEvent(action, 'NONE', 'epic', sender);
        event.issue.user.login = author;
        assert.equal(runs('issues', event), false);
      });
    }

    for (const label of ['story', 'bug', 'area:docs', 'needs-human', 'sprint:2', 'epic-other']) {
      test(`${action}: 別の人の操作でも対象外の ${label} なら起動しない`, () => {
        assert.equal(runs('issues', issueEvent(action, 'NONE', label, 'kaede')), false);
      });
    }

    test(`${action}: GitHub App が外部 Issue の epic を操作したら起動する`, () => {
      const event = issueEvent(action, 'NONE', 'epic', 'aoba-app[bot]');
      event.sender.type = 'Bot';
      assert.equal(runs('issues', event), true);
    });
  }
});
