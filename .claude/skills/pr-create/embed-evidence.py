# PR の本文のエビデンス節に、CI の evidence のコメントが指す R2 の画像を埋め込む（evidence.md の 3）。
# CI の evidence のジョブの段「PR の本文に画像を埋め込む」が走らせ、セッションは確かめに走らせる。
# 使い方: python3 -I embed-evidence.py <本文> <コメント> <出力> <PR の head の SHA> [<付かなかった理由>]
#   <コメント> は `gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate --slurp` の出力（ページの配列の配列）
#   <付かなかった理由> を渡すと、コメントを読まずに、印の中をその理由にする（evidence のジョブが落ちたときなど）
# 書き換えるのは `## エビデンス` 節の中だけ。印の外の説明の文章は残す。
# 出力の最後の行は「本文を書き換える」か「本文は変わらない」。想定内の理由で埋め込めないときも終了コードは 0
# 確かめ: python3 -I embed-evidence.py --check <本文>
#   書き戻した本文のエビデンス節に `&lt;img` があれば件数を出して終了コード 1、無ければ 0（GitHub の MCP の書き込みは <img> を逃がす）
import json
import re
import sys

MARKER = '<!-- e2e-evidence -->'
DATA = '<!-- e2e-evidence-data '
BOT = 'github-actions[bot]'


def section_span(body):
    start = re.search(r'^## エビデンス[ \t]*$', body, re.M)
    if start is None:
        return None
    end = re.search(r'^## ', body[start.end():], re.M)
    return start.start(), (start.end() + end.start() if end else len(body))


def table(screen):
    img = lambda url: f'<img src="{url}" width="400">'
    if 'before' in screen:
        return f'| 変更前 | 変更後 |\n| ---- | ---- |\n| {img(screen["before"])} | {img(screen["after"])} |'
    return f'| 変更後 |\n| ---- |\n| {img(screen["after"])} |'


# コメントは PR の head のコードが作るので、URL は R2 の画像の形（scripts/evidence.ts の imageObjectKey）だけを通す。
# 引用符、山括弧、空白を含む値や別の形の URL を、本文の <img> に入れない
IMAGE_URL = re.compile(r'https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9._-]+)*/(?:main/)?img/[0-9a-f]{64}\.png')


def bad_urls(screens):
    urls = []
    for screen in screens:
        urls.append(screen.get('after'))  # after は必ずある
        if 'before' in screen:  # before は新しい画面に無い
            urls.append(screen['before'])
    return [u for u in urls if not isinstance(u, str) or not IMAGE_URL.fullmatch(u)]


# 中身は次の開始の印をまたがない。閉じの印が欠けた印は当たらずに残り、次の画面の説明と印を呑まない
IMAGES = re.compile(
    r'(<!-- evidence-images: ([^\n]+?) -->)[ \t]*\n((?:(?!<!-- evidence-images: ).)*?)(<!-- /evidence-images -->)', re.S
)


def unclosed(section, marked):
    keys = re.findall(r'<!-- evidence-images: ([^\n]+?) -->', section)
    return [k for k in keys if k not in marked]


def fill(section, inner_of):
    """inner_of(キー, 今の中身) が返す文字列で印の中を置き換える。None なら今の中身を残す"""
    marked = []

    def repl(m):
        marked.append(m.group(2))
        inner = inner_of(m.group(2), m.group(3))
        return m.group(0) if inner is None else f'{m.group(1)}\n{inner}\n\n{m.group(4)}'

    return IMAGES.sub(repl, section), marked


def load_comment(path):
    pages = json.load(open(path, encoding='utf-8'))
    comments = [c for page in pages for c in page if c['user']['login'] == BOT and MARKER in c['body']]
    return comments[0] if comments else None


class BadData(Exception):
    pass


def read_data(comment):
    """JSON の行が無ければ None。あるのに読めないか形が違えば BadData"""
    for line in comment['body'].splitlines():
        line = line.strip()
        if line.startswith(DATA) and line.endswith(' -->'):
            try:
                data = json.loads(line[len(DATA):-len(' -->')])
            except json.JSONDecodeError as error:
                raise BadData(f'JSON として読めない: {error.msg}') from None
            if not (
                isinstance(data, dict)
                and isinstance(data.get('headSha'), str)
                and (data.get('comparedSha') is None or isinstance(data.get('comparedSha'), str))
                and isinstance(data.get('screens'), list)
                and all(isinstance(s, dict) and isinstance(s.get('key'), str) for s in data['screens'])
            ):
                raise BadData('headSha、comparedSha、screens の形が違う')
            return data
    return None


