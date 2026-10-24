export type Health = {
  status: 'ok';
  // ビルドで埋めたコミットの SHA。埋めていなければ dev
  version: string;
};

// CI の試し（#44）: 型の誤りで ci-ok が落ちることを見る。マージしない
export const trialTypeError: number = 'not a number';

export function isHealth(value: unknown): value is Health {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'version' in value &&
    typeof value.version === 'string'
  );
}
