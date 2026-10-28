// expectModalFocus（e2e/helpers.ts）が空振りしないことの確かめ。サーバーを使わず、page.setContent で小さなダイアログを置く。
// 決まりどおりのダイアログでは通り、入らない、Esc で閉じない、閉じても戻らない、一瞬戻ってすぐ外れるダイアログでは、それぞれの段で落ちる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { expectModalFocus } from './helpers.ts';

// 落ちるはずの確かめで待ちすぎない。通るはずの確かめは既定の待ちにする（混んだ CI で誤って落ちないため）
const timeout = 500;

type Broken = 'none' | 'no-focus-in' | 'no-escape' | 'no-return' | 'blink-return';

// <dialog> の showModal() は中へフォーカスを移し、Esc で閉じ、閉じたら開いたボタンへ戻す（Chromium）。
// 壊すときは、開いた後に外へ、閉じた後に別のボタンへフォーカスを動かすか、Esc を止める。
// no-focus-in は showModal() を使わず、open 属性だけで開く（フォーカスは開いたボタンに残る）。
// no-return は Esc を先に受けて閉じ、同期で別のボタンへ移す。close() の中で開いたボタンへ戻った瞬間を残さないため
// （close イベントで移すと、その前の一瞬に戻っていて、確かめがそこをつかむことがある）。
// blink-return は、一瞬戻ってすぐ外れる形を、閉じた後の描画で外して作る。外す時機を描画の速さに任せると、
// 1段目の toBeFocused が戻った瞬間に間に合うかが揺れるので、ページの requestAnimationFrame を差し替え、
// 道具が描画を待ち始めてから外す（1段目は必ず通り、2段目だけで落ちる）
async function setDialog(page: Page, broken: Broken): Promise<void> {
  await page.setContent(`
    <button id="open" type="button">開く</button>
    <button id="other" type="button">ほかのボタン</button>
    <dialog aria-label="見本のダイアログ">
      <button type="button">中のボタン</button>
    </dialog>
    <script>
      const broken = ${JSON.stringify(broken)};
      const dialog = document.querySelector('dialog');
      const opener = document.getElementById('open');
      opener.addEventListener('click', () => {
        if (broken === 'no-focus-in') {
          dialog.setAttribute('open', '');
          document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') dialog.close();
          });
        } else {
          dialog.showModal();
        }
      });
      dialog.addEventListener('cancel', (event) => {
        if (broken === 'no-escape') event.preventDefault();
      });
      const other = document.getElementById('other');
      if (broken === 'no-return') {
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape' || !dialog.open) return;
          event.preventDefault();
          dialog.close();
          other.focus();
        }, true);
      }
      if (broken === 'blink-return') {
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) =>
          raf((time) => {
            if (!dialog.open) other.focus();
            callback(time);
          });
      }
      dialog.addEventListener('close', () => {
        if (broken !== 'no-return') opener.focus();
      });
    </script>
  `);
}

function targets(page: Page) {
  return {
    opener: page.getByRole('button', { name: '開く' }),
    modal: page.getByRole('dialog', { name: '見本のダイアログ' }),
    timeout,
  };
}

test('決まりどおりのダイアログでは通る', async ({ page }) => {
  await setDialog(page, 'none');
  const { opener, modal } = targets(page);
  await expectModalFocus(page, { opener, modal });
  // キーボードで開いても通る
  await expectModalFocus(page, { opener, modal, press: 'Enter' });
});

test('開いても中にフォーカスが入らなければ落ちる', async ({ page }) => {
  await setDialog(page, 'no-focus-in');
  await expect(expectModalFocus(page, targets(page))).rejects.toThrow('モーダルの中にフォーカスが入らない');
});

test('Esc で閉じなければ落ちる', async ({ page }) => {
  await setDialog(page, 'no-escape');
  await expect(expectModalFocus(page, targets(page))).rejects.toThrow('Esc で閉じない');
});

test('閉じてもフォーカスが開いたボタンへ戻らなければ落ちる', async ({ page }) => {
  await setDialog(page, 'no-return');
  await expect(expectModalFocus(page, targets(page))).rejects.toThrow('閉じたらフォーカスが戻らない');
});

test('閉じて一瞬だけ開いたボタンへ戻り、すぐ外れれば落ちる', async ({ page }) => {
  await setDialog(page, 'blink-return');
  await expect(expectModalFocus(page, targets(page))).rejects.toThrow('一瞬戻ってすぐ外れる');
});

test('戻る先を returnTo で渡したときは、開いたボタンへ戻っても落ちる', async ({ page }) => {
  await setDialog(page, 'none');
  const returnTo = page.getByRole('button', { name: 'ほかのボタン' });
  await expect(expectModalFocus(page, { ...targets(page), returnTo })).rejects.toThrow('閉じたらフォーカスが戻らない');
});

test('開く前からダイアログが見えていれば落ちる', async ({ page }) => {
  await setDialog(page, 'none');
  await page.getByRole('button', { name: '開く' }).click();
  await expect(expectModalFocus(page, targets(page))).rejects.toThrow('開く前からモーダルが見えている');
});
