// 画面の見出し（h1.page-title。組織の外の紙の画面（運用など）では h1.gate-title）へフォーカスを移す。
// 戻す先の要素が無くなったとき（行が消えた、開いたボタンが作り直された）に使う。
// 見出しを focusable にしていない画面（メンバーなど）でも移せるよう、tabindex が無ければ -1 を付ける（Tab の順には入れない）
export function focusPageHeading(): void {
  const heading = document.querySelector<HTMLElement>('h1.page-title, h1.gate-title');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
}
