// シェルのコマンドを、区切り（; && || | & 改行 ( )）ごとの語の並びに分ける。
// 引用符の中の区切りは区切りとして扱わないので、grep "wrangler deploy" のような文字列は1語になる。
// $(...) と `...` は（二重引用符の中でも）実行されるので、別の区切りとして取り出す。
// コメントは捨てる。語の並びには、シェルが道具に渡す argv だけを残す。
// リダイレクト、ヒアドキュメント、ヒアストリングは、区切りに付けた列挙されない属性 redirects に { op, target, shape, substitutions } で持つ。
// 語の並びに混ぜると、引用符の中の ">.dev.vars" と見分けられず、argv の位置を数える判定が取り違えるため。
// op は > >> < << <<< &> >| >>&| などの記号（記述子の番号と zsh の ! は含めない）、target は引数の位置と同じ読み方で引用符と \ を解いた先
// （ヒアドキュメントは本文）、shape は語の shapes と同じ作りの先（実行時に決まる位置が DYNAMIC）、
// substitutions は先の中の $(…) と `…` の中身。中身は別の区切りとしても取り出す。
// 終わりの印に引用符も \ も無いヒアドキュメントは、シェルが本文の置換を実行するので、本文の中身も substitutions に入れて別の区切りにする。
// 終わりの印の行が見つからないヒアドキュメントの項目には unterminated を付ける（後ろのコマンドを全部本文に飲むので、判定の側が確認を挟む）
// 完全なシェルの解釈ではない。判定に使うのは、各区切りで先頭に来る道具の名前と引数だけ。
// 区切りの配列は、語ごとに2つの印を列挙されない属性に持つ。引用符を外した文字列だけでは、"a b?" と a\ b? や {a,--no-local}、
// '$x' と "$x" を見分けられないため。
// - expands: 語が展開で別の語に分かれるか、別の文字列になりうるか。引用符の外の変数、置換、brace、glob、zsh の括弧の glob、
//   zsh の数値の glob（<->、<1-10>）、~名前 と、引用符の中の変数のうち QUOTED_PARAMETER に当たらないもの（"$@"、"${a[@]}"、"${(f)x}"、"$=x"、"$x[@]"）
// - shapes: 語の中で実行時に決まる位置（引用符の内外の変数と置換、~名前）を DYNAMIC に置き換えた文字列
// 区切りそのものにも、zsh の括弧の glob の閉じの ) の直後から始まったか（followsGlobGroup）の印を列挙されない属性に持つ。
// 括弧の glob（cp /tmp/x(N) wrangler.jsonc）は ( で区切りを切るので、閉じの後ろの語（wrangler.jsonc）は同じコマンドの引数なのに別の区切りに入る

const OPERATORS = ['&&', '||', ';', '|', '&', '\n', '(', ')'];
// コマンド置換の位置に残す印。中身は別の区切りとして判定し、元の語には「中身が実行時に決まる」ことだけを残す
export const SUBSTITUTION = '$(…)';
// zsh の括弧の glob（(a|b)、x(N)）の位置に残す語
export const GLOB_GROUP = '(…)';
// shapes の中で、実行時に決まる位置を表す文字
export const DYNAMIC = '\0';
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')', '`']);
// 引用符の外にあると、シェルが展開する記号
const EXPANSION_CHARS = /[$`{}*?[\]]/;
// 二重引用符の中で、1語のまま展開すると決まっている変数の形（$NAME、${NAME}、${NAME:-語}、${#NAME}、$1、$?）。
// これ以外（$@、${a[@]}、zsh の ${(f)x}、$=x）は、引用符の中でも複数の語に分かれうるものとして扱う。
// 語を分ける形を並べる代わりに、分けない形を決めておく。zsh は修飾と添字の書き方が多く、並べると漏れるため
const QUOTED_PARAMETER = /^\$([A-Za-z_]\w*|\d|[?$#!*-]|\{#?[A-Za-z_]\w*(:?[-=+?][^$`@{}()[\]]*)?\})$/;
// case のラベルの残り。今の位置の ) か、| で並べたラベルの続きと閉じの )
const CASE_LABEL_REST = /^(\|[ \t]*[^\s;&|()<>]+[ \t]*)*\)/;
// 記号だけでできた予約語と test の道具（{ … }、[ -f x ]、[[ … ]]）は展開しない
const LITERAL_WORDS = new Set(['{', '}', '[', ']', '[[', ']]']);

