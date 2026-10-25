export type Health = {
  status: 'ok';
  // D1 に届いた。届かないときは 200 ではなく 503 の unavailable を返す
  database: 'ok';
  // ビルドで埋めたコミットの SHA。埋めていなければ dev
  version: string;
};

export function isHealth(value: unknown): value is Health {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'database' in value &&
    value.database === 'ok' &&
    'version' in value &&
    typeof value.version === 'string'
  );
}
