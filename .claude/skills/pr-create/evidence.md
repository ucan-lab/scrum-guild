# エビデンス（UI が変わる PR）

画面の見た目か挙動が変わる PR では、本文の `## エビデンス` 節に、変えた画面の変更前と変更後の画像を並べる。
PR テンプレートにこの節が無ければ `## 変更点` の直後に足す。

画像はセッションが撮らない。CI の `evidence` のジョブが e2e のスクリーンショットを `main` の画像と比べ、R2 に上げて PR にコメント（見出しは「e2e の画面の差分」）を付けるので、その画像の URL を本文に埋め込む（`docs/development.md` の「e2e の画像のコメント」）。手元のセッションもクラウドのセッションも同じ手順で行う。

- 作成の時点（`pr-create`）: 1 と 2 で、画面ごとの説明と画像の置き場の印だけを書く
- CI の完了の後（`pr-feedback` の手順 5）: 3 で、印に画像を埋め込む。push で画像が変わったときも同じ手順で差し替える

画像が付くのは e2e が開く画面だけで、枠や注記は付かず、動きは写らない。どこを見ればよいか、どの操作のときの動きかは説明の文章で伝える。

## 1. UI が変わる画面を決める

Step 2 で読んだ差分から判定する。テンプレート、コンポーネント、CSS、画面に出る文言、画像の変更は UI 変更とみなす。
API やバッチだけの変更でも、画面の表示結果が変わるなら UI 変更に含める。
判定に迷ったら UI 変更として扱う。

UI 変更と判定した画面ごとに、変えた画面と状態を開く e2e のテストを決め、その画面の名前（キー）を取る。

- キーは `<テストのディレクトリの名前>/evidence-<n>.png`。CI のコメントの JSON の `key` と同じ形
- 取り方: ワークツリーで `E2E_EVIDENCE=1 pnpm e2e <ファイル>` を走らせ、`test-results/<ディレクトリ>/evidence-<n>.png` を見る（再試行の `-retry<n>` はキーに含めない）。`n` はテストの終わりに開いている画面ごとに 1 から増える
- 撮れた画像を Read し、変えた所が写っているかを確かめる。写っていなければ、テストの終わりの画面が変えた状態になるようにテストを足すか直す
- 変えた画面と状態を開くテストが無ければ、`done-check` の手順 5 に戻ってテストを足す（PR を作る前に済ませる）

## 2. 作成の時点の節を書く

```markdown
## エビデンス

<!-- evidence: pending -->

### <画面名>

<何が変わったか。どこを見ればよいか。動きが変わる画面は、どの操作をしたときの動きか>

<!-- evidence-images: <キー> -->
画像は CI の完了の後に入る。
<!-- /evidence-images -->

全画面の差分は <!-- evidence-comment -->CI の `evidence` のコメント（e2e の画面の差分）<!-- /evidence-comment --> にある。
```

- 画面ごとに `###` と説明と印の組を並べる。説明は印の外に書く（3 は印の中だけを書き換える）
- 新しく作った画面は、説明に「新しい画面なので変更前は無い」と書く
- 1つのテストが2つの画面を撮るなら、キーごとに印を分ける

## 3. 画像を埋め込む

`pr-feedback` の手順 5 で、check-runs がすべて `completed` になった後に行う。

1. `evidence` のチェックが成功していなければ、節は書き換えず、ジョブの注記とログから画像が付かない理由を報告する
2. コメントと本文を取る。本文は書き換える直前に取り直す（人や他のセッションの編集を消さないため）

   ```bash
   gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate --slurp > "<スクラッチパッドの絶対パス>/evidence-comments.json"
   gh api "repos/{owner}/{repo}/pulls/<n>" --jq .body > "<スクラッチパッドの絶対パス>/pr-body.md"
   ```

3. 下のスクリプトをスクラッチパッドに書き、`python3 -I <スクリプト> <本文> <コメント> <出力>` で走らせる。コメントの目印 `<!-- e2e-evidence -->` の次の行の JSON（`<!-- e2e-evidence-data {...} -->`。`scripts/evidence.ts` の `evidenceData`）を読み、印ごとに画像の表を入れ、`<!-- evidence: ... -->` をコメントが撮った head の SHA にする
4. 出力が本文と違えば、`gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -F body=@<出力>` で書き換える。同じなら書き換えない（画像が変わっていない）
5. スクリプトが出した次のものを報告に書く
   - コメントに出たのに、印の無い画面: PR が変えたと判定していない画面。本文には載せない。揺れか、意図しない変更の印なので、画像を見て、どちらかを報告する
   - 印があるのに、コメントに無い画面: 20 画面の上限を超えたか、e2e がその状態を写していないか、`main` と同じ画像になった。印の中は「出ていない」と書いた文章になる
   - 比べられなかった（`comparedSha` が `null`）: 変更前の一覧が無いか読めない。印の中は書き換えない

```python
import json
import re
import sys

MARKER = '<!-- e2e-evidence -->'
DATA = '<!-- e2e-evidence-data '

body_path, comments_path, out_path = sys.argv[1:4]
body = open(body_path, encoding='utf-8').read().replace('\r\n', '\n')
pages = json.load(open(comments_path, encoding='utf-8'))
comments = [
    c for page in pages for c in page
    if c['user']['login'] == 'github-actions[bot]' and MARKER in c['body']
]
if not comments:
    sys.exit('evidence のコメントが無い（変わった画面が無いか、evidence が動いていない）')
comment = comments[0]
lines = [l.strip() for l in comment['body'].splitlines() if l.strip().startswith(DATA)]
if not lines:
    sys.exit('コメントに JSON の行が無い（JSON を出す前の版のコメント。push し直して CI を待つ）')
data = json.loads(lines[0][len(DATA):-len(' -->')])
if data['comparedSha'] is None:
    sys.exit('CI が比べられなかった（変更前の画像の一覧が無いか読めない）。節は書き換えない')

screens = {s['key']: s for s in data['screens']}
marked = []

def table(screen):
    img = lambda url: f'<img src="{url}" width="400px">'
    if 'before' in screen:
        return f'| 変更前 | 変更後 |\n| ---- | ---- |\n| {img(screen["before"])} | {img(screen["after"])} |'
    return f'| 変更後 |\n| ---- |\n| {img(screen["after"])} |'

def fill(m):
    key = m.group(2)
    marked.append(key)
    screen = screens.get(key)
    inner = table(screen) if screen else 'CI のコメントに、この画面の画像は出ていない。'
    return f'{m.group(1)}\n{inner}\n\n{m.group(3)}'

body = re.sub(r'(<!-- evidence-images: (.+?) -->)\n.*?(<!-- /evidence-images -->)', fill, body, flags=re.S)
body = re.sub(r'<!-- evidence: \S+ -->', f'<!-- evidence: {data["headSha"]} -->', body, count=1)
body = re.sub(
    r'(<!-- evidence-comment -->).*?(<!-- /evidence-comment -->)',
    lambda m: f'{m.group(1)}[CI の `evidence` のコメント（e2e の画面の差分）]({comment["html_url"]}){m.group(2)}',
    body,
    flags=re.S,
)
open(out_path, 'w', encoding='utf-8').write(body)

print('埋め込んだ画面:', [k for k in marked if k in screens])
print('印があるのにコメントに無い画面:', [k for k in marked if k not in screens])
print('コメントに出たのに印の無い画面:', [k for k in screens if k not in marked])
```

`<!-- evidence: <SHA> -->` が、コメントの JSON の `headSha` と同じなら、画像は埋め込み済みなので 3 を飛ばしてよい。