def embed(section, comment_path, head_sha, reason):
    """(書き換えた節, 報告の行) を返す"""
    if reason is None:
        comment = load_comment(comment_path)
        data = None
        try:
            data = read_data(comment) if comment else None
        except BadData as error:
            reason = f'コメントの JSON の行を読めない（{error}）'
    if reason is None:
        if comment is None:
            reason = 'CI の evidence のコメントが無い（変わった画面が無いか、evidence が動いていない）'
        elif data is None:
            reason = 'コメントに JSON の行が無い（JSON を出す前の版のコメント）'
        elif data['headSha'] != head_sha:
            reason = f'コメントが前の push（{data["headSha"][:7]}）のまま（evidence がコメントを書き換えていない）'
        elif data['comparedSha'] is None:
            reason = 'CI が比べられなかった（変更前の画像の一覧が無いか読めない）'
        elif bad_urls(data['screens']):
            reason = 'コメントの画像の URL が R2 の画像の形でない（PR の差分の scripts/ を確かめる）'
    if reason is not None:
        # 前の push で入れた画像は、今回の失敗の文で消さずに残す（節の evidence: の SHA が、その画像の head を示す）
        kept = []

        def reason_of(key, inner):
            if '<img ' in inner:
                kept.append(key)
                return None
            return f'CI の画像は付かなかった: {reason}。'

        section, marked = fill(section, reason_of)
        return section, [
            f'埋め込めない: {reason}',
            f'理由を書いた印: {[k for k in marked if k not in kept]}',
            f'前の画像を残した印: {kept}',
            f'閉じの印が無い印: {unclosed(section, marked)}',
        ]

    screens = {s['key']: s for s in data['screens']}
    section, marked = fill(
        section,
        lambda key, inner: table(screens[key]) if key in screens else 'CI のコメントに、この画面の画像は出ていない。',
    )
    section = re.sub(r'<!-- evidence: \S+ -->', f'<!-- evidence: {data["headSha"]} -->', section, count=1)
    section = re.sub(
        r'(<!-- evidence-comment -->).*?(<!-- /evidence-comment -->)',
        lambda m: f'{m.group(1)}[CI の `evidence` のコメント（e2e の画面の差分）]({comment["html_url"]}){m.group(2)}',
        section,
        flags=re.S,
    )
    return section, [
        f'埋め込んだ画面: {[k for k in marked if k in screens]}',
        f'印があるのにコメントに無い画面: {[k for k in marked if k not in screens]}',
        f'コメントに出たのに印の無い画面: {[k for k in screens if k not in marked]}',
        f'閉じの印が無い印: {unclosed(section, marked)}',
    ]


def check(body_path):
    """書き戻した本文のエビデンス節の <img> が逃がされていないかを見る。逃がされていれば 1。
    節の外は見ない（本文の説明に `&lt;img` と書いた PR を落とさないため）"""
    body = open(body_path, encoding='utf-8').read().replace('\r\n', '\n')
    span = section_span(body)
    count = len(re.findall(r'&lt;img', body[span[0] : span[1]], re.I)) if span else 0
    if count:
        print(f'本文に逃がされた <img>（&lt;img）が {count} 件ある: MCP の書き込みが <img> を逃がした恐れ')
        return 1
    print('本文に逃がされた <img> は無い')
    return 0


def main(argv):
    if len(argv) > 1 and argv[1] == '--check':
        sys.exit(check(argv[2]))
    body_path, comment_path, out_path, head_sha = argv[1:5]
    reason = argv[5] if len(argv) > 5 else None
    # Web で編集した本文は CRLF。gh の --jq は末尾に改行を足す。比べる前にそろえる
    body = open(body_path, encoding='utf-8').read().replace('\r\n', '\n').rstrip('\n')
    span = section_span(body)
    if span is None:
        open(out_path, 'w', encoding='utf-8').write(body)
        print('本文に `## エビデンス` 節が無い')
        print('本文は変わらない')
        return
    start, end = span
    section, report = embed(body[start:end], comment_path, head_sha, reason)
    new = body[:start] + section + body[end:]
    open(out_path, 'w', encoding='utf-8').write(new)
    print('\n'.join(report))
    print('本文を書き換える' if new != body else '本文は変わらない')


if __name__ == '__main__':
    main(sys.argv)
