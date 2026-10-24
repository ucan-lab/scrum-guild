// シェルのコマンドを、区切り（; && || | & 改行 ( )）ごとの語の並びに分ける。
// 引用符の中の区切りは区切りとして扱わないので、grep "wrangler deploy" のような文字列は1語になる。
// $(...) と `...` は（二重引用符の中でも）実行されるので、別の区切りとして取り出す。
// コメントは捨てる。リダイレクトは '<' か '>' で始まる1語にまとめ、ヒアドキュメントの本文は '<<本文' の1語にする。
// 完全なシェルの解釈ではない。判定に使うのは、各区切りで先頭に来る道具の名前と引数だけ。

const OPERATORS = ['&&', '||', ';', '|', '&', '\n', '(', ')'];
// コマンド置換の位置に残す印。中身は別の区切りとして判定し、元の語には「中身が実行時に決まる」ことだけを残す
export const SUBSTITUTION = '$(…)';
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')', '`']);

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

export function splitSegments(command) {
  const segments = [];
  const nested = [];
  const heredocs = [];
  let words = [];
  let word = '';
  let inWord = false;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  // 引用符を外した1語を読む。リダイレクトの宛先とヒアドキュメントの終わりの印に使う
  const readWord = (start) => {
    let j = start;
    while (command[j] === ' ' || command[j] === '\t') j++;
    let text = '';
    while (j < command.length && !WORD_END.has(command[j])) {
      const ch = command[j];
      if (ch === "'" || ch === '"') {
        const end = command.indexOf(ch, j + 1);
        const stop = end === -1 ? command.length : end;
        text += command.slice(j + 1, stop);
        j = stop + 1;
      } else {
        text += ch;
        j++;
      }
    }
    return [text, j];
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
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (command.startsWith('$(', i) || c === '`') {
      const end = c === '`' ? command.indexOf('`', i + 1) : closingParen(command, i + 2);
      const stop = end === -1 ? command.length : end;
      nested.push(command.slice(c === '`' ? i + 1 : i + 2, stop));
      word += SUBSTITUTION;
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      let j = i + 2;
      while (j < command.length && command[j] !== "'") {
        if (command[j] === '\\') j++;
        word += command[j] ?? '';
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') {
          word += command[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (command.startsWith('$(', j)) {
          const end = closingParen(command, j + 2);
          nested.push(command.slice(j + 2, end));
          j = end + 1;
          continue;
        }
        if (command[j] === '`') {
          const end = command.indexOf('`', j + 1);
          const stop = end === -1 ? command.length : end;
          nested.push(command.slice(j + 1, stop));
          j = stop + 1;
          continue;
        }
        word += command[j];
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      // 行継続（\ と改行）は語の状態を変えずに読み飛ばす。空の語を積むと、その後ろの道具を見失う
      if (command[i + 1] !== '\n') {
        word += command[i + 1];
        inWord = true;
      }
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }

    const isRedirect = c === '<' || c === '>' || (c === '&' && command[i + 1] === '>');
    if (isRedirect) {
      // 2>&1 の 2 のような番号は語に残さない
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      if (command.startsWith('<<<', i)) {
        const [text, next] = readWord(i + 3);
        words.push(`<<<${text}`);
        i = next - 1;
        continue;
      }
      if (command.startsWith('<<', i)) {
        const start = command[i + 2] === '-' ? i + 3 : i + 2;
        const [delimiter, next] = readWord(start);
        // 本文は改行の後で読み、この区切りの語に '<<本文' として足す
        heredocs.push({ delimiter, words });
        i = next - 1;
        continue;
      }
      let j = i;
      while ('<>&|'.includes(command[j]) && j - i < 3) j++;
      const op = command.slice(i, j);
      if (op.endsWith('&') && /[\d-]/.test(command[j] ?? '')) {
        while (/[\d-]/.test(command[j] ?? '')) j++;
        i = j - 1;
        continue;
      }
      const [text, next] = readWord(j);
      words.push(`${op.includes('<') ? '<' : '>'}${text}`);
      i = next - 1;
      continue;
    }

    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op) {
      endSegment();
      i += op.length - 1;
      // ヒアドキュメントの本文（行の終わりから終わりの印の行まで）は、区切りとして読まない
      if (op === '\n' && heredocs.length > 0) {
        let j = i + 1;
        for (const { delimiter, words: owner } of heredocs) {
          const body = [];
          while (j < command.length) {
            const end = command.indexOf('\n', j);
            const lineEnd = end === -1 ? command.length : end;
            const line = command.slice(j, lineEnd);
            j = lineEnd + 1;
            if (line.trim() === delimiter) break;
            body.push(line);
          }
          owner.push(`<<${body.join('\n')}`);
        }
        heredocs.length = 0;
        i = j - 1;
      }
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment();
  for (const inner of nested) segments.push(...splitSegments(inner));
  return segments;
}

// 実行する道具の前に付く語（シェルの予約語、環境変数の代入、env や timeout、npx）を飛ばす
const PREFIXES = new Set([
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}',
  'env', 'sudo', 'time', 'nohup', 'exec', 'command', 'builtin',
  'timeout', 'nice', 'ionice', 'stdbuf', 'xargs', 'watch', 'caffeinate',
  'npx', 'pnpx', 'bunx', 'dlx',
]);
// 前置きの道具が値を取るフラグ（sudo -u root、nice -n 10、xargs -I {}）
const PREFIX_FLAGS_WITH_VALUE = new Set(['-u', '-g', '-n', '-s', '-k', '-I', '-P', '-L', '-d', '-E', '-C', '-p', '--package']);

export function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

export function baseName(word) {
  const name = word.split('/').pop();
  // npx wrangler@4 のような版の指定を外す
  return name.replace(/(.)@[^@]*$/, '$1');
}

// 語の並びから、実行する道具の位置を返す。見つからなければ -1
export function commandIndex(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '' || isAssignment(w) || /^[<>]/.test(w)) continue;
    if (w.startsWith('-')) {
      if (PREFIX_FLAGS_WITH_VALUE.has(w)) i++;
      continue;
    }
    // timeout 300 や watch -n 2 の数
    if (/^\d+(\.\d+)?[smhd]?$/.test(w)) continue;
    if (PREFIXES.has(baseName(w))) continue;
    return i;
  }
  return -1;
}

// 値を取るフラグとリダイレクトを飛ばして、位置の引数だけを返す
export function positionals(args, flagsWithValue = new Set()) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || /^[<>]/.test(a)) continue;
    if (a.startsWith('-')) {
      if (flagsWithValue.has(a)) i++;
      continue;
    }
    result.push(a);
  }
  return result;
}