function withMarks(words, expands, shapes, redirects = []) {
  Object.defineProperty(words, 'expands', { value: expands, configurable: true });
  Object.defineProperty(words, 'shapes', { value: shapes, configurable: true });
  Object.defineProperty(words, 'redirects', { value: redirects, configurable: true });
  return words;
}

// 区切りのリダイレクト。印の無い配列（splitSegments を通っていない語）は持たない
export function redirectsOf(words) {
  return words.redirects ?? [];
}

// i 番目の語が展開で別の語に分かれるか、別の文字列になりうるか。印の無い配列（splitSegments を通っていない語）は、記号があれば展開とみなす
export function expandsAt(words, i) {
  return words.expands?.[i] ?? EXPANSION_CHARS.test(words[i] ?? '');
}

// i 番目の語の、実行時に決まる位置を DYNAMIC に置き換えた文字列。印の無い配列は、$ を全部実行時に決まるものとみなす
export function shapeAt(words, i) {
  return words.shapes?.[i] ?? (words[i] ?? '').replaceAll('$', DYNAMIC);
}

// 区切りが括弧の glob の閉じの ) の直後から始まったか。始まったなら、その語は前の区切りのコマンドの続き
export function followsGlobGroup(words) {
  return words.followsGlobGroup === true;
}

// 語と印を一緒に切り出す。Array.prototype.slice は印を落とすので、判定の途中で語を切り出すときはこれを使う。
// リダイレクトは語の位置を持たず区切りぜんたいに掛かるので、切り出しても全部を運ぶ
export function sliceWords(words, start, end) {
  return withMarks(
    words.slice(start, end),
    words.map((_, i) => expandsAt(words, i)).slice(start, end),
    words.map((_, i) => shapeAt(words, i)).slice(start, end),
    redirectsOf(words),
  );
}

// 語と印を一緒につなぐ。切り出した部分をつなぎ直すと同じリダイレクトが重なるので、同じ項目は1つにする
export function concatWords(...parts) {
  return withMarks(
    parts.flatMap((p) => [...p]),
    parts.flatMap((p) => p.map((_, i) => expandsAt(p, i))),
    parts.flatMap((p) => p.map((_, i) => shapeAt(p, i))),
    [...new Set(parts.flatMap(redirectsOf))],
  );
}

