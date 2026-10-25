const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);

// 日時の表示。DB の日時は UTC の ISO 文字列で、画面はブラウザのタイムゾーンで出す（docs/requirements.md の「日付と時刻」）。
// timeZone を渡すと、そのタイムゾーンで出す（テスト用。省略はブラウザのタイムゾーン）。
// 日時として読めない値は、受け取った文字列のまま返す
export function formatDateTime(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  // 日付と時刻の間は折り返さない空白にする（狭い幅で、日付と時刻が別の行に割れない）
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  })
    .format(time)
    .replace(/\s/, NO_BREAK_SPACE);
}
