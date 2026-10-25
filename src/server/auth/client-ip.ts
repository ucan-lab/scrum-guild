// リクエストの IP（CF-Connecting-IP）を、レート制限で数える単位に直す。
// IPv4 はそのまま。IPv6 は、1人が /64 の中の無数のアドレスを使え、事業者の単位では /48 の中も自由に使えるので、
// 上位 64 ビット（/64）と上位 48 ビット（/48）の2つの単位にする。IPv4 を IPv6 に写したアドレス（`::ffff:1.2.3.4`、
// `::ffff:0102:0304`、`0:0:0:0:0:ffff:0102:0304` のどの書き方でも）は、IPv4 に直す。
// 解釈できない値は、1つの枠（`unknown`）にまとめる。本物の値だと誤って別の枠に分けるより、まとめて数えるほうが安全

const MAX_IP_LENGTH = 64;

export type ClientIpUnits =
  { kind: 'v4'; address: string } | { kind: 'v6'; network64: string; network48: string } | { kind: 'unknown' };

function parseIpv4(text: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (match === null) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

// `::` の前か後の組の並び。末尾に IPv4 の書き方（`::1.2.3.4`）があれば、16ビット2つに直す
function parseGroups(part: string): number[] | undefined {
  if (part === '') return [];
  const texts = part.split(':');
  const groups: number[] = [];
  for (const [index, text] of texts.entries()) {
    if (text.includes('.')) {
      const octets = index === texts.length - 1 ? parseIpv4(text) : undefined;
      if (octets === undefined) return undefined;
      groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    } else if (/^[0-9a-f]{1,4}$/.test(text)) {
      groups.push(parseInt(text, 16));
    } else {
      return undefined;
    }
  }
  return groups;
}

// 8つの組。`::` は1つ以上の 0 の組を表す
function parseIpv6(text: string): number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const filler = 8 - head.length - tail.length;
  return filler >= 1 ? [...head, ...Array<number>(filler).fill(0), ...tail] : undefined;
}

const hex = (groups: readonly number[]) => groups.map((group) => group.toString(16)).join(':');

export function clientIpUnits(ip: string | undefined): ClientIpUnits {
  const text = (ip ?? '').trim().slice(0, MAX_IP_LENGTH).toLowerCase();
  const octets = parseIpv4(text);
  if (octets !== undefined) return { kind: 'v4', address: octets.join('.') };
  if (!text.includes(':')) return { kind: 'unknown' };

  // ゾーンの名前（`fe80::1%eth0`）は数えない
  const groups = parseIpv6(text.split('%', 1)[0]!);
  if (groups === undefined) return { kind: 'unknown' };
  // IPv4 を写したアドレス（::ffff:0:0/96）は、写された IPv4 として数える
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return {
      kind: 'v4',
      address: [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.'),
    };
  }
  return { kind: 'v6', network64: `${hex(groups.slice(0, 4))}::/64`, network48: `${hex(groups.slice(0, 3))}::/48` };
}