// text[start] の $ から始まる変数の展開（$NAME、${…}、$1、$@）を読み、{ end, substitutions } を返す。end は展開の次の位置。
// ${X:-$(wrangler deploy)} の中の $(…) と `…` は実行されるので、substitutions に取り出して別の区切りとして判定させる。
// } の位置は、入れ子の ${ と $(…) を数えて決める。引用符は読み飛ばさない（"${X:-it's $(cmd)}" の ' は文字で、
// 読み飛ばすと中の $(cmd) を見落とす）。引用符の中の } で早く終わっても、残りは呼び出し元が続けて読むので置換は取りこぼさない。
// 名前が続かない $ は1文字
function readParameter(text, start) {
  if (text[start + 1] !== '{') {
    const name = /^\$([A-Za-z_]\w*|[\d@*#?$!-])/.exec(text.slice(start));
    return { end: start + (name?.[0].length ?? 1), substitutions: [] };
  }
  const substitutions = [];
  let depth = 1;
  for (let j = start + 2; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (text.startsWith('$(', j)) {
      const close = closingParen(text, j + 2);
      substitutions.push(text.slice(j + 2, close));
      j = close;
    } else if (ch === '`') {
      const close = text.indexOf('`', j + 1);
      const stop = close === -1 ? text.length : close;
      substitutions.push(text.slice(j + 1, stop));
      j = stop;
    } else if (text.startsWith('${', j)) {
      depth++;
      j++;
    } else if (ch === '}' && --depth === 0) return { end: j + 1, substitutions };
  }
  return { end: text.length, substitutions };
}

const ANSI_C_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// $'…' を bash と同じに解く（$'\x77rangler' と $'wrangler' は wrangler）。start は開きの ' の次の位置で、end は閉じの ' の位置。
// 解けない \ の並びは bash と同じく \ ごと残す。NUL が出たら、bash と同じく $'…' の残りを捨てる（argv に NUL は入らない）
function decodeAnsiC(text, start) {
  let decoded = '';
  let truncated = false;
  let j = start;
  while (j < text.length && text[j] !== "'") {
    let ch = text[j];
    if (ch !== '\\') j++;
    else {
      const rest = text.slice(j + 1);
      const code = /^x([0-9a-fA-F]{1,2})/.exec(rest) ?? /^u([0-9a-fA-F]{1,4})/.exec(rest) ?? /^U([0-9a-fA-F]{1,8})/.exec(rest);
      const octal = /^[0-7]{1,3}/.exec(rest);
      const control = /^c(.)/s.exec(rest);
      if (code) {
        ch = String.fromCodePoint(Math.min(parseInt(code[1], 16), 0x10ffff));
        j += 1 + code[0].length;
      } else if (octal) {
        ch = String.fromCharCode(parseInt(octal[0], 8) & 0xff);
        j += 1 + octal[0].length;
      } else if (control) {
        ch = String.fromCharCode(control[1].charCodeAt(0) & 0x1f);
        j += 3;
      } else {
        ch = ANSI_C_ESCAPES[rest[0]] ?? `\\${rest[0] ?? ''}`;
        j += 2;
      }
    }
    if (ch === '\0') truncated = true;
    else if (!truncated) decoded += ch;
  }
  return { decoded, end: j };
}

// $( の後ろから、対応する ) の位置を返す。
// git commit -m "$(cat <<'EOF' ... EOF)" の本文の ' や ( で数えを崩さないよう、ヒアドキュメントの本文は数えない
function closingParen(text, start) {
  let depth = 1;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (text.startsWith('<<', j) && text[j + 2] !== '<') {
      const match = /^<<-?\s*(['"]?)([\w-]+)\1/.exec(text.slice(j));
      if (!match) continue;
      const bodyStart = text.indexOf('\n', j);
      if (bodyStart === -1) return text.length;
      const end = new RegExp(`\\n[\\t ]*${match[2]}[\\t ]*(\\n|\\)|$)`).exec(text.slice(bodyStart));
      if (!end) return text.length;
      // 終わりの印の行の末尾（改行か ) の手前）まで進める
      j = bodyStart + end.index + end[0].length - (end[1] === ')' ? 2 : 1);
    } else if (ch === "'") {
      const end = text.indexOf("'", j + 1);
      j = end === -1 ? text.length : end;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j;
  }
  return text.length;
}

// 引用符も \ も無い終わりの印のヒアドキュメントの本文で、シェルが実行する置換（$(…)、`…`、${X:-$(…)}）の中身。
// 本文の中の引用符は文字なので読み飛ばさない。\ は次の1文字を文字にする（\$(x) は実行しない）
function substitutionsIn(body) {
  const found = [];
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (ch === '\\') j++;
    else if (body.startsWith('$(', j)) {
      const close = closingParen(body, j + 2);
      found.push(body.slice(j + 2, close));
      j = close;
    } else if (ch === '`') {
      const close = body.indexOf('`', j + 1);
      const stop = close === -1 ? body.length : close;
      found.push(body.slice(j + 1, stop));
      j = stop;
    } else if (ch === '$') {
      const { end, substitutions } = readParameter(body, j);
      found.push(...substitutions);
      j = end - 1;
    }
  }
  return found;
}

export function splitSegments(command) {
  const segments = [];
  const nested = [];
  const heredocs = [];
  let words = withMarks([], [], []);
  let word = '';
  let shape = '';
  let inWord = false;
  let expands = false;
  // 開いている ( の数。0 のときの ) は case のラベルの終わり
  let depth = 0;
  // [[ … ]] の中で開いている ( の数
  let testDepth = 0;
  // 開いている ( ごとに、括弧の glob か（サブシェルや関数の定義でないか）
  const groups = [];
  // 今の区切りが、括弧の glob の閉じの ) の直後から始まったか
  let afterGlobGroup = false;

  // 語に文字を足す。shapes には、実行時に決まる位置なら DYNAMIC を、そうでなければ同じ文字を足す
  const add = (text, dynamic = false) => {
    word += text;
    shape += dynamic ? DYNAMIC : text;
    inWord = true;
  };
  // 演算子（> など）を読んだ後で、先の語を待っているリダイレクト。次の1語は argv ではなく、この先になる
  let openRedirect = null;
  // 先の語が来なかったリダイレクト（echo x >; …）は、空の先で閉じる
  const closeRedirect = () => {
    if (!openRedirect) return;
    words.redirects.push({ op: openRedirect.op, target: '', shape: '', substitutions: [] });
    openRedirect = null;
  };
  const endWord = () => {
    if (inWord && openRedirect) {
      // 先の中の $(…) と `…` の中身は、nested に積んだ分から取る（別の区切りとしても判定される）
      words.redirects.push({ op: openRedirect.op, target: word, shape, substitutions: nested.slice(openRedirect.nestedFrom) });
      openRedirect = null;
    } else if (inWord) {
      words.push(word);
      words.expands.push(expands && !LITERAL_WORDS.has(word));
      words.shapes.push(shape);
    }
    word = '';
    shape = '';
    inWord = false;
    expands = false;
  };
  const endSegment = () => {
    endWord();
    closeRedirect();
    if (words.length > 0 || words.redirects.length > 0) {
      if (afterGlobGroup) Object.defineProperty(words, 'followsGlobGroup', { value: true, configurable: true });
      segments.push(words);
    }
    words = withMarks([], [], []);
  };

  // ヒアドキュメントの終わりの印を、引数の位置と同じ読み方（引用符、\、$'…'）で読む。
  // 引用符か \ が1つでもあれば quoted で、シェルは本文を展開しない（<<'EOF'、<<\EOF、<<E\OF）
  const readDelimiter = (start) => {
    let j = start;
    while (command[j] === ' ' || command[j] === '\t') j++;
    let text = '';
    let quoted = false;
    while (j < command.length && !WORD_END.has(command[j])) {
      const ch = command[j];
      if (ch === "'" || ch === '"') {
        quoted = true;
        const end = command.indexOf(ch, j + 1);
        const stop = end === -1 ? command.length : end;
        text += command.slice(j + 1, stop);
        j = stop + 1;
      } else if (ch === '$' && command[j + 1] === "'") {
        quoted = true;
        const { decoded, end } = decodeAnsiC(command, j + 2);
        text += decoded;
        j = end + 1;
      } else if (ch === '\\' && j + 1 < command.length) {
        // \<改行> は行継続で、印の一部にも引用にもならない
        if (command[j + 1] !== '\n') {
          quoted = true;
          text += command[j + 1];
        }
        j += 2;
      } else {
        text += ch;
        j++;
      }
    }
    return [text, j, quoted];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];

    if (c === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = (end === -1 ? command.length : end) - 1;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      add(command.slice(i + 1, stop));
      i = stop;
      continue;
    }
    if (command.startsWith('$(', i) || c === '`') {
      const end = c === '`' ? command.indexOf('`', i + 1) : closingParen(command, i + 2);
      const stop = end === -1 ? command.length : end;
      nested.push(command.slice(c === '`' ? i + 1 : i + 2, stop));
      add(SUBSTITUTION, true);
      expands = true;
      i = stop;
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      const { decoded, end } = decodeAnsiC(command, i + 2);
      add(decoded);
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') {
          // 二重引用符の中の \ が外すのは $ ` " \ と改行だけ。\<改行> は丸ごと消え（"\<改行>--remote" は --remote）、
          // それ以外の \ は文字として残る（"\--x" は \--x でフラグにならない）
          const next = command[j + 1] ?? '';
          if (next !== '\n') add('$`"\\'.includes(next) && next !== '' ? next : `\\${next}`);
          j += 2;
          continue;
        }
        if (command.startsWith('$(', j)) {
          const end = closingParen(command, j + 2);
          nested.push(command.slice(j + 2, end));
          add(SUBSTITUTION, true);
          j = end + 1;
          continue;
        }
        if (command[j] === '`') {
          const end = command.indexOf('`', j + 1);
          const stop = end === -1 ? command.length : end;
          nested.push(command.slice(j + 1, stop));
          add(SUBSTITUTION, true);
          j = stop + 1;
          continue;
        }
        if (command[j] === '$') {
          const { end, substitutions } = readParameter(command, j);
          nested.push(...substitutions);
          const parameter = command.slice(j, end);
          if (parameter === '$' && !/[=~^]/.test(command[end] ?? '')) {
            // 名前の続かない $ は文字（"a $"）。zsh の $=x、$~x、$^x は語を分けるか glob にする
            add('$');
          } else {
            // zsh の "$x[@]" は、添字で語を分ける
            if (!QUOTED_PARAMETER.test(parameter) || command[end] === '[') expands = true;
            add(parameter, true);
          }
          j = end;
          continue;
        }
        add(command[j]);
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      // 行継続（\ と改行）は語の状態を変えずに読み飛ばす。空の語を積むと、その後ろの道具を見失う
      if (command[i + 1] !== '\n') add(command[i + 1]);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }

    if ((c === '<' || c === '>') && command[i + 1] === '(') {
      // プロセス置換 <(…) と >(…)。中身は別の区切りとして判定し、語には /dev/fd/… のパスに置き換わる印を残す
      const end = closingParen(command, i + 2);
      nested.push(command.slice(i + 2, end));
      add(`${c}(…)`);
      i = end;
      continue;
    }
    // zsh の数値の glob <->、<1-10>（語の途中の x<1-10> も）。リダイレクトとして読むと、後ろの > が次の語を宛先にして argv から隠す
    // （<-> --remote の >-- が > の宛先になる）。zsh は数に当たるファイルの名前に展開する語として読む
    const numericGlob = c === '<' ? /^<\d*-\d*>/.exec(command.slice(i)) : null;
    if (numericGlob) {
      add(numericGlob[0]);
      expands = true;
      i += numericGlob[0].length - 1;
      continue;
    }
    const isRedirect = c === '<' || c === '>' || (c === '&' && command[i + 1] === '>');
    if (isRedirect) {
      // 2>&1 の 2 のような番号は語に残さない。先を待っているリダイレクトの後ろ（> 2>x）の数字は先なので残す
      if (!openRedirect && inWord && /^\d+$/.test(word)) {
        word = '';
        shape = '';
        inWord = false;
      }
      endWord();
      closeRedirect();
      if (command.startsWith('<<<', i)) {
        openRedirect = { op: '<<<', nestedFrom: nested.length };
        i += 2;
        continue;
      }
      if (command.startsWith('<<', i)) {
        const start = command[i + 2] === '-' ? i + 3 : i + 2;
        const [delimiter, next, quoted] = readDelimiter(start);
        // 本文は改行の後で読み、この項目の target に足す。<<- も同じ op（タブを外す違いは、本文の行を trim して照合するので区別しない）
        const redirect = { op: '<<', target: '', shape: '', substitutions: [] };
        words.redirects.push(redirect);
        heredocs.push({ delimiter, redirect, quoted });
        i = next - 1;
        continue;
      }
      let j = i;
      while ('<>&|'.includes(command[j]) && j - i < 3) j++;
      // zsh の >!、>>!、&>!、>&! は、既にあるファイルを上書きする >。! を宛先の語に残さない。
      // >>&| と &>>| は 3 文字に収まらず、末尾の | がパイプに切れるので、| も同じに読む
      const written = command.slice(i, j);
      if ((command[j] === '!' || (command[j] === '|' && !written.endsWith('|'))) && written.includes('>')) j++;
      const op = command.slice(i, j).replace(/!$/, '');
      // 記述子の複製と閉じ（2>&1、>&2、<&0、>&-）は、書き込み先にも読み込み元にも数えない
      if (op.endsWith('&') && /[\d-]/.test(command[j] ?? '')) {
        while (/[\d-]/.test(command[j] ?? '')) j++;
        i = j - 1;
        continue;
      }
      openRedirect = { op, nestedFrom: nested.length };
      i = j - 1;
      continue;
    }

    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op) {
      // 先の語が続かない演算子（echo x > ; …）は、リダイレクトを空の先で閉じる
      if (!inWord) closeRedirect();
      // 先を読んでいる語は argv ではないので、道具の位置の判定には数えない
      const pending = inWord && !openRedirect ? [...words, word] : [...words];
      // [[ … ]] の中の ( ) と、=~ の後ろか括弧の中の | は、条件式と正規表現の文字（[[ $x =~ ^(a|b)$ ]]）。
      // 閉じていない [[ に、後ろのコマンドを | で飲み込ませないよう、| は =~ の後ろか括弧の中に限る
      const inTest = pending[commandIndex(pending)] === '[[' && !pending.includes(']]');
      if (inTest && (op === '(' || op === ')' || (op === '|' && (testDepth > 0 || pending.includes('=~'))))) {
        if (op === '(') testDepth++;
        if (op === ')') testDepth = Math.max(0, testDepth - 1);
        add(op);
        continue;
      }
      testDepth = 0;
      // 対応する ( の無い ) の前の1語は、case のラベル（*.md)、*)）。| で並べたラベル（*.md|*.txt)）も、) までをまとめてラベルとする。
      // ラベルはコマンドではないので捨てる。2語以上（wrangler deploy )）は構文エラーだが、判定から落とさずに区切りとして読む
      // リダイレクトのある区切り（bash <<< "…")、cat < f)）は、道具とその入出力なのでラベルにしない（捨てると redirects ごと判定から落ちる）
      const label = depth === 0 && pending.length <= 1 && words.redirects.length === 0 && !openRedirect ? CASE_LABEL_REST.exec(command.slice(i)) : null;
      if (label) {
        word = '';
        shape = '';
        inWord = false;
        expands = false;
        openRedirect = null;
        words = withMarks([], [], []);
        afterGlobGroup = false;
        i += label[0].length - 1;
        continue;
      }
      let closesGlobGroup = false;
      if (op === '(') {
        // 道具の後ろに書ける ( は、zsh の glob（(a|b)、x(N)）と関数の定義（f() { … }）だけ。前置きだけの後ろ（if (、! (、time (）はサブシェル。
        // zsh は (KV|--no-local) を作業場所のファイルの名前に展開するので、区切りは切ったまま、括弧の位置に展開の印の付いた GLOB_GROUP を残す。
        // 語に続く括弧（--(remote|x)、x(N)）はその語の一部にし、-- やリダイレクトの後ろの括弧も argv の語として残す。
        // 括弧の glob の閉じにすぐ続く ( （(a|b)(N)）も同じ語の続きの glob。
        // 中身の無い () は関数の定義なので残さない
        const continuesGlob = afterGlobGroup && pending.length === 0 && command[i - 1] === ')';
        const isGlob = (commandIndex(pending) !== -1 || continuesGlob) && !/^\(\s*\)/.test(command.slice(i));
        if (isGlob) {
          add(GLOB_GROUP);
          expands = true;
        }
        groups.push(isGlob);
        depth++;
      } else if (op === ')') {
        depth = Math.max(0, depth - 1);
        closesGlobGroup = groups.pop() === true;
      }
      endSegment();
      afterGlobGroup = closesGlobGroup;
      i += op.length - 1;
      // ヒアドキュメントの本文（行の終わりから終わりの印の行まで）は、区切りとして読まない
      if (op === '\n' && heredocs.length > 0) {
        let j = i + 1;
        for (const { delimiter, redirect, quoted } of heredocs) {
          const body = [];
          let closed = false;
          while (j < command.length && !closed) {
            const end = command.indexOf('\n', j);
            const lineEnd = end === -1 ? command.length : end;
            const line = command.slice(j, lineEnd);
            j = lineEnd + 1;
            if (line.trim() === delimiter) closed = true;
            else body.push(line);
          }
          redirect.target = body.join('\n');
          // 終わりの印の行が無いと、後ろのコマンドを全部本文に飲む。判定の側が確認を挟めるよう印を残す
          if (!closed) redirect.unterminated = true;
          // 引用符も \ も無い印の本文は、シェルが $(…)、`…`、${…} の中の置換を実行する
          if (!quoted) {
            const inner = substitutionsIn(redirect.target);
            nested.push(...inner);
            redirect.substitutions.push(...inner);
          }
        }
        heredocs.length = 0;
        i = j - 1;
      }
      continue;
    }
    // zsh は語の先頭の =名前 を道具のパスに展開する（=wrangler は /…/wrangler）。道具の位置では = を外して道具の名前として読む。
    // 引数の位置（echo =.env）は、道具が見つからなければ zsh が実行を止めるので、文字のまま読む
    if (c === '=' && !inWord && !openRedirect && commandIndex(words) === -1 && /[\w.-]/.test(command[i + 1] ?? '')) continue;
    // ~名前（zsh の hash -d、bash の ~- と ~+、~user）は、語の先頭か = と : の後ろで別の文字列に展開される。
    // ~ だけと ~/ は家のディレクトリなので文字として読む
    if (c === '~' && (!inWord || /[=:]$/.test(word)) && !/^~(\/|$|[\s;&|<>()])/.test(command.slice(i))) {
      add('~', true);
      expands = true;
      continue;
    }
    if (c === '$') {
      const { end, substitutions } = readParameter(command, i);
      nested.push(...substitutions);
      add(command.slice(i, end), true);
      expands = true;
      i = end - 1;
      continue;
    }
    if (EXPANSION_CHARS.test(c)) expands = true;
    add(c);
  }
  endSegment();
  for (const inner of nested) segments.push(...splitSegments(inner));
  return segments;
}

