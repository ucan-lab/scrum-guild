export type Health = {
  status: 'ok';
  // ビルドで埋めたコミットの SHA。埋めていなければ dev
  version: string;
};

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
