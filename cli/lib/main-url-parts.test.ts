// 接続先の URL に、問い合わせ（?）や断片（#）があると、後ろに足す /api/<操作名> がその中に入り、宛先が壊れる。使い方の誤り（2）にする
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { main, type Config, type ConfigStore } from './main.ts';

const TOKEN = `sgp_${'Q'.repeat(43)}`;

function memoryStore(initial: Config): ConfigStore & { current(): Config } {
  let saved = structuredClone(initial);
  return {
    read: async () => structuredClone(saved),
    write: async (config) => {
      saved = structuredClone(config);
    },
    current: () => saved,
  };
}

async function sg(argv: string[], config: ConfigStore, env: Record<string, string> = {}) {
  const urls: string[] = [];
  let stderr = '';
  const code = await main(argv, {
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ operations: [] });
    }) as typeof fetch,
    env,
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => '',
    config,
  });
  return { code, stderr, urls };
}

const base = (): Config => ({
  default_profile: 'main',
  profiles: { main: { url: 'https://guild.example', token: TOKEN } },
});

describe('URL の問い合わせと断片', () => {
  for (const url of ['https://guild.example/?mode=a', 'https://guild.example/#top', 'https://guild.example?']) {
    test(`config set url ${url} は 2 で、保存しない`, async () => {
      const config = memoryStore(base());
      const result = await sg(['config', 'set', 'url', url], config);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, 'usage');
      assert.deepEqual(config.current(), base());
    });

    test(`使うときも ${url} は 2 で、送らない`, async () => {
      const result = await sg(['ops'], memoryStore(base()), { SG_URL: url, SG_TOKEN: TOKEN });
      assert.equal(result.code, 2, result.stderr);
      assert.deepEqual(result.urls, []);
    });
  }

  test('パスを含む URL は受け付け、その下に /api を足す', async () => {
    const result = await sg(['ops'], memoryStore(base()), { SG_URL: 'https://guild.example/team/', SG_TOKEN: TOKEN });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.urls, ['https://guild.example/team/api/operation-list']);
  });
});