// 実行する道具の前に付く語（シェルの予約語、環境変数の代入、env や timeout、npx、cross-env）を飛ばす
const PREFIXES = new Set([
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}',
  'env', 'sudo', 'time', 'nohup', 'exec', 'command', 'builtin',
  'timeout', 'nice', 'ionice', 'stdbuf', 'xargs', 'gxargs', 'genv', 'watch', 'caffeinate',
  'npx', 'pnpx', 'bunx', 'dlx',
  // cross-env FOO=1 cmd は env と同じく、代入を付けて cmd を動かす
  'cross-env',
]);
// 前置きの道具が値を取るフラグ（sudo -u root、nice -n 10、xargs -I {}）
const PREFIX_FLAGS_WITH_VALUE = new Set([
  '-u', '-g', '-n', '-s', '-k', '-I', '-P', '-L', '-d', '-E', '-C', '-p', '--package', '--chdir', '--unset',
]);

export function isAssignment(word) {
  // NAME+=値 と、配列の要素の NAME[添字]=値 も代入
  return /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word);
}

export function baseName(word) {
  const name = word.split('/').pop();
  // npx wrangler@4 のような版の指定を外す
  return name.replace(/(.)@[^@]*$/, '$1');
}

// Homebrew の GNU findutils と coreutils は g を前に付けた名前で入る（gxargs、genv）。前置きの名前は g を外した名前にそろえる
export function prefixName(word) {
  const name = baseName(word);
  return name === 'gxargs' || name === 'genv' ? name.slice(1) : name;
}

