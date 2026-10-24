export type Health = {
  status: 'ok';
  // ビルドで埋めたコミットの SHA。埋めていなければ dev
  version: string;
};
