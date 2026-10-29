// 開発ボードの機能の一覧（.claude/skills/daily-scrum/page/features.json）を、人が直した後も形が崩れていないか確かめる。
// ページは知らない phase を初版に、番号でない Issue を無しに黙って読み替えるので、打ち間違いが画面に出ないため
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeFeatures } from '../.claude/skills/daily-scrum/page/board.js';

const raw: unknown = JSON.parse(
  readFileSync(new URL('../.claude/skills/daily-scrum/page/features.json', import.meta.url), 'utf8'),
);

type RawFeatures = { areas: { features: { issues?: number[]; phase?: string }[] }[]; notGoals: string[] };

test('features.json はページが読み替えずに読める形をしている', () => {
  // ページは issues の無い機能に空の配列を、phase の無い機能に undefined を補う。それ以外に読み替えて捨てる項目があれば、元と食い違う
  const source = raw as RawFeatures;
  const expected = {
    ...source,
    areas: source.areas.map((area) => ({
      ...area,
      features: area.features.map((feature) => ({ ...feature, issues: feature.issues ?? [], phase: feature.phase })),
    })),
  };
  assert.deepEqual(normalizeFeatures(raw), expected);
});

test('features.json の phase は later、open、無しのどれか', () => {
  const features = normalizeFeatures(raw)?.areas.flatMap((area) => area.features) ?? [];
  assert.ok(features.length > 0);
  for (const feature of features) {
    assert.ok(
      feature.phase === undefined || feature.phase === 'later' || feature.phase === 'open',
      `${feature.name} の phase が ${String(feature.phase)}`,
    );
  }
});

test('features.json の領域の id は重ならない', () => {
  const ids = normalizeFeatures(raw)?.areas.map((area) => area.id) ?? [];
  assert.equal(new Set(ids).size, ids.length);
});