// GNU の getopt は長いオプションを一意な省略形でも受け付ける。--ch は --chdir、--s は --split-string（name は -- を除いた1文字以上の名前）
export function abbreviates(name, full) {
  return name.length > 0 && full.startsWith(name);
}

// xargs だけが値を取るフラグ（-a と --arg-file は引数を読むファイル、--delimiter は区切り、--process-slot-var は環境変数の名前、
// -J、-R、-S は BSD の置換と行数と置換の長さ）。
// sudo -a のように他の前置きでは値を取らないので、直前の前置きが xargs のときだけ効かせる。
// GNU の getopt は長いオプションを一意な省略形でも受け付ける（--arg、--delim、--process）。-afile や --arg-file=file の連結の形は1語で済む。
// 逆に -p は、npx -p と sudo -p では値を取るが、xargs では値を取らない確認のフラグなので、xargs の後ろでは値として飛ばさない
const XARGS_FLAGS_WITH_VALUE = new Set(['-a', '-J', '-R', '-S']);
function takesValueInXargs(word) {
  if (word === '-p') return false;
  if (XARGS_FLAGS_WITH_VALUE.has(word)) return true;
  const long = /^--([a-z-]+)$/.exec(word);
  return Boolean(long) && ['arg-file', 'delimiter', 'process-slot-var'].some((full) => abbreviates(long[1], full));
}

