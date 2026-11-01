// 録画の前の試し（record.mjs --probe）が、手順書の項目を実画面（Playwright の page）で実行する部分。
// 録画の perform と同じ locator を使う。record.mjs と、Playwright で確かめるテストの両方が読む
import { PROBE_GOTO_TIMEOUT_MS, PROBE_TIMEOUT_MS } from './plan.mjs';

export function locate(page, spec) {
  const scope = spec.within ? locate(page, spec.within) : page;
  let locator;
  if (spec.css) locator = scope.locator(spec.css);
  else if (spec.role) locator = scope.getByRole(spec.role, { name: spec.name, exact: spec.exact });
  else locator = scope.getByLabel(spec.label, { exact: spec.exact });
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

/** probePlan の 1 項目を実行する。見つからないとき（HTTP のエラーも）投げる */
export function probeExec(page, base) {
  const timeout = PROBE_TIMEOUT_MS;
  return async ({ kind, spec, action, path }) => {
    if (kind === 'goto') {
      const response = await page.goto(base + path, { timeout: PROBE_GOTO_TIMEOUT_MS });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    } else if (kind === 'mark') {
      // 録画の mark は evaluate で、要素が付くまで待つ
      await locate(page, spec).waitFor({ state: 'attached', timeout });
    } else if (kind === 'click') {
      await locate(page, spec).click({ timeout });
    } else if (kind === 'check') {
      await locate(page, spec).check({ timeout });
    } else if (kind === 'select') {
      await locate(page, spec).selectOption({ label: action.label }, { timeout });
    } else if (kind === 'fill') {
      await locate(page, spec).fill(action.text, { timeout });
    } else if (kind === 'wait') {
      await locate(page, spec).waitFor({ state: action.state ?? 'visible', timeout });
    } else {
      throw new Error(`試しが知らない操作: ${kind}`);
    }
  };
}
