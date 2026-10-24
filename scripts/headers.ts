// build/_headers の中身を作る。CSP は SvelteKit が build/index.html の meta に書いたもの（ハッシュ入り）を出どころにする。
// meta の CSP では frame-ancestors が効かず、ハッシュは build ごとに変わるので、コミットした _headers に書けない。
import { createHash } from 'node:crypto';
import {
  fixedHeaders,
  immutableCacheControl,
  metaIgnoredDirectives,
  pageCspDirectives,
} from '../src/shared/security-headers.ts';

const metaPattern = /<meta\s+http-equiv="content-security-policy"\s+content="([^"]*)"\s*\/?>/gi;

// SvelteKit の書き方（self）を CSP の書き方（'self'）に直す
const keywords = new Set([
  'self',
  'none',
  'unsafe-inline',
  'unsafe-eval',
  'unsafe-hashes',
  'strict-dynamic',
  'report-sample',
]);

function quoteSource(value: string): string {
  return keywords.has(value) || /^(sha256|sha384|sha512|nonce)-/.test(value) ? `'${value}'` : value;
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function extractMetaCsp(html: string): string {
  const matches = [...html.matchAll(metaPattern)];
  if (matches.length !== 1) {
    throw new Error(`index.html に CSP の meta が1つだけあるはずが、${matches.length} 個あった`);
  }
  return decodeAttribute(matches[0][1]).trim();
}

export function withIgnoredDirectives(metaCsp: string): string {
  const present = new Set(metaCsp.split(';').map((part) => part.trim().split(/\s+/)[0]));
  const added: string[] = [];
  for (const name of metaIgnoredDirectives) {
    const values = (pageCspDirectives as Record<string, readonly string[] | undefined>)[name];
    if (!values || present.has(name)) continue;
    added.push([name, ...values.map(quoteSource)].join(' '));
  }
  return [metaCsp.replace(/;\s*$/, ''), ...added].join('; ');
}

// 書き出した JS に埋まった静的な style 属性のうち、CSP の style-src のハッシュに無いものを返す。
// 無いものがあると、その要素の見た目が CSP で止まる（例: Kit の読み上げ用の要素が隠れず画面に出る）
export function missingStyleHashes(csp: string, scripts: string[]): string[] {
  const styleSrc = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === 'style-src');
  const allowed = new Set(styleSrc?.slice(1) ?? []);
  const missing = new Set<string>();
  for (const script of scripts) {
    for (const [, style] of script.matchAll(/style="([^"]*)"/g)) {
      const hash = `'sha256-${createHash('sha256').update(style).digest('base64')}'`;
      if (!allowed.has(hash)) missing.add(`${style} → ${hash}`);
    }
  }
  return [...missing];
}

export function headersFile(indexHtml: string): string {
  const csp = withIgnoredDirectives(extractMetaCsp(indexHtml));
  const page = Object.entries({ 'Content-Security-Policy': csp, ...fixedHeaders })
    .map(([name, value]) => `  ${name}: ${value}`)
    .join('\n');
  return `/*\n${page}\n\n/_app/immutable/*\n  Cache-Control: ${immutableCacheControl}\n`;
}