// env の --chdir とその省略形（--c、--ch）。GNU env の長いオプションで c から始まるのは chdir だけ。値は次の語
function takesValueInEnv(word) {
  const long = /^--([a-z-]+)$/.exec(word);
  return Boolean(long) && abbreviates(long[1], 'chdir');
}

// index は実行する道具の位置（見つからなければ -1）、prefixes は道具の前で飛ばした前置きの語（env、xargs など）の位置
function scanCommand(words) {
  const prefixes = [];
  let previous = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '' || isAssignment(w)) continue;
    if (w.startsWith('-')) {
      const takesValue =
        previous === 'xargs'
          ? takesValueInXargs(w) || (w !== '-p' && PREFIX_FLAGS_WITH_VALUE.has(w))
          : PREFIX_FLAGS_WITH_VALUE.has(w) || (previous === 'env' && takesValueInEnv(w));
      if (takesValue) i++;
      continue;
    }
    // timeout 300 や watch -n 2 の数
    if (/^\d+(\.\d+)?[smhd]?$/.test(w)) continue;
    if (PREFIXES.has(baseName(w))) {
      prefixes.push(i);
      previous = prefixName(w);
      continue;
    }
    return { index: i, prefixes };
  }
  return { index: -1, prefixes };
}

// 語の並びから、実行する道具の位置を返す。見つからなければ -1
export function commandIndex(words) {
  return scanCommand(words).index;
}

// 道具の前に飛ばした前置きの語の位置。道具の後ろで効く前置き（xargs の後ろのコマンド、env -S）を判定の側が探すために使う
export function prefixIndexes(words) {
  return scanCommand(words).prefixes;
}

// 値を取るフラグを飛ばして、位置の引数の位置を返す。展開の印を引くとき（git push の refspec）に使う
export function positionalIndexes(args, flagsWithValue = new Set()) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (flagsWithValue.has(a)) i++;
      continue;
    }
    result.push(i);
  }
  return result;
}

// 値を取るフラグを飛ばして、位置の引数だけを返す
export function positionals(args, flagsWithValue = new Set()) {
  return positionalIndexes(args, flagsWithValue).map((i) => args[i]);
}
