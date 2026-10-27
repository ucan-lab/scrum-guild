# Issue の本文の受け入れ条件のチェックボックスに印を付ける（`- [ ]` を `- [x]` にする）。
# 使い方: python3 -I check-criterion.py <本文> <条件の文字列> <出力>
#   <本文> は Issue の本文を書いたファイル。読み書き（gh api か GitHub の MCP の issue_write）はセッションが行う
#   <条件の文字列> を `[ ]` の後の文に部分文字列として含む未チェックの行が、ちょうど1行のときだけ印を付ける
# フェンスのコードブロックの中の行は数えない。改行コードと末尾の改行の有無は変えない。
# 出力の最後の行は「本文を書き換える」か「本文は変わらない」（同じ条件に既に印がある）。
# 当たる行が無いか2行以上のときは、標準エラーに理由を出し、出力を書かずに終了コード 1
# 引数の誤りと、本文と出力のファイルを読み書きできないときは終了コード 2
import re
import sys

USAGE = '使い方: python3 -I check-criterion.py <本文> <条件の文字列> <出力>'
TASK = re.compile(r'^([ \t]*[-*+][ \t]+\[)([ xX])(\][ \t]+)(\S.*)$')
FENCE = re.compile(r'^[ \t]*(`{3,}|~{3,})')


def task_lines(lines):
    """コードブロックの外のタスクリストの行を (行の番号, 印, 文) で返す"""
    fence = None
    for i, raw in enumerate(lines):
        line = raw[:-1] if raw.endswith('\r') else raw
        opening = FENCE.match(line)
        if fence is None:
            if opening:
                fence = opening.group(1)
                continue
        else:
            # 閉じは同じ記号で、開きより短くない並びだけの行
            rest = line.strip()
            if opening and rest[0] == fence[0] and set(rest) == {fence[0]} and len(rest) >= len(fence):
                fence = None
            continue
        m = TASK.match(line)
        if m:
            yield i, m.group(2), m.group(4)


def main(argv):
    if len(argv) != 4:
        print(USAGE, file=sys.stderr)
        return 2
    body_path, criterion, out_path = argv[1:4]
    if not criterion.strip():
        print('条件の文字列が空白だけ', file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    with open(body_path, encoding='utf-8', newline='') as f:
        body = f.read()
    lines = body.split('\n')
    hits = [(i, mark, text) for i, mark, text in task_lines(lines) if criterion in text]
    unchecked = [h for h in hits if h[1] == ' ']
    if len(unchecked) == 1:
        i = unchecked[0][0]
        m = TASK.match(lines[i].rstrip('\r'))
        lines[i] = m.group(1) + 'x' + lines[i][m.end(2):]
        with open(out_path, 'w', encoding='utf-8', newline='') as f:
            f.write('\n'.join(lines))
        print(f'印を付けた行: {unchecked[0][2]}')
        print('本文を書き換える')
        return 0
    if len(unchecked) > 1:
        print(f'条件の文字列を含む未チェックの行が {len(unchecked)} 行ある。1行に絞れる文字列を渡す:', file=sys.stderr)
        for _, _, text in unchecked:
            print(f'- [ ] {text}', file=sys.stderr)
        return 1
    if hits:
        with open(out_path, 'w', encoding='utf-8', newline='') as f:
            f.write(body)
        print(f'既に印がある行: {hits[0][2]}')
        print('本文は変わらない')
        return 0
    print('条件の文字列を含むタスクリストの行が無い（コードブロックの中の行は数えない）', file=sys.stderr)
    return 1


if __name__ == '__main__':
    # 読み書きの失敗は、該当なしと2行以上の 1 と分けて 2 にする（文字列を変えて打ち直しても直らないため）
    try:
        sys.exit(main(sys.argv))
    except (OSError, UnicodeError) as e:
        print(f'本文か出力のファイルを読み書きできない: {e}', file=sys.stderr)
        sys.exit(2)
