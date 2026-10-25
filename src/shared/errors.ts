// API のエラーの形（docs/development.md の「API のエラーとログ」）。画面は code で分岐し、文言は言葉の辞書から出す。

export const errorCodes = [
  'invalid_input',
  'forbidden',
  'not_found',
  'conflict',
  'internal',
  // 依存先（D1）に届かない。503
  'unavailable',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type ErrorBody = {
  error: {
    code: ErrorCode;
    // 開発者向け。画面にそのまま出さない
    message: string;
    details?: unknown;
  };
};

export function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (errorCodes as readonly unknown[]).includes(error.code)
  );
}
